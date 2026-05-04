/*
  firebase-config.js
  ------------------
  This file holds your personal Firebase project credentials. Without them, the
  app falls back to "same-device mode" — both players take turns on one phone,
  which is a fine fallback but not the main experience you want.

  How to set this up (free, ~5 minutes):
    1. Go to https://console.firebase.google.com/
    2. Click "Add project". Name it anything (e.g. "scategories").
       You can skip Google Analytics.
    3. In the project, click the "</>" web icon to "Add app". Give it a nickname.
    4. Firebase shows you a `firebaseConfig` object — copy it.
    5. Replace the `null` below with that object.
    6. In the left sidebar, click "Build" → "Firestore Database" → "Create database".
       Pick "Start in test mode" (it expires in 30 days; we'll deal with that
       in the README). Pick the location closest to you.
    7. Reload the app on both phones. Done.

  Full step-by-step screenshots are in README.md.

  These keys ARE safe to commit. They identify your project, not authenticate
  it — Firebase security rules are what actually control access, and we set
  those up in the README. (This is intentional Firebase design, not a leak.)
*/

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCprnuuBbvaU0McrrNJ_Vl-KIZ8lV_FsZ0",
  authDomain: "scategories-c6945.firebaseapp.com",
  projectId: "scategories-c6945",
  storageBucket: "scategories-c6945.firebasestorage.app",
  messagingSenderId: "653824857061",
  appId: "1:653824857061:web:8c11de6604bab9b7de550c"
};
;

// When you're ready, replace `null` above with your config, e.g.:
//
// window.FIREBASE_CONFIG = {
//   apiKey: "AIza...",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project",
//   storageBucket: "your-project.appspot.com",
//   messagingSenderId: "123456789012",
//   appId: "1:123456789012:web:abcdef123456"
// };
