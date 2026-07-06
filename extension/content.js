// voice-pr content script — lives on a GitHub PR page.
// Press record, scroll the diff, and talk. Each spoken chunk is anchored to the
// file+line centered in your viewport when you said it, then the whole session
// is handed to the local bridge → orchestrator.
(function () {
  const BRIDGE = "http://localhost:4100";
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return;
  const prUrl = `${location.origin}/${m[1]}/${m[2]}/pull/${m[3]}`;
  if (document.getElementById("voicepr-root")) return; // guard against re-inject

  let recording = false;
  let segments = [];
  let anchorTimer = null;
  let sessionId = null; // correlates the recording + transcript + orchestrator run
  // audio recording + anchor timeline (mapped to transcript on the bridge)
  let mediaRecorder = null,
    mediaStream = null,
    chunks = [],
    recStart = 0,
    timeline = [],
    paused = false,
    dispatched = false,
    stopResolve = null,
    activePort = null;
  function pushTimeline() {
    if (!recording) return;
    timeline.push({ t: Date.now() - recStart, ...anchorNow() });
  }

  // ---------- viewport anchoring ----------------------------------------------
  // Resolve which file the given node lives in (GitHub diff DOM).
  function fileOf(el) {
    const f = el && el.closest?.("[data-tagsearch-path], .file, .js-file");
    if (!f) return null;
    return (
      f.getAttribute?.("data-tagsearch-path") ||
      f.querySelector?.(".file-header")?.getAttribute("data-path") ||
      f.querySelector?.("[data-path]")?.getAttribute("data-path") ||
      null
    );
  }
  // The new-file line number for a DOM node's diff row (right side of the diff).
  function lineOf(el) {
    const row = el && (el.nodeType === 3 ? el.parentElement : el)?.closest?.("tr");
    if (!row) return null;
    const nums = [...row.querySelectorAll("td.blob-num[data-line-number]")];
    const n = nums.length ? parseInt(nums[nums.length - 1].getAttribute("data-line-number"), 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  // Track what the user last selected / clicked in the diff — richer than the
  // viewport, and what people actually do ("highlight this, then say what's wrong").
  let lastSel = null,
    lastClick = null;
  function selAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const startEl = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
    const file = fileOf(startEl);
    if (!file) return null;
    const a = lineOf(sel.anchorNode),
      b = lineOf(sel.focusNode);
    const lines = [a, b].filter((x) => x != null);
    return {
      file,
      line: lines.length ? Math.min(...lines) : null,
      endLine: lines.length ? Math.max(...lines) : null,
      snippet: text.slice(0, 400),
    };
  }
  document.addEventListener("mouseup", () => {
    const s = selAnchor();
    if (s) lastSel = { ...s, ts: Date.now() };
    pushTimeline();
  });
  document.addEventListener("mousedown", (e) => {
    const file = fileOf(e.target),
      line = lineOf(e.target);
    if (file && line != null) lastClick = { file, line, ts: Date.now() };
    pushTimeline();
  });

  // Viewport-center fallback (what's on screen if you didn't select/click).
  function anchorViewport() {
    const cy = window.innerHeight / 2;
    const el = document.elementFromPoint(Math.min(window.innerWidth / 2, 400), cy);
    const file = fileOf(el);
    if (!file) return { file: null, line: null };
    let best = null,
      bestDist = Infinity;
    el.closest("[data-tagsearch-path], .file, .js-file")
      ?.querySelectorAll("td.blob-num[data-line-number]")
      .forEach((td) => {
        const r = td.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - cy);
        if (d < bestDist) (bestDist = d), (best = td);
      });
    const line = best ? parseInt(best.getAttribute("data-line-number"), 10) : null;
    return { file, line: Number.isFinite(line) ? line : null };
  }

  // Priority: live selection → recent selection → recent click → viewport.
  function anchorNow() {
    const live = selAnchor();
    if (live) return live;
    const fresh = (x) => x && Date.now() - x.ts < 12000;
    if (fresh(lastSel)) return { file: lastSel.file, line: lastSel.line, endLine: lastSel.endLine, snippet: lastSel.snippet };
    if (fresh(lastClick)) return { file: lastClick.file, line: lastClick.line };
    return anchorViewport();
  }
  function fmtAnchor(a) {
    if (!a || !a.file) return "no selection/line — will infer from words";
    const range = a.endLine && a.endLine !== a.line ? `${a.line}-${a.endLine}` : a.line || "";
    return `${a.file}${range ? ":" + range : ""}`;
  }

  // ---------- UI --------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "voicepr-root";
  root.innerHTML = `
    <button id="vp-pill" class="vp-pill">🎙️ Review with voice</button>
    <div id="vp-panel" class="vp-panel" hidden>
      <div class="vp-head">
        <span class="vp-title">🎙️ voice-pr</span>
        <button id="vp-close" class="vp-x">✕</button>
      </div>
      <div id="vp-context" class="vp-context">PR #${m[3]}</div>
      <div id="vp-looking" class="vp-looking"></div>
      <ol id="vp-segments" class="vp-segments"></ol>
      <div class="vp-add">
        <input id="vp-type" type="text" placeholder="…or type a comment (uses what you're looking at)" />
      </div>
      <div class="vp-actions">
        <button id="vp-toggle" class="vp-rec">● Record</button>
        <button id="vp-send" class="vp-send" disabled>Dispatch →</button>
      </div>
      <div id="vp-status" class="vp-status" hidden></div>
    </div>`;
  document.body.appendChild(root);

  const $ = (id) => root.querySelector(id);
  const pill = $("#vp-pill"),
    panel = $("#vp-panel"),
    ctxEl = $("#vp-context"),
    lookingEl = $("#vp-looking"),
    segEl = $("#vp-segments"),
    typeEl = $("#vp-type"),
    toggleBtn = $("#vp-toggle"),
    sendBtn = $("#vp-send"),
    statusEl = $("#vp-status");

  // Tear down all in-flight state and return the panel to a clean, fresh-session
  // state. Called on every open so reopening after a send/stop is never janky.
  function teardown() {
    try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch {}
    mediaStream?.getTracks().forEach((t) => t.stop());
    clearInterval(anchorTimer);
    try { activePort?.disconnect(); } catch {}
    mediaRecorder = null;
    mediaStream = null;
    stopResolve = null;
    activePort = null;
    recording = false;
    paused = false;
    dispatched = false;
    chunks = [];
    timeline = [];
    segments = [];
    lastSel = null;
    lastClick = null;
  }
  function resetUI() {
    segEl.innerHTML = "";
    statusEl.hidden = true;
    statusEl.innerHTML = "";
    lookingEl.textContent = "";
    typeEl.value = "";
    ctxEl.textContent = `PR #${m[3]}`;
    sendBtn.disabled = false;
    sendBtn.textContent = "Dispatch →";
    toggleBtn.disabled = false;
    toggleBtn.textContent = "● Record";
    toggleBtn.classList.remove("vp-recording");
  }

  // One click = fresh session + open + start recording (context loads in parallel).
  pill.addEventListener("click", () => {
    teardown();
    resetUI();
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    panel.hidden = false;
    pill.hidden = true;
    loadContext();
    start();
  });
  $("#vp-close").addEventListener("click", () => {
    teardown(); // closing cancels the current session; reopening starts fresh
    panel.hidden = true;
    pill.hidden = false;
  });

  function renderSegments() {
    segEl.innerHTML = segments
      .map(
        (s) =>
          `<li><span class="vp-loc">${escapeHtml(fmtAnchor(s))}</span>${
            s.snippet ? `<code class="vp-snip">${escapeHtml(s.snippet.slice(0, 90))}</code>` : ""
          }${escapeHtml(s.text)}</li>`
      )
      .join("");
    segEl.scrollTop = segEl.scrollHeight;
  }
  function addSegment(text) {
    text = text.trim();
    if (!text) return;
    segments.push({ text, ...anchorNow() });
    renderSegments();
  }

  // ---------- context chip (via the background worker) ------------------------
  // The content script can't hit localhost directly (Chrome blocks the loopback
  // address space); the background service worker makes the bridge calls.
  function loadContext() {
    ctxEl.textContent = "loading context…";
    chrome.runtime.sendMessage({ type: "context", prUrl }, (res) => {
      if (!res || !res.ok || res.json?.error) {
        ctxEl.innerHTML = `<span class="vp-warn">bridge not reachable — is the voice-pr server running on ${BRIDGE}?</span>`;
        return;
      }
      const c = res.json;
      const bits = [`PR #${c.pr.number}`, c.pr.branch];
      if (c.jiraKey) bits.push(`🎫 ${c.jiraKey}`);
      if (c.checksSummary) bits.push(`✔︎ ${c.checksSummary}`);
      ctxEl.textContent = bits.join("  ·  ");
    });
  }

  // ---------- audio recording ------------------------------------------------
  function paintLooking() {
    if (paused) return (lookingEl.innerHTML = `<span class="vp-dim">⏸ paused</span>`);
    if (!recording) return (lookingEl.textContent = "");
    const secs = Math.floor((Date.now() - recStart) / 1000);
    lookingEl.innerHTML = `<span class="vp-dim">🔴 recording ${Math.floor(secs / 60)}:${String(
      secs % 60
    ).padStart(2, "0")} · looking at ${escapeHtml(fmtAnchor(anchorNow()))}</span>`;
  }
  function mimeType() {
    for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"])
      if (window.MediaRecorder?.isTypeSupported(t)) return { mimeType: t };
    return {};
  }
  async function start() {
    if (recording || mediaRecorder) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      lookingEl.innerHTML = `<span class="vp-warn">mic blocked — allow it (🔒 in the address bar) or just type comments</span>`;
      sendBtn.disabled = false; // can still dispatch typed comments
      return;
    }
    recording = true;
    paused = false;
    chunks = [];
    timeline = [];
    recStart = Date.now();
    pushTimeline();
    sendBtn.disabled = false; // Dispatch is live the entire time
    toggleBtn.textContent = "❚❚ Pause";
    toggleBtn.classList.add("vp-recording");
    paintLooking();
    anchorTimer = setInterval(() => (paintLooking(), pushTimeline()), 1200);
    mediaRecorder = new MediaRecorder(mediaStream, mimeType());
    mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      const ext = /mp4/.test(blob.type) ? "mp4" : "webm";
      (blob.size ? blobToB64(blob) : Promise.resolve(null)).then((b64) => {
        stopResolve?.(b64 ? { audioB64: b64, ext } : null);
        stopResolve = null;
      });
    };
    mediaRecorder.start();
  }
  function pauseResume() {
    if (!mediaRecorder) return;
    if (!paused) {
      paused = true;
      recording = false;
      clearInterval(anchorTimer);
      try { mediaRecorder.pause(); } catch {}
      toggleBtn.textContent = "● Resume";
      toggleBtn.classList.remove("vp-recording");
    } else {
      paused = false;
      recording = true;
      try { mediaRecorder.resume(); } catch {}
      anchorTimer = setInterval(() => (paintLooking(), pushTimeline()), 1200);
      toggleBtn.textContent = "❚❚ Pause";
      toggleBtn.classList.add("vp-recording");
    }
    paintLooking();
  }
  function stopAndGetAudio() {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") return resolve(null);
      stopResolve = resolve;
      recording = false;
      paused = false;
      clearInterval(anchorTimer);
      try { mediaRecorder.stop(); } catch { resolve(null); }
      mediaStream?.getTracks().forEach((t) => t.stop());
    });
  }
  function blobToB64(blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(String(r.result).split(",")[1] || "");
      r.readAsDataURL(blob);
    });
  }
  toggleBtn.addEventListener("click", pauseResume);
  typeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      addSegment(typeEl.value);
      typeEl.value = "";
    }
  });

  // ---------- dispatch: click and be on your way ------------------------------
  // Never blocks. Stops the mic, then hands the audio + typed comments to the
  // bridge, which transcribes AND dispatches server-side — so you can close the
  // tab immediately; the work completes without this page.
  sendBtn.addEventListener("click", async () => {
    if (dispatched) return;
    dispatched = true;
    toggleBtn.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sent ✓";
    statusEl.hidden = false;
    statusEl.innerHTML = `<div class="vp-result ok">✅ On it — handed to the orchestrator.</div>
      <div class="vp-reassure">You can close this tab. Transcription + the work run on the server; the PR updates in a few minutes.</div>`;
    const audio = await stopAndGetAudio();
    try {
      const port = chrome.runtime.connect({ name: "dispatch" });
      activePort = port;
      port.onMessage.addListener((ev) => {
        if (ev.stage === "_end") return port.disconnect();
        onEvent(ev);
      });
      port.postMessage({ prRef: prUrl, sessionId, typedSegments: segments, timeline, ...(audio || {}) });
    } catch (e) {
      line(`error: ${e.message}`, true);
    }
  });

  const STAGE = {
    transcribing: () => `transcribing your audio locally (Whisper)…`,
    transcribed: (d) => `heard ${d.count} comment(s): “${(d.text || "").slice(0, 60)}…”`,
    "pr-loaded": (d) => `loaded PR (branch ${d.branch})`,
    context: (d) =>
      `context: ${d.segments} comments${d.jiraKey ? `, ticket ${d.jiraKey}` : ""}${
        d.checksSummary ? `, ${d.checksSummary}` : ""
      }`,
    "project-ready": () => `repo registered with the orchestrator`,
    "work-filed": (d) => `filed work item ${d.id}`,
    dispatching: (d) => `nudging the mayor to dispatch ${d.id}…`,
    "work-status": (d) => `work item ${d.id}: ${d.status}`,
    "re-nudged": (d) => `re-nudged the mayor for ${d.id}`,
    refinery: (d) => `refinery: ${d.status}`,
    commenting: () => `posting the intent trail on the PR…`,
  };
  function onEvent(ev) {
    const { stage, detail } = ev;
    if (stage === "result" || stage === "done") return done(detail);
    if (stage === "error") return line(`error: ${detail.message}`, true);
    if (stage === "agent-log") return;
    const f = STAGE[stage];
    line(f ? f(detail || {}) : stage);
  }
  function done(r) {
    const ok = r.status === "done";
    statusEl.innerHTML = `
      <div class="vp-result ${ok ? "ok" : "warn"}">
        ${ok ? "✅" : r.status === "failed" ? "⚠️" : "⏳"} ${escapeHtml(r.summary)}
      </div>
      <div class="vp-line">work item <code>${r.workItemId}</code>${
        r.refinery ? ` · refinery ${r.refinery.status}` : ""
      }</div>
      ${
        r.trailCommentUrl
          ? `<a class="vp-link" href="${r.trailCommentUrl}" target="_blank">see the comment on the PR →</a>`
          : ""
      }
      <button id="vp-reload" class="vp-send">Refresh PR to see commits</button>`;
    const rl = statusEl.querySelector("#vp-reload");
    if (rl) rl.addEventListener("click", () => location.reload());
  }

  function line(text, isErr) {
    const d = document.createElement("div");
    d.className = "vp-line" + (isErr ? " vp-warn" : "");
    d.textContent = text;
    statusEl.appendChild(d);
    statusEl.scrollTop = statusEl.scrollHeight;
  }
  function escapeHtml(s) {
    return (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
})();
