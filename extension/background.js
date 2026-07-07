// Background service worker. The content script can't fetch localhost directly
// (Chrome blocks page/content-script access to the loopback address space), so
// all bridge traffic goes through here — the extension context, covered by
// host_permissions.
const BRIDGE = "http://localhost:4100";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // record-start context enrichment
  if (msg?.type === "context") {
    fetch(`${BRIDGE}/api/context?pr=${encodeURIComponent(msg.prUrl)}`)
      .then((r) => r.json())
      .then((json) => sendResponse({ ok: true, json }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // end-to-end preflight (debug panel) — probe every dispatch dependency
  if (msg?.type === "preflight") {
    fetch(`${BRIDGE}/api/preflight`)
      .then((r) => r.json())
      .then((json) => sendResponse({ ok: true, json }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // local whisper transcription of a recorded session
  if (msg?.type === "transcribe") {
    fetch(`${BRIDGE}/api/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioB64: msg.audioB64,
        ext: msg.ext,
        timeline: msg.timeline,
        audioStartMs: msg.audioStartMs,
        sessionId: msg.sessionId,
        prUrl: msg.prUrl,
      }),
    })
      .then((r) => r.json())
      .then((json) => sendResponse({ ok: !json.error, json }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
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
    try {
      const res = await fetch(`${BRIDGE}${endpoint}`, {
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
      port.postMessage({ stage: "error", detail: { message: String(e) } });
      port.postMessage({ stage: "_end" });
    }
  });
});
