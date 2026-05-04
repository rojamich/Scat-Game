/*
  js/app.js
  ---------
  The entry point. This file runs last (after all the other scripts have
  defined their stuff onto `Game`), and:

    1. Initializes Firebase if it's configured.
    2. Looks at the URL hash for a room code (so an invite link like
       `https://your.app/#ABCD` jumps straight to the join screen).
    3. Renders the initial screen.
    4. Sets up a couple of small global niceties (back gesture, install prompt).

  Everything else is reactive: state changes call `Game.render()`, which
  re-paints. There's no other lifecycle to worry about.
*/

(function () {
  // Wait for the DOM to be ready so #app exists.
  function init() {
    Game.initSync();

    // Deep-link: if the URL hash is a 4-letter code, jump to the join screen
    // with the code prefilled.
    const hash = (location.hash || '').replace(/^#/, '').toUpperCase();
    if (/^[A-Z]{4}$/.test(hash) && window.FIREBASE_CONFIG) {
      Game.state.screen = 'joinCode';
      Game.render();
      // Prefill the code after render mounts.
      setTimeout(() => {
        const codeInput = document.getElementById('codeInput');
        if (codeInput) {
          codeInput.value = hash;
          const nameInput = document.getElementById('nameInput');
          if (nameInput) nameInput.focus();
        }
      }, 50);
      return;
    }

    Game.render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Browser back button: if we're inside something (lobby, settings, etc.) take
  // the user up one level rather than navigating away from the app.
  window.addEventListener('popstate', () => {
    const screen = Game.state.screen;
    if (screen === 'home') return; // let the browser navigate away
    if (screen === 'lobby') {
      // Back from lobby = leave room and go home.
      if (confirm('Leave this room?')) Game.leaveRoom();
      else history.pushState({}, ''); // re-push so they don't actually navigate
      return;
    }
    // Otherwise pop back to a sensible parent.
    if (Game.state.room) Game.goto('lobby');
    else Game.goto('home');
    history.pushState({}, '');
  });

  // Push an initial history entry so the back gesture has something to handle.
  history.pushState({}, '');

  /* ----------------------------------------------------------------------
     PWA install prompt: capture and stash the event so we can offer "Add to
     Home Screen" at a moment that makes sense (after their first round). For
     simplicity we just expose it as a window function — you can call
     `Game.promptInstall()` from the console or hook a button to it later.
     -------------------------------------------------------------------- */
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
  Game.promptInstall = function () {
    if (!deferredInstallPrompt) {
      Game.toast('Install prompt not available on this browser.');
      return;
    }
    deferredInstallPrompt.prompt();
    deferredInstallPrompt = null;
  };
})();
