// One-off admin script — NOT deployed to Cloud Functions.
// Creates one demo Firebase Auth user per package option (A/B/C/D),
// with a Firestore profile already filled in and a balance set directly
// (bypassing orders/ and fulfillPaidOrder entirely, since this is a
// service-account write — Firestore rules don't apply to it).
//
// Usage:
//   cd scripts
//   npm install firebase-admin
//   node seed-demo-users.js            # real purchased durations (30m / 3h / 6h / unlimited)
//   node seed-demo-users.js --fast      # short durations, so you can actually watch
//                                       # a session hit its cap and auto-stop without waiting hours
//
// Requires a service account key: Firebase console -> Project settings ->
// Service accounts -> Generate new private key -> save as
// scripts/service-account.json (already gitignored below — do not commit it).

const admin = require("firebase-admin");
const path = require("path");

const serviceAccount = require(path.join(__dirname, "service-account.json"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const auth = admin.auth();
const db = admin.firestore();

const FAST = process.argv.includes("--fast");

// Same shape as OPTION_GRANTS in functions/index.js. --fast swaps in short
// durations so you can watch max_duration_seconds actually cut the call off
// instead of waiting out a real 3-hour balance.
const DEMO_USERS = [
  {
    option: "A",
    email: "demo-optionA@makis-lifecoach.test",
    fullName: "Demo — Option A",
    grant: { remainingSeconds: FAST ? 30 : 30 * 60 }
  },
  {
    option: "B",
    email: "demo-optionB@makis-lifecoach.test",
    fullName: "Demo — Option B",
    grant: { remainingSeconds: FAST ? 45 : 3 * 60 * 60 }
  },
  {
    option: "C",
    email: "demo-optionC@makis-lifecoach.test",
    fullName: "Demo — Option C",
    grant: { remainingSeconds: FAST ? 60 : 6 * 60 * 60, liveSessionsRemaining: 3 }
  },
  {
    option: "D",
    email: "demo-optionD@makis-lifecoach.test",
    fullName: "Demo — Option D",
    // Unlimited still goes through startSession's MAX_SESSION_CAP_SECONDS
    // (7200s) per conversation — there's no "unlimited single call" on
    // ElevenLabs's side, only unlimited *balance*.
    grant: { isUnlimited: true, unlimitedUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000) }
  }
];

const DEMO_PASSWORD = "Demo-Password-123!"; // change after testing, or delete these accounts

async function upsertUser(demo) {
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(demo.email);
  } catch (e) {
    userRecord = await auth.createUser({
      email: demo.email,
      password: DEMO_PASSWORD,
      emailVerified: true,
      displayName: demo.fullName
    });
  }

  const profile = {
    fullName: demo.fullName,
    interests: "testing the " + demo.option + " package timer",
    email: demo.email,
    isDemo: true,
    demoOption: demo.option,
    remainingSeconds: 0,
    isUnlimited: false,
    liveSessionsRemaining: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  Object.assign(profile, demo.grant);

  // Direct write via the Admin SDK — bypasses firestore.rules and the
  // orders/ -> fulfillPaidOrder flow on purpose, since these accounts
  // are meant to skip payment entirely.
  await db.collection("users").doc(userRecord.uid).set(profile, { merge: true });

  return userRecord.uid;
}

(async () => {
  console.log(FAST ? "Seeding demo users with SHORT test durations...\n" : "Seeding demo users with REAL purchased durations...\n");

  for (const demo of DEMO_USERS) {
    const uid = await upsertUser(demo);
    const durationNote = demo.grant.isUnlimited
      ? "unlimited (30 days)"
      : demo.grant.remainingSeconds + "s";
    console.log(`Option ${demo.option}: ${demo.email} / ${DEMO_PASSWORD}  (uid ${uid}, balance ${durationNote})`);
  }

  console.log("\nSign in to signin.html with any of the emails above to test that package's start/stop timer.");
  console.log("Run scripts/delete-demo-users.js when you're done to remove them.");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
