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

// Toggle a "questionable" flag on an answer. The flag doesn't change scoring
// by itself — it just gets included in the chatbot prompt so the AI gives
// that answer extra scrutiny. Either player can flag any answer.
Game.toggleAnswerFlag = function (catIdx, playerId) {
  const dec = getDecision(catIdx);
  const newFlagged = !(dec.flagged && dec.flagged[playerId]);
  Game.updateRoomFields({
    [`round.scoring.decisions.${catIdx}.flagged.${playerId}`]: newFlagged,
  });
  Game.render();
};

/* ============================================================================
   IMPORT CHATBOT JUDGMENT: parse the chatbot's reply, apply winners in bulk
   ============================================================================
   The chatbot's reply has one line per category:
       1. WINNER: Mike — Reason
       3. WINNER: NONE — Reason
   We parse each line, match the winner name (case-insensitive) to a player,
   and update decisions in bulk. NONE means clear all winners for that
   category. Unknown / unmatched names get reported back to the user.
*/
Game.applyChatbotJudgment = function (rawText) {
  if (!rawText || !Game.state.room) return;
  const room = Game.state.room;
  const r = room.round;
  if (!r || !r.scoring) return;

  // Build a map of lowercased player names → playerId for matching.
  const nameToId = {};
  room.players.forEach((p) => { nameToId[p.name.toLowerCase().trim()] = p.id; });

  // Match lines like "5. WINNER: Mike — reason" or "5. WINNER: NONE - reason"
  // or "5: WINNER: Mike — reason". Tolerant of various dashes and punctuation.
  const lineRegex = /^\s*(\d+)\s*[.:)]\s*WINNER\s*:\s*([^—\-–]+?)\s*[—\-–]/gim;
  const updates = {};
  const results = { applied: 0, none: 0, unknown: [], skipped: [] };

  let match;
  while ((match = lineRegex.exec(rawText)) !== null) {
    const catNum = Number(match[1]);
    const catIdx = catNum - 1;
    if (catIdx < 0 || catIdx >= r.categories.length) continue;

    const rawWinner = match[2].trim().toLowerCase().replace(/["'.]/g, '');

    if (rawWinner === 'none' || rawWinner === 'no one' || rawWinner === 'neither') {
      // Clear all winners for this category.
      room.players.forEach((p) => {
        updates[`round.scoring.decisions.${catIdx}.winners.${p.id}`] = false;
      });
      results.none++;
      results.applied++;
      continue;
    }

    if (rawWinner === 'tie' || rawWinner === 'both') {
      // Even though the prompt asked for no ties, the chatbot might still tie.
      // Treat as "no winner" — user can manually pick afterward if they want.
      room.players.forEach((p) => {
        updates[`round.scoring.decisions.${catIdx}.winners.${p.id}`] = false;
      });
      results.skipped.push(`Category ${catNum}: TIE (manual pick needed)`);
      continue;
    }

    // Try to match the winner name. Allow partial matches in case the chatbot
    // shortened a name (e.g. "Waggle" matching "Waggle Bottom").
    const winnerId =
      nameToId[rawWinner] ||
      Object.keys(nameToId).find((n) => n.startsWith(rawWinner) || rawWinner.startsWith(n));
    const winnerPlayerId = typeof winnerId === 'string' && winnerId.includes('_')
      ? winnerId
      : nameToId[winnerId];

    if (!winnerPlayerId) {
      results.unknown.push(`Category ${catNum}: "${match[2].trim()}"`);
      continue;
    }

    // Apply: this player wins, everyone else loses for this category.
    room.players.forEach((p) => {
      updates[`round.scoring.decisions.${catIdx}.winners.${p.id}`] = (p.id === winnerPlayerId);
    });
    results.applied++;
  }

  if (Object.keys(updates).length === 0) {
    Game.toast('No "N. WINNER: ..." lines found. Paste the full chatbot reply.');
    return;
  }

  Game.updateRoomFields(updates);
  Game.render();

  // Tell the user what happened.
  const messages = [`Applied ${results.applied} categor${results.applied === 1 ? 'y' : 'ies'}`];
  if (results.unknown.length) messages.push(`Unknown name${results.unknown.length > 1 ? 's' : ''}: ${results.unknown.length}`);
  if (results.skipped.length) messages.push(`Ties skipped: ${results.skipped.length}`);
  Game.toast(messages.join(' · '), 4000);
};

/* ============================================================================
   COPY CHATBOT PROMPT
   ============================================================================ */

Game.buildChatbotPrompt = function () {
  const r = Game.state.room.round;
  const players = Game.state.room.players;
  const lines = [];

  // Gather flagged-by-opponent answers so we can call them out for extra scrutiny.
  // Format we surface to the chatbot: "Flag: Mike answered X for category 5 — please verify."
  const flagged = [];
  r.categories.forEach((cat, idx) => {
    const dec = (r.scoring && r.scoring.decisions && r.scoring.decisions[idx]) || {};
    players.forEach((p) => {
      if (dec.flagged && dec.flagged[p.id]) {
        flagged.push({ idx, name: p.name, ans: getAnswer(p.id, idx) || '(blank)' });
      }
    });
  });

  lines.push(`You are the official judge for a Scategories round.`);
  lines.push(`The letter is: ${r.letter}`);
  lines.push('');
  lines.push(`Players: ${players.map((p) => p.name).join(' and ')}`);
  lines.push('');
  lines.push(`For each numbered category, pick ONE winner — a single player's name, or "NONE" if no one deserves the point. NEVER reply with "TIE": if both answers are valid, pick whichever you think is stronger and explain why in one line.`);
  lines.push('');
  lines.push(`Rules:`);
  lines.push(`- An answer must start with "${r.letter}" (ignore "A", "An", "The" prefixes).`);
  lines.push(`- VERIFY answers are actually real things — don't trust an answer just because it sounds plausible. If a player invented a word or proper noun that doesn't exist (e.g. a fake song title, made-up celebrity, non-existent dish), call it out and treat it as invalid.`);
  lines.push(`- A descriptive adjective doesn't make an answer valid: "White jacket" is NOT a valid answer for "Something you wear" when the letter is W — the noun (jacket) doesn't start with W. But "Watermelon salad" IS valid for "A salad ingredient" because the answer's defining noun starts with W.`);
  lines.push(`- An invalid answer still beats a blank one — the player at least tried.`);
  lines.push(`- Identical answers cancel out — winner is "NONE".`);
  lines.push(`- Be reasonable: creative-but-real interpretations of a category are fine.`);
  if (flagged.length > 0) {
    lines.push('');
    lines.push(`⚑ The opposing player flagged these answers as questionable. Scrutinize them especially carefully:`);
    flagged.forEach((f) => {
      lines.push(`   - Category ${f.idx + 1}: ${f.name} answered "${f.ans}"`);
    });
  }
  lines.push('');
  lines.push(`REPLY FORMAT (one line per category, exactly as shown — no markdown, no extra text):`);
  lines.push(`1. WINNER: <player name or NONE> — <one-line reason>`);
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

        <div class="card text-small" id="promptHelp" style="display:none;">
          <div class="text-bold mb-8">1. Copy the prompt</div>
          <textarea class="prompt-area" readonly id="promptArea">${Game.esc(Game.buildChatbotPrompt())}</textarea>
          <button class="btn btn-small btn-primary mt-8" data-action="copy-prompt" style="width:100%;">
            Copy to clipboard
          </button>
          <div class="text-bold mt-16 mb-8">2. Paste the chatbot reply here</div>
          <textarea class="prompt-area" id="judgeImport" placeholder="1. WINNER: Mike — Reason&#10;2. WINNER: NONE — Reason&#10;..." style="min-height:120px;"></textarea>
          <button class="btn btn-small btn-primary mt-8" data-action="apply-judgment" style="width:100%;">
            Apply judgment
          </button>
          <div class="text-dim mt-8">
            This auto-fills winners based on the chatbot's reply. You can still tap any answer to override afterward.
          </div>
        </div>

        <div class="text-small text-dim text-center">
          <strong>Tap</strong> = mark winner ·
          <strong>Long-press</strong> = mark invalid ·
          <strong>⚑</strong> = flag as questionable
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
                    const isFlagged = !!(dec.flagged && dec.flagged[p.id]);
                    const isEmpty = !ans;
                    const isDup = !!dec.duplicate && !isEmpty;
                    const classes = [
                      'judge-answer',
                      isWinner ? 'winner' : '',
                      isInvalid ? 'invalid' : '',
                      isEmpty ? 'empty' : '',
                      isDup ? 'duplicate' : '',
                      isFlagged ? 'flagged' : '',
                    ].filter(Boolean).join(' ');
                    const tag = isWinner ? '✓' : isDup ? '=' : isInvalid ? '✗' : '';
                    return `
                      <div class="${classes}"
                           data-cat="${catIdx}" data-pid="${Game.esc(p.id)}">
                        <button class="judge-answer-flag" data-flag-cat="${catIdx}" data-flag-pid="${Game.esc(p.id)}"
                                title="Flag as questionable" aria-label="Flag">⚑</button>
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

    // The "Apply judgment" button reads the textarea and bulk-applies winners.
    const applyBtn = document.querySelector('[data-action="apply-judgment"]');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const ta = document.getElementById('judgeImport');
        if (!ta) return;
        Game.applyChatbotJudgment(ta.value);
      });
    }

    document.querySelector('[data-action="finalize"]').addEventListener('click', () => {
      Game.finalizeScores();
    });

    // Flag buttons. Wired separately and stop propagation so they don't also
    // trigger the parent answer's tap (which would toggle winner).
    document.querySelectorAll('[data-flag-cat]').forEach((flagBtn) => {
      flagBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const catIdx = Number(flagBtn.dataset.flagCat);
        const pid = flagBtn.dataset.flagPid;
        Game.toggleAnswerFlag(catIdx, pid);
        Game.vibrate(20);
      });
      // Also stop pointerdown so the long-press detection on the parent
      // doesn't see this as starting a press on the answer.
      flagBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
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
