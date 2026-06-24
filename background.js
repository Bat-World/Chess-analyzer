// background.js — service worker. Owns the offscreen document that hosts
// Stockfish, and brokers messages between content scripts and offscreen.
//
// MV3 doesn't let a content script spawn a Worker from a chrome-extension://
// URL because the content script's origin is the host page (chess.com).
// Offscreen documents run at the extension origin, so they can spawn the
// Stockfish Worker freely. We route engine traffic content → background →
// offscreen → background → content.

const OFFSCREEN_URL = 'offscreen.html';

// id → { tabId } for in-flight analyze requests
const pending = new Map();

// Resolved once OFFSCREEN_READY fires for the current offscreen document.
let readyPromise = null;
let resolveReady = null;

function freshReadyPromise() {
  readyPromise = new Promise((res) => { resolveReady = res; });
  setTimeout(() => resolveReady?.({ ok: false, error: 'Offscreen init timeout' }), 15000);
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  // Older Chrome fallback
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) {
    if (!readyPromise) readyPromise = Promise.resolve({ ok: true });
    return readyPromise;
  }
  freshReadyPromise();
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Run Stockfish chess engine in a Web Worker',
  });
  return readyPromise;
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  if (!/^https:\/\/www\.chess\.com\//.test(tab.url || '')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── From offscreen ──────────────────────────────────────────────────────
  if (msg?.type === 'OFFSCREEN_READY') {
    resolveReady?.({ ok: true });
    return;
  }
  if (msg?.type === 'OFFSCREEN_ERROR') {
    resolveReady?.({ ok: false, error: msg.error });
    return;
  }
  if (msg?.type === 'ENGINE_RESULT') {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      chrome.tabs.sendMessage(p.tabId, msg).catch(() => {});
    }
    return;
  }

  // ── From content script ─────────────────────────────────────────────────
  if (msg?.type === 'INIT_ENGINE') {
    ensureOffscreen()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async sendResponse
  }
  if (msg?.type === 'ANALYZE_POSITION') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    pending.set(msg.id, { tabId });
    ensureOffscreen().then((r) => {
      if (!r?.ok) {
        chrome.tabs.sendMessage(tabId, { type: 'ENGINE_RESULT', id: msg.id, result: null, error: r?.error }).catch(() => {});
        pending.delete(msg.id);
        return;
      }
      // Forward to offscreen; the `_to` discriminator stops other listeners.
      chrome.runtime.sendMessage({ ...msg, _to: 'offscreen' }).catch(() => {});
    });
    return;
  }
  if (msg?.type === 'STOP_ENGINE') {
    // Content aborted: tell the offscreen engine to drop its current search and
    // forget any requests still in flight for this tab (their results, if they
    // ever arrive, would be stale). Don't spin up an offscreen doc just to stop.
    const tabId = sender.tab?.id;
    if (tabId) for (const [id, p] of pending) if (p.tabId === tabId) pending.delete(id);
    hasOffscreenDocument().then((exists) => {
      if (exists) chrome.runtime.sendMessage({ type: 'STOP_ENGINE', _to: 'offscreen' }).catch(() => {});
    });
    return;
  }
});
