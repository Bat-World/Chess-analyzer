// content.js — chess.com analysis panel with live log

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let sfReady       = false;
  let analyzedMoves = [];
  let currentHalfMove = -1;
  let currentArrowIdx = -1; // -1 = played move, 0..2 = engine top moves

  // ── SAN / move helpers ────────────────────────────────────────────────────

  // Convert a UCI move (e.g. "e2e4", "e7e8q") to SAN ("e4", "e8=Q") given the
  // FEN of the position *before* the move. Falls back to UCI on failure.
  function uciToSan(fen, uci) {
    if (!uci || uci.length < 4) return uci || '';
    try {
      const c = new Chess(fen);
      const from = uci.slice(0, 2);
      const to   = uci.slice(2, 4);
      const promotion = uci.length === 5 ? uci[4] : undefined;
      const m = c.move({ from, to, promotion });
      return m?.san ?? uci;
    } catch { return uci; }
  }

  // Convert a SAN move ("Bb4", "O-O", "e8=Q") to UCI ("c5b4", ...) given the
  // FEN of the position *before* the move. Returns null on failure.
  function sanToUci(fen, san) {
    if (!san) return null;
    try {
      const c = new Chess(fen);
      const m = c.move(san, { sloppy: true });
      return m ? m.from + m.to + (m.promotion ?? '') : null;
    } catch { return null; }
  }

  // Resolve a move (SAN or UCI) to {from, to} squares for arrow drawing.
  function moveSquares(fen, sanOrUci) {
    if (!sanOrUci) return null;
    try {
      const c = new Chess(fen);
      // Try as UCI first
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(sanOrUci)) {
        const from = sanOrUci.slice(0, 2);
        const to   = sanOrUci.slice(2, 4);
        const promotion = sanOrUci.length === 5 ? sanOrUci[4] : undefined;
        const m = c.move({ from, to, promotion });
        return m ? { from: m.from, to: m.to } : null;
      }
      const m = c.move(sanOrUci, { sloppy: true });
      return m ? { from: m.from, to: m.to } : null;
    } catch { return null; }
  }

  // ── Stockfish bridge ──────────────────────────────────────────────────────
  // The engine lives in an offscreen document at the extension origin (see
  // background.js / offscreen.js). We talk to it by message, not by Worker.

  const pendingAnalysis = new Map(); // id → resolve fn
  let nextAnalysisId = 1;

  function initStockfish() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Engine init timeout')), 15000);
      chrome.runtime.sendMessage({ type: 'INIT_ENGINE' }, (res) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.ok) { sfReady = true; resolve(); }
        else reject(new Error(res?.error || 'Engine init failed'));
      });
    });
  }

  function analyzePosition(fen, depth = 14, multiPV = 3) {
    return new Promise((resolve, reject) => {
      const id = nextAnalysisId++;
      const timeout = setTimeout(() => {
        pendingAnalysis.delete(id);
        reject(new Error('Engine timeout for FEN: ' + fen));
      }, 30000);
      pendingAnalysis.set(id, (result) => { clearTimeout(timeout); resolve(result); });
      chrome.runtime.sendMessage({ type: 'ANALYZE_POSITION', id, fen, depth, multiPV });
    });
  }

  // ── PGN extraction ─────────────────────────────────────────────────────────
  // Strategy: drive chess.com's own Share → PGN modal. It's the only source
  // that's guaranteed correct, available, and stable across page redesigns
  // (selectors live on data attributes and ARIA labels, not hashed classes).
  // If automation fails, fall through to a manual paste textarea.

  function findShareButton() {
    // Prefer exact ARIA match — chess.com's primary Share button is reliably
    // labelled. Class-based hints are deliberately avoided here because the
    // share-menu modal itself contains a nested element matching those classes
    // and clicking it does nothing.
    const candidates = [
      ...document.querySelectorAll('button[aria-label="Share" i]'),
      ...document.querySelectorAll('a[role="button"][aria-label="Share" i]'),
      ...document.querySelectorAll('button[aria-label^="Share " i]'),
    ];
    for (const el of candidates) {
      // Skip anything already inside an open share modal
      if (el.closest('[class*="share-menu"], [class*="modal"]')) continue;
      return el;
    }
    // Fallback: visible-text "Share" on a top-level button
    for (const b of document.querySelectorAll('button')) {
      if (b.closest('[class*="share-menu"], [class*="modal"]')) continue;
      if ((b.textContent || '').trim().toLowerCase() === 'share') return b;
    }
    // Last resort (review/analysis pages): a share control identified by a
    // partial aria-label or a share-flavoured class/data attribute. Still skip
    // anything inside the open share modal so we don't click its inert element.
    for (const el of document.querySelectorAll(
      'button[aria-label*="share" i], a[role="button"][aria-label*="share" i], ' +
      '[data-cy*="share" i], button[class*="share" i]'
    )) {
      if (el.closest('[class*="share-menu"], [class*="modal"]')) continue;
      return el;
    }
    return null;
  }

  function findPgnTab() {
    const all = document.querySelectorAll('button, [role="tab"], a');
    for (const el of all) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const txt  = (el.textContent || '').trim().toLowerCase();
      if (txt === 'pgn' || aria === 'pgn' || aria.includes('pgn tab')) return el;
    }
    return null;
  }

  function findShareModalCloseButton() {
    const modal = document.querySelector('.share-menu-tab-pgn-textarea')?.closest('[class*="modal"]');
    if (!modal) return null;
    return modal.querySelector('[aria-label*="close" i], [aria-label*="Close" i], button[class*="close"]');
  }

  function waitForElement(selector, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  // Once the share modal is actually in the DOM, hide *that specific element*
  // by inline-style. Much safer than a global CSS rule that might break
  // chess.com's other modals.
  function hideElement(el) {
    if (!el) return;
    el.dataset.caHidden = el.getAttribute('style') || '';
    el.style.cssText += ';visibility:hidden !important;opacity:0 !important;pointer-events:none !important;';
  }
  function unhideElement(el) {
    if (!el) return;
    el.setAttribute('style', el.dataset.caHidden || '');
    delete el.dataset.caHidden;
  }

  function closeShareModal() {
    const closeBtn = findShareModalCloseButton();
    if (closeBtn) { closeBtn.click(); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  }

  function describeButton(el) {
    if (!el) return '<none>';
    const aria = el.getAttribute('aria-label') || '';
    const txt  = (el.textContent || '').trim().slice(0, 40);
    const cls  = (el.className || '').toString().slice(0, 60);
    return `aria="${aria}" text="${txt}" class="${cls}"`;
  }

  async function extractPGNViaShareButton() {
    const shareBtn = findShareButton();
    if (!shareBtn) { log('No Share button visible on this page', 'warn'); return null; }
    log(`Share button found → ${describeButton(shareBtn)}`, 'info');

    log('Clicking Share...', 'info');
    shareBtn.click();

    // First locate the modal container (so we can hide it briefly), then look
    // for the PGN textarea inside.
    const modal = await waitForElement('[class*="share-menu"], [class*="modal-container"]', 3000);
    if (modal) {
      log('Share modal opened, hiding it during read', 'info');
      hideElement(modal);
    } else {
      log('Share modal did not appear within 3s', 'warn');
    }

    let textarea = await waitForElement('.share-menu-tab-pgn-textarea', 2500);
    if (!textarea) {
      const pgnTab = findPgnTab();
      if (pgnTab) {
        log(`Clicking PGN tab → ${describeButton(pgnTab)}`, 'info');
        pgnTab.click();
        textarea = await waitForElement('.share-menu-tab-pgn-textarea', 3000);
      } else {
        log('No PGN tab found inside modal', 'warn');
      }
    }

    let pgn = null;
    if (textarea) {
      pgn = textarea.value || textarea.textContent || null;
      log(`PGN textarea found, ${pgn?.length ?? 0} chars`, 'info');
    } else {
      log('PGN textarea did not appear', 'warn');
    }

    closeShareModal();
    unhideElement(modal);

    return pgn && pgn.trim() ? pgn.trim() : null;
  }

  function waitForManualPaste() {
    return new Promise((resolve) => {
      const fb = document.getElementById('ca-paste-fallback');
      if (!fb) { resolve(null); return; }
      fb.style.display = 'block';
      const ta  = document.getElementById('ca-paste-textarea');
      const ok  = document.getElementById('ca-paste-submit');
      const no  = document.getElementById('ca-paste-cancel');
      ta.value = '';
      ta.focus();
      const cleanup = () => {
        fb.style.display = 'none';
        ok.removeEventListener('click', onOk);
        no.removeEventListener('click', onNo);
      };
      const onOk = () => { const v = ta.value.trim(); cleanup(); resolve(v || null); };
      const onNo = () => { cleanup(); resolve(null); };
      ok.addEventListener('click', onOk);
      no.addEventListener('click', onNo);
    });
  }

  async function getPGN() {
    log('Extracting PGN via chess.com Share menu...', 'info');
    const pgn = await extractPGNViaShareButton();
    if (pgn) { log('PGN captured ✓', 'ok'); return pgn; }

    log('Automation failed — paste PGN manually below', 'warn');
    const pasted = await waitForManualPaste();
    if (pasted) log('PGN pasted ✓', 'ok');
    return pasted;
  }

  // ── Analyze-button gating ──────────────────────────────────────────────────
  // We enable "Analyze Game" once the game is over. Two independent signals,
  // either of which is sufficient:
  //   1. The URL is an analysis/review/archived-game page — the game is over by
  //      definition there (e.g. /analysis/game/live/<id>/review).
  //   2. A top-level Share button is present. Finished games on the normal game
  //      page expose one; live in-progress games do not.
  // The URL check matters because the review page lays its controls out
  // differently and findShareButton() can miss its share control, which used to
  // leave the button stuck on "Waiting for game to end…" on a finished game.
  // We poll on a low-frequency interval instead of a MutationObserver because
  // chess.com mutates the DOM heavily (clocks, animations, move list) and
  // observing the whole subtree freezes the page.

  function isFinishedGamePage() {
    return /\/(analysis|review|archive)\b/i.test(location.pathname);
  }

  function isGameReady() {
    return isFinishedGamePage() || !!findShareButton();
  }

  let lastShareReady = null;
  function updateAnalyzeButtonState() {
    const btn = document.getElementById('ca-analyze-btn');
    if (!btn) return;
    const ready = isGameReady();
    if (ready === lastShareReady) return;
    lastShareReady = ready;
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Waiting for game to end (no Share button on page yet)';
    btn.textContent = ready ? 'Analyze Game' : 'Waiting for game to end…';
  }

  let shareProbeInterval = null;
  function startShareProbe() {
    lastShareReady = null;
    updateAnalyzeButtonState();
    stopShareProbe();
    shareProbeInterval = setInterval(updateAnalyzeButtonState, 1500);
  }
  function stopShareProbe() {
    if (shareProbeInterval) { clearInterval(shareProbeInterval); shareProbeInterval = null; }
  }

  // ── Move classification ────────────────────────────────────────────────────
  // We classify on the *change in win probability*, not raw centipawns. A
  // 0.7-pawn drop is meaningless at ±8 but decisive near 0.0 — pawn thresholds
  // can't tell those apart, which is what made the old logic over-flag.

  // Convert one engine line {score (pawns), isMate, mateIn} to a 0–100 win
  // probability. `sign` flips perspective: +1 = the side to move in the line's
  // own position, −1 = the opponent (used when reading the *next* position).
  function evalToWinPct(line, sign = 1) {
    if (!line) return 50;
    if (line.isMate) {
      const m = (line.mateIn ?? 0) * sign; // >0 → mover mates, <0 → gets mated
      return m > 0 ? 100 : 0;
    }
    const cp = line.score * 100 * sign;    // line.score is in pawns
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  // Map a win-probability loss (0–100) to one of the five labels. A move that
  // matched the engine's top choice is always 'best' — this keeps the badge and
  // the "✓ Engine's top choice" line from ever disagreeing.
  function classifyByWinLoss(winLoss, wasBest) {
    if (wasBest || winLoss < 2) return 'best';
    if (winLoss < 5)            return 'good';
    if (winLoss < 10)           return 'inaccuracy';
    if (winLoss < 20)           return 'mistake';
    return 'blunder';
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Per-move accuracy from win-probability loss (lichess formula).
  function moveAccuracy(winLoss) {
    return clamp(103.1668 * Math.exp(-0.04354 * winLoss) - 3.1669, 0, 100);
  }

  // Rough, clearly-approximate game Elo from accuracy. No engine produces a
  // rigorous game rating; constants are tunable.
  function estimateElo(accuracy) {
    return clamp(Math.round((accuracy - 30) * 35), 100, 2900);
  }

  // ── Live log ───────────────────────────────────────────────────────────────

  function log(msg, type = 'info') {
    const el = document.getElementById('ca-log');
    if (!el) return;
    const line = document.createElement('div');
    line.className = `ca-log-line ca-log-${type}`;
    const time = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.innerHTML = `<span class="ca-log-time">${time}</span> ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function logClear() {
    const el = document.getElementById('ca-log');
    if (el) el.innerHTML = '';
  }

  // ── Analysis flow ──────────────────────────────────────────────────────────

  async function startAnalysis() {
    const btn     = document.getElementById('ca-analyze-btn');
    const statusEl = document.getElementById('ca-status');
    const viewEl  = document.getElementById('ca-view');
    const summaryEl = document.getElementById('ca-summary');

    btn.disabled = true;
    btn.textContent = 'Analyzing…';
    viewEl.innerHTML = '';
    summaryEl.innerHTML = '';
    logClear();

    // Restore the button on any exit path (error or completion).
    const finish = () => { btn.disabled = false; btn.textContent = 'Analyze Game'; };

    // 1. Load PGN
    renderProgress({ phase: 'Reading game…' });
    const pgn = await getPGN();
    if (!pgn) {
      log('Could not read game — make sure it is finished and you are on /game/live/... or /game/daily/...', 'error');
      renderProgress(null);
      finish();
      return;
    }

    // 2. Parse PGN → positions
    let positions;
    try {
      const chess   = new Chess();
      const loaded  = chess.load_pgn(pgn);
      if (!loaded) throw new Error('load_pgn returned false');
      const history = chess.history({ verbose: true });
      const replay  = new Chess();
      positions = history.map((move, i) => {
        const fen = replay.fen();
        replay.move(move);
        return { fen, san: move.san, moveNumber: Math.floor(i / 2) + 1, color: move.color === 'w' ? 'White' : 'Black' };
      });
    } catch (e) {
      log('PGN parse error: ' + e.message, 'error');
      renderProgress(null);
      finish();
      return;
    }

    log(`Game loaded — ${positions.length} moves to analyze`, 'ok');

    // 3. Init Stockfish
    if (!sfReady) {
      renderProgress({ phase: 'Starting Stockfish engine…' });
      log('Starting Stockfish engine...', 'info');
      try {
        await initStockfish();
        log('Stockfish ready ✓', 'ok');
      } catch (e) {
        log('Stockfish failed to start: ' + e.message, 'error');
        renderProgress(null);
        finish();
        return;
      }
    } else {
      log('Stockfish already running ✓', 'ok');
    }

    // 4. Analyze each position
    const results = [];
    for (let i = 0; i < positions.length; i++) {
      const { fen, san, moveNumber, color } = positions[i];
      renderProgress({ phase: 'Analyzing moves', current: i, total: positions.length,
                       label: `${moveNumber}${color === 'Black' ? '…' : '.'} ${san}` });
      log(`[${i + 1}/${positions.length}] Stockfish analyzing move ${moveNumber}. ${color}: ${san}...`, 'engine');

      const engineData = await analyzePosition(fen, 12, 3);
      const bestMove   = engineData.bestMove;

      const topStr = engineData.topMoves.map((m, j) =>
        `#${j+1} ${m.uci} (${m.score > 0 ? '+' : ''}${m.score.toFixed(2)})`
      ).join(' | ');

      log(
        `→ Best: <strong>${bestMove}</strong> | Top moves: ${topStr}`,
        'result'
      );

      results.push({ index: i, moveNumber, color, played: san, fen, engineData, bestMove });
    }

    // Second pass: classify each move by its win-probability loss. We compare
    // the win% of the engine's best line at this position against the win% the
    // player actually achieved (read from the *next* position's best line,
    // flipped to the mover's perspective). Playing the engine's top move pins
    // the loss to exactly 0 — the two searches won't be re-compared, so search
    // instability can no longer manufacture a fake "loss" on the best move.
    renderProgress({ phase: 'Classifying moves…' });
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const bestLine = r.engineData.topMoves[0] ?? null;
      const bestScoreBefore = bestLine?.score ?? 0;
      const playedUci = sanToUci(r.fen, r.played);
      const wasBest = !!r.bestMove && playedUci === r.bestMove;

      const winBefore = evalToWinPct(bestLine, 1);
      let winAfter, achievedScore;
      if (wasBest) {
        winAfter = winBefore;
        achievedScore = bestScoreBefore;
      } else {
        const next = results[i + 1];
        if (next) {
          const nextLine = next.engineData.topMoves[0] ?? null;
          winAfter = evalToWinPct(nextLine, -1); // opponent's line, flipped
          achievedScore = -(nextLine?.score ?? 0);
        } else {
          // Last ply of the game — no successor. Use the played move from our
          // own top lines if present, else the worst line we have.
          const hit = r.engineData.topMoves.find((m) => m.uci === playedUci);
          const line = hit ?? r.engineData.topMoves.at(-1) ?? bestLine;
          winAfter = evalToWinPct(line, 1);
          achievedScore = line?.score ?? bestScoreBefore;
        }
      }

      r.scoreDelta = Math.max(0, bestScoreBefore - achievedScore);
      r.winLoss = Math.max(0, winBefore - winAfter);
      r.wasBest = wasBest;
      r.classification = classifyByWinLoss(r.winLoss, wasBest);
      log(
        `Move ${r.moveNumber}${r.color === 'Black' ? '…' : '.'} ${r.played}: −${r.winLoss.toFixed(1)}% win → <span class="ca-log-${r.classification}">${r.classification}</span>`,
        'result'
      );
    }

    analyzedMoves = results;

    // 5. Summary stats
    const counts = { blunder: 0, mistake: 0, inaccuracy: 0, good: 0, best: 0 };
    for (const m of analyzedMoves) counts[m.classification] = (counts[m.classification] ?? 0) + 1;
    log(`─── Analysis complete ───`, 'section');
    log(`${counts.blunder} blunders · ${counts.mistake} mistakes · ${counts.inaccuracy} inaccuracies · ${counts.best + counts.good} good/best`, 'summary');

    // Per-player accuracy & estimated Elo
    const perPlayer = {};
    for (const side of ['White', 'Black']) {
      const moves = analyzedMoves.filter((m) => m.color === side);
      if (!moves.length) continue;
      const accuracy = moves.reduce((s, m) => s + moveAccuracy(m.winLoss ?? 0), 0) / moves.length;
      const acpl     = moves.reduce((s, m) => s + (m.scoreDelta ?? 0) * 100, 0) / moves.length;
      perPlayer[side] = { accuracy, acpl, elo: estimateElo(accuracy) };
    }
    for (const side of ['White', 'Black']) {
      const p = perPlayer[side];
      if (p) log(`${side}: ${p.accuracy.toFixed(1)}% accuracy · ≈${p.elo} Elo`, 'summary');
    }

    statusEl.innerHTML = renderAccuracyHtml(perPlayer) + renderStatsHtml(counts);

    currentHalfMove = getCurrentHalfMoveFromURL();
    currentArrowIdx = -1;
    renderProgress(null);     // cleared visually by renderCurrentMove below
    renderCurrentMove();
    renderSummaryList();
    finish();
  }

  // Render (or clear) the in-progress analysis card in the main view area.
  // Pass null to clear. `state` = { phase, current?, total?, label? }.
  function renderProgress(state) {
    const el = document.getElementById('ca-view');
    if (!el) return;
    if (!state) { el.innerHTML = ''; return; }

    const { phase, current, total, label } = state;
    const determinate = Number.isFinite(current) && Number.isFinite(total) && total > 0;
    const done = determinate ? current : 0;
    const pct  = determinate ? Math.round((done / total) * 100) : 0;

    const counter = determinate ? `<span class="ca-prog-count">${done} / ${total}</span>` : '';
    const sub     = determinate && label
      ? `<div class="ca-prog-sub">Move ${label}</div>`
      : '';
    const bar = determinate
      ? `<div class="ca-prog-bar"><div class="ca-prog-fill" style="width:${pct}%"></div></div>`
      : `<div class="ca-prog-bar ca-prog-indeterminate"><div class="ca-prog-fill"></div></div>`;

    el.innerHTML = `
      <div class="ca-progress">
        <div class="ca-prog-top">
          <span class="ca-prog-spinner"></span>
          <span class="ca-prog-phase">${phase}</span>
          ${counter}
        </div>
        ${bar}
        ${sub}
      </div>`;
  }

  function renderAccuracyHtml(perPlayer) {
    const row = (side, p) => {
      if (!p) return '';
      return `<div class="ca-acc-row">
        <span class="ca-acc-side ca-acc-${side.toLowerCase()}">${side}</span>
        <span class="ca-acc-val">${p.accuracy.toFixed(1)}<span class="ca-acc-unit">%</span></span>
        <span class="ca-acc-elo" title="Estimated rating (approximate)">≈ ${p.elo}</span>
      </div>`;
    };
    const rows = row('White', perPlayer.White) + row('Black', perPlayer.Black);
    if (!rows) return '';
    return `<div class="ca-accuracy">
      <div class="ca-acc-head"><span>Accuracy</span><span>Est. Elo</span></div>
      ${rows}
    </div>`;
  }

  function renderStatsHtml(counts) {
    const order = ['blunder', 'mistake', 'inaccuracy', 'good', 'best'];
    return `<div class="ca-stats">` + order.map((k) => `
      <div class="ca-stat ca-stat-${k}" title="${CLASS_LABELS[k]}">
        <span class="ca-stat-dot"></span>
        <span class="ca-stat-count">${counts[k] ?? 0}</span>
        <span class="ca-stat-label">${CLASS_LABELS[k]}</span>
      </div>`).join('') + `</div>`;
  }

  // ── Move navigation ────────────────────────────────────────────────────────

  function getCurrentHalfMoveFromURL() {
    const m = location.href.match(/[?&]move=(\d+)/);
    return m ? parseInt(m[1]) - 1 : -1;
  }

  function watchMoveNavigation() {
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        const hm = getCurrentHalfMoveFromURL();
        if (hm !== currentHalfMove && analyzedMoves.length > 0) {
          currentHalfMove = hm;
          renderCurrentMove();
        }
      }
    }, 200);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const CLASS_COLORS = { best: '#4caf50', good: '#8bc34a', inaccuracy: '#ff9800', mistake: '#f44336', blunder: '#9c27b0', unknown: '#888' };
  const CLASS_LABELS = { best: 'Best', good: 'Good', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };
  // Always use filled glyphs; color white vs. black via CSS.
  const PIECE_GLYPH  = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
                         P: '♟', N: '♞', B: '♝', R: '♜', Q: '♛', K: '♚' };

  function fmtScore(m) {
    if (!m) return '';
    if (m.isMate) return `M${Math.abs(m.mateIn)}${m.mateIn < 0 ? '−' : ''}`;
    return (m.score > 0 ? '+' : '') + m.score.toFixed(2);
  }

  function renderMiniBoard(fen, arrow) {
    let board;
    try { board = new Chess(fen).board(); } catch { return ''; }
    const SQ = 38;
    const size = SQ * 8;
    let cells = '';
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const piece = board[r][f];
        const cls = ((r + f) % 2 === 0) ? 'l' : 'd';
        const glyph = piece ? PIECE_GLYPH[piece.color === 'w' ? piece.type.toUpperCase() : piece.type] : '';
        const colorCls = piece ? (piece.color === 'w' ? 'pw' : 'pb') : '';
        cells += `<div class="ca-mb-sq ${cls} ${colorCls}">${glyph}</div>`;
      }
    }
    let arrowSvg = '';
    if (arrow?.from && arrow?.to) {
      const toXY = (sq) => ({
        x: (sq.charCodeAt(0) - 97) * SQ + SQ / 2,
        y: (8 - parseInt(sq[1])) * SQ + SQ / 2,
      });
      const a = toXY(arrow.from), b = toXY(arrow.to);
      const color = arrow.color || '#4caf50';
      const mid = Math.random().toString(36).slice(2, 8);
      arrowSvg = `
        <svg class="ca-mb-arrows" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <defs>
            <marker id="ah-${mid}" viewBox="0 0 10 10" refX="7" refY="5"
                    markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="${color}" />
            </marker>
          </defs>
          <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
                stroke="${color}" stroke-width="3.5" stroke-linecap="round"
                marker-end="url(#ah-${mid})" opacity="0.88" />
        </svg>`;
    }
    return `<div class="ca-mb" style="width:${size}px;height:${size}px">
      <div class="ca-mb-board" style="grid-template-columns:repeat(8,${SQ}px);grid-template-rows:repeat(8,${SQ}px);font-size:${Math.round(SQ * 0.82)}px">${cells}</div>
      ${arrowSvg}
    </div>`;
  }

  function renderCurrentMove() {
    const el = document.getElementById('ca-view');
    if (!el) return;
    const move = analyzedMoves[currentHalfMove];
    if (!move) {
      el.innerHTML = `<div class="ca-nav-hint">Navigate with ← → to see move analysis</div>`;
      return;
    }

    const cls   = move.classification;
    const color = CLASS_COLORS[cls] ?? '#888';
    const label = CLASS_LABELS[cls] ?? cls;
    const topMoves = move.engineData?.topMoves ?? [];
    const wasBest = move.wasBest ?? (move.bestMove && sanToUci(move.fen, move.played) === move.bestMove);

    // Decide which arrow to draw. Default: engine's top move (so the user sees
    // the recommendation). When a specific engine line is selected, show that
    // one instead.
    let arrow = null;
    if (currentArrowIdx >= 0 && topMoves[currentArrowIdx]) {
      const sq = moveSquares(move.fen, topMoves[currentArrowIdx].uci);
      if (sq) arrow = { ...sq, color: '#4caf50' };
    } else if (topMoves[0]) {
      const sq = moveSquares(move.fen, topMoves[0].uci);
      if (sq) arrow = { ...sq, color: '#4caf50' };
    }

    // Engine lines (SAN)
    const topLinesHtml = topMoves.map((m, j) => {
      const san = uciToSan(move.fen, m.uci);
      const active = currentArrowIdx === j ? ' ca-line-active' : '';
      return `<button class="ca-top-line${active}" data-engine-idx="${j}">
        <span class="ca-top-rank">${j + 1}</span>
        <span class="ca-top-san">${san}</span>
        <span class="ca-top-score">${fmtScore(m)}</span>
      </button>`;
    }).join('');

    const turnLabel = move.color === 'White' ? `${move.moveNumber}.` : `${move.moveNumber}…`;
    const bestSan = move.bestMove ? uciToSan(move.fen, move.bestMove) : null;

    const evalLine = wasBest
      ? `<div class="ca-mc-eval ca-eval-ok">✓ Engine's top choice</div>`
      : `<div class="ca-mc-eval">Engine prefers <strong>${bestSan ?? move.bestMove}</strong>
         <span class="ca-delta">Δ −${(move.scoreDelta ?? 0).toFixed(2)} pawns</span></div>`;

    el.innerHTML = `
      <div class="ca-current-card" style="border-left-color:${color}">
        <div class="ca-mc-top">
          <span class="ca-mc-turn">${turnLabel} <span class="ca-mc-side">${move.color}</span></span>
          <span class="ca-mc-played">${move.played}</span>
          <span class="ca-mc-badge ca-badge-${cls}">${label}</span>
        </div>
        ${evalLine}
        ${renderMiniBoard(move.fen, arrow)}
        ${topMoves.length ? `
          <div class="ca-top-lines">
            <div class="ca-top-lines-title">Top engine lines <span class="ca-hint">(click to show on board)</span></div>
            ${topLinesHtml}
          </div>` : ''}
      </div>`;

    // Wire up engine-line clicks
    el.querySelectorAll('.ca-top-line').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.engineIdx);
        currentArrowIdx = (currentArrowIdx === idx) ? -1 : idx;
        renderCurrentMove();
      });
    });

    // Sync active row in All Moves
    document.querySelectorAll('.ca-move-cell').forEach((c) => c.classList.remove('ca-cell-active'));
    const activeCell = document.querySelector(`.ca-move-cell[data-half="${currentHalfMove}"]`);
    if (activeCell) {
      activeCell.classList.add('ca-cell-active');
      activeCell.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderSummaryList() {
    const el = document.getElementById('ca-summary');
    if (!el) return;
    el.innerHTML = '<div class="ca-summary-title">All moves</div>';

    const grid = document.createElement('div');
    grid.className = 'ca-moves-grid';

    // Group by move number; pair white + black
    const byMoveNum = new Map();
    analyzedMoves.forEach((m, i) => {
      const e = byMoveNum.get(m.moveNumber) || { num: m.moveNumber };
      if (m.color === 'White') e.white = { ...m, half: i };
      else                     e.black = { ...m, half: i };
      byMoveNum.set(m.moveNumber, e);
    });

    for (const row of byMoveNum.values()) {
      const r = document.createElement('div');
      r.className = 'ca-move-row';
      r.innerHTML = `
        <span class="ca-move-num">${row.num}.</span>
        ${cellHtml(row.white)}
        ${cellHtml(row.black)}`;
      grid.appendChild(r);
    }
    el.appendChild(grid);

    grid.querySelectorAll('.ca-move-cell').forEach((c) => {
      c.addEventListener('click', () => {
        currentHalfMove = parseInt(c.dataset.half);
        currentArrowIdx = -1;
        renderCurrentMove();
      });
    });
  }

  function cellHtml(m) {
    if (!m) return `<span class="ca-move-cell ca-cell-empty"></span>`;
    const color = CLASS_COLORS[m.classification] ?? '#888';
    return `<button class="ca-move-cell" data-half="${m.half}">
      <span class="ca-cell-san">${m.played}</span>
      <span class="ca-cell-dot" style="background:${color}" title="${CLASS_LABELS[m.classification]}"></span>
    </button>`;
  }

  // ── Panel HTML ─────────────────────────────────────────────────────────────

  function injectPanel() {
    if (document.getElementById('chess-analyzer-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'chess-analyzer-panel';
    panel.innerHTML = `
      <div class="ca-resize-grip" id="ca-grip"></div>
      <div class="ca-header">
        <span class="ca-title">♟ Chess Analyzer</span>
        <div class="ca-header-actions">
          <button class="ca-dock-btn" id="ca-dock-btn" title="Float / Dock">⊞ Float</button>
          <button class="ca-close">✕</button>
        </div>
      </div>
      <div class="ca-body">
        <button class="ca-analyze-btn" id="ca-analyze-btn">Analyze Game</button>
        <div class="ca-paste-fallback" id="ca-paste-fallback" style="display:none">
          <div class="ca-paste-title">Couldn't read PGN automatically</div>
          <div class="ca-paste-hint">On chess.com: click <strong>Share</strong> → <strong>PGN</strong> tab → copy. Paste below:</div>
          <textarea class="ca-paste-textarea" id="ca-paste-textarea" placeholder="[Event &quot;...&quot;]&#10;1. e4 e5 2. Nf3 ..."></textarea>
          <div class="ca-paste-actions">
            <button class="ca-paste-submit" id="ca-paste-submit">Analyze pasted PGN</button>
            <button class="ca-paste-cancel" id="ca-paste-cancel">Cancel</button>
          </div>
        </div>
        <div class="ca-status" id="ca-status"></div>
        <div class="ca-view" id="ca-view"></div>
        <div class="ca-log-section">
          <div class="ca-log-header">
            <span>Live Log</span>
            <div class="ca-log-actions">
              <button class="ca-log-btn" id="ca-log-copy" title="Copy log">⧉ Copy</button>
              <button class="ca-log-toggle" id="ca-log-toggle">▼</button>
            </div>
          </div>
          <div class="ca-log" id="ca-log"></div>
        </div>
        <div class="ca-summary" id="ca-summary"></div>
        <div class="ca-kb-hint">← → navigate moves · click any move below</div>
      </div>`;

    document.body.appendChild(panel);

    panel.querySelector('.ca-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#ca-analyze-btn').addEventListener('click', startAnalysis);
    panel.querySelector('#ca-log-copy').addEventListener('click', async () => {
      const logEl = document.getElementById('ca-log');
      if (!logEl) return;
      const text = [...logEl.querySelectorAll('.ca-log-line')]
        .map((l) => l.innerText.trim())
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('ca-log-copy');
        const old = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch (e) {
        log('Copy failed: ' + e.message, 'error');
      }
    });
    panel.querySelector('#ca-log-toggle').addEventListener('click', () => {
      const logEl = document.getElementById('ca-log');
      const btn   = document.getElementById('ca-log-toggle');
      const hide  = logEl.style.display !== 'none';
      logEl.style.display = hide ? 'none' : 'block';
      btn.textContent = hide ? '►' : '▼';
    });

    // Dock ↔ Float toggle. Floating means free positioning + size; docked is the
    // full-height right sidebar (CSS default). Current mode lives on
    // panel.dataset.docked so the save/drag/resize helpers can read it.
    panel.querySelector('#ca-dock-btn').addEventListener('click', () => {
      const nowDocked = panel.dataset.docked === 'false'; // about to flip
      if (nowDocked) {
        applyPanelState(panel, { docked: true });
      } else {
        // Floating: seed from the panel's current on-screen geometry.
        const r = panel.getBoundingClientRect();
        applyPanelState(panel, { docked: false, left: r.left, top: r.top, width: r.width, height: 600 });
      }
      savePanelState(panel);
    });

    // Restore the last-used position/size/dock state before wiring interactions.
    applyPanelState(panel, loadPanelState());
    makeDraggable(panel);
    makeResizable(panel);

    // Keep the panel on-screen if the window is resized smaller.
    window.addEventListener('resize', () => {
      if (panel.dataset.docked === 'false') { clampToViewport(panel); savePanelState(panel); }
    });

    watchMoveNavigation();
    wireKeyboardNav();
  }

  // ── Panel position/size persistence ────────────────────────────────────────
  // Remember where the user put the panel (and whether it's floating) across
  // page loads. Stored per-origin in localStorage.
  const PANEL_STATE_KEY = 'caPanelState';

  function loadPanelState() {
    try { return JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || 'null'); }
    catch { return null; }
  }

  function savePanelState(panel) {
    try {
      const docked = panel.dataset.docked !== 'false';
      const state = { docked, width: panel.offsetWidth };
      if (!docked) {
        const r = panel.getBoundingClientRect();
        state.left = r.left; state.top = r.top; state.height = panel.offsetHeight;
      }
      localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
    } catch { /* storage may be blocked; non-fatal */ }
  }

  // Apply a saved (or default) state to the panel's inline styles.
  function applyPanelState(panel, state) {
    const docked  = !state || state.docked !== false;
    const dockBtn = panel.querySelector('#ca-dock-btn');
    const header  = panel.querySelector('.ca-header');
    panel.dataset.docked = String(docked);

    if (docked) {
      panel.style.cssText = '';                       // back to the CSS sidebar
      if (state?.width) panel.style.width = state.width + 'px';
      if (dockBtn) dockBtn.textContent = '⊞ Float';
      if (header) header.style.cursor = 'default';
    } else {
      const w = state.width  ?? 360;
      const h = state.height ?? 600;
      panel.style.right  = 'auto';
      panel.style.width  = w + 'px';
      panel.style.height = h + 'px';
      panel.style.left   = (state.left ?? (window.innerWidth - w - 20)) + 'px';
      panel.style.top    = (state.top  ?? 80) + 'px';
      if (dockBtn) dockBtn.textContent = '⊟ Dock';
      if (header) header.style.cursor = 'grab';
      clampToViewport(panel);
    }
  }

  // Keep a floating panel fully inside the viewport (header always reachable).
  function clampToViewport(panel) {
    const r = panel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth  - r.width);
    const maxTop  = Math.max(0, window.innerHeight - 40);
    const left = Math.min(Math.max(0, r.left), maxLeft);
    const top  = Math.min(Math.max(0, r.top),  maxTop);
    panel.style.left = left + 'px';
    panel.style.top  = top  + 'px';
  }

  function wireKeyboardNav() {
    if (window.__caKbBound) return;
    window.__caKbBound = true;
    window.addEventListener('keydown', (e) => {
      if (!analyzedMoves.length) return;
      // Ignore if user is typing in an input/textarea
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight') {
        if (currentHalfMove < analyzedMoves.length - 1) {
          currentHalfMove++;
          currentArrowIdx = -1;
          renderCurrentMove();
        }
      } else if (e.key === 'ArrowLeft') {
        if (currentHalfMove > 0) {
          currentHalfMove--;
          currentArrowIdx = -1;
          renderCurrentMove();
        }
      }
    }, true);
  }

  function makeDraggable(el) {
    const header = el.querySelector('.ca-header');
    let ox, oy, dragging = false;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return; // don't drag on button clicks
      // Dragging a docked panel implicitly floats it.
      if (el.dataset.docked !== 'false') {
        const r = el.getBoundingClientRect();
        applyPanelState(el, { docked: false, left: r.left, top: r.top, width: r.width, height: r.height });
      }
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      el.style.right = 'auto';
      header.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = e.clientX - ox + 'px';
      el.style.top  = e.clientY - oy + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      header.style.cursor = 'grab';
      clampToViewport(el);
      savePanelState(el);
    });
  }

  function makeResizable(el) {
    // Left-edge resize grip
    const grip = el.querySelector('#ca-grip');
    if (!grip) return;
    let resizing = false, startX, startW;
    grip.addEventListener('mousedown', (e) => {
      resizing = true;
      startX = e.clientX;
      startW = el.offsetWidth;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = startX - e.clientX;
      el.style.width = Math.max(280, startW + dx) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      savePanelState(el);
    });
  }

  // ── Panel toggle (driven by toolbar icon) ──────────────────────────────────

  function togglePanel() {
    const existing = document.getElementById('chess-analyzer-panel');
    if (existing) { existing.remove(); stopShareProbe(); return; }
    injectPanel();
    startShareProbe();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'TOGGLE_PANEL') togglePanel();
    if (msg?.type === 'ENGINE_RESULT') {
      const cb = pendingAnalysis.get(msg.id);
      if (cb) {
        pendingAnalysis.delete(msg.id);
        cb(msg.result);
      }
    }
  });
})();
