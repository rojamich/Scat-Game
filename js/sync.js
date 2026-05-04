/*
  js/sync.js
  ----------
  Handles room creation, joining, and live syncing between devices.

  Two backends, picked automatically:

    1. FIREBASE (multi-device).  If `window.FIREBASE_CONFIG` is set in
       firebase-config.js, we use Firestore. Each room is one document at
       `rooms/{ROOMCODE}`. Both phones subscribe to it; any change one phone
       makes is mirrored to the other within ~100ms.

    2. LOCAL ONLY (same-device).  No Firebase. Both "players" share the same
       phone. We persist the room to localStorage so closing the tab doesn't
       lose progress.

  Public functions exposed on `Game`:
    - Game.initSync()                       called once on app start
    - Game.createRoom(name)                 multi-device, host creates a code
    - Game.joinRoom(code, name)             multi-device, partner joins
    - Game.createSameDeviceRoom(n1, n2)     same-device room with both names
    - Game.persistRoom()                    save current room state (LS or FS)
    - Game.leaveRoom()                      mark offline, return to home
    - Game.rejoinLastRoom()                 from "rejoin" button on home
*/

window.Game = window.Game || {};

/* ============================================================================
   INITIALIZATION
   ============================================================================ */

let firestoreDb = null;        // the Firestore handle if Firebase is set up
let activeUnsubscribe = null;  // function to call to stop the current room watcher
let pendingPersistTimer = null;

Game.initSync = function () {
  if (window.FIREBASE_CONFIG && typeof firebase !== 'undefined') {
    try {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      firestoreDb = firebase.firestore();
      // Enable Firestore's built-in offline cache. With this on, Firestore
      // will queue writes when offline and replay them when reconnected,
      // and reads will hit the local cache first.
      firestoreDb.enablePersistence({ synchronizeTabs: true }).catch(() => {
        // Multiple tabs without `synchronizeTabs` support, or private mode.
        // The app still works, just without offline persistence.
      });
      Game.state.syncConnected = true;
    } catch (err) {
      console.warn('Firebase init failed; falling back to local-only mode.', err);
      firestoreDb = null;
    }
  }
};

/* ============================================================================
   MULTI-DEVICE: CREATE / JOIN
   ============================================================================ */

Game.createRoom = async function (myName) {
  if (!firestoreDb) {
    // Without Firebase we can't have multi-device rooms. Fall back to same-device.
    Game.toast('Multi-device sync not configured. Starting same-phone game.');
    Game.createSameDeviceRoom(myName, 'Player 2');
    return;
  }

  // Generate a code that isn't already in use. Try a few times before giving up.
  let code = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = Game.makeRoomCode();
    const docRef = firestoreDb.collection('rooms').doc(candidate);
    const snap = await docRef.get();
    if (!snap.exists) { code = candidate; break; }
  }
  if (!code) throw new Error('Could not generate a unique room code.');

  const room = Game.makeBlankRoom(code, 'multi-device', Game.state.myPlayerId, myName);
  await firestoreDb.collection('rooms').doc(code).set(room);

  // Subscribe to updates and remember we're in this room.
  attachRoomWatcher(code);
  Game.state.prefs.lastJoinedRoom = { code, mode: 'multi-device' };
  Game.state.prefs.lastUsedName = myName;
  Game.savePrefs();
};

Game.joinRoom = async function (code, myName) {
  if (!firestoreDb) {
    throw new Error('Multi-device sync not configured. See README to set up Firebase.');
  }
  const docRef = firestoreDb.collection('rooms').doc(code);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error(`Room ${code} doesn't exist.`);

  const room = snap.data();
  Game.addPlayerToRoom(room, {
    id: Game.state.myPlayerId,
    name: myName,
  });
  await docRef.set(room);

  attachRoomWatcher(code);
  Game.state.prefs.lastJoinedRoom = { code, mode: 'multi-device' };
  Game.state.prefs.lastUsedName = myName;
  Game.savePrefs();
};

Game.rejoinLastRoom = async function () {
  const last = Game.state.prefs.lastJoinedRoom;
  if (!last) return;
  if (last.mode === 'same-device') {
    // Reload from localStorage.
    const saved = Game.lsGet('sameDeviceRoom', null);
    if (saved) {
      Game.state.room = saved;
      Game.goto('lobby');
    } else {
      Game.toast('Your previous game was cleared.');
      Game.state.prefs.lastJoinedRoom = null;
      Game.savePrefs();
      Game.render();
    }
    return;
  }
  // Multi-device rejoin
  if (!firestoreDb) {
    Game.toast('Sync is offline — cannot rejoin remote room.');
    return;
  }
  try {
    const snap = await firestoreDb.collection('rooms').doc(last.code).get();
    if (!snap.exists) {
      Game.state.prefs.lastJoinedRoom = null;
      Game.savePrefs();
      Game.toast(`Room ${last.code} no longer exists.`);
      Game.render();
      return;
    }
    // Mark ourselves online again in case the doc has us as offline.
    const room = snap.data();
    const me = room.players.find((p) => p.id === Game.state.myPlayerId);
    if (me) { me.online = true; me.lastSeenAt = Date.now(); }
    await firestoreDb.collection('rooms').doc(last.code).set(room);
    attachRoomWatcher(last.code);
  } catch (err) {
    Game.toast('Could not rejoin. Check your connection.');
  }
};

/* ============================================================================
   SAME-DEVICE ROOMS
   ============================================================================ */

Game.createSameDeviceRoom = function (n1, n2) {
  const code = Game.makeRoomCode();
  // Host (player 1) is "myPlayerId". Player 2 gets a separate id.
  const room = Game.makeBlankRoom(code, 'same-device', Game.state.myPlayerId, n1);
  const p2Id = Game.makeId('p');
  Game.addPlayerToRoom(room, { id: p2Id, name: n2 });
  Game.state.room = room;
  Game.state.prefs.lastJoinedRoom = { code, mode: 'same-device' };
  Game.savePrefs();
  saveSameDeviceRoom();
  Game.goto('lobby');
};

function saveSameDeviceRoom() {
  if (Game.state.room && Game.isSameDevice()) {
    Game.lsSet('sameDeviceRoom', Game.state.room);
  }
}

/* ============================================================================
   PERSISTENCE: write the current room state to wherever it lives
   ============================================================================
   Called from anywhere that mutates `Game.state.room`. Debounced lightly so
   typing into 12 inputs doesn't hammer Firestore.
*/

Game.persistRoom = function (immediate = false) {
  if (!Game.state.room) return;

  if (Game.isSameDevice()) {
    saveSameDeviceRoom();
    return;
  }

  if (!firestoreDb) return;

  const room = Game.state.room;
  const writeNow = () => {
    // Use `set` (full overwrite) — our room doc is small (< few KB) so this
    // is fine and avoids hairy partial-update races. Firestore charges per
    // *document write*, not per byte.
    firestoreDb.collection('rooms').doc(room.code).set(room).catch((err) => {
      console.warn('persistRoom failed', err);
    });
  };

  if (immediate) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
    writeNow();
  } else {
    // Debounce: wait 400ms of inactivity before writing. This bunches keystrokes.
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = setTimeout(writeNow, 400);
  }
};

/* ============================================================================
   ROOM WATCHER: subscribe to Firestore updates for this room
   ============================================================================ */

function attachRoomWatcher(code) {
  // Tear down any previous watcher first so we don't get duplicate updates
  // when leaving / rejoining.
  if (activeUnsubscribe) { activeUnsubscribe(); activeUnsubscribe = null; }

  const docRef = firestoreDb.collection('rooms').doc(code);
  activeUnsubscribe = docRef.onSnapshot(
    (snap) => {
      if (!snap.exists) {
        Game.toast('Room was deleted.');
        Game.leaveRoom();
        return;
      }
      const incoming = snap.data();

      // We need to be careful here: the local copy of `myAnswers` for the
      // current round is what the user is typing. If we blindly overwrite
      // the room state from Firestore, our typing gets clobbered. So we
      // merge: take the incoming room as the new truth, BUT preserve our
      // own pending answers from `state.myAnswers`.
      Game.state.room = incoming;
      const myId = Game.state.myPlayerId;
      if (
        incoming.round &&
        Game.state.myAnswers &&
        Object.keys(Game.state.myAnswers).length > 0
      ) {
        if (!incoming.round.answers) incoming.round.answers = {};
        if (!incoming.round.answers[myId]) incoming.round.answers[myId] = {};
        Object.assign(incoming.round.answers[myId], Game.state.myAnswers);
      }

      // First-paint: if we don't have a screen set yet, show the lobby (or
      // round / judge as appropriate based on room state).
      decideScreenFromRoom();
      Game.render();
    },
    (err) => {
      console.warn('snapshot error', err);
      Game.toast('Lost connection. Trying to reconnect…');
    }
  );
}

/*
  Decide what screen we should be on based on the room state. Used after a
  snapshot arrives — if the host just started a round, we should jump to it.
*/
function decideScreenFromRoom() {
  const r = Game.state.room;
  if (!r) { Game.state.screen = 'home'; return; }

  // If we're already in a "navigation" screen (settings/history), don't yank
  // the user off it just because the room state changed.
  const stayPut = ['settings', 'roomSettings', 'history', 'historyDetail'];
  if (stayPut.includes(Game.state.screen)) return;

  if (!r.round) {
    Game.state.screen = 'lobby';
  } else if (r.round.scoring && r.round.scoring.finalScores) {
    Game.state.screen = 'results';
  } else if (r.round.scoring) {
    Game.state.screen = 'judge';
  } else {
    Game.state.screen = 'round';
  }
}

/* ============================================================================
   LEAVE ROOM
   ============================================================================ */

Game.leaveRoom = function () {
  if (activeUnsubscribe) { activeUnsubscribe(); activeUnsubscribe = null; }
  const wasSameDevice = Game.isSameDevice();
  // For multi-device, mark ourselves offline so the other player sees it.
  if (Game.state.room && !wasSameDevice && firestoreDb) {
    const room = Game.state.room;
    const me = room.players.find((p) => p.id === Game.state.myPlayerId);
    if (me) {
      me.online = false;
      me.lastSeenAt = Date.now();
      firestoreDb.collection('rooms').doc(room.code).set(room).catch(() => {});
    }
  }
  if (wasSameDevice) Game.lsRemove('sameDeviceRoom');
  Game.state.room = null;
  Game.state.myAnswers = {};
  Game.state.prefs.lastJoinedRoom = null;
  Game.savePrefs();
  Game.goto('home');
};

/* ============================================================================
   PRESENCE: occasional heartbeat
   ============================================================================ */

/*
  Every 20 seconds while we're in a room, update our `lastSeenAt`. The other
  player's UI can use this to detect "really gone" vs "just switched apps".
*/
setInterval(() => {
  if (!Game.state.room || Game.isSameDevice()) return;
  const me = Game.state.room.players.find((p) => p.id === Game.state.myPlayerId);
  if (me) {
    me.lastSeenAt = Date.now();
    me.online = true;
    Game.persistRoom();
  }
}, 20000);

// On page hide (user backgrounded the app), mark offline so partner can see.
document.addEventListener('visibilitychange', () => {
  if (!Game.state.room || Game.isSameDevice() || !firestoreDb) return;
  const room = Game.state.room;
  const me = room.players.find((p) => p.id === Game.state.myPlayerId);
  if (!me) return;
  me.online = !document.hidden;
  me.lastSeenAt = Date.now();
  Game.persistRoom(true);
});
