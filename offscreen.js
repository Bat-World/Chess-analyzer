// offscreen.js — hosts the Stockfish Web Worker at the extension origin.
// The Worker is spawned here (not in the content script) because content
// scripts have the host page's origin and can't load chrome-extension://
// scripts as Workers in MV3.

let worker = null;
let buffer = [];
let collecting = false;
let currentId = null;
let initialized = false;

function initWorker() {
  try {
    worker = new Worker(chrome.runtime.getURL('stockfish.js'));
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: 'Failed to spawn Stockfish: ' + e.message });
    return;
  }

  worker.onmessage = (e) => {
    const line = typeof e.data === 'string' ? e.data : String(e.data);

    if (!initialized) {
      if (line === 'readyok') {
        initialized = true;
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
      }
      return;
    }

    if (collecting) buffer.push(line);

    if (line.startsWith('bestmove') && currentId !== null) {
      collecting = false;
      const result = parseEngineOutput(buffer, line);
      const id = currentId;
      currentId = null;
      buffer = [];
      chrome.runtime.sendMessage({ type: 'ENGINE_RESULT', id, result });
    }
  };

  worker.onerror = (e) => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: 'Worker error: ' + (e.message || 'unknown') });
  };

  worker.postMessage('uci');
  // Configure once, up front. A big hash table + (if the build supports it)
  // multiple threads is what makes repeated searches across one game fast.
  // This asm.js build is single-threaded, so Threads is a no-op here but is
  // harmless and future-proofs a multi-threaded engine swap.
  const cores = Math.max(1, (self.navigator?.hardwareConcurrency || 1) - 1);
  worker.postMessage(`setoption name Threads value ${cores}`);
  worker.postMessage('setoption name Hash value 128');
  worker.postMessage('isready');
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?._to !== 'offscreen') return;
  if (msg.type === 'STOP_ENGINE') {
    // Abandon the current search and reset our collector. `stop` makes the
    // engine emit a final `bestmove`, but with currentId cleared the handler
    // above ignores it — so the next ANALYZE_POSITION starts from a clean slate.
    if (worker) { try { worker.postMessage('stop'); } catch { /* noop */ } }
    currentId = null;
    collecting = false;
    buffer = [];
    return;
  }
  if (msg.type === 'ANALYZE_POSITION') {
    if (!initialized || !worker) return;
    currentId = msg.id;
    buffer = [];
    collecting = true;
    worker.postMessage(`setoption name MultiPV value ${msg.multiPV ?? 3}`);
    // NOTE: deliberately no `ucinewgame` here. Positions within one game share
    // enormous search structure, so keeping the transposition table warm across
    // moves makes each subsequent search far faster. `ucinewgame` would wipe it.
    worker.postMessage(`position fen ${msg.fen}`);
    worker.postMessage(`go depth ${msg.depth ?? 14}`);
  }
});

initWorker();
