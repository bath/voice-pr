// Background service worker. Three jobs:
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
//     it live via storage.onChanged. (This is the #44 "centralized background
//     work" substrate the hub is built on.)
//
//  3. (D1) Global signal. The count of active jobs is mirrored onto the toolbar
//     action badge, so "3 running" is visible on ANY tab — even a non-GitHub one
//     — the moment the in-page hub is collapsed or you've navigated away. This
//     closes the "no signal when the panel is closed" gap from the UX memo
//     without a second in-page home.
const BRIDGE = "http://localhost:4100";
const JOBS_KEY = "voicepr:jobs";
const JOBS_CAP = 40; // distinct PRs kept in the registry; oldest terminal ones drop
const PREFLIGHT_TTL_MS = 60_000;
let preflightCache = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Passive page-load preparation: deterministic context + git workspace only.
  // The bridge does not create or message a Cursor agent on this endpoint.
  if (msg?.type === "prepare") {
    fetch(`${BRIDGE}/api/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prRef: msg.prUrl,
        pageLoadedAt: msg.pageLoadedAt,
      }),
    })
      .then((r) => r.json())
      .then((json) => sendResponse({ ok: !json.error, json }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // Record-start pre-warm. The bridge returns PR context as soon as it has
  // launched the workspace + agent analysis in the background.
  if (msg?.type === "warm") {
    fetch(`${BRIDGE}/api/warm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prRef: msg.prUrl,
        sessionId: msg.sessionId,
        recordStartedAt: msg.recordStartedAt,
      }),
    })
      .then((r) => r.json())
      .then((json) => sendResponse({ ok: !json.error, json }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
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
    getPreflight(!!msg.force)
      .then((json) => sendResponse({ ok: !json.error, json }))
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
  // hub "jump" — focus the PR's existing tab, or open it if it's gone
  if (msg?.type === "focus-pr") {
    focusPr(msg.prUrl, msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // hub "dismiss" — drop a terminal job from the registry
  if (msg?.type === "dismiss-job") {
    updateJob(msg.prUrl, null).then(() => sendResponse({ ok: true }));
    return true;
  }
  // hub "clear finished" — drop every terminal job in one write. Active jobs stay.
  if (msg?.type === "clear-finished-jobs") {
    clearFinishedJobs().then((removed) => sendResponse({ ok: true, removed }));
    return true;
  }
});

async function getPreflight(force = false) {
  if (
    !force &&
    preflightCache &&
    Date.now() - preflightCache.at < PREFLIGHT_TTL_MS
  ) {
    return preflightCache.value;
  }
  const response = await fetch(`${BRIDGE}/api/preflight`);
  const value = await response.json();
  if (!value.error) preflightCache = { at: Date.now(), value };
  return value;
}

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
    refreshBadge(map);
  });
  return writeChain;
}
// Sweep every terminal (done/failed/error) job from the registry in a single
// serialized write. Active jobs are left in place. Returns the count removed.
const TERMINAL = new Set(["done", "failed", "error"]);
function clearFinishedJobs() {
  writeChain = writeChain.then(async () => {
    const map = await loadJobs();
    let removed = 0;
    for (const [prUrl, job] of Object.entries(map)) {
      if (TERMINAL.has(job.status)) { delete map[prUrl]; removed++; }
    }
    if (removed) {
      await new Promise((res) => chrome.storage.local.set({ [JOBS_KEY]: map }, res));
      refreshBadge(map);
    }
    return removed;
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

// ---------- (D1) toolbar badge: the always-visible global signal ------------
// The active-job count (running + queued) painted onto the action icon. Visible
// on every tab regardless of whether any PR panel is open. Empty when idle so
// the icon stays quiet.
const ACTIVE = new Set(["running", "queued"]);
function activeCount(map) {
  return Object.values(map || {}).filter((j) => ACTIVE.has(j.status)).length;
}
function refreshBadge(map) {
  if (!chrome.action) return; // older channels: no-op
  const n = activeCount(map);
  try {
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
    chrome.action.setTitle({
      title: n ? `voice-pr — ${n} job${n === 1 ? "" : "s"} in flight` : "voice-pr — no work in flight",
    });
  } catch {}
}
// Paint the badge on wake-up (the worker is torn down between events) and keep
// it honest if the registry is edited from anywhere else.
loadJobs().then(refreshBadge);
chrome.runtime.onStartup?.addListener(() => loadJobs().then(refreshBadge));
chrome.runtime.onInstalled?.addListener(() => loadJobs().then(refreshBadge));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[JOBS_KEY]) {
    jobs = changes[JOBS_KEY].newValue || {};
    refreshBadge(jobs);
  }
});

function parsePr(prUrl) {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl || "");
  return m ? { repo: m[1], prNumber: m[2] } : {};
}

// Map a stream event onto a registry patch. Mirrors the tab's pipeline labels
// but flattened to a single status line — the fleet shows one line per PR, not a
// checklist.
function patchForEvent(ev) {
  const { stage, detail: d = {} } = ev;
  if (stage === "result" || stage === "done") {
    const ok = d.status === "done";
    return {
      status: ok ? "done" : d.status === "failed" ? "failed" : "error",
      label: d.summary || (ok ? "Done" : "Incomplete"),
      summary: d.summary || "",
      agentId: d.agentId ?? null,
      runId: d.runId ?? null,
      metrics: d.metrics ?? null,
      actionSummary: d.actionSummary ?? null,
      trailCommentUrl: d.trailCommentUrl ?? null,
      trailCommentPending: d.trailCommentPending ?? false,
    };
  }
  if (stage === "agent-log") return null; // noise
  if (stage === "error") return { status: "error", label: `Failed — ${d.message || "error"}`, error: d.message || "error" };
  switch (stage) {
    case "transcribing": return { status: "running", label: "Transcribing audio…" };
    case "transcribed": return { status: "running", label: `Heard ${d.count ?? 0} comment${d.count === 1 ? "" : "s"}` };
    case "pr-loaded": return { status: "running", label: "Loaded PR", branch: d.branch ?? null };
    case "context": return { status: "running", label: "Context ready" };
    case "agent-starting": return { status: "running", label: "Connecting prepared agent…" };
    case "agent-warm-waiting": return { status: "running", label: `Waiting for agent setup · ${Math.max(0, Math.floor((d.elapsedMs || 0) / 1000))}s` };
    case "agent-ready": return { status: "running", label: d.warmWaitMs ? `Agent ready · waited ${(d.warmWaitMs / 1000).toFixed(1)}s` : "Agent ready" };
    case "interpreting": return { status: "running", label: "Interpreting requests…" };
    case "agent-running": return { status: "running", label: "Agent editing and validating…", agentId: d.agentId ?? null, runId: d.runId ?? null };
    case "actions-compiled": return {
      status: "running",
      label: `${d.totalActions ?? 0} action${d.totalActions === 1 ? "" : "s"} compiled${d.blockedEffects ? ` · ${d.blockedEffects} ${d.blockedEffects === 1 ? "needs" : "need"} permission` : ""}`,
      actionSummary: d,
    };
    case "agent-pushing": return { status: "running", label: `Pushing to ${d.branch || "PR branch"}…` };
    case "agent-push-blocked": return { status: "running", label: "Prepared locally · push needs permission" };
    case "agent-finished": return { status: "running", label: d.commits ? `Pushed ${d.commits} commit${d.commits === 1 ? "" : "s"}` : "Review complete" };
    case "comment-queued": return { status: "running", label: "Intent trail posting…" };
    case "commenting": return { status: "running", label: "Posting intent trail…" };
    case "branch-queued": return { status: "queued", label: `Queued${d.position ? ` · position ${d.position}` : ""}…` };
    default: return null;
  }
}

// ---------- streaming dispatch ----------------------------------------------
// The content script opens a port; we POST and stream each NDJSON progress event
// back to it (for its rich per-PR pipeline) AND fold each event into the central
// registry (for every tab's hub + the toolbar badge). The fetch lives here in
// the worker, so it keeps going — and keeps updating the registry — even if the
// PR tab closes.
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
      agentId: null,
      runId: null,
      metrics: null,
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
            // the agent completed — clear the tab's crash-safe pending
            // copy centrally, so a reopened origin tab doesn't offer to resend.
            try { chrome.storage.local.remove([`voicepr:pending:${prUrl}`, `voicepr:handedoff:${prUrl}`]); } catch {}
          }
        }
      }
      try { port.postMessage({ stage: "_end" }); } catch {}
      if (!sawResult) updateJob(prUrl, { status: "error", label: "Bridge closed before finishing", error: "bridge closed before finishing" });
    } catch (e) {
      // Relay failure (bridge unreachable / crashed): tag it with a code so the
      // content script's diagnostic report can point an agent at this layer.
      console.error("[voice-pr] dispatch relay failed:", e);
      try {
        port.postMessage({ stage: "error", detail: { message: String(e), code: "background.relay.error", loc: "extension/background.js" } });
        port.postMessage({ stage: "_end" });
      } catch {}
      if (!sawResult) updateJob(prUrl, { status: "error", label: String(e), error: String(e) });
    }
  });
});

// ---------- author fast-path: keyboard shortcut -----------------------------
// (D3's one cost is the extra tap to record; the memo's mitigation is a keyboard
// shortcut + a deep-link affordance.) The command tells the active PR tab's
// content script to skip the hub and arm capture directly. Still an explicit
// user action — Law 1 holds.
chrome.commands?.onCommand.addListener((command) => {
  if (command !== "record-on-pr") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(tab.url || ""))
      chrome.tabs.sendMessage(tab.id, { type: "vp-record-now" });
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
