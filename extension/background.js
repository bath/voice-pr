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
  // local whisper transcription of a recorded session
  if (msg?.type === "transcribe") {
    fetch(`${BRIDGE}/api/transcribe`, {
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
      .then((json) => sendResponse({ ok: !json.error, json }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

// Streaming: a live session. The content script opens a port; we POST the
// session and stream each NDJSON progress event back over the port.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "session") return;
  port.onMessage.addListener(async (payload) => {
    try {
      const res = await fetch(`${BRIDGE}/api/session`, {
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
