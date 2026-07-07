// Background service worker. Two jobs:
//
//  1. Bridge proxy. The content script can't fetch localhost directly (Chrome
//     blocks page/content-script access to the loopback address space), so all
//     bridge traffic goes through here — the extension context, covered by
//     host_permissions.
//
//  2. Cross-tab coordinator. Each PR tab dispatches independently, but the work
//     it kicks off should be visible from *every* PR tab, not just the one that
//     started it. So this worker owns a single central job registry in shared
//     storage (`voicepr:jobs`), updated as each dispatch streams. Because the
//     fetch + the writes live here — not in the tab — a job reaches its result
//     even if the origin tab was closed mid-run, and any other open PR tab sees
//     it live via storage.onChanged.
const BRIDGE = "http://localhost:4100";
const JOBS_KEY = "voicepr:jobs";
const JOBS_CAP = 40; // distinct PRs kept in the registry; oldest terminal ones drop

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
  // tray "jump" — focus the PR's existing tab, or open it if it's gone
  if (msg?.type === "focus-pr") {
    focusPr(msg.prUrl, msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // tray "dismiss" — drop a terminal job from the registry
  if (msg?.type === "dismiss-job") {
    updateJob(msg.prUrl, null).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------- central job registry -------------------------------------------
// One write path, serialized so concurrent dispatches don't clobber the map.
// The in-memory `jobs` cache mirrors storage and is hydrated once on first use;
// the worker may be torn down between events, so every update read-modifies the
// persisted map rather than trusting the cache alone.
let jobs = null;
let writeChain = Promise.resolve();
function loadJobs() {
  if (jobs) return Promise.resolve(jobs);
  return new Promise((resolve) => {
    chrome.storage.local.get(JOBS_KEY, (o) => {
      jobs = o?.[JOBS_KEY] || {};
      resolve(jobs);
    });
  });
}
// patch === null removes the entry. Returns the write's promise.
function updateJob(prUrl, patch) {
  if (!prUrl) return Promise.resolve();
  writeChain = writeChain.then(async () => {
    const map = await loadJobs();
    if (patch === null) {
      delete map[prUrl];
    } else {
      const prev = map[prUrl] || {};
      map[prUrl] = { ...prev, ...patch, prUrl, updatedAt: Date.now() };
    }
    prune(map);
    await new Promise((res) => chrome.storage.local.set({ [JOBS_KEY]: map }, res));
  });
  return writeChain;
}
// Keep the registry bounded: drop the oldest *terminal* jobs past the cap.
// Active jobs are never pruned.
function prune(map) {
  const entries = Object.values(map);
  if (entries.length <= JOBS_CAP) return;
  const terminal = entries
    .filter((j) => j.status === "done" || j.status === "failed" || j.status === "error")
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  let over = entries.length - JOBS_CAP;
  for (const j of terminal) {
    if (over-- <= 0) break;
    delete map[j.prUrl];
  }
}

function parsePr(prUrl) {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl || "");
  return m ? { repo: m[1], prNumber: m[2] } : {};
}

// Map a stream event onto a registry patch. Mirrors the tab's pipeline labels
// but flattened to a single status line — the tray shows one line per PR, not a
// checklist.
function patchForEvent(ev) {
  const { stage, detail: d = {} } = ev;
  if (stage === "result" || stage === "done") {
    const ok = d.status === "done";
    return {
      status: ok ? "done" : d.status === "failed" ? "failed" : "error",
      label: d.summary || (ok ? "Done" : "Incomplete"),
      summary: d.summary || "",
      workItemId: d.workItemId ?? null,
      refinery: d.refinery?.status ?? null,
      trailCommentUrl: d.trailCommentUrl ?? null,
    };
  }
  if (stage === "agent-log") return null; // noise
  if (stage === "error") return { status: "error", label: `Failed — ${d.message || "error"}` };
  switch (stage) {
    case "transcribing": return { status: "running", label: "Transcribing audio…" };
    case "transcribed": return { status: "running", label: `Heard ${d.count ?? 0} comment${d.count === 1 ? "" : "s"}` };
    case "pr-loaded": return { status: "running", label: "Loaded PR", branch: d.branch ?? null };
    case "context": return { status: "running", label: "Gathering context…" };
    case "project-ready": return { status: "running", label: "Registering repo…" };
    case "work-filed": return { status: "running", label: d.id ? `Filed ${d.id}` : "Filed work item", workItemId: d.id ?? null };
    case "dispatching": return { status: "running", label: "In the orchestrator's hands" };
    case "work-status": return { status: "running", label: `Orchestrator working${d.status ? ` · ${d.status}` : ""}` };
    case "refinery": return { status: "running", label: `Refinery${d.status ? ` · ${d.status}` : ""}` };
    case "commenting": return { status: "running", label: "Posting intent trail…" };
    case "branch-queued": return { status: "queued", label: `Queued${d.position ? ` · position ${d.position}` : ""}…` };
    case "branch-dispatch-start": return { status: "running", label: "Registering repo…" };
    default: return null;
  }
}

// ---------- streaming dispatch ----------------------------------------------
// The content script opens a port; we POST and stream each NDJSON progress event
// back to it (for its rich per-PR pipeline) AND fold each event into the central
// registry (for every tab's tray). The fetch lives here in the worker, so it
// keeps going — and keeps updating the registry — even if the PR tab closes.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "dispatch") return;
  const originTabId = port.sender?.tab?.id ?? null;
  port.onMessage.addListener(async (payload) => {
    const prUrl = payload?.prRef;
    updateJob(prUrl, {
      ...parsePr(prUrl),
      sessionId: payload?.sessionId ?? null,
      status: "queued",
      label: "Dispatching…",
      originTabId,
      startedAt: Date.now(),
      summary: "",
      workItemId: null,
      refinery: null,
      trailCommentUrl: null,
      error: null,
    });
    let sawResult = false;
    try {
      const res = await fetch(`${BRIDGE}/api/dispatch`, {
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
          if (!line) continue;
          const ev = JSON.parse(line);
          try { port.postMessage(ev); } catch {} // tab may be gone; registry still updates
          const patch = patchForEvent(ev);
          if (patch) updateJob(prUrl, patch);
          if (ev.stage === "result" || ev.stage === "done") {
            sawResult = true;
            // the orchestrator has it now — clear the tab's crash-safe pending
            // copy centrally, so a reopened origin tab doesn't offer to resend.
            try { chrome.storage.local.remove(`voicepr:pending:${prUrl}`); } catch {}
          }
        }
      }
      try { port.postMessage({ stage: "_end" }); } catch {}
      if (!sawResult) updateJob(prUrl, { status: "error", label: "Bridge closed before finishing" });
    } catch (e) {
      try {
        port.postMessage({ stage: "error", detail: { message: String(e) } });
        port.postMessage({ stage: "_end" });
      } catch {}
      if (!sawResult) updateJob(prUrl, { status: "error", label: String(e), error: String(e) });
    }
  });
});

// ---------- jump to a PR tab ------------------------------------------------
// Prefer the tab that started the job; fall back to any tab already on that PR;
// open a fresh tab only if none exists.
async function focusPr(prUrl, tabId) {
  if (!prUrl) return;
  const activate = async (tab) => {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  };
  if (tabId != null) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t?.url && t.url.startsWith(prUrl)) return activate(t);
    } catch {} // tab closed — fall through
  }
  const tabs = await chrome.tabs.query({ url: "https://github.com/*" });
  const match = tabs.find((t) => t.url && t.url.startsWith(prUrl));
  if (match) return activate(match);
  await chrome.tabs.create({ url: prUrl });
}
