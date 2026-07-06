// voice-pr content script — lives on a GitHub PR page.
// Press record, scroll the diff, and talk. Each spoken chunk is anchored to the
// file+line centered in your viewport when you said it, then the whole session
// is handed to the local bridge → orchestrator.
(function () {
  const BRIDGE = "http://localhost:4100";
  const anchors = window.VoicePrAnchors.createAnchorResolver(document, window);
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
    sessionStart = 0,
    audioStartMs = 0,
    timeline = [],
    captureOpen = false,
    paused = false,
    dispatched = false,
    stopResolve = null,
    activePort = null;
  function pushTimeline(src = "scroll", anchor) {
    if (!captureOpen || !sessionStart) return;
    const a = anchor || anchorNow();
    timeline.push({ t: Date.now() - sessionStart, src, ...a });
    debugLine(a, src);
    if (!recording) paintLooking();
  }

  // ---------- diff anchoring (view-agnostic) ----------------------------------
  // GitHub tags each diff line with a deep-link id: diff-<filehash>(L|R)<line>
  // (the same scheme in your URL bar), and the file sidebar maps #diff-<hash> to
  // the path. This works on BOTH the classic /files view and the new React
  // /changes view, so we anchor off it and fall back to classic DOM selectors.
  const fileOf = (el) => anchors.fileOf(el);
  const lineOf = (el) => anchors.lineOf(el);

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
    pushTimeline(s ? "select" : "click");
  });
  document.addEventListener("mousedown", (e) => {
    const file = fileOf(e.target),
      line = lineOf(e.target);
    if (file && line != null) lastClick = { file, line, ts: Date.now() };
    pushTimeline("click");
  });

  // The code token/identifier directly under a screen point (the "laser dot").
  function tokenAt(x, y) {
    const r = document.caretRangeFromPoint?.(x, y);
    const node = r?.startContainer;
    if (!node || node.nodeType !== 3) return null;
    const text = node.textContent || "";
    const isW = (c) => /[\w$.]/.test(c || "");
    let i = r.startOffset;
    if (!isW(text[i]) && !isW(text[i - 1])) return null;
    let a = i, b = i;
    while (a > 0 && isW(text[a - 1])) a--;
    while (b < text.length && isW(text[b])) b++;
    const tok = text.slice(a, b).trim().replace(/^\.+|\.+$/g, "");
    return tok && tok.length <= 60 ? tok : null;
  }
  // Full attention datum at a screen point: file, line, token, coords.
  function anchorAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const file = fileOf(el);
    if (!file) return null;
    return { file, line: lineOf(el), token: tokenAt(x, y) || null, x: Math.round(x), y: Math.round(y) };
  }

  // Mouse-as-laser: while the session is open, continuously capture where the pointer is
  // over the diff — movement (on change), dwell (lingering = strong attention),
  // and the token under it. Throttled; only logs when the target changes.
  let lastHover = null,
    hoverKey = "",
    moveThrottle = 0,
    dwellTimer = null;
  document.addEventListener("mousemove", (e) => {
    if (!captureOpen) return;
    const now = Date.now();
    laserPaint(e.clientX, e.clientY);
    if (now - moveThrottle < 120) return;
    moveThrottle = now;
    const a = anchorAtPoint(e.clientX, e.clientY);
    if (!a) return;
    lastHover = { ...a, ts: now };
    const key = `${a.file}:${a.line}:${a.token || ""}`;
    if (key === hoverKey) return;
    hoverKey = key;
    pushTimeline("move", a);
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(() => {
      if (captureOpen && hoverKey === key) pushTimeline("dwell", a); // lingered here
    }, 700);
  });

  // Viewport-center fallback (what's on screen if you didn't select/click).
  function anchorViewport() {
    return anchors.anchorViewport();
  }

  // A live text selection always wins; otherwise take the MOST RECENT signal
  // among selection / click / pointer-hover (pointing counts as attention).
  function anchorNow() {
    const live = selAnchor();
    if (live) return live;
    const cands = [lastSel, lastClick, lastHover].filter(
      (x) => x && Date.now() - x.ts < (x === lastHover ? 4000 : 12000)
    );
    if (cands.length) {
      const c = cands.sort((a, b) => b.ts - a.ts)[0];
      return { file: c.file, line: c.line, endLine: c.endLine, snippet: c.snippet, token: c.token };
    }
    return anchorViewport();
  }
  function fmtAnchor(a) {
    if (!a || !a.file) return "no target — will infer from words";
    const range = a.endLine && a.endLine !== a.line ? `${a.line}-${a.endLine}` : a.line || "";
    return `${a.file}${range ? ":" + range : ""}${a.token ? ` \`${a.token}\`` : ""}`;
  }

  // ---------- UI --------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "voicepr-root";
  root.innerHTML = `
    <button id="vp-pill" class="vp-pill">🎙️ Review with voice</button>
    <div id="vp-panel" class="vp-panel" hidden>
      <div class="vp-head">
        <span class="vp-title">🎙️ voice-pr</span>
        <span class="vp-head-right">
          <button id="vp-gaze-btn" class="vp-dbg" title="experimental: on-device webcam eye tracking (video never leaves your machine)">👁 gaze</button>
          <button id="vp-debug-btn" class="vp-dbg" title="show what's being captured as you talk">🐛 debug</button>
          <button id="vp-close" class="vp-x">✕</button>
        </span>
      </div>
      <div id="vp-context" class="vp-context">PR #${m[3]}</div>
      <div id="vp-looking" class="vp-looking"></div>
      <div id="vp-debug" class="vp-debug" hidden></div>
      <div class="vp-actions">
        <button id="vp-toggle" class="vp-rec">● Record</button>
        <button id="vp-send" class="vp-send" disabled>Dispatch →</button>
      </div>
      <div id="vp-status" class="vp-status" hidden></div>
    </div>`;
  document.body.appendChild(root);

  // The "laser" — highlights the diff line under the cursor while recording.
  const laser = document.createElement("div");
  laser.id = "vp-laser";
  laser.style.display = "none";
  document.body.appendChild(laser);
  function laserPaint(x, y) {
    const r = captureOpen && anchors.highlightRectAtPoint(x, y);
    if (!r) return void (laser.style.display = "none");
    Object.assign(laser.style, {
      display: "block",
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  // Gaze dot — where the eye tracker thinks you're looking.
  const gazeDot = document.createElement("div");
  gazeDot.id = "vp-gazedot";
  gazeDot.style.display = "none";
  document.body.appendChild(gazeDot);

  const $ = (id) => root.querySelector(id);
  const pill = $("#vp-pill"),
    panel = $("#vp-panel"),
    ctxEl = $("#vp-context"),
    lookingEl = $("#vp-looking"),
    debugEl = $("#vp-debug"),
    debugBtn = $("#vp-debug-btn"),
    gazeBtn = $("#vp-gaze-btn"),
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
    recStart = 0;
    sessionStart = 0;
    audioStartMs = 0;
    timeline = [];
    captureOpen = false;
    segments = [];
    lastSel = null;
    lastClick = null;
    lastHover = null;
    hoverKey = "";
    clearTimeout(dwellTimer);
    laser.style.display = "none";
    gazeDot.style.display = "none";
  }
  function resetUI() {
    statusEl.hidden = true;
    statusEl.innerHTML = "";
    lookingEl.textContent = "";
    debugEl.innerHTML = "";
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
    sessionStart = Date.now();
    captureOpen = true;
    panel.hidden = false;
    pill.hidden = true;
    loadContext();
    paintLooking();
    pushTimeline("open");
    start();
  });
  $("#vp-close").addEventListener("click", () => {
    teardown(); // closing cancels the current session; reopening starts fresh
    panel.hidden = true;
    pill.hidden = false;
  });

  // ---------- debug: show what's being captured as you talk -------------------
  let debugOn = localStorage.getItem("voicepr:debug") === "1";
  function applyDebug() {
    debugEl.hidden = !debugOn;
    debugBtn.classList.toggle("on", debugOn);
  }
  function debugLine(a, src) {
    if (!debugOn) return;
    const secs = Math.floor((Date.now() - sessionStart) / 1000);
    const row = document.createElement("div");
    row.className = "vp-dbgrow";
    row.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · ${src} · ${fmtAnchor(a)}`;
    debugEl.prepend(row);
    while (debugEl.childElementCount > 40) debugEl.lastElementChild.remove();
  }
  debugBtn.addEventListener("click", () => {
    debugOn = !debugOn;
    localStorage.setItem("voicepr:debug", debugOn ? "1" : "0");
    applyDebug();
  });
  applyDebug();

  // ---------- gaze: experimental on-device webcam eye tracking ----------------
  // WebGazer runs entirely in-browser — webcam frames never leave the machine
  // (only the face model downloads once from Google). Gaze is just another
  // timeline source: predictions → anchorAtPoint(x,y) → pushTimeline("gaze").
  let gazeOn = false,
    gazeThrottle = 0,
    gazeKey = "";
  function onGaze(x, y) {
    if (x == null || y == null) return;
    Object.assign(gazeDot.style, { display: "block", left: `${x}px`, top: `${y}px` });
    const now = Date.now();
    if (now - gazeThrottle < 150) return;
    gazeThrottle = now;
    const a = anchorAtPoint(x, y);
    if (!a) return;
    const key = `${a.file}:${a.line}:${a.token || ""}`;
    if (key === gazeKey) return;
    gazeKey = key;
    if (captureOpen) pushTimeline("gaze", a);
  }
  // test/injection seam: a synthetic gaze coordinate (real source is WebGazer).
  window.addEventListener("vp-synthetic-gaze", (e) => onGaze(e.detail?.x, e.detail?.y));
  async function startGaze() {
    gazeBtn.classList.add("on");
    lookingEl.innerHTML = `<span class="vp-dim">👁 starting eye tracking (on-device)… allow the camera, then look around the diff to calibrate</span>`;
    try {
      if (typeof window.webgazer === "undefined") {
        const res = await new Promise((r) => chrome.runtime.sendMessage({ type: "inject-webgazer" }, r));
        if (!res?.ok) throw new Error(res?.error || "failed to load webgazer");
      }
      const wg = window.webgazer;
      wg.setGazeListener((data) => data && onGaze(data.x, data.y));
      // Show WebGazer's own feedback so you can SEE it working + calibrate:
      // the webcam preview + face mesh confirm tracking; the red dot is its
      // raw prediction; our green #vp-gazedot is the anchored one.
      wg.showVideoPreview?.(true);
      wg.showFaceOverlay?.(true);
      wg.showFaceFeedbackBox?.(true);
      wg.showPredictionPoints?.(true);
      await wg.begin();
      gazeDot.style.display = "block";
      lookingEl.innerHTML = `<span class="vp-dim">👁 look at a spot and click it a few times to calibrate — the green dot should start following your eyes</span>`;
    } catch (e) {
      gazeOn = false;
      gazeBtn.classList.remove("on");
      lookingEl.innerHTML = `<span class="vp-warn">gaze unavailable: ${escapeHtml(String(e.message || e))}</span>`;
    }
  }
  function stopGaze() {
    gazeBtn.classList.remove("on");
    gazeDot.style.display = "none";
    try { window.webgazer?.pause?.(); } catch {}
  }
  gazeBtn.addEventListener("click", () => {
    gazeOn = !gazeOn;
    gazeOn ? startGaze() : stopGaze();
  });

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
    if (!captureOpen) return (lookingEl.textContent = "");
    if (!recording) {
      lookingEl.innerHTML = `<span class="vp-dim">capturing attention · pointing at ${escapeHtml(
        fmtAnchor(anchorNow())
      )}</span>`;
      return;
    }
    const secs = Math.floor((Date.now() - recStart) / 1000);
    lookingEl.innerHTML = `<span class="vp-dim">🔴 recording ${Math.floor(secs / 60)}:${String(
      secs % 60
    ).padStart(2, "0")} · pointing at ${escapeHtml(fmtAnchor(anchorNow()))}</span>`;
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
    recStart = Date.now();
    if (!sessionStart) sessionStart = recStart;
    audioStartMs = recStart - sessionStart;
    pushTimeline("record-start");
    sendBtn.disabled = false; // Dispatch is live the entire time
    toggleBtn.textContent = "❚❚ Pause";
    toggleBtn.classList.add("vp-recording");
    paintLooking();
    anchorTimer = setInterval(() => (paintLooking(), pushTimeline("scroll")), 1200);
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
      anchorTimer = setInterval(() => (paintLooking(), pushTimeline("scroll")), 1200);
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

  // ---------- dispatch: click and be on your way ------------------------------
  // Never blocks. Stops the mic, then hands the audio + typed comments to the
  // bridge, which transcribes AND dispatches server-side — so you can close the
  // tab immediately; the work completes without this page.
  sendBtn.addEventListener("click", async () => {
    if (dispatched) return;
    dispatched = true;
    // recording is over — clear the red indicator immediately (don't leave a
    // stuck "❚❚ Pause" button).
    recording = false;
    paused = false;
    captureOpen = false;
    clearInterval(anchorTimer);
    toggleBtn.disabled = true;
    toggleBtn.textContent = "● Record";
    toggleBtn.classList.remove("vp-recording");
    lookingEl.textContent = "";
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
      port.postMessage({ prRef: prUrl, sessionId, typedSegments: segments, timeline, audioStartMs, ...(audio || {}) });
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
