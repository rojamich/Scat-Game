/*
  js/game.js
  ----------
  Round mechanics + the round screen.

  Concepts:
    - A "round" is one playthrough: a letter, a set of categories, a timer,
      and per-player answers.
    - In MULTI-DEVICE mode, both players play simultaneously; the timer is
      shared and so are submissions.
    - In SAME-DEVICE mode, players take turns. Player 1 plays the round on
      their own timer, then passes the phone to Player 2 who plays the same
      letter + categories on a fresh timer. Then we go to judging.

  Public functions:
    - Game.startRound()              host kicks off a new round
    - Game.pauseRound() / resumeRound()
    - Game.submitMyAnswers()         done early
    - Game.advanceSameDevice()       hand-off button
*/

window.Game = window.Game || {};

/* ============================================================================
   LETTER + CATEGORY SELECTION
   ============================================================================ */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const SKIPPABLE = ['Q', 'X', 'Z'];

/*
  Pick a letter that isn't in the "recent" list and respects the skip-QXZ
  setting. The recent list lives on the room and grows with each round.
*/
function pickLetter(room) {
  const skip = room.settings.skipQXZ ? new Set(SKIPPABLE) : new Set();
  const recent = new Set((room.recentLetters || []).slice(-8));   // avoid last 8

  let pool = ALPHABET.filter((l) => !skip.has(l) && !recent.has(l));
  // If we've burnt through almost everything, ignore the recent filter.
  if (pool.length < 3) pool = ALPHABET.filter((l) => !skip.has(l));

  return pool[Math.floor(Math.random() * pool.length)];
}

/*
  Build a balanced set of N categories.

  Strategy:
    1. Filter the master bank to enabled packs and remove user-hidden ones
       and any that were used in the last 30 rounds (avoids repeats).
    2. Group surviving categories by their PRIMARY tag (first tag in the list).
    3. Round-robin pick from groups until we have N. This gives a mix even
       when a user has, say, 100 "food" categories enabled but only 10
       "transport" ones.
*/
function pickCategories(room, n) {
  const hidden = new Set(Game.state.prefs.hiddenCategoryTexts || []);
  const recent = new Set((room.recentCategoryTexts || []).slice(-30));

  // The host's custom categories ride along on every round. We tag them
  // 'custom' so the balanced-mix picker treats them as their own group —
  // a bunch of customs all in one round still get round-robined with the
  // built-ins instead of dominating.
  const customs = (Game.state.prefs.customCategories || []).map((text) => ({
    text,
    tags: ['custom'],
  }));

  let pool = Game.filterCategoriesByPacks(room.settings.packs)
    .concat(customs)
    .filter((c) => !hidden.has(c.text) && !recent.has(c.text));

  // If filters left us too small a pool, ignore the recent-used filter.
  if (pool.length < n) {
    pool = Game.filterCategoriesByPacks(room.settings.packs)
      .concat(customs)
      .filter((c) => !hidden.has(c.text));
  }
  // Still not enough? Just shuffle the whole bank.
  if (pool.length < n) pool = Game.CATEGORIES.slice().concat(customs);

  // Group by primary tag for balance.
  const groups = {};
  pool.forEach((c) => {
    const primary = c.tags[0];
    (groups[primary] = groups[primary] || []).push(c);
  });

  // Shuffle each group.
  Object.values(groups).forEach(shuffle);

  // Round-robin draw across groups.
  const picked = [];
  const tagKeys = shuffle(Object.keys(groups));
  let idx = 0;
  while (picked.length < n) {
    const tag = tagKeys[idx % tagKeys.length];
    const arr = groups[tag];
    if (arr && arr.length) picked.push(arr.shift());
    idx++;
    // Safety: bail if all groups are empty.
    if (idx > n * 4) break;
  }

  return picked.map((c) => c.text);
}

/* In-place Fisher-Yates shuffle. Returns the same array for chaining. */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================================================================
   START ROUND
   ============================================================================ */

Game.startRound = function () {
  const room = Game.state.room;
  if (!room) return;
  if (room.players.length < 2) {
    Game.toast('Need 2 players first.');
    return;
  }

  // Only the host should be the one writing this initial setup, otherwise
  // both phones might race and pick different letters/categories.
  if (!Game.isSameDevice() && !Game.isHost()) {
    Game.toast('Only the host can start a round.');
    return;
  }

  const letter = pickLetter(room);
  const categories = pickCategories(room, room.settings.categoryCount);

  const roundNumber = (room.history ? room.history.length : 0) + 1;

  room.round = {
    number: roundNumber,
    letter,
    categories,
    startedAt: Date.now(),
    pausedAt: null,
    pausedDuration: 0,
    answers: {},
    submittedBy: [],
    scoring: null,
    // Same-device only:
    currentTurnId: Game.isSameDevice() ? room.players[0].id : null,
    turnHandedOff: false,
  };

  // Clear my local pending answers from any previous round.
  Game.state.myAnswers = {};

  Game.persistRoom(true);
  Game.goto('round');
  acquireWakeLock();
};

/* ============================================================================
   TIMER LOGIC
   ============================================================================ */

/*
  Compute remaining seconds in the current round.
  - elapsed time = (now - startedAt) - pausedDuration
  - if currently paused, freeze at (pausedAt - startedAt - pausedDuration)
*/
Game.remainingSeconds = function () {
  const r = Game.state.room && Game.state.room.round;
  if (!r) return 0;
  const now = r.pausedAt || Date.now();
  const elapsedMs = now - r.startedAt - r.pausedDuration;
  return Math.max(0, Math.ceil((Game.state.room.settings.roundDuration * 1000 - elapsedMs) / 1000));
};

Game.pauseRound = function () {
  const r = Game.state.room && Game.state.room.round;
  if (!r || r.pausedAt || !Game.state.room.settings.pauseAllowed) return;
  r.pausedAt = Date.now();
  Game.persistRoom(true);
};

Game.resumeRound = function () {
  const r = Game.state.room && Game.state.room.round;
  if (!r || !r.pausedAt) return;
  r.pausedDuration += Date.now() - r.pausedAt;
  r.pausedAt = null;
  r.startedAt = r.startedAt; // unchanged
  Game.persistRoom(true);
};

/* ============================================================================
   AUTOSAVE: capture an answer being typed
   ============================================================================ */

Game.recordAnswer = function (catIdx, text) {
  const r = Game.state.room && Game.state.room.round;
  if (!r) return;

  // Update local cache (used to repaint inputs without losing state).
  Game.state.myAnswers[catIdx] = text;

  // Figure out which player slot this answer belongs to.
  // Multi-device: my own slot.
  // Same-device: whoever's turn it currently is.
  const playerId = Game.isSameDevice() ? r.currentTurnId : Game.state.myPlayerId;

  if (!r.answers[playerId]) r.answers[playerId] = {};
  r.answers[playerId][catIdx] = text;

  // Debounced write — don't hammer Firestore on every keystroke.
  Game.persistRoom();
};

/* ============================================================================
   SUBMIT (early)
   ============================================================================ */

Game.submitMyAnswers = function () {
  const r = Game.state.room && Game.state.room.round;
  if (!r) return;

  const playerId = Game.isSameDevice() ? r.currentTurnId : Game.state.myPlayerId;
  if (!r.submittedBy.includes(playerId)) r.submittedBy.push(playerId);

  // In same-device, advance turn to the next player or to judging.
  if (Game.isSameDevice()) {
    r.turnHandedOff = true;
    Game.persistRoom(true);
    // force=true so the round screen does a full re-render and shows the
    // hand-off layout instead of staying on the active-input view.
    Game.goto('round', true);
    return;
  }

  // Multi-device: if everyone has submitted, push to scoring.
  Game.persistRoom(true);
  maybeAdvanceToJudging();
};

Game.advanceSameDevice = function () {
  const room = Game.state.room;
  const r = room && room.round;
  if (!r || !r.turnHandedOff) return;

  // Find next player who hasn't submitted yet.
  const nextPlayer = room.players.find((p) => !r.submittedBy.includes(p.id));
  if (nextPlayer) {
    r.currentTurnId = nextPlayer.id;
    r.turnHandedOff = false;
    r.startedAt = Date.now();    // fresh timer for the next player
    r.pausedAt = null;
    r.pausedDuration = 0;
    Game.state.myAnswers = {};
    Game.persistRoom(true);
    // force=true so we morph back from hand-off layout to active-input layout.
    Game.goto('round', true);
  } else {
    // Nobody left — onward to judging.
    setupScoring();
  }
};

function maybeAdvanceToJudging() {
  const room = Game.state.room;
  const r = room && room.round;
  if (!r) return;
  const allSubmitted = room.players.every((p) => r.submittedBy.includes(p.id));
  if (allSubmitted) setupScoring();
}

function setupScoring() {
  const room = Game.state.room;
  const r = room.round;
  // Initialize a blank scoring object that judging.js will fill in.
  r.scoring = {
    decisions: {},        // per category: { winner, invalid:{playerId:bool}, dup:bool }
    finalScores: null,    // filled in when judging is finalized
  };
  releaseWakeLock();
  Game.persistRoom(true);
  Game.goto('judge');
}

/*
  Called every tick from the round screen — checks if the timer ran out and
  auto-submits if so.
*/
function checkTimerExpiry() {
  const r = Game.state.room && Game.state.room.round;
  if (!r) return false;
  if (r.scoring) return false;
  if (Game.remainingSeconds() > 0) return false;
  if (r.pausedAt) return false;

  // Timer expired. Auto-submit current player.
  const playerId = Game.isSameDevice() ? r.currentTurnId : Game.state.myPlayerId;
  if (!r.submittedBy.includes(playerId)) {
    r.submittedBy.push(playerId);
    Game.vibrate([100, 50, 200]);
    if (Game.isSameDevice()) {
      r.turnHandedOff = true;
      Game.persistRoom(true);
      Game.goto('round', true);
    } else {
      Game.persistRoom(true);
      maybeAdvanceToJudging();
    }
  }
  return true;
}

/* ============================================================================
   WAKE LOCK: keep the screen on during a round
   ============================================================================ */

let wakeLockHandle = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLockHandle = await navigator.wakeLock.request('screen');
    // If the user backgrounds the app, the wake lock is auto-released; we
    // re-acquire on visibility change.
    wakeLockHandle.addEventListener('release', () => { wakeLockHandle = null; });
  } catch (e) {
    // Permission denied or unsupported — ignore.
  }
}
function releaseWakeLock() {
  if (wakeLockHandle) { wakeLockHandle.release(); wakeLockHandle = null; }
}
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && Game.state.room && Game.state.room.round && !Game.state.room.round.scoring) {
    acquireWakeLock();
  }
});

/* ============================================================================
   AUDIO CUE: short beep using Web Audio API (no audio file needed)
   ============================================================================ */

let audioCtx = null;
function beep(freq = 660, durationMs = 150) {
  if (!Game.state.prefs.soundEnabled) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000 + 0.05);
  } catch (e) {}
}

/* ============================================================================
   THE ROUND SCREEN
   ============================================================================ */

let tickerHandle = null;
let lastBeepedSecond = -1;

Game.screens.round = {
  render() {
    const room = Game.state.room;
    const r = room && room.round;
    if (!r) {
      // Shouldn't happen, but return something safe.
      return `<div class="screen"><p>No active round.</p></div>`;
    }

    // Same-device hand-off screen.
    if (Game.isSameDevice() && r.turnHandedOff) {
      const next = room.players.find((p) => !r.submittedBy.includes(p.id));
      const isLast = !next;
      return `
        <div class="screen">
          <div class="card text-center" style="margin-top:40px; padding:32px;">
            ${isLast ? `
              <div style="font-size:48px;">📝</div>
              <h2 class="mt-16">Both done!</h2>
              <div class="text-dim mt-8">On to scoring.</div>
              <button class="btn btn-primary mt-16" data-action="advance">Score this round</button>
            ` : `
              <div style="font-size:48px;">📱</div>
              <h2 class="mt-16">Pass the phone</h2>
              <div class="text-dim mt-8">Hand it to <strong>${Game.esc(next.name)}</strong></div>
              <button class="btn btn-primary mt-16" data-action="advance">${Game.esc(next.name)} is ready</button>
            `}
          </div>
        </div>
      `;
    }

    // Active round screen.
    const sameDevice = Game.isSameDevice();
    const activePlayer = sameDevice
      ? room.players.find((p) => p.id === r.currentTurnId)
      : Game.me();
    const opponent = room.players.find((p) => p.id !== activePlayer.id);
    const myAnswers = sameDevice
      ? (r.answers[r.currentTurnId] || {})
      : (r.answers[Game.state.myPlayerId] || Game.state.myAnswers || {});

    return `
      <div class="screen">
        <div class="round-header">
          <div>
            <div class="round-letter">${Game.esc(r.letter)}</div>
          </div>
          <div class="round-meta">
            <div class="round-timer" id="timerDisplay">${Game.fmtTime(Game.remainingSeconds())}</div>
            <div class="round-info" id="opponentStatus">
              ${sameDevice
                ? `<strong>${Game.esc(activePlayer.name)}</strong>'s turn`
                : opponentStatusText(r, opponent)}
            </div>
          </div>
        </div>

        <div class="btn-row">
          ${room.settings.pauseAllowed ? `
            <button class="btn btn-small btn-ghost" id="pauseBtn">
              ${r.pausedAt ? '▶ Resume' : '⏸ Pause'}
            </button>
          ` : '<div class="spacer"></div>'}
          <button class="btn btn-small" id="submitBtn">
            ${sameDevice ? "✓ I'm done" : '✓ Submit early'}
          </button>
        </div>

        <div class="categories">
          ${r.categories.map((cat, idx) => `
            <div class="category">
              <div class="category-name">${idx + 1}. ${Game.esc(cat)}</div>
              <input class="category-input" type="text" autocomplete="off"
                     data-cat-idx="${idx}"
                     placeholder="Starts with ${Game.esc(r.letter)}…"
                     value="${Game.esc(myAnswers[idx] || '')}">
            </div>
          `).join('')}
        </div>

        <div class="text-small text-dim text-center mt-16">
          Answers save automatically.
        </div>
      </div>
    `;
  },

  mount() {
    const r = Game.state.room && Game.state.room.round;
    if (!r) return;

    if (Game.isSameDevice() && r.turnHandedOff) {
      document.querySelector('[data-action="advance"]').addEventListener('click', () => {
        // Either advance to the next player or set up scoring.
        const nextPlayer = Game.state.room.players.find((p) => !r.submittedBy.includes(p.id));
        if (nextPlayer) {
          Game.advanceSameDevice();
        } else {
          setupScoring();
        }
      });
      return;
    }

    // Wire up answer inputs. Each input fires `recordAnswer` on every keystroke.
    document.querySelectorAll('.category-input').forEach((input) => {
      input.addEventListener('input', (e) => {
        const idx = Number(e.target.dataset.catIdx);
        Game.recordAnswer(idx, e.target.value);
      });
    });

    const pauseBtn = document.getElementById('pauseBtn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (Game.state.room.round.pausedAt) Game.resumeRound();
        else Game.pauseRound();
        Game.goto('round', true);   // force full re-render to flip the button label
      });
    }

    document.getElementById('submitBtn').addEventListener('click', () => {
      if (!confirm('Submit your answers for this round?')) return;
      Game.submitMyAnswers();
    });

    startTicker();
  },

  // The round screen has its own tick loop that updates JUST the timer text
  // (so we don't re-render and lose typing focus). When the screen un-mounts,
  // the ticker is cleared in render() before swapping HTML — see startTicker.
  update() {
    // Called when state changes but we're still on this screen.
    // Update the opponent status without touching the inputs.
    const room = Game.state.room;
    const r = room && room.round;
    if (!r) return;
    if (Game.isSameDevice()) return;
    const opponent = room.players.find((p) => p.id !== Game.state.myPlayerId);
    const el = document.getElementById('opponentStatus');
    if (el) el.textContent = opponentStatusText(r, opponent);

    // If we just got into the scoring phase via the other player submitting,
    // navigate to judge.
    if (r.scoring) {
      Game.goto('judge');
    }
  },
};

function opponentStatusText(round, opponent) {
  if (!opponent) return '';
  if (round.submittedBy.includes(opponent.id)) return `${opponent.name}: ✓ submitted`;
  if (!opponent.online) return `${opponent.name}: away`;
  return `${opponent.name}: typing…`;
}

function startTicker() {
  if (tickerHandle) clearInterval(tickerHandle);
  lastBeepedSecond = -1;
  tickerHandle = setInterval(() => {
    const r = Game.state.room && Game.state.room.round;
    if (!r || r.scoring) {
      clearInterval(tickerHandle);
      tickerHandle = null;
      return;
    }
    const remaining = Game.remainingSeconds();
    const display = document.getElementById('timerDisplay');
    if (display) {
      display.textContent = Game.fmtTime(remaining);
      display.classList.toggle('warn', remaining <= 30 && remaining > 10);
      display.classList.toggle('danger', remaining <= 10);
    }
    // Audio cue every second from 10 to 1.
    if (remaining <= 10 && remaining >= 1 && remaining !== lastBeepedSecond && !r.pausedAt) {
      lastBeepedSecond = remaining;
      beep(remaining <= 3 ? 880 : 660, 100);
    }
    // Time's up.
    if (remaining === 0 && !r.pausedAt) {
      clearInterval(tickerHandle);
      tickerHandle = null;
      beep(440, 600);
      checkTimerExpiry();
    }
  }, 250);
}
