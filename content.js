// content.js — chess.com analysis panel with live log

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let sfWorker      = null;
  let sfReady       = false;
  let analyzedMoves = [];
  let currentHalfMove = -1;

  // ── Stockfish (runs as Worker directly in content script) ──────────────────

  function initStockfish() {
    return new Promise((resolve, reject) => {
      sfWorker = new Worker(chrome.runtime.getURL('stockfish.js'));
      const timeout = setTimeout(() => reject(new Error('Stockfish init timeout')), 10000);

      sfWorker.onmessage = (e) => {
        if (e.data === 'readyok') {
          clearTimeout(timeout);
          sfReady = true;
          resolve();
        }
      };
      sfWorker.onerror = (e) => { clearTimeout(timeout); reject(e); };
      sfWorker.postMessage('uci');
      sfWorker.postMessage('isready');
    });
  }

  function analyzePosition(fen, depth = 14, multiPV = 3) {
    return new Promise((resolve) => {
      const lines = [];

      sfWorker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data);
        lines.push(line);
        if (line.startsWith('bestmove')) {
          resolve(parseEngineOutput(lines, line));
        }
      };

      sfWorker.postMessage(`setoption name MultiPV value ${multiPV}`);
      sfWorker.postMessage('ucinewgame');
      sfWorker.postMessage(`position fen ${fen}`);
      sfWorker.postMessage(`go depth ${depth}`);
    });
  }

  function parseEngineOutput(lines, bestmoveLine) {
    const topMoves = [];

    for (const line of lines) {
      const multipvMatch = line.match(/multipv (\d+)/);
      const scoreMatch   = line.match(/score (cp|mate) (-?\d+)/);
      const pvMatch      = line.match(/ pv (\S+)/);
      const depthMatch   = line.match(/depth (\d+)/);
      if (!multipvMatch || !scoreMatch || !pvMatch) continue;

      const idx   = parseInt(multipvMatch[1]) - 1;
      const type  = scoreMatch[1];
      const val   = parseInt(scoreMatch[2]);
      const depth = depthMatch ? parseInt(depthMatch[1]) : 0;

      if (!topMoves[idx] || depth > (topMoves[idx]._depth ?? 0)) {
        topMoves[idx] = {
          uci:    pvMatch[1],
          score:  type === 'cp' ? val / 100 : (val > 0 ? 99 : -99),
          isMate: type === 'mate',
          mateIn: type === 'mate' ? val : null,
          _depth: depth,
        };
      }
    }

    const bm = bestmoveLine.match(/bestmove (\S+)/)?.[1] ?? null;
    return { bestMove: bm, topMoves: topMoves.filter(Boolean) };
  }

  // ── PGN extraction ─────────────────────────────────────────────────────────

  // Inject a <script> into the page context so we can read window.chesscom,
  // Vue instances etc. — content scripts run in an isolated world and cannot
  // access page-level JS variables directly.
  function readFromPageContext() {
    return new Promise((resolve) => {
      const id = 'CA_PAGE_DATA_' + Date.now();
      const handler = (e) => {
        if (e.data?.type === id) {
          window.removeEventListener('message', handler);
          resolve(e.data.payload);
        }
      };
      window.addEventListener('message', handler);

      const script = document.createElement('script');
      script.textContent = `(function(){
        try {
          // username from window or nav
          const username =
            window?.chesscom?.user?.username ||
            window?.chesscom?.username ||
            document.querySelector('.username')?.textContent?.trim() ||
            document.querySelector('[class*="username"]')?.textContent?.trim() ||
            null;

          // PGN from Vue board instance
          let pgn = null;
          const board = document.querySelector('chess-board') || document.querySelector('wc-chess-board');
          if (board) {
            const vue = board.__vue__ || board.__vue3__ || board._vei;
            const game = vue?.game || vue?.$parent?.game || vue?.controller?.game || vue?.chessboard?.game;
            if (game) {
              pgn = typeof game.pgn === 'function' ? game.pgn() : game.pgn;
            }
          }

          window.postMessage({ type: '${id}', payload: { username, pgn } }, '*');
        } catch(e) {
          window.postMessage({ type: '${id}', payload: { username: null, pgn: null, err: e.message } }, '*');
        }
      })();`;
      document.documentElement.appendChild(script);
      script.remove();

      // timeout fallback
      setTimeout(() => { window.removeEventListener('message', handler); resolve({}); }, 2000);
    });
  }

  async function getPGN() {
    const liveMatch  = location.href.match(/chess\.com\/game\/live\/(\d+)/);
    const dailyMatch = location.href.match(/chess\.com\/game\/daily\/(\d+)/);
    const gameId   = liveMatch?.[1] || dailyMatch?.[1];
    const gameType = liveMatch ? 'live' : dailyMatch ? 'daily' : null;

    // Try reading username + pgn from page JS context first
    log('Reading game data from page context...', 'info');
    const pageData = await readFromPageContext();
    const username = pageData.username || null;
    log(`Page context → username: "${username || 'not found'}", pgn: ${pageData.pgn ? 'found ✓' : 'not found'}`, pageData.pgn ? 'ok' : 'warn');

    if (pageData.pgn) return pageData.pgn;

    if (gameId && gameType) {
      log(`Trying chess.com public API (game ${gameId})...`, 'info');
      if (username) {
        const pgn = await fetchPGNFromPublicAPI(username, gameId, gameType);
        if (pgn) { log('Loaded from public API ✓', 'ok'); return pgn; }
      }

      log('Trying internal callback API...', 'warn');
      const pgn2 = await fetchPGNFromCallback(gameType, gameId);
      if (pgn2) { log('Loaded from callback API ✓', 'ok'); return pgn2; }
    }

    log('All API methods failed — trying DOM reconstruction...', 'warn');
    return reconstructPGNFromDOM();
  }

  async function fetchPGNFromPublicAPI(username, gameId, gameType) {
    for (let offset = 0; offset <= 1; offset++) {
      const d     = new Date(new Date().getFullYear(), new Date().getMonth() - offset, 1);
      const year  = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      try {
        log(`  api.chess.com/pub/player/${username}/games/${year}/${month}`, 'info');
        const res = await fetch(`https://api.chess.com/pub/player/${username}/games/${year}/${month}`);
        if (!res.ok) { log(`  → HTTP ${res.status}`, 'warn'); continue; }
        const data = await res.json();
        log(`  → Got ${data.games?.length ?? 0} games`, 'info');
        const game = data.games?.find((g) => g.url === `https://www.chess.com/game/${gameType}/${gameId}`);
        if (game?.pgn) return game.pgn;
        log(`  → Game ${gameId} not found in this month`, 'warn');
      } catch (e) { log(`  → Error: ${e.message}`, 'error'); }
    }
    return null;
  }

  async function fetchPGNFromCallback(type, gameId) {
    try {
      const url = `https://www.chess.com/callback/${type}/game/${gameId}`;
      log(`  ${url}`, 'info');
      const res = await fetch(url, { credentials: 'include' });
      log(`  → HTTP ${res.status}`, res.ok ? 'info' : 'warn');
      if (!res.ok) return null;
      const data = await res.json();
      return data?.game?.pgn || data?.pgn || null;
    } catch (e) { log(`  → Error: ${e.message}`, 'error'); return null; }
  }

  function reconstructPGNFromDOM() {
    const container = document.querySelector('.moves-wrapper, .move-list, [class*="moves"]');
    if (!container) { log('No move list container found in DOM', 'error'); return null; }
    const pat = /^([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?|O-O-O|O-O)$/;
    const candidates = [...container.querySelectorAll('span,div')]
      .map((el) => el.textContent.trim()).filter((t) => pat.test(t));
    log(`DOM reconstruction found ${candidates.length} move tokens`, candidates.length ? 'ok' : 'warn');
    if (!candidates.length) return null;
    return candidates.map((m, i) => (i % 2 === 0 ? `${Math.floor(i/2)+1}. ` : '') + m).join(' ');
  }

  // ── Move classification ────────────────────────────────────────────────────

  const CLASS_THRESHOLDS = [
    [0.2,  'best'],
    [0.5,  'good'],
    [1.0,  'inaccuracy'],
    [2.0,  'mistake'],
    [Infinity, 'blunder'],
  ];

  function classifyDelta(delta) {
    for (const [threshold, label] of CLASS_THRESHOLDS) {
      if (delta < threshold) return label;
    }
    return 'blunder';
  }

  // ── GPT explanation ────────────────────────────────────────────────────────

  async function getExplanation(move, apiKey) {
    const { moveNumber, color, played, bestMove, classification, scoreDelta, fen } = move;
    const prompt = `You are a chess coach. Explain in 2-3 sentences for a beginner.
Position (FEN): ${fen}
Move ${moveNumber} (${color}) played: ${played} — ${classification} (${scoreDelta?.toFixed(2)} pawn drop)
Engine best: ${bestMove}
Why was "${played}" a ${classification}? What makes "${bestMove}" better? Be specific.`;

    const res = await chrome.runtime.sendMessage({ type: 'GPT_EXPLAIN', prompt, apiKey });
    return res?.text ?? null;
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
    viewEl.innerHTML = '';
    summaryEl.innerHTML = '';
    logClear();

    // 1. Load PGN
    const pgn = await getPGN();
    if (!pgn) {
      log('Could not read game — make sure it is finished and you are on /game/live/... or /game/daily/...', 'error');
      btn.disabled = false;
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
      btn.disabled = false;
      return;
    }

    log(`Game loaded — ${positions.length} moves to analyze`, 'ok');

    // 3. Init Stockfish
    if (!sfReady) {
      log('Starting Stockfish engine...', 'info');
      try {
        await initStockfish();
        log('Stockfish ready ✓', 'ok');
      } catch (e) {
        log('Stockfish failed to start: ' + e.message, 'error');
        btn.disabled = false;
        return;
      }
    } else {
      log('Stockfish already running ✓', 'ok');
    }

    // 4. Get API key
    const { openaiApiKey } = await chrome.storage.sync.get('openaiApiKey');
    if (!openaiApiKey) {
      log('No API key set — open extension popup to add your OpenAI key', 'warn');
    }

    // 5. Analyze each position
    const results = [];
    for (let i = 0; i < positions.length; i++) {
      const { fen, san, moveNumber, color } = positions[i];
      log(`[${i + 1}/${positions.length}] Stockfish analyzing move ${moveNumber}. ${color}: ${san}...`, 'engine');

      const engineData = await analyzePosition(fen, 14, 3);
      const bestMove   = engineData.bestMove;
      const bestScore  = engineData.topMoves[0]?.score ?? 0;
      const playedData = engineData.topMoves.find((m) => m.uci === bestMove);
      // If played move IS the best move, delta = 0; otherwise estimate
      const playedScore = (engineData.topMoves[0]?.uci === bestMove) ? bestScore
                        : (engineData.topMoves[1]?.score ?? bestScore - 0.5);
      const delta = Math.max(0, bestScore - playedScore);
      const classification = classifyDelta(delta);

      const topStr = engineData.topMoves.map((m, j) =>
        `#${j+1} ${m.uci} (${m.score > 0 ? '+' : ''}${m.score.toFixed(2)})`
      ).join(' | ');

      log(
        `→ Best: <strong>${bestMove}</strong> | Top moves: ${topStr} | Classification: <span class="ca-log-${classification}">${classification}</span>`,
        'result'
      );

      results.push({ index: i, moveNumber, color, played: san, fen, engineData, bestMove, scoreDelta: delta, classification });
    }

    // 6. GPT explanations for blunders/mistakes/inaccuracies
    analyzedMoves = results;
    if (openaiApiKey) {
      const needGPT = results.filter((m) => ['blunder', 'mistake', 'inaccuracy'].includes(m.classification));
      log(`─── Stockfish done. Requesting GPT explanations for ${needGPT.length} moves... ───`, 'section');

      for (const move of needGPT) {
        log(`[GPT] Explaining move ${move.moveNumber}. ${move.color}: ${move.played} (${move.classification})...`, 'gpt');
        const explanation = await getExplanation(move, openaiApiKey);
        move.explanation = explanation;
        if (explanation) {
          log(`→ "${explanation.slice(0, 80)}${explanation.length > 80 ? '…' : ''}"`, 'gpt-result');
        } else {
          log('→ No explanation returned', 'warn');
        }
      }
    } else {
      log('Skipping GPT (no API key)', 'warn');
    }

    // 7. Summary stats
    const counts = { blunder: 0, mistake: 0, inaccuracy: 0, good: 0, best: 0 };
    for (const m of analyzedMoves) counts[m.classification] = (counts[m.classification] ?? 0) + 1;
    log(`─── Analysis complete ───`, 'section');
    log(`?? ${counts.blunder} blunders  ? ${counts.mistake} mistakes  ?! ${counts.inaccuracy} inaccuracies  ✓ ${counts.best + counts.good} good/best`, 'summary');

    statusEl.innerHTML = `
      <span style="color:#9c27b0">?? ${counts.blunder}</span>
      <span style="color:#f44336">? ${counts.mistake}</span>
      <span style="color:#ff9800">?! ${counts.inaccuracy}</span>
      <span style="color:#8bc34a">✓ ${counts.best + counts.good}</span>
    `;

    currentHalfMove = getCurrentHalfMoveFromURL();
    renderCurrentMove();
    renderSummaryList();
    btn.disabled = false;
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
  const CLASS_ICONS  = { best: '✓', good: '○', inaccuracy: '?!', mistake: '?', blunder: '??', unknown: '—' };

  function renderCurrentMove() {
    const el = document.getElementById('ca-view');
    if (!el) return;
    const move = analyzedMoves[currentHalfMove];
    if (!move) { el.innerHTML = `<div class="ca-nav-hint">Navigate with ← → to see move analysis</div>`; return; }

    const color = CLASS_COLORS[move.classification] ?? '#888';
    const icon  = CLASS_ICONS[move.classification]  ?? '';
    el.innerHTML = `
      <div class="ca-current-card" style="border-left-color:${color}">
        <div class="ca-current-header">
          <span class="ca-move-num">${move.moveNumber}. ${move.color}</span>
          <span class="ca-move-san">${move.played}</span>
          <span class="ca-move-badge" style="background:${color}">${icon} ${move.classification}</span>
        </div>
        ${move.bestMove && move.bestMove !== move.played
          ? `<div class="ca-best-move">Engine best: <strong>${move.bestMove}</strong>
             ${move.scoreDelta ? `<span class="ca-delta">−${move.scoreDelta.toFixed(2)} pawns</span>` : ''}</div>`
          : `<div class="ca-best-move" style="color:#4caf50">✓ Engine's top choice</div>`}
        ${move.explanation
          ? `<div class="ca-explanation">${move.explanation}</div>`
          : ''}
      </div>`;

    document.querySelectorAll('.ca-summary-row').forEach((r) => r.classList.remove('ca-active-row'));
    const row = document.getElementById(`ca-row-${currentHalfMove}`);
    if (row) { row.classList.add('ca-active-row'); row.scrollIntoView({ block: 'nearest' }); }
  }

  function renderSummaryList() {
    const el = document.getElementById('ca-summary');
    if (!el) return;
    el.innerHTML = '<div class="ca-summary-title">All moves</div>';
    for (let i = 0; i < analyzedMoves.length; i++) {
      const move  = analyzedMoves[i];
      const color = CLASS_COLORS[move.classification] ?? '#888';
      const icon  = CLASS_ICONS[move.classification]  ?? '';
      const row   = document.createElement('div');
      row.className = 'ca-summary-row';
      row.id = `ca-row-${i}`;
      row.innerHTML = `
        <span class="ca-row-num">${move.moveNumber}${move.color === 'White' ? '.' : '…'}</span>
        <span class="ca-row-san">${move.played}</span>
        <span class="ca-row-badge" style="color:${color}">${icon}</span>`;
      row.addEventListener('click', () => { currentHalfMove = i; renderCurrentMove(); });
      el.appendChild(row);
    }
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
        <div class="ca-status" id="ca-status"></div>
        <div class="ca-view" id="ca-view"></div>
        <div class="ca-log-section">
          <div class="ca-log-header">
            <span>Live Log</span>
            <button class="ca-log-toggle" id="ca-log-toggle">▼</button>
          </div>
          <div class="ca-log" id="ca-log"></div>
        </div>
        <div class="ca-summary" id="ca-summary"></div>
      </div>`;

    document.body.appendChild(panel);
    makeDraggable(panel);

    panel.querySelector('.ca-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#ca-analyze-btn').addEventListener('click', startAnalysis);
    panel.querySelector('#ca-log-toggle').addEventListener('click', () => {
      const logEl = document.getElementById('ca-log');
      const btn   = document.getElementById('ca-log-toggle');
      const hide  = logEl.style.display !== 'none';
      logEl.style.display = hide ? 'none' : 'block';
      btn.textContent = hide ? '►' : '▼';
    });

    // Dock ↔ Float toggle
    let docked = true;
    panel.querySelector('#ca-dock-btn').addEventListener('click', () => {
      docked = !docked;
      if (docked) {
        panel.style.cssText = '';  // reset to CSS defaults (sidebar)
        panel.querySelector('#ca-dock-btn').textContent = '⊞ Float';
        panel.querySelector('.ca-header').style.cursor = 'grab';
      } else {
        const r = panel.getBoundingClientRect();
        panel.style.top    = r.top + 'px';
        panel.style.right  = 'auto';
        panel.style.left   = r.left + 'px';
        panel.style.height = '600px';
        panel.style.width  = '360px';
        panel.querySelector('#ca-dock-btn').textContent = '⊟ Dock';
      }
    });

    makeDraggable(panel);
    makeResizable(panel);
    watchMoveNavigation();
  }

  function makeDraggable(el) {
    const header = el.querySelector('.ca-header');
    let ox, oy, dragging = false;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return; // don't drag on button clicks
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
      dragging = false;
      header.style.cursor = 'grab';
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
    document.addEventListener('mouseup', () => { resizing = false; });
  }

  // ── Trigger button ─────────────────────────────────────────────────────────

  function injectTriggerButton() {
    if (document.getElementById('ca-trigger')) return;
    const btn = document.createElement('button');
    btn.id = 'ca-trigger';
    btn.textContent = '♟ Analyze';
    btn.addEventListener('click', injectPanel);
    document.body.appendChild(btn);
  }

  const obs = new MutationObserver(injectTriggerButton);
  obs.observe(document.body, { childList: true, subtree: true });
  injectTriggerButton();
})();
