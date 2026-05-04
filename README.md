# Scategories

A two-player Scattergories-style game built as a Progressive Web App. Free to host, free to run. Designed for couples or duos who travel and don't want to lug the box around.

## What's in the box

- 12 categories per round (configurable: 6–18)
- 120 second timer (configurable: 60s–5m), pausable
- Random letter generator that avoids recently-used letters and (optionally) skips Q/X/Z
- 250+ tagged categories drawn from a balanced mix of types per round
- Real-time sync between two phones via Firebase (free tier, ~5 minute setup)
- Falls back to "same-phone" pass-and-play mode if Firebase isn't set up
- Auto-saves every keystroke; survives switching apps mid-round
- Auto-detects invalid (wrong letter) and duplicate answers
- One-tap "copy chatbot prompt" for judging — paste into ChatGPT/Claude
- Manual override on every answer (tap = winner, long-press = invalid)
- Round history and cumulative score
- Wake lock (screen stays on during a round)
- Dark mode, install-to-home-screen support
- Works offline once installed

## Quick start (no setup)

Just open `index.html` in a browser. The app starts in "same-phone" mode immediately — both players take turns on the one device. Good for testing, road trips with one charged phone, or when you don't feel like dealing with Firebase.

## Two-phone mode (free, ~5 minutes)

The game needs a tiny bit of cloud storage to sync between phones. Firebase's free tier is more than enough: 50,000 reads and 20,000 writes per day, of which two players will use about 0.1%.

### Step 1 — Create a Firebase project

1. Go to <https://console.firebase.google.com/> (sign in with any Google account).
2. Click **Add project**. Name it anything — e.g. `scategories`.
3. Disable Google Analytics (you don't need it). Click **Create project**.

### Step 2 — Register a web app

1. On the project home, click the **`</>`** (web) icon to "Add app to get started".
2. Give it a nickname (e.g. `Scat web`). **Don't** check Firebase Hosting yet.
3. Click **Register app**.
4. Firebase shows a code snippet with a `firebaseConfig = { ... }` block. Copy the object. It looks like:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:abcdef123456"
   };
   ```
5. Open `firebase-config.js` in this project. Replace `null` with that object (just rename `firebaseConfig` → `window.FIREBASE_CONFIG`):
   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "AIza...",
     // ...
   };
   ```

### Step 3 — Turn on Firestore

1. In the Firebase console, left sidebar → **Build → Firestore Database**.
2. Click **Create database**.
3. Pick **Start in test mode** for now (we lock it down in step 4).
4. Choose the location closest to you. Click **Enable**.

### Step 4 — Lock down the rules

Test mode lets anyone read/write your database for 30 days. To extend that, we add some rules. The game has no user accounts, so the rules are simple — anyone with the room code can read/write that specific room.

1. In Firestore, click the **Rules** tab.
2. Replace the contents with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /rooms/{roomCode} {
         // Anyone can create or read/write a room. The room code itself is the
         // (light) authentication — only people who know the 4 letters can
         // touch the doc.
         allow read, write: if true;
       }
     }
   }
   ```
3. Click **Publish**.

For a couple's private game this is fine. If you ever expose this on the public internet, consider adding rate-limiting or a real auth layer.

### Step 5 — Host it (optional but nice)

You can technically email each other the `index.html` and open it locally, but you really want a URL you can both load. A few free options:

**Easiest: Firebase Hosting** (since you already have a Firebase project)
1. Install Node.js if you don't have it (<https://nodejs.org/>).
2. From the project folder, run:
   ```
   npm install -g firebase-tools
   firebase login
   firebase init hosting
   ```
   When prompted, pick the project you created. Set the public directory to `.` (current folder). Configure as single-page app: **No**.
3. Deploy:
   ```
   firebase deploy
   ```
4. Firebase prints a URL like `https://your-project.web.app`. Open that on both phones.

**Other free hosts:** GitHub Pages, Netlify Drop, Cloudflare Pages, Vercel. All work — just upload the folder.

### Step 6 — Add to home screen

On each phone, open the URL in a browser and:
- **iOS Safari:** Share button → "Add to Home Screen"
- **Android Chrome:** menu → "Install app" or "Add to Home Screen"

Now it launches like a native app, full-screen, no browser bars.

## How a round plays

1. **Lobby** — share the 4-letter code (or your hosted URL with `#CODE` appended). Once both players are in, host taps **Start round**.
2. **Round** — letter and 12 categories appear. Both players type answers on their own phone, with a shared timer. Either can pause if pausing is allowed. Tap **Submit early** if you're done before the buzzer; once both submit, the timer ends.
3. **Score** — both players' answers show side-by-side. The app pre-marks blanks, wrong-letter answers, and matches.
   - **Tap an answer** to mark it the winner.
   - **Long-press** to mark it invalid.
   - Tap the **📋 icon** to copy a structured prompt; paste into any chatbot to get a one-line ruling per category.
   - Then mark the winners based on the ruling.
4. **Tally** — round score and cumulative score show. **Next round** rolls a new letter and fresh categories. **End game** goes back to lobby with history saved.

## Customizing

- **Categories** — open `js/categories.js` and add to the `Game.CATEGORIES` array. Use any of the existing tags, or invent new ones (and add them to `Game.CATEGORY_TAGS` to make them togglable).
- **Theme color** — change `--accent` in `styles.css`.
- **Letter pool / round length / packs** — change in-app via Settings.

## Files

```
index.html                — page shell + script load order
styles.css                — all visual styling
firebase-config.js        — your personal Firebase keys go here
manifest.webmanifest      — PWA install metadata
sw.js                     — service worker (offline support)
js/categories.js          — the master category bank
js/state.js               — central state object + localStorage helpers
js/sync.js                — Firebase + same-device backends
js/ui.js                  — render layer + simple screens (home, lobby, settings, history)
js/game.js                — round logic + round screen
js/judging.js             — judging logic + judge / results / history-detail screens
js/app.js                 — entry point, deep-link routing
```

Every file is heavily commented — open them up and poke around.

## Cost (none)

| | Free tier limit | Two-player usage |
|---|---|---|
| Firestore reads | 50,000/day | ~50/day if you play 5 rounds |
| Firestore writes | 20,000/day | ~200/day if you play 5 rounds |
| Firestore storage | 1 GB | ~1 KB per room |
| Firebase Hosting bandwidth | 10 GB/month | ~5 MB per visit |

You will not pay a cent unless you somehow play 1000+ rounds per day, in which case, write a book about your relationship.
