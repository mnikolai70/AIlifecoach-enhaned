// Removes the four demo accounts created by seed-demo-users.js —
// both the Firebase Auth user and their Firestore users/ doc.
//
// Usage: node delete-demo-users.js

const admin = require("firebase-admin");
const path = require("path");

const serviceAccount = require(path.join(__dirname, "service-account.json"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const auth = admin.auth();
const db = admin.firestore();

const DEMO_EMAILS = [
  "demo-optionA@makis-lifecoach.test",
  "demo-optionB@makis-lifecoach.test",
  "demo-optionC@makis-lifecoach.test",
  "demo-optionD@makis-lifecoach.test"
];

(async () => {
  for (const email of DEMO_EMAILS) {
    try {
      const user = await auth.getUserByEmail(email);
      await db.collection("users").doc(user.uid).delete();
      await auth.deleteUser(user.uid);
      console.log(`Deleted ${email} (uid ${user.uid})`);
    } catch (e) {
      console.log(`${email}: not found, skipping`);
    }
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
