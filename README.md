# Chess Analyzer

A Chrome extension that analyzes any finished game on chess.com using a local Stockfish engine. No accounts, no API keys, no cloud calls.

## What it does

Open any completed game on chess.com, click the extension's toolbar icon, hit **Analyze Game**. The extension grabs the PGN from chess.com's Share menu, runs every position through Stockfish, classifies each move (best / good / inaccuracy / mistake / blunder), and shows the results in a side panel — while drawing the analysis **directly on chess.com's own board**, like its native Game Review:

- A **progress card** with phase labels and a live move-by-move bar while the engine works.
- Summary chips: per-player **accuracy** and an approximate **Elo**, plus counts of blunders, mistakes, inaccuracies, and good/best moves.
- Per-move card with the played move, classification badge, the engine's preferred move, and the win-probability/eval delta.
- **On the real board:** a green arrow to the engine's preferred move (shown only when the move wasn't best) and a colored **quality badge** on the square of the move that was just played.
- Top three engine lines per position (click one to draw it on the board).
- Compact "All moves" grid grouped by move number.
- `← →` keyboard navigation, synced to chess.com's own move navigation.
- A **floating / docked** panel that remembers its position and size between page loads.

## How it works

Four files, four jobs:

```
content.js   ──► UI panel, PGN extraction, classification, board overlay (runs on chess.com)
background.js ──► broker between content and offscreen
offscreen.js ──► hosts the Stockfish Web Worker at the extension origin
stockfish.js ──► the engine itself (WASM bundle)
```

### When the Analyze button enables

A finished game is detected two independent ways, either of which is enough:

1. The URL is an **analysis / review / archive** page (`/analysis/game/live/<id>/review`, etc.) — the game is over by definition there.
2. A top-level **Share** button is present on the page (finished games expose one; live games don't).

A 1.5 s poll watches for these, so the button auto-enables the moment a live game ends. Until then it reads "Waiting for game to end…".

### PGN extraction

Chess.com's own **Share → PGN** menu is the most reliable PGN source across the "viewing a finished game" contexts (just-ended live game, your archive, someone else's game, the review page). The extension drives that menu programmatically:

1. Find the **Share** button (by ARIA label, visible text, or a share-flavoured class/`data-cy` — the last covers the review page's differently-built control).
2. Click it (the modal is hidden via inline style while we read it).
3. Click the **PGN** tab.
4. Read `.share-menu-tab-pgn-textarea.value`.
5. Close the modal.

If anything in that chain fails — locale changes, markup shifts, etc. — a paste textarea appears in the panel as a manual fallback.

### Engine pipeline

Stockfish can't be spawned as a Web Worker directly from the content script — Manifest V3 forbids it because content scripts run at the host page's origin (chess.com), and the `chrome-extension://stockfish.js` URL is foreign to that origin. Instead:

1. `content.js` sends `INIT_ENGINE` / `ANALYZE_POSITION` messages to `background.js`.
2. `background.js` creates an **offscreen document** (`offscreen.html`) on first use. Offscreen documents run at the extension origin and can spawn Workers freely.
3. `offscreen.js` spawns the Stockfish Worker and talks UCI to it. On startup it configures the engine once (`setoption name Hash value 128`, `Threads`), then per position sends `position fen ...` and `go depth 12` with `MultiPV 3`.
4. Results stream back: `offscreen → background → content` via `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.
5. The content script renders.

**Speed:** the engine is configured for fast repeated searches. It does **not** issue `ucinewgame` between positions, so the transposition table stays warm across the game's moves (consecutive positions share huge amounts of structure). Combined with a depth of 12 and a 128 MB hash, a typical game analyzes in well under a minute.

### Move classification

Classification is based on the **change in win probability**, not raw centipawns — a 0.7-pawn drop is meaningless at ±8 but decisive near 0.0, and pawn thresholds can't tell those apart. Each engine eval (pawns/mate) is mapped to a 0–100 win % via a logistic curve, and the move's win-probability loss is compared against the engine's best line:

| Win-% lost vs. best   | Label      |
|-----------------------|------------|
| < 2 (or matched best) | Best       |
| < 5                   | Good       |
| < 10                  | Inaccuracy |
| < 20                  | Mistake    |
| ≥ 20                  | Blunder    |

Playing the engine's top move pins the loss to exactly 0, so search instability can never manufacture a fake "loss" on a best move. Per-move accuracy uses the lichess accuracy formula; the per-player Elo estimate is a deliberately rough, tunable approximation.

### Board overlay (arrows + badges)

Rather than a separate mini board, the analysis is drawn on chess.com's actual board so it lines up with the pieces you're looking at:

- The extension **reads the board's piece placement from the DOM** (`.piece .square-FR` elements) and matches it to the analyzed position. This means the overlay is correct regardless of board flip (playing Black) or which ply chess.com is displaying — it never relies on guessing the `?move=` numbering.
- The **green arrow** shows the engine's preferred move *instead of* the one played, and only appears when that move wasn't best (a best move needs no correction). Clicking a top engine line in the panel overrides it to draw that line.
- The **quality badge** (★ / ✓ / ?! / ? / ??) sits on the destination square of the move that produced the displayed position, colored by classification. A terminal-position check ensures the final move of the game also gets its badge.
- The overlay is an SVG layered over the board, re-synced as you navigate (and re-drawn if chess.com re-renders the board and drops it).

`chess.js` parses the PGN into a FEN per half-move, resolves SAN ↔ UCI, and supplies the square coordinates used to position arrows and badges.

## Install (developer mode)

1. Clone the repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the repo folder.
3. Pin the **Chess Analyzer** icon (gold knight) to the toolbar.
4. Visit chess.com, open a finished game, click the icon, hit Analyze.

## File layout

| File             | Role                                                              |
|------------------|-------------------------------------------------------------------|
| `manifest.json`  | MV3 manifest. Declares content script, service worker, offscreen permission. |
| `content.js`     | UI panel, PGN extraction, classification, rendering, board overlay. |
| `background.js`  | Service worker. Toolbar click → toggle panel. Brokers engine traffic. |
| `offscreen.html` | One-line shell that loads `offscreen.js`.                          |
| `offscreen.js`   | Hosts the Stockfish Worker; configures and relays UCI messages.    |
| `stockfish.js`   | Stockfish engine binary (WASM bundle).                             |
| `chess.js`       | Position parser + SAN/UCI converter.                               |
| `panel.css`      | Side-panel styling.                                                |
| `icons/`         | Toolbar icons (gold knight).                                       |

## Limitations

- **Finished games only.** Live in-progress games don't expose a PGN/Share button; the Analyze button stays disabled until one ends. Decoding chess.com's live move-stream isn't supported and isn't planned.
- **Depth 12, MultiPV 3, single-threaded WASM.** Tuned for browser speed, not engine-tournament accuracy. The bundled engine is single-threaded; swapping in a modern multi-threaded NNUE build would be faster still but needs cross-origin isolation.
- **Depends on chess.com's DOM.** PGN extraction and the board overlay read chess.com's markup (Share menu, `wc-chess-board`, piece/square classes). If chess.com changes these, the manual-paste fallback still works and the overlay simply won't draw until selectors are updated.
