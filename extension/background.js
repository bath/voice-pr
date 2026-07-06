// Background service worker. The content script can't fetch localhost directly
// (Chrome blocks page/content-script access to the loopback address space), so
// all bridge traffic goes through here — the extension context, covered by
// host_permissions.
const DEFAULT_BRIDGE_URL = "http://localhost:4100";

function normalizeBridgeUrl(value) {
  const raw = String(value || DEFAULT_BRIDGE_URL).trim();
  const url = new URL(raw || DEFAULT_BRIDGE_URL);
  if (url.protocol !== "http:") throw new Error("bridge URL must use http://");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("bridge URL must point at localhost or 127.0.0.1");
  }
  return url.origin;
}

async function bridgeUrl() {
  const { bridgeUrl } = await chrome.storage.sync.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
  return normalizeBridgeUrl(bridgeUrl);
}

function replyWithBridge(sendResponse, fn) {
  bridgeUrl()
    .then((url) => fn(url))
    .catch((e) => sendResponse({ ok: false, error: String(e), bridgeUrl: DEFAULT_BRIDGE_URL }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // lazy-load the vendored WebGazer into the tab (isolated world) only when the
  // user turns on gaze — keeps 1.6MB off every PR page.
  if (msg?.type === "inject-webgazer") {
    chrome.scripting
      .executeScript({ target: { tabId: _sender.tab.id }, files: ["vendor/webgazer.js"] })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "open-options") {
    chrome.runtime.openOptionsPage(() => sendResponse({ ok: !chrome.runtime.lastError }));
    return true;
  }
  // record-start context enrichment
  if (msg?.type === "context") {
    return replyWithBridge(sendResponse, (url) =>
      fetch(`${url}/api/context?pr=${encodeURIComponent(msg.prUrl)}`)
        .then((r) => r.json())
        .then((json) => sendResponse({ ok: true, json, bridgeUrl: url }))
        .catch((e) => sendResponse({ ok: false, error: String(e), bridgeUrl: url }))
    );
  }
  // local whisper transcription of a recorded session
  if (msg?.type === "transcribe") {
    return replyWithBridge(sendResponse, (url) =>
      fetch(`${url}/api/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioB64: msg.audioB64,
          ext: msg.ext,
          timeline: msg.timeline,
          sessionId: msg.sessionId,
          prUrl: msg.prUrl,
        }),
      })
        .then((r) => r.json())
        .then((json) => sendResponse({ ok: !json.error, json, bridgeUrl: url }))
        .catch((e) => sendResponse({ ok: false, error: String(e), bridgeUrl: url }))
    );
  }
});

// Streaming: a session (/api/session) or the combined transcribe+dispatch
// (/api/dispatch). The content script opens a port; we POST and stream each
// NDJSON progress event back. The fetch lives here in the worker, so it keeps
// going even if the PR tab closes.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "session" && port.name !== "dispatch") return;
  const endpoint = port.name === "dispatch" ? "/api/dispatch" : "/api/session";
  port.onMessage.addListener(async (payload) => {
    let url = DEFAULT_BRIDGE_URL;
    try {
      url = await bridgeUrl();
      const res = await fetch(`${url}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) port.postMessage(JSON.parse(line));
        }
      }
      port.postMessage({ stage: "_end" });
    } catch (e) {
      port.postMessage({ stage: "error", detail: { message: String(e), bridgeUrl: url } });
      port.postMessage({ stage: "_end" });
    }
  });
});
