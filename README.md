# Chess Analyzer

A Chrome extension that analyzes any finished game on chess.com using a local Stockfish engine. No accounts, no API keys, no cloud calls.

## What it does

Open any completed game on chess.com, click the extension's toolbar icon, hit **Analyze Game**. The extension grabs the PGN from chess.com's Share menu, runs every position through Stockfish, classifies each move (best / good / inaccuracy / mistake / blunder), and displays the results in a side panel:

- Summary chips counting blunders, mistakes, inaccuracies, and best moves.
- Per-move card with played move, classification badge, engine's recommended move, and the delta in pawns.
- Mini board with an arrow showing either the played move or the engine's choice.
- Top three engine lines per position (click one to redraw the arrow).
- Compact "All moves" grid grouped by move number.
- `← →` keyboard navigation between moves.

## How it works

Four files, four jobs:

```
content.js   ──► UI panel + PGN extraction (runs on chess.com pages)
background.js ──► broker between content and offscreen
offscreen.js ──► hosts the Stockfish Web Worker at the extension origin
stockfish.js ──► the engine itself (Stockfish 16 Lite, WASM)
```

### PGN extraction

Chess.com's own **Share → PGN** menu is the only reliable source for PGN across the three "viewing a finished game" contexts (just-ended live game, your archive, someone else's game). The extension drives that menu programmatically:

1. Find the **Share** button by ARIA label.
2. Click it (the modal is hidden inline-style while we read).
3. Click the **PGN** tab.
4. Read `.share-menu-tab-pgn-textarea.value`.
5. Close the modal.

If anything in that chain fails — locale changes, chess.com markup shifts, etc. — a paste textarea appears in the panel as a manual fallback.

The **Analyze Game** button is disabled until a Share button is detected on the page. A 1.5 s poll watches for it to appear, so the button auto-enables the moment a live game ends.

### Engine pipeline

Stockfish can't be spawned as a Web Worker directly from the content script — Manifest V3 forbids it because content scripts run at the host page's origin (chess.com), and the chrome-extension://stockfish.js URL is foreign to that origin. Instead:

1. `content.js` sends `INIT_ENGINE` / `ANALYZE_POSITION` messages to `background.js`.
2. `background.js` creates an **offscreen document** (`offscreen.html`) on first use. Offscreen documents run at the extension origin and can spawn Workers freely.
3. `offscreen.js` spawns the Stockfish Worker, talks to it via the UCI protocol (`uci`, `position fen ...`, `go depth 14`, `setoption name MultiPV value 3`).
4. Results stream back: `offscreen → background → content` via `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.
5. The content script renders.

### Move classification

Each played move's score is compared to the engine's top choice. The delta (in pawns) maps to a classification:

| Δ from best (pawns) | Label      |
|---------------------|------------|
| < 0.2               | Best       |
| < 0.5               | Good       |
| < 1.0               | Inaccuracy |
| < 2.0               | Mistake    |
| ≥ 2.0               | Blunder    |

### Rendering

`chess.js` parses the PGN and produces a FEN per half-move. The mini board uses `chess.js.board()` to render an 8×8 unicode-piece grid; arrows are drawn as an SVG overlay positioned from algebraic square coordinates. Engine moves are returned in UCI (`e2e4`) and converted to SAN (`e4`) on render by running them back through `chess.js.move()`.

## Install (developer mode)

1. Clone the repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the repo folder.
3. Pin the **Chess Analyzer** icon to the toolbar.
4. Visit chess.com, open a finished game, click the icon, hit Analyze.

## File layout

| File             | Role                                                              |
|------------------|-------------------------------------------------------------------|
| `manifest.json`  | MV3 manifest. Declares content script, service worker, offscreen permission. |
| `content.js`     | UI panel, PGN extraction, move classification, rendering.          |
| `background.js`  | Service worker. Toolbar click → toggle panel. Brokers engine traffic. |
| `offscreen.html` | One-line shell that loads `offscreen.js`.                          |
| `offscreen.js`   | Hosts the Stockfish Worker; relays UCI messages.                   |
| `stockfish.js`   | Stockfish engine binary (WASM bundle).                             |
| `chess.js`       | Position parser + SAN converter.                                   |
| `panel.css`      | Side-panel styling.                                                |

## Limitations

- **Finished games only.** Live in-progress games don't expose a Share button; the Analyze button stays disabled until one ends. Decoding chess.com's live move-stream isn't supported and isn't planned.
- **Stockfish 16 Lite at depth 14, MultiPV 3.** Tuned for browser speed, not engine-tournament accuracy. ~1 second per position on modern hardware.
