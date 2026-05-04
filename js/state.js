/*
  js/state.js
  -----------
  All shared state for the app. There's exactly ONE state object, and every
  other file reads and mutates it. When state changes, we call `render()` (in
  ui.js) which redraws the current screen.

  This is essentially a tiny home-grown version of what Redux/Zustand do for
  bigger apps. We don't need a real library because the state is small and we
  don't need fancy features like undo or middleware.

  Two important things to understand:

  1. SHARED room state vs LOCAL device state.
     - Things like the current round, timer, both players' answers — these
       are SHARED. In multi-device mode they live in a Firebase document and
       both phones see the same thing. In same-device mode they live only in
       this state object on the one phone.
     - Things like dark mode, my name, my Player ID — these are LOCAL. Each
       phone has its own. They go in localStorage.

  2. Persistence.
     - LOCAL state (preferences, identity) is saved to localStorage so it
       survives a page reload.
     - SHARED state in multi-device mode is owned by Firestore; we just keep
       a copy in memory.
     - In same-device mode the SHARED state is also saved to localStorage so
       you can close the app and come back to the same round.
*/

window.Game = window.Game || {};

/* ============================================================================
   SECTION 1: small utilities
   ============================================================================ */

/*
  Generate a random URL-safe ID. Used for player IDs and other one-offs.
  We avoid the standard `crypto.randomUUID` because some older mobile browsers
  don't support it; this is good enough for our scale.
*/
Game.makeId = function (prefix = 'id') {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${random}`;
};

/*
  Generate a 4-letter room code, all uppercase consonants/vowels mixed but no
  confusing characters (no I, O, 0, 1). Easy to read out loud.
*/
Game.makeRoomCode = function () {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
};

/* ============================================================================
   SECTION 2: localStorage wrappers
   ============================================================================
   localStorage is the browser's persistent key/value store. It survives reloads
   but is per-domain and per-browser. Values must be strings, so we JSON-encode.
*/

const LS_PREFIX = 'scat:';

Game.lsGet = function (key, fallback) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    // localStorage can throw in private mode or when full. Fail soft.
    return fallback;
  }
};

Game.lsSet = function (key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    // Quota exceeded or disabled — silently ignore.
  }
};

Game.lsRemove = function (key) {
  try { localStorage.removeItem(LS_PREFIX + key); } catch (e) {}
};

/* ============================================================================
   SECTION 3: the state object itself
   ============================================================================ */

/*
  Our identity is generated once and reused forever (until the user clears
  storage). This lets us recognize "you" across reloads so we can rejoin a
  game without losing your spot.
*/
function loadOrCreateIdentity() {
  let id = Game.lsGet('myPlayerId', null);
  if (!id) {
    id = Game.makeId('p');
    Game.lsSet('myPlayerId', id);
  }
  return id;
}

function loadPreferences() {
  return Object.assign(
    {
      darkMode: true,
      soundEnabled: true,
      vibrationEnabled: true,
      lastUsedName: '',
      lastJoinedRoom: null,   // { code, mode } — used to auto-rejoin on reload
      enabledPacks: [
        'classic', 'people', 'food', 'places', 'things',
        'nature', 'entertainment', 'school', 'abstract',
        'holiday', 'body', 'transport',
        // 'spicy' deliberately off by default
      ],
      defaultRoundDuration: 120,
      defaultCategoryCount: 12,
      skipQXZ: true,
      hiddenCategoryTexts: [],   // texts user has reported / hidden
      customCategories: [],      // your own categories — strings, e.g. "A Star Wars character"
    },
    Game.lsGet('prefs', {})
  );
}

Game.state = {
  myPlayerId: loadOrCreateIdentity(),
  prefs: loadPreferences(),

  // The current screen: one of 'home', 'lobby', 'round', 'judge', 'history', 'settings'.
  screen: 'home',

  // The room we're in, or null if on home screen. Shape documented in the room
  // creation code below.
  room: null,

  // For autosave: my answers being typed for the current round.
  // Keyed by category index. We save these to localStorage every keystroke
  // and push to Firestore (debounced) in multi-device mode.
  myAnswers: {},

  // True when sync.js has hooked up to Firestore (multi-device mode only).
  syncConnected: false,

  // Set if the most recent action raised an error worth showing.
  errorMessage: null,
};

/*
  Persist preferences to localStorage. Call after any change to state.prefs.
*/
Game.savePrefs = function () {
  Game.lsSet('prefs', Game.state.prefs);
};

/* ============================================================================
   SECTION 4: room lifecycle helpers
   ============================================================================ */

/*
  A blank room shape. Used when creating a new room or joining one that
  doesn't exist yet.
*/
Game.makeBlankRoom = function (code, mode, hostId, hostName) {
  return {
    code,
    mode,                  // 'multi-device' | 'same-device'
    hostId,
    createdAt: Date.now(),
    players: [
      { id: hostId, name: hostName, online: true, lastSeenAt: Date.now() }
    ],
    settings: {
      roundDuration: Game.state.prefs.defaultRoundDuration,
      categoryCount: Game.state.prefs.defaultCategoryCount,
      skipQXZ: Game.state.prefs.skipQXZ,
      packs: Game.state.prefs.enabledPacks.slice(),
      pauseAllowed: true,
    },
    round: null,
    history: [],
    cumulativeScores: { [hostId]: 0 },
    recentLetters: [],
    recentCategoryTexts: [],
    // For same-device mode we track whose turn it is for input.
    sameDeviceTurnId: hostId,
  };
};

/*
  Add a player to an existing room (used when a second device joins).
  Returns the updated room (mutates in place too).
*/
Game.addPlayerToRoom = function (room, player) {
  const existing = room.players.find((p) => p.id === player.id);
  if (existing) {
    // Same player rejoining — refresh their info.
    existing.name = player.name || existing.name;
    existing.online = true;
    existing.lastSeenAt = Date.now();
  } else {
    room.players.push({
      id: player.id,
      name: player.name,
      online: true,
      lastSeenAt: Date.now(),
    });
    if (room.cumulativeScores[player.id] == null) {
      room.cumulativeScores[player.id] = 0;
    }
  }
  return room;
};

/* ============================================================================
   SECTION 5: getter helpers
   ============================================================================ */

Game.me = function () {
  if (!Game.state.room) return null;
  return Game.state.room.players.find((p) => p.id === Game.state.myPlayerId);
};

Game.opponents = function () {
  if (!Game.state.room) return [];
  return Game.state.room.players.filter((p) => p.id !== Game.state.myPlayerId);
};

Game.isHost = function () {
  return Game.state.room && Game.state.room.hostId === Game.state.myPlayerId;
};

/*
  Same-device mode means there's only one phone, and players "pass the phone".
  Detect either explicitly (room.mode === 'same-device') or implicitly (no
  Firebase configured).
*/
Game.isSameDevice = function () {
  return Game.state.room && Game.state.room.mode === 'same-device';
};
