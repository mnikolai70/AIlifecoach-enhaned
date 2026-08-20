# Per-user time metering — setup

Files changed/added:
- `dashboard.html` — public widget replaced with a balance-gated "Start session" flow
- `functions/index.js`, `functions/package.json` — the backend that enforces it
- `firestore.rules` — locks `remainingSeconds` etc. to Cloud Functions only

`profile.html`, `signin.html`, `order.html`, `index.html` are unchanged.

## 1. Make the agent private

ElevenLabs dashboard → your agent → **Security** tab → enable authentication
(require a signed URL). This is what stops anyone from bypassing your backend
and talking to the agent directly, the way the old public embed allowed.

## 2. Deploy Firestore rules

```
firebase deploy --only firestore:rules
```

## 3. Set the three secrets Cloud Functions needs

```
firebase functions:secrets:set ELEVENLABS_API_KEY
firebase functions:secrets:set ELEVENLABS_AGENT_ID
firebase functions:secrets:set ELEVENLABS_WEBHOOK_SECRET
```

- `ELEVENLABS_API_KEY` — from ElevenLabs → Settings → API keys.
- `ELEVENLABS_AGENT_ID` — the same `agent_...` id the old widget used
  (`agent_1001ky9scz2qemaayvswg2cs07ns`).
- `ELEVENLABS_WEBHOOK_SECRET` — generated when you create the webhook in step 5.

## 4. Deploy the functions

```
cd functions && npm install && cd ..
firebase deploy --only functions
```

This deploys four functions:
- `grantFreeDemoOnSignup` — gives every new signup a 300-second (5 min) free
  balance automatically, replacing the old "open the widget for a free demo"
  copy.
- `fulfillPaidOrder` — watches `orders/{orderId}`; when `status` becomes
  `"paid"` it credits the buyer's balance per the option purchased. PayPal
  sets `status: 'paid'` itself on capture. For bank transfer / IRIS orders,
  you confirm the transfer and then set that order's `status` field to
  `"paid"` by hand in the Firestore console — the function does the rest.
- `startSession` — callable from the client; checks balance, requests a
  signed URL from ElevenLabs, and caps that conversation at whatever time
  is left.
- `elevenLabsWebhook` — the reconciliation endpoint (see next step).

## 5. Point ElevenLabs' post-call webhook at your function

After deploying, `firebase deploy` prints the `elevenLabsWebhook` URL
(something like
`https://<region>-<project-id>.cloudfunctions.net/elevenLabsWebhook`).

In ElevenLabs: Settings → Webhooks → create one, paste that URL, copy the
generated signing secret into `ELEVENLABS_WEBHOOK_SECRET` (step 3), then open
your agent → the webhook should be selectable as its post-call webhook.

## Notes / things to decide later

- **Option D (unlimited/month)** is stored as `isUnlimited: true` +
  `unlimitedUntil` (30 days from `fulfillPaidOrder` running). There's no
  recurring billing wired up here — Option D is "Contact for customised
  plan" in the UI already, so renewing/cancelling it is presumably something
  you do by hand today; `fulfillPaidOrder` just needs its `status` set to
  `paid` again each renewal to extend `unlimitedUntil`.
- **Option C's 3 live human sessions** are tracked in `liveSessionsRemaining`
  on the user doc but nothing currently reads or decrements it — that part
  of scheduling/using a live session isn't wired to anything yet.
- If you'd rather not maintain Cloud Functions, the same three pieces
  (balance check, signed URL + `max_duration_seconds`, webhook reconciliation)
  can live on any backend you control — Cloud Functions was the natural fit
  here since the site already uses Firebase Auth + Firestore.

## 6. Demo users for testing (scripts/)

`scripts/seed-demo-users.js` creates one demo login per package —
Option A, B, C, D — with a Firestore balance set directly by the Admin SDK,
skipping `orders/` and `fulfillPaidOrder` entirely.

```
cd scripts
npm install
```

Download a service account key (Firebase console → Project settings →
Service accounts → Generate new private key) and save it as
`scripts/service-account.json` — it's gitignored, don't commit it.

```
node seed-demo-users.js          # real durations: 30m / 3h / 6h / unlimited
node seed-demo-users.js --fast   # short durations so you can watch the
                                  # session actually hit max_duration_seconds
                                  # and auto-stop, instead of waiting 3 hours
```

This prints four email/password logins — sign in with any of them on
`signin.html` to test that package's start/stop timer on `dashboard.html`
exactly as a paying user would see it. Note: even Option D's "unlimited"
balance is still capped per-conversation at 7200s (`MAX_SESSION_CAP_SECONDS`
in `functions/index.js`) — that's an ElevenLabs ceiling on a single call, not
a balance limit.

Run `node delete-demo-users.js` when you're done to remove all four.
