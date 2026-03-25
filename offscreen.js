// offscreen.js — runs Stockfish in a Web Worker, relays results to background

let worker = null;
let currentResolve = null;
let currentId = null;
let buffer = [];
let collecting = false;

function initWorker() {
  worker = new Worker(chrome.runtime.getURL('stockfish.js'));

  worker.onmessage = (e) => {
    const line = e.data;

    if (collecting) {
      buffer.push(line);
    }

    // Engine signals it's done with "bestmove"
    if (line.startsWith('bestmove') && currentResolve) {
      collecting = false;
      const result = parseEngineOutput(buffer, line);
      buffer = [];
      currentResolve(result);
      currentResolve = null;

      // Send result back to background
      chrome.runtime.sendMessage({
        type: 'ENGINE_RESULT',
        id: currentId,
        result,
      });
      currentId = null;
    }
  };

  worker.onerror = (e) => console.error('Stockfish worker error:', e);

  // Init engine
  worker.postMessage('uci');
  worker.postMessage('setoption name MultiPV value 3');
  worker.postMessage('isready');
}

function parseEngineOutput(lines, bestmoveLine) {
  const topMoves = [];

  for (const line of lines) {
    // e.g. "info depth 18 seldepth 24 multipv 1 score cp 35 ... pv e2e4 ..."
    const multipvMatch = line.match(/multipv (\d+)/);
    const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
    const pvMatch = line.match(/ pv (\S+)/);
    const depthMatch = line.match(/depth (\d+)/);

    if (multipvMatch && scoreMatch && pvMatch) {
      const pvIndex = parseInt(multipvMatch[1]) - 1;
      const scoreType = scoreMatch[1];
      const scoreValue = parseInt(scoreMatch[2]);
      const uci = pvMatch[1];
      const depth = depthMatch ? parseInt(depthMatch[1]) : 0;

      // Only keep the deepest info line per multipv slot
      if (!topMoves[pvIndex] || depth > (topMoves[pvIndex]._depth ?? 0)) {
        topMoves[pvIndex] = {
          uci,
          score: scoreType === 'cp' ? scoreValue / 100 : (scoreValue > 0 ? 100 : -100),
          isMate: scoreType === 'mate',
          mateIn: scoreType === 'mate' ? scoreValue : null,
          _depth: depth,
        };
      }
    }
  }

  const bestmoveMatch = bestmoveLine.match(/bestmove (\S+)/);
  const bestMove = bestmoveMatch?.[1] ?? null;

  return {
    bestMove,
    topMoves: topMoves.filter(Boolean),
  };
}

// Listen for analyze requests from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ANALYZE_POSITION') {
    currentId = msg.id;
    buffer = [];
    collecting = true;

    worker.postMessage(`setoption name MultiPV value ${msg.multiPV ?? 3}`);
    worker.postMessage('ucinewgame');
    worker.postMessage(`position fen ${msg.fen}`);
    worker.postMessage(`go depth ${msg.depth ?? 18}`);
  }
});

// Notify background we're ready
initWorker();
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
