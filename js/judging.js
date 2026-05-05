/*
  js/judging.js
  -------------
  The judging and results screens.

  Once a round ends, both players' answers are compared per category. We:
    - auto-mark blanks
    - auto-mark answers that don't start with the round's letter as INVALID
    - auto-mark identical answers as DUPLICATE (Scategories tradition: matching
      answers cancel out)
    - figure out an automatic winner where the rules unambiguously give one
      (e.g. one answer present + valid vs blank → present wins)
    - leave the rest for human override (tap an answer to flip it winner)
    - generate a copy-paste prompt for ChatGPT / Claude / etc. when neither
      player wants to argue about which is better

  Scoring:
    - Winner of a category = 1 point
    - Both win (tied judgment, both valid) = 1 point each
    - Duplicate = 0 each (Scategories rule)
    - Both blank = 0 each
    - Invalid still beats a blank (per the user's house rule). So an "invalid"
      answer next to a blank → invalid one wins (1pt).

  Public functions:
    - Game.toggleAnswerWinner(catIdx, playerId)
    - Game.toggleAnswerInvalid(catIdx, playerId)
    - Game.copyChatbotPrompt()
    - Game.finalizeScores()
    - Game.startNextRound()
    - Game.viewHistoryRound(idx)
*/

window.Game = window.Game || {};

/* ============================================================================
   PER-CATEGORY DECISION HELPERS
   ============================================================================ */

/*
  Read the decision object for a given category, creating an empty one if
  needed. The decision shape is:
    { winners: { [playerId]: bool }, invalid: { [playerId]: bool }, duplicate: bool }
*/
function getDecision(catIdx) {
  const r = Game.state.room.round;
  if (!r.scoring.decisions[catIdx]) {
    r.scoring.decisions[catIdx] = { winners: {}, invalid: {}, duplicate: false };
  }
  return r.scoring.decisions[catIdx];
}

/*
  Return the cleaned-up answer text for a player+category, or '' if blank.
  We trim whitespace and lowercase for comparison purposes.
*/
function getAnswer(playerId, catIdx) {
  const r = Game.state.room.round;
  const a = r.answers[playerId];
  return a && a[catIdx] ? String(a[catIdx]).trim() : '';
}

/*
  Auto-classify a single answer relative to the round's letter.
  Returns 'blank' | 'invalid' | 'valid'.
*/
function classifyAnswer(text, letter) {
  if (!text) return 'blank';
  // First word's first letter — ignore quotes and articles like "A " / "The "
  const stripped = text.trim().replace(/^["'`]+/, '');
  const lowered = stripped.toLowerCase();
  // Allow "A " and "The " prefixes to match on the next word.
  let token = lowered;
  if (lowered.startsWith('the ')) token = lowered.slice(4);
  else if (lowered.startsWith('a ')) token = lowered.slice(2);
  else if (lowered.startsWith('an ')) token = lowered.slice(3);

  if (token[0] && token[0].toUpperCase() === letter.toUpperCase()) return 'valid';
  return 'invalid';
}

/*
  Run the auto-classification across all categories, populating `invalid` and
  `duplicate` flags. Called when the judge screen first opens.
*/
function autoClassify() {
  const r = Game.state.room.round;
  const players = Game.state.room.players;
  r.categories.forEach((_, catIdx) => {
    const dec = getDecision(catIdx);

    // Per-player invalid check.
    players.forEach((p) => {
      const text = getAnswer(p.id, catIdx);
      const cls = classifyAnswer(text, r.letter);
      // Only set if not already manually overridden — but since auto runs
      // once on entry, this is essentially the initial state.
      dec.invalid[p.id] = cls === 'invalid';
    });

    // Duplicate check (only meaningful with 2+ filled answers).
    const texts = players.map((p) => getAnswer(p.id, catIdx).toLowerCase()).filter(Boolean);
    dec.duplicate = texts.length >= 2 && new Set(texts).size === 1;
  });
}

/*
  For each category, derive the auto-winner based on the rules. This runs
  before tally, after the user has had a chance to override.

  Rules:
    - duplicate → nobody (0/0)
    - both blank → nobody
    - one blank, other not → the non-blank wins (invalid still beats blank)
    - both non-blank, both invalid → nobody (unless user manually picked)
    - both non-blank, one invalid → the valid one wins
    - both non-blank, both valid → tied unless user manually picked
*/
function autoDeriveWinners() {
  const r = Game.state.room.round;
  const players = Game.state.room.players;

  r.categories.forEach((_, catIdx) => {
    const dec = getDecision(catIdx);

    // If the user has explicitly picked any winner, respect that — don't auto.
    const someoneManuallyPicked = Object.values(dec.winners).some(Boolean);
    if (someoneManuallyPicked) return;

    if (dec.duplicate) {
      players.forEach((p) => { dec.winners[p.id] = false; });
      return;
    }

    const filled = players.filter((p) => getAnswer(p.id, catIdx) !== '');
    if (filled.length === 0) {
      players.forEach((p) => { dec.winners[p.id] = false; });
      return;
    }

    if (filled.length === 1) {
      players.forEach((p) => { dec.winners[p.id] = (p === filled[0]); });
      return;
    }

    // Two or more filled.
    const validPlayers = filled.filter((p) => !dec.invalid[p.id]);
    if (validPlayers.length === 0) {
      // All invalid. Leave for manual judgment (chatbot prompt will help).
      players.forEach((p) => { dec.winners[p.id] = false; });
      return;
    }
    if (validPlayers.length === 1) {
      players.forEach((p) => { dec.winners[p.id] = (p === validPlayers[0]); });
      return;
    }
    // Multiple filled-and-valid answers — DON'T auto-pick a tie. The user
    // wants a single winner per category, so the chatbot (or them) decides.
    // Leave winners blank so they have to tap one.
    players.forEach((p) => { dec.winners[p.id] = false; });
  });
}

/* ============================================================================
   USER ACTIONS: toggle winner / invalid
   ============================================================================ */

Game.toggleAnswerWinner = function (catIdx, playerId) {
  const dec = getDecision(catIdx);
  const wasWinner = !!dec.winners[playerId];

  // Build a per-field update for Firestore. Single-winner rule: clear all
  // players for this category, then set the new one if we weren't toggling
  // an already-winner off.
  //
  // Using updateRoomFields (per-field) instead of persistRoom (whole-doc)
  // means concurrent taps from two phones on different categories can BOTH
  // succeed — neither player's pick clobbers the other's.
  const updates = {};
  const allPlayerIds = Game.state.room.players.map((p) => p.id);
  allPlayerIds.forEach((pid) => {
    updates[`round.scoring.decisions.${catIdx}.winners.${pid}`] = false;
  });
  if (!wasWinner) {
    updates[`round.scoring.decisions.${catIdx}.winners.${playerId}`] = true;
  }
  Game.updateRoomFields(updates);
  Game.render();
};

Game.toggleAnswerInvalid = function (catIdx, playerId) {
  const dec = getDecision(catIdx);
  const newInvalid = !dec.invalid[playerId];
  const updates = {
    [`round.scoring.decisions.${catIdx}.invalid.${playerId}`]: newInvalid,
  };
  // If we just marked invalid, also clear that player's winner flag.
  if (newInvalid) {
    updates[`round.scoring.decisions.${catIdx}.winners.${playerId}`] = false;
  }
  Game.updateRoomFields(updates);
  Game.render();
};

/* ============================================================================
   COPY CHATBOT PROMPT
   ============================================================================ */

Game.buildChatbotPrompt = function () {
  const r = Game.state.room.round;
  const players = Game.state.room.players;
  const lines = [];

  lines.push(`You are judging a Scategories round.`);
  lines.push(`The letter is: ${r.letter}`);
  lines.push('');
  lines.push(`Players: ${players.map((p) => p.name).join(' and ')}`);
  lines.push('');
  lines.push(`For each numbered category, pick the WINNER (one player's name, "TIE", or "NONE" if nothing fits) and give a one-line reason.`);
  lines.push(`Rules:`);
  lines.push(`- An answer must start with "${r.letter}" (ignore "A", "An", "The" prefixes).`);
  lines.push(`- An invalid answer still beats a blank one.`);
  lines.push(`- Identical answers cancel out — winner is "NONE".`);
  lines.push(`- If you can't decide between two valid answers, "TIE" gives both a point.`);
  lines.push(`- Be lenient: creative interpretations of a category are fine.`);
  lines.push('');
  lines.push(`Format your reply as:`);
  lines.push(`1. WINNER: [name|TIE|NONE] — [reason]`);
  lines.push('');
  lines.push(`---`);
  lines.push('');
  r.categories.forEach((cat, idx) => {
    lines.push(`${idx + 1}. ${cat}`);
    players.forEach((p) => {
      const ans = getAnswer(p.id, idx) || '(blank)';
      lines.push(`   ${p.name}: ${ans}`);
    });
    lines.push('');
  });
  return lines.join('\n');
};

Game.copyChatbotPrompt = async function () {
  const text = Game.buildChatbotPrompt();
  try {
    await navigator.clipboard.writeText(text);
    Game.toast('Prompt copied — paste into ChatGPT/Claude!');
  } catch (e) {
    Game.toast('Could not copy automatically — long-press the textarea.');
  }
};

/* ============================================================================
   FINALIZE SCORES
   ============================================================================ */

Game.finalizeScores = function () {
  const room = Game.state.room;
  const r = room.round;

  autoDeriveWinners();   // last chance for the auto-rules to fill in any blanks

  // Tally: 1 point per category where a player's `winners[playerId]` is true.
  const finalScores = {};
  room.players.forEach((p) => { finalScores[p.id] = 0; });

  r.categories.forEach((_, catIdx) => {
    const dec = getDecision(catIdx);
    Object.keys(dec.winners).forEach((pid) => {
      if (dec.winners[pid]) finalScores[pid] = (finalScores[pid] || 0) + 1;
    });
  });

  r.scoring.finalScores = finalScores;

  // Update cumulative scores on the room.
  Object.keys(finalScores).forEach((pid) => {
    room.cumulativeScores[pid] = (room.cumulativeScores[pid] || 0) + finalScores[pid];
  });

  // Mark these letters / categories as "recently used" so future rounds avoid them.
  room.recentLetters = (room.recentLetters || []).concat(r.letter).slice(-12);
  room.recentCategoryTexts = (room.recentCategoryTexts || []).concat(r.categories).slice(-60);

  Game.persistRoom(true);
  Game.goto('results');
};

/* ============================================================================
   START NEXT ROUND (rematch button)
   ============================================================================ */

Game.startNextRound = function () {
  const room = Game.state.room;
  if (!room || !room.round || !room.round.scoring || !room.round.scoring.finalScores) {
    Game.toast('Finish the current round first.');
    return;
  }
  // Push the completed round into history before starting a new one.
  room.history = room.history || [];
  room.history.push({
    number: room.round.number,
    letter: room.round.letter,
    categories: room.round.categories,
    answers: room.round.answers,
    scores: room.round.scoring.finalScores,
    decisions: room.round.scoring.decisions,
    completedAt: Date.now(),
  });
  room.round = null;
  Game.persistRoom(true);
  // Clear any submitter-side answers now that the round is closed.
  Game.state.myAnswers = {};
  Game.startRound();
};

Game.endGameAndArchive = function () {
  // Same as startNextRound but doesn't kick off a new one.
  const room = Game.state.room;
  if (room && room.round && room.round.scoring && room.round.scoring.finalScores) {
    room.history = room.history || [];
    room.history.push({
      number: room.round.number,
      letter: room.round.letter,
      categories: room.round.categories,
      answers: room.round.answers,
      scores: room.round.scoring.finalScores,
      decisions: room.round.scoring.decisions,
      completedAt: Date.now(),
    });
    room.round = null;
    Game.persistRoom(true);
  }
  Game.goto('lobby');
};

/* ============================================================================
   THE JUDGE SCREEN
   ============================================================================ */

Game.screens.judge = {
  render() {
    const room = Game.state.room;
    const r = room && room.round;
    if (!r || !r.scoring) {
      return `<div class="screen"><p>No active scoring.</p></div>`;
    }

    // Make sure auto-classification has run at least once.
    if (Object.keys(r.scoring.decisions).length === 0) {
      autoClassify();
      autoDeriveWinners();
      Game.persistRoom();
    }

    const players = room.players;

    return `
      <div class="screen">
        <div class="header">
          <h1>Score round ${r.number}</h1>
          <div class="header-actions">
            <button class="btn btn-icon" data-action="toggle-prompt">📋</button>
          </div>
        </div>

        <div class="card text-center">
          <div class="text-small text-dim">Letter</div>
          <div class="round-letter" style="display:inline-block;">${Game.esc(r.letter)}</div>
        </div>

        <div class="card text-small text-dim" id="promptHelp" style="display:none;">
          Tap 📋 to copy a prompt for ChatGPT / Claude. Paste their response and
          tap an answer below to mark winners.
          <textarea class="prompt-area mt-8" readonly id="promptArea">${Game.esc(Game.buildChatbotPrompt())}</textarea>
          <button class="btn btn-small btn-primary mt-8" data-action="copy-prompt" style="width:100%;">
            Copy to clipboard
          </button>
        </div>

        <div class="text-small text-dim text-center">
          Tap an answer to toggle winner. Long-press to mark invalid.<br>
          Green = winner. Strikethrough = invalid. Yellow border = duplicate.
        </div>

        <div class="mt-8">
          ${r.categories.map((cat, catIdx) => {
            const dec = getDecision(catIdx);
            return `
              <div class="judge-row">
                <div class="judge-category">${catIdx + 1}. ${Game.esc(cat)}</div>
                <div class="judge-answers">
                  ${players.map((p) => {
                    const ans = getAnswer(p.id, catIdx);
                    const isWinner = !!dec.winners[p.id];
                    const isInvalid = !!dec.invalid[p.id];
                    const isEmpty = !ans;
                    const isDup = !!dec.duplicate && !isEmpty;
                    const classes = [
                      'judge-answer',
                      isWinner ? 'winner' : '',
                      isInvalid ? 'invalid' : '',
                      isEmpty ? 'empty' : '',
                      isDup ? 'duplicate' : '',
                    ].filter(Boolean).join(' ');
                    const tag = isWinner ? '✓' : isDup ? '=' : isInvalid ? '✗' : '';
                    return `
                      <div class="${classes}"
                           data-cat="${catIdx}" data-pid="${Game.esc(p.id)}">
                        <div class="judge-answer-name">${Game.esc(p.name)}</div>
                        <div class="judge-answer-text">${Game.esc(ans || '(blank)')}</div>
                        ${tag ? `<div class="judge-answer-tag">${tag}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <div class="spacer"></div>

        <button class="btn btn-primary" data-action="finalize">Tally scores</button>
      </div>
    `;
  },

  mount() {
    document.querySelector('[data-action="toggle-prompt"]').addEventListener('click', () => {
      const el = document.getElementById('promptHelp');
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    });
    const copyBtn = document.querySelector('[data-action="copy-prompt"]');
    if (copyBtn) copyBtn.addEventListener('click', () => Game.copyChatbotPrompt());

    document.querySelector('[data-action="finalize"]').addEventListener('click', () => {
      Game.finalizeScores();
    });

    // Tap = toggle winner. Long-press = toggle invalid.
    document.querySelectorAll('.judge-answer').forEach((el) => {
      let pressTimer = null;
      let longPressed = false;
      const catIdx = Number(el.dataset.cat);
      const pid = el.dataset.pid;

      el.addEventListener('pointerdown', () => {
        longPressed = false;
        pressTimer = setTimeout(() => {
          longPressed = true;
          Game.toggleAnswerInvalid(catIdx, pid);
          Game.vibrate(30);
        }, 500);
      });
      const cancel = () => { clearTimeout(pressTimer); };
      el.addEventListener('pointerup', () => {
        clearTimeout(pressTimer);
        if (!longPressed) Game.toggleAnswerWinner(catIdx, pid);
      });
      el.addEventListener('pointerleave', cancel);
      el.addEventListener('pointercancel', cancel);
    });
  },
};

/* ============================================================================
   RESULTS SCREEN: shown after `finalizeScores`
   ============================================================================ */

Game.screens.results = {
  render() {
    const room = Game.state.room;
    const r = room && room.round;
    if (!r || !r.scoring || !r.scoring.finalScores) {
      return `<div class="screen"><p>No completed round to show.</p></div>`;
    }

    const scores = r.scoring.finalScores;
    const players = room.players;

    // Find the winner of this round (or "tie").
    let topScore = -Infinity;
    players.forEach((p) => { topScore = Math.max(topScore, scores[p.id] || 0); });
    const winners = players.filter((p) => (scores[p.id] || 0) === topScore);
    const isTie = winners.length > 1;

    return `
      <div class="screen">
        <div class="header">
          <h1>Round ${r.number} results</h1>
          <div style="width:40px"></div>
        </div>

        <div class="card text-center" style="padding:24px;">
          ${isTie
            ? `<div style="font-size:36px;">🤝</div><h2 class="mt-8">Tied at ${topScore}</h2>`
            : `<div style="font-size:36px;">🏆</div><h2 class="mt-8">${Game.esc(winners[0].name)} wins the round</h2>`}
        </div>

        <div class="score-summary">
          ${players.map((p) => `
            <div class="score-pile">
              <div class="score-pile-name">${Game.esc(p.name)}</div>
              <div class="score-pile-num">${scores[p.id] || 0}</div>
              <div class="score-pile-total">total: ${room.cumulativeScores[p.id] || 0}</div>
            </div>
          `).join('')}
        </div>

        <div class="btn-row">
          <button class="btn btn-ghost" data-action="back-to-judge">← Edit scores</button>
          <button class="btn btn-primary" data-action="next">▶ Next round</button>
        </div>

        <div class="btn-row">
          <button class="btn btn-ghost btn-small" data-action="end">End game</button>
          <button class="btn btn-ghost btn-small" data-action="hist">View history</button>
        </div>
      </div>
    `;
  },
  mount() {
    document.querySelector('[data-action="back-to-judge"]').addEventListener('click', () => {
      // Allow returning to judge to fix mistakes — clear finalScores so the
      // judge screen treats it as still in scoring.
      const r = Game.state.room.round;
      r.scoring.finalScores = null;
      // Roll back the cumulative additions we made.
      Object.keys(r.scoring.decisions).forEach(() => {});
      // Recompute by undoing: subtract the most recent finalScores.
      // (We didn't store the prior totals; safest is to recompute from history.)
      recomputeCumulativeScores();
      Game.persistRoom(true);
      Game.goto('judge');
    });
    document.querySelector('[data-action="next"]').addEventListener('click', () => {
      Game.startNextRound();
    });
    document.querySelector('[data-action="end"]').addEventListener('click', () => {
      if (confirm('End the game and go back to lobby? Your history is saved.')) {
        Game.endGameAndArchive();
      }
    });
    document.querySelector('[data-action="hist"]').addEventListener('click', () => {
      // Archive the current round into history first so it shows up.
      const room = Game.state.room;
      if (room && room.round && room.round.scoring && room.round.scoring.finalScores) {
        room.history = room.history || [];
        room.history.push({
          number: room.round.number,
          letter: room.round.letter,
          categories: room.round.categories,
          answers: room.round.answers,
          scores: room.round.scoring.finalScores,
          decisions: room.round.scoring.decisions,
          completedAt: Date.now(),
        });
        room.round = null;
        Game.persistRoom(true);
      }
      Game.goto('history');
    });
  },
};

function recomputeCumulativeScores() {
  const room = Game.state.room;
  const totals = {};
  room.players.forEach((p) => { totals[p.id] = 0; });
  (room.history || []).forEach((h) => {
    Object.keys(h.scores || {}).forEach((pid) => {
      totals[pid] = (totals[pid] || 0) + (h.scores[pid] || 0);
    });
  });
  room.cumulativeScores = totals;
}

/* ============================================================================
   HISTORY DETAIL: a read-only view of one past round
   ============================================================================ */

Game.viewHistoryRound = function (idx) {
  Game.state._historyIdx = idx;
  Game.goto('historyDetail');
};

Game.screens.historyDetail = {
  render() {
    const room = Game.state.room;
    const idx = Game.state._historyIdx;
    const round = room && room.history && room.history[idx];
    if (!round) {
      return `<div class="screen"><p>That round wasn't found.</p></div>`;
    }
    const players = room.players;

    return `
      <div class="screen">
        <div class="header">
          <button class="btn btn-icon" data-action="back">‹</button>
          <h1>Round ${round.number}</h1>
          <div style="width:40px"></div>
        </div>

        <div class="card text-center">
          <div class="round-letter" style="display:inline-block;">${Game.esc(round.letter)}</div>
          <div class="text-small text-dim mt-8">${Game.fmtWhen(round.completedAt)}</div>
        </div>

        <div class="score-summary">
          ${players.map((p) => `
            <div class="score-pile">
              <div class="score-pile-name">${Game.esc(p.name)}</div>
              <div class="score-pile-num">${(round.scores && round.scores[p.id]) || 0}</div>
            </div>
          `).join('')}
        </div>

        ${round.categories.map((cat, catIdx) => {
          const dec = (round.decisions && round.decisions[catIdx]) || {};
          return `
            <div class="judge-row">
              <div class="judge-category">${catIdx + 1}. ${Game.esc(cat)}</div>
              <div class="judge-answers">
                ${players.map((p) => {
                  const ans = (round.answers[p.id] && round.answers[p.id][catIdx]) || '';
                  const isW = dec.winners && dec.winners[p.id];
                  const isI = dec.invalid && dec.invalid[p.id];
                  const cls = ['judge-answer', isW ? 'winner' : '', isI ? 'invalid' : '', !ans ? 'empty' : ''].filter(Boolean).join(' ');
                  return `
                    <div class="${cls}">
                      <div class="judge-answer-name">${Game.esc(p.name)}</div>
                      <div class="judge-answer-text">${Game.esc(ans || '(blank)')}</div>
                      ${isW ? '<div class="judge-answer-tag">✓</div>' : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  },
  mount() {
    document.querySelector('[data-action="back"]').addEventListener('click', () => Game.goto('history'));
  },
};
