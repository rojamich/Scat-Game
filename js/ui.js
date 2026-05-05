/*
  js/ui.js
  --------
  The rendering layer. This file:
    - Owns the main render() function that picks the right screen and draws it.
    - Defines the "navigation" screens: home, join, lobby, history, settings.
    - Provides shared helpers: HTML escaping, time formatting, toasts, etc.

  The "round" and "judge/results" screens live in game.js and judging.js
  respectively because they each have a lot of associated logic.

  Rendering approach:
    Each screen has a render() function returning an HTML string. After we set
    innerHTML, an optional mount() function attaches event listeners. We keep
    things simple by re-rendering on most state changes — the app is small
    enough that performance isn't an issue.

    Exception: the round screen avoids re-rendering inputs while you're typing,
    because that would lose focus and clear what you typed. See game.js.
*/

window.Game = window.Game || {};

/* ============================================================================
   HELPERS
   ============================================================================ */

/*
  Escape a string for safe insertion into HTML. NEVER drop user-supplied text
  (names, answers) into HTML without going through this — otherwise someone
  could put `<script>` in their name and mess with the page.
*/
Game.esc = function (s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/* Format seconds as M:SS. */
Game.fmtTime = function (totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
};

/* Pretty-print a timestamp as "Today 2:14 PM" / "Yesterday 8:01 PM" / date. */
Game.fmtWhen = function (ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const wasYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (wasYesterday) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
};

/*
  Show a brief toast message at the bottom of the screen. Auto-dismisses.
*/
let toastTimer = null;
Game.toast = function (message, ms = 2400) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
};

/*
  Provide haptic feedback on supported devices. Wrapped so we can no-op if
  the user has disabled vibration in settings.
*/
Game.vibrate = function (pattern) {
  if (!Game.state.prefs.vibrationEnabled) return;
  if (navigator.vibrate) navigator.vibrate(pattern);
};

/*
  Quick helper to swap to a new screen and render.
  Pass `force=true` to bypass the "already on this screen, just call update()"
  optimization. Useful when the screen needs to morph between sub-views (e.g.
  the round screen swapping between active-input and hand-off layouts) so the
  DOM actually redraws.
*/
Game.goto = function (screen, force) {
  Game.state.screen = screen;
  if (force) {
    const app = document.getElementById('app');
    if (app) delete app.dataset.screen;
  }
  Game.render();
};

/* ============================================================================
   MAIN RENDER DISPATCHER
   ============================================================================ */

/*
  Each screen is registered in this map. We don't define them all here — round
  and judge get registered from their own files when those load.
*/
Game.screens = {};

Game.render = function () {
  // Apply theme class to <body>.
  document.body.classList.toggle('light-mode', !Game.state.prefs.darkMode);

  const app = document.getElementById('app');
  const screen = Game.state.screen;
  const def = Game.screens[screen];

  if (!def) {
    app.innerHTML = `<div class="screen"><p>Unknown screen: ${Game.esc(screen)}</p></div>`;
    return;
  }

  // If we're already on this screen and it has an `update` function, prefer
  // that over a full re-render — keeps inputs from losing focus.
  if (app.dataset.screen === screen && def.update) {
    def.update();
    return;
  }

  app.dataset.screen = screen;
  app.innerHTML = def.render();
  if (def.mount) def.mount();
};

/* ============================================================================
   HOME SCREEN
   ============================================================================ */

Game.screens.home = {
  render() {
    const lastRoom = Game.state.prefs.lastJoinedRoom;
    const hasFirebase = !!window.FIREBASE_CONFIG;

    return `
      <div class="screen">
        <div class="home-logo">
          <div class="home-logo-mark">S</div>
          <div class="home-logo-name">Scategories</div>
          <div class="home-logo-tag">Categories game for two</div>
        </div>

        ${lastRoom ? `
          <button class="btn btn-primary" data-action="rejoin">
            Rejoin room ${Game.esc(lastRoom.code)}
          </button>
          <div class="text-center text-dim text-small">— or —</div>
        ` : ''}

        ${hasFirebase ? `
          <button class="btn btn-primary" data-action="create">Create new room</button>
          <button class="btn" data-action="join">Join room</button>
          <div class="text-center text-dim text-small mt-8">— or —</div>
          <button class="btn btn-ghost" data-action="same-device">Play on this phone</button>
        ` : `
          <button class="btn btn-primary" data-action="same-device">Start a game</button>
          <div class="card mt-16">
            <div class="text-small text-dim">
              <strong>Two-phone mode is off.</strong><br>
              To play with each phone showing a separate hand, set up a free
              Firebase project — see <code>README.md</code>. Until then this
              works as a "pass the phone" game.
            </div>
          </div>
        `}

        <div class="spacer"></div>

        <div class="btn-row">
          <button class="btn btn-ghost btn-small" data-action="history">History</button>
          <button class="btn btn-ghost btn-small" data-action="settings">Settings</button>
        </div>
      </div>
    `;
  },

  mount() {
    document.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'rejoin') Game.rejoinLastRoom();
        else if (action === 'create') Game.goto('createName');
        else if (action === 'join') Game.goto('joinCode');
        else if (action === 'same-device') Game.goto('sameDeviceSetup');
        else if (action === 'history') Game.goto('history');
        else if (action === 'settings') Game.goto('settings');
      });
    });
  },
};

/* ============================================================================
   CREATE ROOM (multi-device): step 1 = enter name
   ============================================================================ */

Game.screens.createName = {
  render() {
    const name = Game.state.prefs.lastUsedName || '';
    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="back">‹</button>
          <h1>Create room</h1>
          <div style="width:40px"></div>
        </div>

        <div class="field">
          <label>Your name</label>
          <input class="input" id="nameInput" type="text" maxlength="20"
                 placeholder="e.g. Mike" value="${Game.esc(name)}" autocomplete="off">
        </div>

        <button class="btn btn-primary" data-action="create" id="createBtn">
          Create room
        </button>

        <div class="text-small text-dim text-center mt-16">
          You'll get a 4-letter code. Share it with your partner so they can join.
        </div>
      </div>
    `;
  },
  mount() {
    const nameInput = document.getElementById('nameInput');
    nameInput.focus();
    nameInput.addEventListener('input', () => {
      Game.state.prefs.lastUsedName = nameInput.value.trim();
      Game.savePrefs();
    });
    document.querySelector('[data-action="back"]').addEventListener('click', () => Game.goto('home'));
    document.getElementById('createBtn').addEventListener('click', async () => {
      const name = nameInput.value.trim() || 'Player 1';
      try {
        await Game.createRoom(name);
      } catch (err) {
        Game.toast('Could not create room. Check your connection.');
      }
    });
  },
};

/* ============================================================================
   JOIN ROOM (multi-device): step 1 = enter code + name
   ============================================================================ */

Game.screens.joinCode = {
  render() {
    const name = Game.state.prefs.lastUsedName || '';
    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="back">‹</button>
          <h1>Join room</h1>
          <div style="width:40px"></div>
        </div>

        <div class="field">
          <label>Room code</label>
          <input class="input" id="codeInput" type="text" maxlength="4"
                 placeholder="ABCD" autocomplete="off"
                 style="text-transform:uppercase; letter-spacing:6px; text-align:center; font-size:24px; font-family:'Courier New',monospace;">
        </div>

        <div class="field">
          <label>Your name</label>
          <input class="input" id="nameInput" type="text" maxlength="20"
                 placeholder="e.g. Sara" value="${Game.esc(name)}" autocomplete="off">
        </div>

        <button class="btn btn-primary" id="joinBtn">Join</button>
      </div>
    `;
  },
  mount() {
    const codeInput = document.getElementById('codeInput');
    const nameInput = document.getElementById('nameInput');
    codeInput.focus();

    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    });
    nameInput.addEventListener('input', () => {
      Game.state.prefs.lastUsedName = nameInput.value.trim();
      Game.savePrefs();
    });

    document.querySelector('[data-action="back"]').addEventListener('click', () => Game.goto('home'));
    document.getElementById('joinBtn').addEventListener('click', async () => {
      const code = codeInput.value.trim().toUpperCase();
      const name = nameInput.value.trim() || 'Player 2';
      if (code.length !== 4) { Game.toast('Room code is 4 letters.'); return; }
      try {
        await Game.joinRoom(code, name);
      } catch (err) {
        Game.toast(err.message || 'Could not join room.');
      }
    });
  },
};

/* ============================================================================
   SAME-DEVICE SETUP: enter both names
   ============================================================================ */

Game.screens.sameDeviceSetup = {
  render() {
    const n1 = Game.state.prefs.lastUsedName || '';
    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="back">‹</button>
          <h1>Same-phone game</h1>
          <div style="width:40px"></div>
        </div>

        <div class="card text-small text-dim mb-16">
          You'll take turns. The phone shows one player's answers at a time;
          when one is done they hand the phone over.
        </div>

        <div class="field">
          <label>Player 1 name</label>
          <input class="input" id="p1" type="text" maxlength="20"
                 placeholder="e.g. Mike" value="${Game.esc(n1)}" autocomplete="off">
        </div>

        <div class="field">
          <label>Player 2 name</label>
          <input class="input" id="p2" type="text" maxlength="20"
                 placeholder="e.g. Sara" autocomplete="off">
        </div>

        <button class="btn btn-primary" id="goBtn">Continue</button>
      </div>
    `;
  },
  mount() {
    document.querySelector('[data-action="back"]').addEventListener('click', () => Game.goto('home'));
    document.getElementById('goBtn').addEventListener('click', () => {
      const n1 = document.getElementById('p1').value.trim() || 'Player 1';
      const n2 = document.getElementById('p2').value.trim() || 'Player 2';
      Game.state.prefs.lastUsedName = n1;
      Game.savePrefs();
      Game.createSameDeviceRoom(n1, n2);
    });
  },
};

/* ============================================================================
   LOBBY: room code, players, "Start round"
   ============================================================================ */

Game.screens.lobby = {
  render() {
    const r = Game.state.room;
    if (!r) return '';
    const sameDevice = Game.isSameDevice();
    const shareUrl = sameDevice
      ? null
      : `${location.origin}${location.pathname}#${r.code}`;
    const enoughPlayers = r.players.length >= 2;

    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="leave">‹</button>
          <h1>Lobby</h1>
          <button class="btn btn-icon" data-action="settings">⚙</button>
        </div>

        ${sameDevice ? `
          <div class="card text-center">
            <div class="text-small text-dim">Same-phone mode</div>
            <div class="text-bold mt-8">${Game.esc(r.players[0].name)} vs ${Game.esc(r.players[1].name)}</div>
          </div>
        ` : `
          <div>
            <label class="text-center" style="text-align:center; display:block;">Room code</label>
            <div class="room-code">${Game.esc(r.code)}</div>
            <button class="btn btn-small btn-ghost mt-8" id="copyLinkBtn" style="width:100%;">
              Copy invite link
            </button>
          </div>
        `}

        <div>
          <label>Players (${r.players.length})</label>
          <div class="players-list">
            ${r.players.map((p) => {
              // Who can edit this name?
              //   - Same-device: I host both players, so I can edit either.
              //   - Multi-device: only my own row.
              const canEdit = sameDevice || p.id === Game.state.myPlayerId;
              return `
                <div class="player-row">
                  <span class="player-name ${p.id === Game.state.myPlayerId ? 'you' : ''}">${Game.esc(p.name)}</span>
                  <span style="display:flex; gap:8px; align-items:center;">
                    ${canEdit ? `
                      <button class="btn btn-icon btn-small" data-edit-name="${Game.esc(p.id)}"
                              title="Rename" style="width:32px; height:32px; min-height:32px; font-size:14px;">✎</button>
                    ` : ''}
                    <span class="player-status ${p.online ? 'ready' : ''}">${p.online ? 'Online' : 'Offline'}</span>
                  </span>
                </div>
              `;
            }).join('')}
            ${!sameDevice && r.players.length < 2 ? `
              <div class="player-row text-dim">
                <span class="player-name">Waiting for partner…</span>
                <span class="player-status">Share the code</span>
              </div>
            ` : ''}
          </div>
        </div>

        <div class="card">
          <div class="text-small text-dim">Round settings</div>
          <div class="mt-8" style="display:flex; justify-content:space-between;">
            <span>Timer</span>
            <span class="text-bold">${Game.fmtTime(r.settings.roundDuration)}</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span>Categories per round</span>
            <span class="text-bold">${r.settings.categoryCount}</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span>Skip Q, X, Z</span>
            <span class="text-bold">${r.settings.skipQXZ ? 'Yes' : 'No'}</span>
          </div>
          <button class="btn btn-small btn-ghost mt-8" data-action="roomSettings" style="width:100%;">
            Adjust round settings
          </button>
        </div>

        <div class="spacer"></div>

        <button class="btn btn-primary" id="startBtn" ${!enoughPlayers ? 'disabled' : ''}>
          ${enoughPlayers ? 'Start round' : 'Need 2 players'}
        </button>

        ${r.history && r.history.length > 0 ? `
          <div class="card text-center text-small">
            <div class="text-dim">Cumulative score</div>
            <div class="mt-8" style="display:flex; justify-content:space-around;">
              ${r.players.map((p) => `
                <div>
                  <div class="text-bold">${Game.esc(p.name)}</div>
                  <div style="font-size:24px; color:var(--accent);">${r.cumulativeScores[p.id] || 0}</div>
                </div>
              `).join('')}
            </div>
            <button class="btn btn-small btn-ghost mt-8" data-action="history">View ${r.history.length} past round${r.history.length === 1 ? '' : 's'}</button>
          </div>
        ` : ''}
      </div>
    `;
  },
  mount() {
    document.querySelector('[data-action="leave"]').addEventListener('click', () => {
      if (confirm('Leave this room? You can rejoin from the home screen.')) {
        Game.leaveRoom();
      }
    });
    document.querySelector('[data-action="settings"]').addEventListener('click', () => Game.goto('settings'));
    const copyBtn = document.getElementById('copyLinkBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const url = `${location.origin}${location.pathname}#${Game.state.room.code}`;
        try {
          await navigator.clipboard.writeText(url);
          Game.toast('Link copied!');
        } catch (e) {
          Game.toast(`Code: ${Game.state.room.code}`);
        }
      });
    }
    const settingsBtn = document.querySelector('[data-action="roomSettings"]');
    if (settingsBtn) settingsBtn.addEventListener('click', () => Game.goto('roomSettings'));
    const histBtn = document.querySelector('[data-action="history"]');
    if (histBtn) histBtn.addEventListener('click', () => Game.goto('history'));
    const startBtn = document.getElementById('startBtn');
    if (startBtn && !startBtn.disabled) {
      startBtn.addEventListener('click', () => Game.startRound());
    }

    // Rename buttons. We use a `prompt()` for simplicity — it works on every
    // browser. If you ever want a fancier modal, replace this block.
    document.querySelectorAll('[data-edit-name]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.editName;
        const room = Game.state.room;
        const player = room.players.find((p) => p.id === pid);
        if (!player) return;
        const newName = prompt('New name:', player.name);
        if (newName == null) return;            // cancelled
        const trimmed = newName.trim().slice(0, 20);
        if (!trimmed || trimmed === player.name) return;
        player.name = trimmed;
        // Also update lastUsedName if it was your own name, so creating new
        // rooms later remembers the change.
        if (pid === Game.state.myPlayerId) {
          Game.state.prefs.lastUsedName = trimmed;
          Game.savePrefs();
        }
        Game.persistRoom(true);
        Game.render();
      });
    });
  },
};

/* ============================================================================
   ROOM SETTINGS (per-game): timer, count, packs, skip QXZ
   ============================================================================ */

Game.screens.roomSettings = {
  render() {
    const r = Game.state.room;
    if (!r) return '';
    const isHost = Game.isHost();
    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="back">‹</button>
          <h1>Round settings</h1>
          <div style="width:40px"></div>
        </div>

        ${!isHost ? `
          <div class="card text-small text-dim">
            Only the host can change these. (You can change your personal
            preferences in Settings.)
          </div>
        ` : ''}

        <div class="field">
          <label>Timer (seconds)</label>
          <select class="select" id="timerSel" ${!isHost ? 'disabled' : ''}>
            ${[60, 90, 120, 150, 180, 240, 300].map((s) => `
              <option value="${s}" ${s === r.settings.roundDuration ? 'selected' : ''}>
                ${Game.fmtTime(s)}
              </option>
            `).join('')}
          </select>
        </div>

        <div class="field">
          <label>Categories per round</label>
          <select class="select" id="countSel" ${!isHost ? 'disabled' : ''}>
            ${[6, 8, 10, 12, 15, 18].map((n) => `
              <option value="${n}" ${n === r.settings.categoryCount ? 'selected' : ''}>${n}</option>
            `).join('')}
          </select>
        </div>

        <div class="toggle ${r.settings.skipQXZ ? 'on' : ''}" id="skipToggle">
          <span class="toggle-label">Skip Q, X, Z<br><span class="text-small text-dim">Common house rule</span></span>
          <span class="toggle-switch"></span>
        </div>

        <div class="toggle ${r.settings.pauseAllowed ? 'on' : ''} mt-8" id="pauseToggle">
          <span class="toggle-label">Allow pausing the timer</span>
          <span class="toggle-switch"></span>
        </div>

        <div class="mt-16">
          <label>Category packs</label>
          <div style="display:flex; flex-direction:column; gap:6px;">
            ${Game.CATEGORY_TAGS.map((tag) => {
              const on = r.settings.packs.includes(tag.id);
              return `
                <div class="toggle ${on ? 'on' : ''}" data-pack="${tag.id}">
                  <span class="toggle-label">${Game.esc(tag.label)}
                    ${tag.hint ? `<br><span class="text-small text-dim">${Game.esc(tag.hint)}</span>` : ''}
                  </span>
                  <span class="toggle-switch"></span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  },
  mount() {
    document.querySelector('[data-action="back"]').addEventListener('click', () => Game.goto('lobby'));

    if (!Game.isHost()) return; // listeners only matter for the host

    const r = Game.state.room;
    document.getElementById('timerSel').addEventListener('change', (e) => {
      r.settings.roundDuration = Number(e.target.value);
      Game.persistRoom();
    });
    document.getElementById('countSel').addEventListener('change', (e) => {
      r.settings.categoryCount = Number(e.target.value);
      Game.persistRoom();
    });
    document.getElementById('skipToggle').addEventListener('click', () => {
      r.settings.skipQXZ = !r.settings.skipQXZ;
      Game.persistRoom();
      Game.render();
    });
    document.getElementById('pauseToggle').addEventListener('click', () => {
      r.settings.pauseAllowed = !r.settings.pauseAllowed;
      Game.persistRoom();
      Game.render();
    });
    document.querySelectorAll('[data-pack]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.pack;
        const idx = r.settings.packs.indexOf(id);
        if (idx >= 0) r.settings.packs.splice(idx, 1);
        else r.settings.packs.push(id);
        Game.persistRoom();
        Game.render();
      });
    });
  },
};

/* ============================================================================
   SETTINGS (personal preferences, saved per device)
   ============================================================================ */

Game.screens.settings = {
  render() {
    const p = Game.state.prefs;
    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="back">‹</button>
          <h1>Settings</h1>
          <div style="width:40px"></div>
        </div>

        <div class="toggle ${p.darkMode ? 'on' : ''}" id="darkToggle">
          <span class="toggle-label">Dark mode</span>
          <span class="toggle-switch"></span>
        </div>

        <div class="toggle ${p.soundEnabled ? 'on' : ''}" id="soundToggle">
          <span class="toggle-label">Sound on timer warning</span>
          <span class="toggle-switch"></span>
        </div>

        <div class="toggle ${p.vibrationEnabled ? 'on' : ''}" id="vibToggle">
          <span class="toggle-label">Vibration on timer warning</span>
          <span class="toggle-switch"></span>
        </div>

        <div class="card mt-16">
          <div class="text-bold mb-8">Custom categories</div>
          <div class="text-small text-dim mb-8">
            Add your own categories — they get mixed into every round you host.
            Examples: "A Star Wars character", "Something at our wedding".
          </div>

          <div style="display:flex; gap:6px;">
            <input class="input" id="customInput" type="text" maxlength="60"
                   placeholder="A type of …" autocomplete="off" style="flex:1;">
            <button class="btn btn-primary btn-small" id="customAddBtn">Add</button>
          </div>

          <div id="customList" class="mt-8" style="display:flex; flex-direction:column; gap:6px;">
            ${(p.customCategories || []).length === 0 ? `
              <div class="text-small text-dim text-center mt-8">No custom categories yet.</div>
            ` : (p.customCategories || []).map((text, i) => `
              <div class="player-row">
                <span style="flex:1; padding-right:8px;">${Game.esc(text)}</span>
                <button class="btn btn-small btn-ghost" data-custom-del="${i}">Delete</button>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card text-small text-dim mt-16">
          Your name and Player ID are saved on this device only.
          <div class="mt-8">Player ID: <code>${Game.esc(Game.state.myPlayerId)}</code></div>
          ${window.FIREBASE_CONFIG
            ? `<div class="mt-8">Multi-device sync: <strong style="color:var(--good);">configured</strong></div>`
            : `<div class="mt-8">Multi-device sync: <strong style="color:var(--warn);">not configured (see README)</strong></div>`}
        </div>

        <div class="mt-16">
          <button class="btn btn-ghost btn-small" id="resetIdBtn" style="width:100%;">
            Generate new Player ID
          </button>
          <div class="text-small text-dim text-center mt-8">
            Use this if you keep getting marked "online" for a partner who has left.
          </div>
        </div>
      </div>
    `;
  },
  mount() {
    document.querySelector('[data-action="back"]').addEventListener('click', () => {
      // Go back to lobby if we're in a room, otherwise home.
      Game.goto(Game.state.room ? 'lobby' : 'home');
    });

    const toggle = (id, key) => {
      document.getElementById(id).addEventListener('click', () => {
        Game.state.prefs[key] = !Game.state.prefs[key];
        Game.savePrefs();
        Game.render();
      });
    };
    toggle('darkToggle', 'darkMode');
    toggle('soundToggle', 'soundEnabled');
    toggle('vibToggle', 'vibrationEnabled');

    document.getElementById('resetIdBtn').addEventListener('click', () => {
      if (!confirm('Generate a fresh Player ID? You will leave any current room.')) return;
      Game.lsRemove('myPlayerId');
      Game.lsRemove('prefs');
      location.reload();
    });

    // Custom categories: add + delete
    const addCustom = () => {
      const input = document.getElementById('customInput');
      const text = input.value.trim();
      if (!text) return;
      // Don't allow duplicates of either the master bank or existing customs.
      const existing = (Game.state.prefs.customCategories || []).map((s) => s.toLowerCase());
      if (existing.includes(text.toLowerCase())) {
        Game.toast('Already added.');
        return;
      }
      if (Game.CATEGORIES.some((c) => c.text.toLowerCase() === text.toLowerCase())) {
        Game.toast('That one is already in the bank.');
        return;
      }
      Game.state.prefs.customCategories = (Game.state.prefs.customCategories || []).concat(text);
      Game.savePrefs();
      Game.render();
    };

    document.getElementById('customAddBtn').addEventListener('click', addCustom);
    document.getElementById('customInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addCustom();
    });

    document.querySelectorAll('[data-custom-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.customDel);
        const list = (Game.state.prefs.customCategories || []).slice();
        list.splice(i, 1);
        Game.state.prefs.customCategories = list;
        Game.savePrefs();
        Game.render();
      });
    });
  },
};

/* ============================================================================
   HISTORY: list of past rounds in the current room
   ============================================================================ */

Game.screens.history = {
  render() {
    const r = Game.state.room;
    const rounds = (r && r.history) || [];

    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="back">‹</button>
          <h1>Round history</h1>
          <div style="width:40px"></div>
        </div>

        ${rounds.length === 0 ? `
          <div class="card text-center text-dim">
            No completed rounds yet. Once you finish one it'll show up here.
          </div>
        ` : `
          ${rounds.slice().reverse().map((round, idx) => {
            const realIdx = rounds.length - 1 - idx;
            const scoresLine = r.players.map((p) => {
              const score = (round.scores && round.scores[p.id]) || 0;
              return `${Game.esc(p.name)} ${score}`;
            }).join(' · ');
            return `
              <div class="history-row" data-idx="${realIdx}">
                <div class="history-row-letter">${Game.esc(round.letter)}</div>
                <div class="history-row-meta">
                  <div class="text-bold">Round ${round.number}</div>
                  <div class="history-row-date">${Game.fmtWhen(round.completedAt)}</div>
                </div>
                <div class="history-row-score">${scoresLine}</div>
              </div>
            `;
          }).join('')}
        `}
      </div>
    `;
  },
  mount() {
    document.querySelector('[data-action="back"]').addEventListener('click', () => {
      Game.goto(Game.state.room ? 'lobby' : 'home');
    });
    document.querySelectorAll('[data-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.idx);
        Game.viewHistoryRound(idx);
      });
    });
  },
};
