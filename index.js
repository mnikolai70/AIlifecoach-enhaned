const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const functionsV1 = require("firebase-functions/v1");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ---- secrets (set with: firebase functions:secrets:set NAME) ----
const XI_API_KEY = defineSecret("ELEVENLABS_API_KEY");
const AGENT_ID = defineSecret("ELEVENLABS_AGENT_ID");
const WEBHOOK_SECRET = defineSecret("ELEVENLABS_WEBHOOK_SECRET");

// ---- what each purchased option grants ----
// Keep this in sync with the option cards in dashboard.html.
const OPTION_GRANTS = {
  A: { seconds: 30 * 60 },                          // 30 minutes
  B: { seconds: 3 * 60 * 60 },                       // 3 hours
  C: { seconds: 6 * 60 * 60, liveSessions: 3 },      // 6 hours + 3 human sessions
  D: { unlimitedDays: 30 }                           // unlimited / month
};

const FREE_DEMO_SECONDS = 5 * 60;
const MAX_SESSION_CAP_SECONDS = 7200; // ElevenLabs max_duration_seconds hard ceiling

// =====================================================================
// 1) Give every new account a 5-minute free-demo balance automatically.
//    Runs before profile.html's own write, so profile.html's merge never
//    needs to (and per firestore.rules, is not allowed to) set balance
//    fields itself.
// =====================================================================
exports.grantFreeDemoOnSignup = functionsV1.auth.user().onCreate(async (user) => {
  await db.collection("users").doc(user.uid).set(
    {
      remainingSeconds: FREE_DEMO_SECONDS,
      isUnlimited: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
});

// =====================================================================
// 2) When an order's status becomes "paid", credit the user's balance.
//    - PayPal sets status: 'paid' itself on capture (order.html).
//    - Bank transfer / IRIS orders sit at 'pending_verification' until
//      you mark them 'paid' by hand in the Firestore console after you
//      confirm the transfer — this function fires the same way either way.
//    Idempotent via the `fulfilled` flag, so retries/duplicate writes
//    can't double-credit someone.
// =====================================================================
exports.fulfillPaidOrder = onDocumentWritten("orders/{orderId}", async (event) => {
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after || after.status !== "paid" || after.fulfilled) return;

  const grant = OPTION_GRANTS[after.option];
  if (!grant) return;

  const userRef = db.collection("users").doc(after.uid);
  const orderRef = event.data.after.ref;

  await db.runTransaction(async (t) => {
    const orderSnap = await t.get(orderRef);
    if (orderSnap.data().fulfilled) return; // already handled by a concurrent run

    const update = {};
    if (grant.unlimitedDays) {
      const until = admin.firestore.Timestamp.fromMillis(
        Date.now() + grant.unlimitedDays * 24 * 60 * 60 * 1000
      );
      update.isUnlimited = true;
      update.unlimitedUntil = until;
    } else {
      update.remainingSeconds = admin.firestore.FieldValue.increment(grant.seconds);
      if (grant.liveSessions) {
        update.liveSessionsRemaining = admin.firestore.FieldValue.increment(grant.liveSessions);
      }
    }

    t.set(userRef, update, { merge: true });
    t.update(orderRef, { fulfilled: true, fulfilledAt: admin.firestore.FieldValue.serverTimestamp() });
  });
});

// =====================================================================
// 3) Client calls this to start a coaching session. It checks the
//    balance, asks ElevenLabs for a signed URL, and caps that specific
//    conversation at whatever time the user has left — so even if the
//    webhook below is delayed, ElevenLabs itself cuts the call off.
// =====================================================================
exports.startSession = onCall(
  { secrets: [XI_API_KEY, AGENT_ID] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const data = userSnap.data() || {};

    const isUnlimited =
      data.isUnlimited && data.unlimitedUntil && data.unlimitedUntil.toMillis() > Date.now();
    const remaining = data.remainingSeconds || 0;

    if (!isUnlimited && remaining <= 0) {
      throw new HttpsError("failed-precondition", "no-balance");
    }

    const maxDurationSeconds = isUnlimited
      ? MAX_SESSION_CAP_SECONDS
      : Math.max(60, Math.min(remaining, MAX_SESSION_CAP_SECONDS));
    // ElevenLabs requires at least 60s; if the user has less than that,
    // still let the last short session run rather than blocking them —
    // the webhook will zero out the balance afterward regardless.

    const url =
      "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url" +
      `?agent_id=${encodeURIComponent(AGENT_ID.value())}&include_conversation_id=true`;

    const res = await fetch(url, {
      headers: { "xi-api-key": XI_API_KEY.value() }
    });
    if (!res.ok) {
      throw new HttpsError("internal", "Could not reach ElevenLabs.");
    }
    const body = await res.json();

    const sessionRef = await db.collection("sessions").add({
      uid,
      conversationId: body.conversation_id || null,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "active",
      reconciled: false
    });

    return {
      signedUrl: body.signed_url,
      maxDurationSeconds,
      sessionId: sessionRef.id
    };
  }
);

// =====================================================================
// 4) ElevenLabs posts here when a call ends. This is the source of
//    truth: it subtracts the actual seconds used from the balance.
//    Configure the webhook + this URL + the shared secret in the
//    ElevenLabs dashboard (Settings -> Webhooks), and select it under
//    the agent's Post-call webhook setting.
// =====================================================================
exports.elevenLabsWebhook = onRequest(
  { secrets: [WEBHOOK_SECRET] },
  async (req, res) => {
    const signatureHeader = req.get("ElevenLabs-Signature") || "";
    if (!verifyHmac(req.rawBody, signatureHeader, WEBHOOK_SECRET.value())) {
      res.status(401).send("bad signature");
      return;
    }

    const event = req.body;
    if (event.type !== "post_call_transcription") {
      // ignore audio / call_initiation_failure webhook types here
      res.status(200).send("ignored");
      return;
    }

    const conversationId =
      event.data.conversation_id ||
      event.data.conversation_initiation_client_data?.dynamic_variables
        ?.system__conversation_id;
    const durationSecs = event.data.metadata?.call_duration_secs || 0;

    if (!conversationId) {
      res.status(200).send("no conversation id");
      return;
    }

    const sessionQuery = await db
      .collection("sessions")
      .where("conversationId", "==", conversationId)
      .limit(1)
      .get();

    if (sessionQuery.empty) {
      res.status(200).send("unknown session");
      return;
    }

    const sessionDoc = sessionQuery.docs[0];
    if (sessionDoc.data().reconciled) {
      res.status(200).send("already reconciled"); // idempotent on webhook retries
      return;
    }

    const uid = sessionDoc.data().uid;
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (t) => {
      const freshSession = await t.get(sessionDoc.ref);
      if (freshSession.data().reconciled) return;

      const userSnap = await t.get(userRef);
      const isUnlimited =
        userSnap.data().isUnlimited &&
        userSnap.data().unlimitedUntil &&
        userSnap.data().unlimitedUntil.toMillis() > Date.now();

      if (!isUnlimited) {
        const current = userSnap.data().remainingSeconds || 0;
        t.set(
          userRef,
          { remainingSeconds: Math.max(0, current - durationSecs) },
          { merge: true }
        );
      }
      t.update(sessionDoc.ref, {
        reconciled: true,
        durationSecs,
        status: "ended"
      });
    });

    res.status(200).send("ok");
  }
);

function verifyHmac(rawBody, signatureHeader, secret) {
  // Header looks like: t=1700000000,v0=<hex hmac>
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("="))
  );
  if (!parts.t || !parts.v0) return false;

  const payloadToSign = `${parts.t}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payloadToSign)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(parts.v0)
    );
  } catch {
    return false;
  }
}
