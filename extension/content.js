// voice-pr content script — lives on a GitHub PR page.
// Press record, scroll the diff, and talk. Each spoken chunk is anchored to the
// file+line centered in your viewport when you said it, then the whole session
// is handed to the local bridge → orchestrator.
(function () {
  const BRIDGE = "http://localhost:4100";
  const anchors = window.VoicePrAnchors.createAnchorResolver(document, window);
  const attention = window.VoicePrAnchors.createAttentionTracker();
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
    activePort = null,
    attentionTimer = null,
    hudFeed = [];
  const HUD_FEED_MAX = 8;
  // Developer view (off by default) — one switch for the whole diagnostic
  // surface: mouse/scroll attention tracking, the live capture feed + "most
  // attended" HUD, the gaze tracker, and the bridge→whisper→gh→orchestrator
  // preflight. Default (off) is a clean, voice-only panel: no passive signals
  // fire, so nothing misanchors your spoken comments and the viewport is the
  // only fallback anchor. TRACKED_SRCS are the mouse/scroll-derived signals
  // dropped while dev view is off.
  const TRACKED_SRCS = new Set(["move", "dwell", "scroll", "scroll-pause", "revisit", "click", "select", "copy"]);
  let devOn = localStorage.getItem("voicepr:dev") === "1";
  function pushTimeline(src = "scroll", anchor) {
    if (!captureOpen || !sessionStart) return;
    if (!devOn && TRACKED_SRCS.has(src)) return;
    const a = anchor || anchorNow();
    timeline.push({ t: Date.now() - sessionStart, src, ...a });
    debugLine(a, src);
    hudFeed.unshift({ ts: Date.now(), src, anchor: a });
    if (hudFeed.length > HUD_FEED_MAX) hudFeed.length = HUD_FEED_MAX;
    renderHud();
    if (!recording) paintLooking();
  }

  // ---------- traceability: a per-session trail an AI agent can read ----------
  // Every meaningful thing the panel does gets one structured record tagged with
  // the same sessionId that names the recording on disk. Kept in a ring here AND
  // mirrored to chrome.storage (survives a tab refresh / crash) so a failed
  // session is always reconstructable. The bridge keeps the authoritative
  // trace.ndjson server-side; this is the client's vantage point and the source
  // of the Copy-diagnostic report. Deliberately signal-rich: interactions,
  // lifecycle, streamed stages, and errors — NOT the per-1.2s scroll anchors
  // (those are already captured in the timeline and archived).
  const TRACE_MAX = 200;
  let traceRing = [];
  let traceSeq = 0;
  let lastError = null; // {message, code, loc} — most recent error seen, for the report
  let persistTimer = null;
  function persistTrace() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (!sessionId) return;
      try { chrome.storage?.local?.set({ [`voicepr:trace:${sessionId}`]: traceRing }); } catch {}
    }, 1000);
  }
  function capDetail(d) {
    if (!d || typeof d !== "object") return d;
    const out = {};
    for (const [k, v] of Object.entries(d))
      out[k] = typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
    return out;
  }
  function trace(code, detail = {}) {
    const rec = { seq: traceSeq++, t: Date.now(), sessionId, code, detail: capDetail(detail) };
    traceRing.push(rec);
    if (traceRing.length > TRACE_MAX) traceRing.shift();
    try { console.debug(`[voice-pr] ${code}`, detail); } catch {}
    persistTrace();
    return rec;
  }
  function traceError(code, message, extra = {}) {
    lastError = { message: String(message), code: extra.code || code, loc: extra.loc || null };
    return trace(code, { message: String(message), ...extra });
  }
  // Which files each event-code prefix lives in, so the report can point an
  // agent straight at the code. Mirrors lib/trace.js CODE_MAP + the client side.
  const EXT_CODE_MAP = {
    "panel.": "extension/content.js — panel lifecycle",
    "record.": "extension/content.js — MediaRecorder controls (start/pause/stop)",
    "dispatch.": "extension/content.js — dispatch click + streaming port; extension/background.js relays it to the bridge",
    "stage.": "server.js send() + lib/pipeline.js / lib/orchestrator.js emit() — grep the stage name after 'stage.'",
    "gaze.": "extension/content.js + extension/gaze.js — WebGazer overlay",
    "preflight.": "server.js runPreflight() — dependency probes",
    "mic.": "extension/content.js start() — navigator.mediaDevices.getUserMedia",
    "recover.": "extension/content.js checkPendingOnLoad() — crash recovery",
    "bridge.": "server.js — HTTP endpoints",
    "exec.": "lib/exec.js — child processes (gh/git/docker/ffmpeg/whisper)",
    "pipeline.": "lib/pipeline.js — session → PR → orchestrator submit",
    "orchestrator.": "lib/orchestrator.js — docker exec into the pogo container",
  };
  function areasFor(codes) {
    const hits = new Set();
    for (const c of codes)
      for (const [p, where] of Object.entries(EXT_CODE_MAP)) if (c.startsWith(p)) hits.add(where);
    if (!hits.size) hits.add("grep the code strings below across server.js, lib/, and extension/");
    return [...hits];
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
    if (!devOn) return; // pointer tracking is opt-in
    const s = selAnchor();
    if (s) lastSel = { ...s, ts: Date.now() };
    pushTimeline(s ? "select" : "click");
  });
  document.addEventListener("mousedown", (e) => {
    if (!devOn) return; // pointer tracking is opt-in
    const file = fileOf(e.target),
      line = lineOf(e.target);
    if (file && line != null) lastClick = { file, line, ts: Date.now() };
    pushTimeline("click");
  });
  document.addEventListener("copy", () => {
    if (!captureOpen || !devOn) return;
    const s = selAnchor();
    if (s) pushTimeline("copy", s);
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
    if (!captureOpen || !devOn) return; // hover tracking is opt-in
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

  // scroll-pause: motion followed by a stop is a strong "landed here" signal —
  // more meaningful than the constant scroll noise while actively flicking
  // through the diff. Capture-phase listener so nested diff scroll containers
  // (which don't bubble "scroll") are still caught.
  let scrollPauseTimer = null;
  function onScroll() {
    if (!captureOpen || !devOn) return; // scroll tracking is opt-in
    clearTimeout(scrollPauseTimer);
    scrollPauseTimer = setTimeout(() => {
      if (!captureOpen) return;
      const v = anchorViewport();
      pushTimeline("scroll-pause", { ...v, via: "viewport", weight: attention.weightOf(v) });
    }, 260);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });

  // With tracking on, a live text selection always wins; otherwise take the MOST
  // RECENT signal among selection / click / pointer-hover (pointing counts as
  // attention). With tracking off, the viewport is the only anchor — the mouse
  // never steers where a spoken comment lands.
  function anchorNow() {
    if (devOn) {
      const live = selAnchor();
      if (live) return { ...live, via: "select" };
      const cands = [lastSel, lastClick, lastHover].filter(
        (x) => x && Date.now() - x.ts < (x === lastHover ? 4000 : 12000)
      );
      if (cands.length) {
        const c = cands.sort((a, b) => b.ts - a.ts)[0];
        const via = c === lastClick ? "click" : c === lastHover ? "hover" : "select";
        return { file: c.file, line: c.line, endLine: c.endLine, snippet: c.snippet, token: c.token, via };
      }
    }
    return { ...anchorViewport(), via: "viewport" };
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
      <header class="vp-bar">
        <button id="vp-toggle" class="vp-rec" title="Start / pause recording">⏺</button>
        <span id="vp-clock" class="vp-clock">0:00</span>
        <span class="vp-bar-gap"></span>
        <button id="vp-send" class="vp-send" disabled>Dispatch →</button>
        <div class="vp-ready-wrap">
          <button id="vp-ready-btn" class="vp-ready-btn checking" title="Checking you can record & submit…" aria-haspopup="true" aria-expanded="false" hidden>◌</button>
          <div id="vp-ready-pop" class="vp-ready-pop" role="menu" hidden></div>
        </div>
        <div class="vp-menu-wrap">
          <button id="vp-menu-btn" class="vp-icon" title="More" aria-haspopup="true" aria-expanded="false">⋯</button>
          <div id="vp-menu" class="vp-menu" role="menu" hidden>
            <button id="vp-dev-btn" class="vp-menu-item" role="menuitemcheckbox" title="developer view — mouse/scroll attention tracking, the live capture feed + most-attended HUD, and the bridge→whisper→gh→orchestrator preflight (off by default; default is a clean voice-only panel)">🔧 Developer view</button>
            <button id="vp-gaze-btn" class="vp-menu-item" role="menuitemcheckbox" title="experimental: on-device webcam eye tracking (video never leaves your machine)" hidden>👁 Eye tracking</button>
          </div>
        </div>
        <button id="vp-close" class="vp-icon vp-x" title="Close">✕</button>
      </header>
      <div id="vp-context" class="vp-context"></div>
      <div class="vp-body">
        <div id="vp-looking" class="vp-looking vp-now" aria-live="polite"></div>
        <div id="vp-status" class="vp-log" role="log" aria-live="polite"></div>
        <div id="vp-hud" class="vp-hud" hidden>
          <div class="vp-hud-current">
            <span id="vp-hud-pulse" class="vp-pulse"></span>
            <span id="vp-hud-anchor" class="vp-hud-anchor">—</span>
          </div>
          <ol id="vp-hud-feed" class="vp-hud-feed"></ol>
          <div class="vp-hud-top">
            <div class="vp-hud-top-label">Most attended</div>
            <ol id="vp-hud-topn" class="vp-hud-topn"></ol>
          </div>
        </div>
        <div id="vp-debug" class="vp-debug" hidden></div>
      </div>
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
    devBtn = $("#vp-dev-btn"),
    gazeBtn = $("#vp-gaze-btn"),
    toggleBtn = $("#vp-toggle"),
    sendBtn = $("#vp-send"),
    clockEl = $("#vp-clock"),
    menuBtn = $("#vp-menu-btn"),
    menuEl = $("#vp-menu"),
    readyBtn = $("#vp-ready-btn"),
    readyPop = $("#vp-ready-pop"),
    statusEl = $("#vp-status"),
    hudEl = $("#vp-hud"),
    hudPulseEl = $("#vp-hud-pulse"),
    hudAnchorEl = $("#vp-hud-anchor"),
    hudFeedEl = $("#vp-hud-feed"),
    hudTopEl = $("#vp-hud-topn");

  // ---------- overflow menu (holds dev + gaze) --------------------------------
  function closeMenu() {
    menuEl.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
  }
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = menuEl.hidden;
    menuEl.hidden = !opening;
    menuBtn.setAttribute("aria-expanded", String(opening));
    if (opening) closeReadyPop();
  });
  function closeReadyPop() {
    readyPop.hidden = true;
    readyBtn.setAttribute("aria-expanded", "false");
  }
  document.addEventListener("click", (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== menuBtn) closeMenu();
    if (!readyPop.hidden && !readyPop.contains(e.target) && e.target !== readyBtn) closeReadyPop();
  });

  // ---------- context strip: chips (badges) -----------------------------------
  const chip = (text, cls = "") =>
    `<span class="vp-chip${cls ? " " + cls : ""}">${escapeHtml(text)}</span>`;
  function setContextChips() {
    ctxEl.innerHTML = chip("🎙 voice-pr", "brand") + chip(`PR #${m[3]}`);
  }

  // ---------- control-bar clock ----------------------------------------------
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  function updateClock() {
    if (!clockEl) return;
    if (recording) clockEl.textContent = fmtClock(Date.now() - recStart);
    else if (!paused) clockEl.textContent = "0:00";
    clockEl.classList.toggle("live", recording);
  }

  // ---------- unified log feed (captured anchors → dispatch progress) ---------
  // The log is the panel's spine: while recording it shows the anchor trail;
  // after dispatch the same feed streams orchestrator progress. Auto-follows the
  // newest row (shadcn MessageScroller idea) and caps its length.
  const LOG_MAX = 80;
  function clearEmpty() {
    statusEl.querySelector(".vp-empty")?.remove();
  }
  function logRow(text, { cls = "", ts = null } = {}) {
    clearEmpty();
    const row = document.createElement("div");
    row.className = "vp-logrow" + (cls ? " " + cls : "");
    if (ts != null) {
      const t = document.createElement("span");
      t.className = "vp-ts";
      t.textContent = fmtClock(ts);
      row.appendChild(t);
    }
    const span = document.createElement("span");
    span.className = "vp-logtext";
    span.textContent = text;
    row.appendChild(span);
    statusEl.appendChild(row);
    while (statusEl.childElementCount > LOG_MAX) statusEl.firstElementChild.remove();
    statusEl.scrollTop = statusEl.scrollHeight;
    return row;
  }
  function logEmpty(text) {
    statusEl.innerHTML = "";
    const d = document.createElement("div");
    d.className = "vp-empty";
    d.textContent = text;
    statusEl.appendChild(d);
  }
  // Display-only viewport trail: append a row when the viewport file:line changes
  // while recording. This never touches the anchoring `timeline` — it just makes
  // visible what you were reading as you talked.
  let lastTrailKey = "";
  function logTrail() {
    if (!recording) return;
    const v = anchorViewport();
    const key = v.file ? `${v.file}:${v.line ?? ""}` : "";
    if (!key || key === lastTrailKey) return;
    lastTrailKey = key;
    logRow(`◎ ${fmtAnchor(v)}`, { cls: "trail", ts: Date.now() - recStart });
  }

  // ---------- live attention HUD: always visible while a session is open -----
  const SIGNAL_ICON = {
    open: "🟢",
    "record-start": "🔴",
    click: "🖱️",
    select: "✂️",
    move: "➡️",
    dwell: "⏳",
    gaze: "👁",
    scroll: "🕐",
    "scroll-pause": "🛑",
    copy: "📋",
    revisit: "↩️",
  };
  function renderHud() {
    hudEl.hidden = !(captureOpen && devOn);
    if (!captureOpen || !devOn) return;
    hudPulseEl.classList.toggle("vp-pulse-live", captureOpen);
    hudAnchorEl.textContent = fmtAnchor(anchorNow());

    hudFeedEl.innerHTML = "";
    for (const item of hudFeed) {
      const age = Math.max(0, Math.round((Date.now() - item.ts) / 1000));
      const li = document.createElement("li");
      li.className = "vp-hud-row";
      li.textContent = `${SIGNAL_ICON[item.src] || "•"} ${fmtAnchor(item.anchor)} · ${age}s`;
      hudFeedEl.appendChild(li);
    }

    hudTopEl.innerHTML = "";
    for (const entry of attention.topN(5)) {
      const li = document.createElement("li");
      li.className = "vp-hud-row";
      const secs = Math.round(entry.weight / 1000);
      li.textContent = `${entry.file}:${entry.line} · ${secs}s${entry.visits > 1 ? ` · ${entry.visits}×` : ""}`;
      hudTopEl.appendChild(li);
    }
  }

  // Tear down all in-flight state and return the panel to a clean, fresh-session
  // state. Called on every open so reopening after a send/stop is never janky.
  function teardown() {
    try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch {}
    mediaStream?.getTracks().forEach((t) => t.stop());
    clearInterval(anchorTimer);
    clearInterval(attentionTimer);
    clearTimeout(scrollPauseTimer);
    try { activePort?.disconnect(); } catch {}
    mediaRecorder = null;
    mediaStream = null;
    stopResolve = null;
    activePort = null;
    attentionTimer = null;
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
    hudFeed = [];
    attention.reset();
    clearTimeout(dwellTimer);
    stopGaze();
    laser.style.display = "none";
    gazeDot.style.display = "none";
    renderHud();
  }
  function resetUI() {
    statusEl.innerHTML = "";
    pipe = null;
    setReadyBadge("checking", "Checking you can record & submit…");
    closeReadyPop();
    lookingEl.textContent = "";
    debugEl.innerHTML = "";
    setContextChips();
    lastTrailKey = "";
    if (clockEl) {
      clockEl.textContent = "0:00";
      clockEl.classList.remove("live");
    }
    closeMenu();
    sendBtn.disabled = false;
    sendBtn.textContent = "Dispatch →";
    toggleBtn.disabled = false;
    toggleBtn.textContent = "⏺";
    toggleBtn.classList.remove("vp-recording");
  }

  // One click = fresh session + open + start recording (context loads in parallel).
  pill.addEventListener("click", () => {
    teardown();
    resetUI();
    logEmpty("scroll the diff and talk — the file:line you're reading shows up here.");
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStart = Date.now();
    traceRing = [];
    traceSeq = 0;
    lastError = null;
    trace("panel.open", { pr: prUrl });
    captureOpen = true;
    panel.hidden = false;
    pill.hidden = true;
    loadContext();
    paintLooking();
    pushTimeline("open");
    attentionTimer = setInterval(() => {
      updateClock();
      const v = anchorViewport();
      const info = attention.tick(v);
      if (info.revisit) pushTimeline("revisit", { ...v, via: "viewport", weight: attention.weightOf(v) });
      else renderHud();
    }, 1000);
    renderHud();
    start();
    runPreflight(); // validate the whole record→submit chain up front, for everyone
  });
  $("#vp-close").addEventListener("click", () => {
    trace("panel.close", {});
    teardown(); // closing cancels the current session; reopening starts fresh
    panel.hidden = true;
    pill.hidden = false;
  });

  // ---------- readiness check -------------------------------------------------
  // Verify the whole record→submit chain is live BEFORE you start talking, so
  // you never record into a dead bridge. Distilled to one unobtrusive glyph in
  // the control bar — ◌ checking, ✓ green when everything's healthy, ✗ red when
  // anything's wrong — running for EVERY session, not just dev view. Click it to
  // pop the per-check breakdown (with Recheck + Copy-diagnostic when there's a
  // problem); collapsed and out of the way otherwise.
  const PREFLIGHT_STAGES = ["bridge", "ffmpeg", "whisper", "whisper model", "gh auth", "orchestrator"];

  function setReadyBadge(state, title) {
    readyBtn.hidden = false;
    readyBtn.className = `vp-ready-btn ${state}`;
    readyBtn.textContent = state === "ready" ? "✓" : state === "problem" ? "✗" : "◌";
    readyBtn.title = title;
  }

  function renderReadyPop(rows, opts = {}) {
    readyPop.innerHTML = "";
    for (const r of rows) {
      const el = document.createElement("div");
      const kind = r.pending ? "pending" : r.ok ? "ok" : "vp-warn";
      el.className = `vp-ready-row ${kind}`;
      el.textContent = `${r.pending ? "◌" : r.ok ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`;
      readyPop.appendChild(el);
    }
    if (opts.recheck || opts.copyWhy) {
      const foot = document.createElement("div");
      foot.className = "vp-ready-foot";
      if (opts.recheck) {
        const b = document.createElement("button");
        b.className = "vp-ready-recheck";
        b.textContent = "Recheck";
        b.addEventListener("click", () => runPreflight());
        foot.appendChild(b);
      }
      // Same Copy-diagnostic report (with the AI prompt) as every other error surface.
      if (opts.copyWhy) foot.appendChild(copyErrorButton(opts.copyWhy));
      readyPop.appendChild(foot);
    }
  }

  async function runPreflight() {
    setReadyBadge("checking", "Checking you can record & submit…");
    renderReadyPop(PREFLIGHT_STAGES.map((name) => ({ name, pending: true, detail: "checking…" })));
    let resp;
    try {
      resp = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "preflight" }, resolve));
    } catch (e) {
      resp = { ok: false, error: String(e) };
    }
    if (!resp || !resp.ok || !resp.json) {
      traceError("preflight.unreachable", resp?.error || "bridge not reachable");
      setReadyBadge("problem", "Not ready — bridge not reachable. Start it with `npm run serve` (dispatch will fail).");
      renderReadyPop(
        [{ name: "bridge", ok: false, detail: `not reachable — start it with npm run serve${resp?.error ? ` (${resp.error})` : ""}` }],
        { recheck: true, copyWhy: "preflight failed — bridge not reachable" }
      );
      return;
    }
    const { ok, checks } = resp.json;
    const rows = PREFLIGHT_STAGES.map((name) => {
      const c = checks.find((x) => x.name === name);
      return { name, ok: !!(c && c.ok), detail: c ? c.detail : "no result" };
    });
    if (ok) {
      trace("preflight.done", { ok: true });
      setReadyBadge("ready", "Ready — bridge, Whisper, GitHub & orchestrator all good (click for details)");
      renderReadyPop(rows);
    } else {
      const failing = checks.filter((c) => !c.ok);
      trace("preflight.done", { ok: false, failing: failing.map((c) => c.name) });
      setReadyBadge("problem", `Not ready: ${failing.map((c) => c.name).join(", ")} — fix before recording (dispatch will fail).`);
      renderReadyPop(rows, { recheck: true, copyWhy: "preflight failed — one or more dependencies are down" });
    }
  }

  readyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = readyPop.hidden;
    readyPop.hidden = !opening;
    readyBtn.setAttribute("aria-expanded", String(opening));
    if (opening) closeMenu();
  });
  function debugLine(a, src) {
    if (!devOn) return;
    const secs = Math.floor((Date.now() - sessionStart) / 1000);
    const row = document.createElement("div");
    row.className = "vp-dbgrow";
    row.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · ${src} · ${fmtAnchor(a)}`;
    debugEl.prepend(row);
    while (debugEl.childElementCount > 40) debugEl.lastElementChild.remove();
  }
  // ---------- gaze: experimental on-device webcam eye tracking ----------------
  // WebGazer runs in an extension-origin iframe so GitHub's page CSP and camera
  // origin do not own the webcam/model execution path. The content script only
  // receives viewport coordinates and maps them onto the PR diff DOM.
  const GAZE_URL = chrome.runtime.getURL("gaze.html");
  const GAZE_ORIGIN = new URL(GAZE_URL).origin;
  let gazeOn = false,
    gazeThrottle = 0,
    gazeKey = "",
    gazeFrame = null,
    gazeReady = false,
    gazeReadyPromise = null,
    gazeReadyResolve = null,
    gazeReadyReject = null,
    gazeReadyTimer = null;
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
  function ensureGazeFrame() {
    if (gazeReady) return Promise.resolve();
    if (gazeReadyPromise) return gazeReadyPromise;
    gazeFrame = document.createElement("iframe");
    gazeFrame.id = "vp-gaze-frame";
    gazeFrame.title = "voice-pr extension-origin gaze tracker";
    gazeFrame.allow = "camera";
    gazeFrame.src = GAZE_URL;
    gazeFrame.style.display = "none";
    document.documentElement.appendChild(gazeFrame);
    gazeReadyPromise = new Promise((resolve, reject) => {
      gazeReadyResolve = resolve;
      gazeReadyReject = reject;
      gazeReadyTimer = setTimeout(() => {
        gazeReadyPromise = null;
        reject(new Error("gaze overlay did not initialize"));
      }, 10000);
    });
    return gazeReadyPromise;
  }
  function postGaze(command, detail = {}) {
    gazeFrame?.contentWindow?.postMessage({ type: "voice-pr-gaze-command", command, ...detail }, GAZE_ORIGIN);
  }
  function showGazeError(message) {
    gazeOn = false;
    gazeBtn.classList.remove("on");
    gazeDot.style.display = "none";
    if (gazeFrame) gazeFrame.style.display = "none";
    traceError("gaze.error", message);
    lookingEl.innerHTML = `<span class="vp-warn">gaze unavailable: ${escapeHtml(String(message))}</span>`;
    lookingEl.appendChild(copyErrorButton(`gaze unavailable: ${message}`));
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== GAZE_ORIGIN || event.source !== gazeFrame?.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.type !== "voice-pr-gaze") return;
    if (msg.kind === "ready") {
      gazeReady = true;
      clearTimeout(gazeReadyTimer);
      gazeReadyResolve?.();
      return;
    }
    if (msg.kind === "prediction") return onGaze(msg.x, msg.y);
    if (msg.kind === "started") {
      gazeDot.style.display = "block";
      lookingEl.innerHTML = `<span class="vp-dim">👁 look at a spot and click it a few times to calibrate — the green dot should start following your eyes</span>`;
      return;
    }
    if (msg.kind === "status" && gazeOn) {
      lookingEl.innerHTML = `<span class="vp-dim">👁 ${escapeHtml(msg.message || "starting eye tracking")}</span>`;
      return;
    }
    if (msg.kind === "error") showGazeError(msg.message || "failed to start eye tracking");
  });
  async function startGaze() {
    trace("gaze.start", {});
    gazeBtn.classList.add("on");
    lookingEl.innerHTML = `<span class="vp-dim">👁 starting eye tracking (on-device)… allow the camera, then look around the diff to calibrate</span>`;
    try {
      await ensureGazeFrame();
      gazeFrame.style.display = "block";
      postGaze("start");
    } catch (e) {
      showGazeError(e.message || e);
    }
  }
  function stopGaze() {
    trace("gaze.stop", {});
    gazeOn = false;
    gazeBtn.classList.remove("on");
    gazeDot.style.display = "none";
    postGaze("stop");
    if (gazeFrame) gazeFrame.style.display = "none";
  }
  document.addEventListener("click", (e) => {
    if (gazeOn && gazeReady) postGaze("calibrate", { x: e.clientX, y: e.clientY });
  });
  gazeBtn.addEventListener("click", () => {
    if (gazeOn) return stopGaze();
    gazeOn = true;
    startGaze();
  });

  // ---------- developer view: one switch for the whole diagnostic surface -----
  // Reveals + enables attention tracking, the live capture feed + "most
  // attended" HUD, the gaze button, and the preflight checklist. Off by default
  // → a clean, voice-only panel. Defined after gaze so it can stop it on hide.
  function applyDev() {
    devBtn.classList.toggle("on", devOn);
    gazeBtn.hidden = !devOn;
    debugEl.hidden = !devOn;
    if (!devOn) {
      laser.style.display = "none";
      if (gazeOn) stopGaze();
    }
    renderHud();
  }
  devBtn.addEventListener("click", () => {
    devOn = !devOn;
    localStorage.setItem("voicepr:dev", devOn ? "1" : "0");
    applyDev();
    if (captureOpen) runPreflight(); // re-run so the dev breakdown appears/updates
  });
  applyDev();

  // ---------- context chip (via the background worker) ------------------------
  // The content script can't hit localhost directly (Chrome blocks the loopback
  // address space); the background service worker makes the bridge calls.
  function loadContext() {
    ctxEl.innerHTML = chip("🎙 voice-pr", "brand") + chip("loading context…");
    chrome.runtime.sendMessage({ type: "context", prUrl }, (res) => {
      if (!res || !res.ok || res.json?.error) {
        ctxEl.innerHTML =
          chip("🎙 voice-pr", "brand") +
          chip(`bridge not reachable — is the server running on ${BRIDGE}?`, "vp-warn");
        return;
      }
      const c = res.json;
      const bits = [chip("🎙 voice-pr", "brand"), chip(`PR #${c.pr.number}`), chip(c.pr.branch)];
      if (c.jiraKey) bits.push(chip(`🎫 ${c.jiraKey}`, "tk"));
      if (c.checksSummary) bits.push(chip(`✔︎ ${c.checksSummary}`, "ok"));
      ctxEl.innerHTML = bits.join("");
    });
  }

  // ---------- audio recording ------------------------------------------------
  // The now-line is the live anchor readout (the clock/red state lives in the
  // bar, so it isn't duplicated here).
  function paintLooking() {
    if (paused) return (lookingEl.innerHTML = `<span class="vp-dim">⏸ paused</span>`);
    if (!captureOpen) return (lookingEl.textContent = "");
    lookingEl.innerHTML = `<span class="vp-dim">◎ pointing at</span> ${escapeHtml(fmtAnchor(anchorNow()))}`;
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
    } catch (e) {
      traceError("mic.blocked", e?.message || "getUserMedia denied");
      lookingEl.innerHTML = `<span class="vp-warn">mic blocked — allow it (🔒 in the address bar), then reopen the panel</span>`;
      lookingEl.appendChild(copyErrorButton("microphone blocked (getUserMedia denied)"));
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
    trace("record.start", { audioStartMs });
    logRow("● recording started", { cls: "milestone", ts: 0 });
    sendBtn.disabled = false; // Dispatch is live the entire time
    toggleBtn.textContent = "⏸";
    toggleBtn.title = "Pause recording";
    toggleBtn.classList.add("vp-recording");
    updateClock();
    paintLooking();
    anchorTimer = setInterval(() => (paintLooking(), logTrail(), pushTimeline("scroll")), 1200);
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
      toggleBtn.textContent = "⏵";
      toggleBtn.title = "Resume recording";
      toggleBtn.classList.remove("vp-recording");
      trace("record.pause", { ms: Date.now() - recStart });
      logRow("❚❚ paused", { cls: "milestone", ts: Date.now() - recStart });
    } else {
      paused = false;
      recording = true;
      try { mediaRecorder.resume(); } catch {}
      anchorTimer = setInterval(() => (paintLooking(), logTrail(), pushTimeline("scroll")), 1200);
      toggleBtn.textContent = "⏸";
      toggleBtn.title = "Pause recording";
      toggleBtn.classList.add("vp-recording");
      trace("record.resume", { ms: Date.now() - recStart });
      logRow("● resumed", { cls: "milestone", ts: Date.now() - recStart });
    }
    updateClock();
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

  // ---------- crash-safe dispatch bundle --------------------------------------
  // The recording + timeline + typed comments are the user's whole session. If
  // the bridge is down or crashes mid-dispatch we must NOT lose it. So the
  // moment we have the audio we persist the full bundle to extension storage
  // (survives a tab refresh, a crash, even a browser restart), only clearing it
  // once the orchestrator confirms a result. A failed dispatch is retryable —
  // no re-recording from zero.
  const PENDING_KEY = `voicepr:pending:${prUrl}`;
  // Companion marker: set the moment the orchestrator accepts the hand-off (a
  // work item now exists server-side). Its presence is what lets recovery tell
  // "handed off, awaiting result" apart from "saved but never sent" — the saved
  // bundle alone can't, because the dispatch stream survives the tab
  // disconnecting, so a reload that races the terminal event leaves the bundle
  // key set even though the work was in fact sent (#46). Cleared with the bundle
  // on the terminal result.
  const HANDOFF_KEY = `voicepr:handedoff:${prUrl}`;
  function savePending(bundle) {
    try { chrome.storage?.local?.set({ [PENDING_KEY]: { ...bundle, savedAt: Date.now() } }); } catch {}
  }
  function markHandedOff(workItemId) {
    try { chrome.storage?.local?.set({ [HANDOFF_KEY]: { handedOff: true, workItemId: workItemId || null, at: Date.now() } }); } catch {}
  }
  function clearPending() {
    try { chrome.storage?.local?.remove([PENDING_KEY, HANDOFF_KEY]); } catch {}
  }
  function loadPending() {
    return new Promise((resolve) => {
      try { chrome.storage?.local?.get(PENDING_KEY, (o) => resolve(o?.[PENDING_KEY] || null)); }
      catch { resolve(null); }
    });
  }
  function loadHandoff() {
    return new Promise((resolve) => {
      try { chrome.storage?.local?.get(HANDOFF_KEY, (o) => resolve(o?.[HANDOFF_KEY] || null)); }
      catch { resolve(null); }
    });
  }

  // Open the streaming port and drive it to a result. Reusable so Retry and
  // recover-on-load hit the exact same path. Tracks whether a result actually
  // arrived; if the connection ends first (bridge unreachable / crashed), the
  // bundle stays saved and we offer a retry instead of silently dropping it.
  function sendBundle(bundle) {
    let gotResult = false;
    try {
      const port = chrome.runtime.connect({ name: "dispatch" });
      activePort = port;
      trace("dispatch.send", { hasAudio: !!bundle.audioB64, typed: bundle.typedSegments?.length || 0 });
      port.onMessage.addListener((ev) => {
        if (ev.stage === "_end") {
          trace("dispatch.port-end", { gotResult });
          try { port.disconnect(); } catch {}
          if (!gotResult) offerRetry(bundle, "the bridge closed before finishing — is the voice-pr server up?");
          return;
        }
        // A work item now exists server-side (filed, then handed to the
        // orchestrator). Persist that BEFORE any terminal event so a reload that
        // races the result doesn't fall back to the false "never dispatched"
        // recovery — resending here would re-file a duplicate work item.
        if (ev.stage === "work-filed" || ev.stage === "dispatching") {
          markHandedOff(ev.detail?.id);
        }
        if (ev.stage === "result" || ev.stage === "done") {
          gotResult = true;
          clearPending(); // the orchestrator has it now; safe to forget
        }
        onEvent(ev);
      });
      port.postMessage(bundle);
    } catch (e) {
      offerRetry(bundle, e.message);
    }
  }

  // Copy-to-clipboard with a hidden-textarea fallback (github.com may block the
  // async clipboard API under its Permissions-Policy).
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }
  // A self-contained diagnostic report the user can paste straight to an AI
  // agent for a fix. It bundles the failure, the correlation id, where the full
  // server-side logs live on disk, this tab's event trail, AND an explicit AI
  // prompt telling the agent exactly how to map the error back to the code path.
  // This is the point of the whole traceability layer: paste it, and an agent
  // can naively walk from symptom → code → fix.
  function buildDiagnosticReport(why, bundle) {
    const kb = Math.round(((bundle?.audioB64?.length || 0) * 0.75) / 1024);
    const codes = [...new Set(traceRing.map((r) => r.code))];
    const err = lastError || {};
    const trail = traceRing
      .slice(-40)
      .map((r) => {
        const hhmmss = new Date(r.t).toISOString().slice(11, 19);
        const msg = r.detail && r.detail.message ? ` — ${r.detail.message}` : "";
        return `${hhmmss}  ${r.code}${msg}`;
      })
      .join("\n");
    const sid = sessionId || "(none — never started a session)";
    return [
      "===== voice-pr diagnostic report =====",
      `when:  ${new Date().toISOString()}`,
      `error: ${why}`,
      err.code ? `origin code: ${err.code}` : null,
      err.loc ? `origin loc:  ${err.loc}   ← grep the repo for this file:line` : null,
      "",
      "--- correlation ---",
      `session id: ${sid}`,
      `pr:         ${prUrl}`,
      `bridge:     ${BRIDGE}`,
      `events: ${bundle?.timeline?.length ?? timeline.length} timeline, ${bundle?.typedSegments?.length ?? segments.length} typed${kb ? `, audio ~${kb}KB` : ""}`,
      `ua: ${navigator.userAgent}`,
      "",
      "--- where the full logs live (local, on the machine running the bridge) ---",
      `session dir: ~/.voice-pr/sessions/${sid}/   (audio.*, transcript.json, session.json, trace.ndjson)`,
      `global log:  ~/.voice-pr/bridge.ndjson`,
      `latest ptr:  ~/.voice-pr/last-session.json`,
      `quick view:  npm run trace ${sid === "(none — never started a session)" ? "" : sid}   (bare 'npm run trace' opens the most recent session)`,
      "",
      "--- this tab's event trail (newest last) ---",
      trail || "(empty)",
      "",
      "===== FOR AN AI AGENT =====",
      "You are debugging voice-pr: a Chrome extension (extension/) + a local Node bridge (server.js + lib/) that turns spoken GitHub-PR feedback into orchestrator work items. An error above interrupted a session. To find and fix it:",
      "",
      `1. Read the authoritative server-side trail: ~/.voice-pr/sessions/${sid}/trace.ndjson  (or run \`npm run trace ${sid === "(none — never started a session)" ? "" : sid}\`). Every line is {seq, t, level, sessionId, code, loc, detail}; the last level:"error" record is the proximate cause and its \`loc\` is the file:line that threw.`,
      "2. Every `code` in this report is a literal string in the source — grep for it to land on the exact emit site. `loc` pins direct calls precisely; for `stage.*` codes, grep the part after `stage.`.",
      "3. Given the codes seen this session, the failure is most likely in:",
      ...areasFor(codes).map((a) => `     - ${a}`),
      "4. The end-to-end flow, in order — walk it until a step's trace stops matching the happy path:",
      "     extension/content.js (record → Dispatch click) → extension/background.js (relays to the bridge; content scripts can't hit localhost) → server.js POST /api/dispatch → lib/pipeline.js runSession → lib/orchestrator.js (docker exec into the 'codingagent' pogo container) → lib/exec.js (the real gh/git/docker/ffmpeg/whisper child processes; `exec.fail` records carry the child's stderr — usually the smoking gun).",
      "5. If nothing in the trail reached a `bridge.*` code, the bridge was never contacted — the fault is client-side (extension/content.js, extension/background.js) or the bridge is down (`npm run serve`).",
      "6. Report the root cause as code + file:line, then the minimal fix.",
      "=======================================",
    ]
      .filter((x) => x != null)
      .join("\n");
  }
  function makeCopyButton(getText, label = "⧉ Copy diagnostic report") {
    const b = document.createElement("button");
    b.className = "vp-secondary";
    b.textContent = label;
    b.addEventListener("click", async () => {
      const ok = await copyText(getText());
      b.textContent = ok ? "Copied ✓ — paste to an AI agent" : "Copy failed — select the text";
      setTimeout(() => (b.textContent = label), 2200);
    });
    return b;
  }
  // Append a Copy-diagnostic button to any error surface. `why` is the one-line
  // failure; the copied report carries the full context + AI prompt.
  function copyErrorButton(why, bundle) {
    return makeCopyButton(() => buildDiagnosticReport(why, bundle));
  }

  function offerRetry(bundle, why) {
    dispatched = false; // let the user try again without re-recording
    traceError("dispatch.failed", why);
    const kb = Math.round(((bundle.audioB64?.length || 0) * 0.75) / 1024);
    line(
      `⚠️ dispatch didn't go through (${why}). Your recording is saved${kb ? ` (~${kb}KB audio)` : ""} — nothing lost. Start the bridge (\`npm run serve\`), then retry.`,
      true
    );
    const wrap = document.createElement("div");
    wrap.className = "vp-actions-row";
    const btn = document.createElement("button");
    btn.className = "vp-send";
    btn.textContent = "↻ Retry dispatch";
    btn.addEventListener("click", () => {
      wrap.remove();
      dispatched = true;
      line("retrying…");
      sendBundle(bundle);
    });
    wrap.appendChild(btn);
    wrap.appendChild(copyErrorButton(why, bundle));
    statusEl.appendChild(wrap);
    statusEl.scrollTop = statusEl.scrollHeight;
  }

  // ---------- dispatch: click and be on your way ------------------------------
  // Never blocks. Stops the mic, then hands the audio + typed comments to the
  // bridge, which transcribes AND dispatches server-side — so you can close the
  // tab immediately; the work completes without this page.
  sendBtn.addEventListener("click", async () => {
    if (dispatched) return;
    dispatched = true;
    trace("dispatch.click", { typed: segments.length, timeline: timeline.length });
    // recording is over — clear the red indicator immediately (don't leave a
    // stuck "❚❚ Pause" button).
    recording = false;
    paused = false;
    captureOpen = false;
    clearInterval(anchorTimer);
    clearInterval(attentionTimer);
    clearTimeout(scrollPauseTimer);
    renderHud();
    toggleBtn.disabled = true;
    toggleBtn.textContent = "⏺";
    toggleBtn.classList.remove("vp-recording");
    if (clockEl) clockEl.classList.remove("live");
    lookingEl.textContent = "";
    sendBtn.disabled = true;
    sendBtn.textContent = "Sent ✓";
    pipe = renderPipeline();
    logRow(
      "You can close this tab — transcription + the work run on the server; your recording is saved locally until the orchestrator confirms.",
      { cls: "reassure" }
    );
    const audio = await stopAndGetAudio();
    const bundle = { prRef: prUrl, sessionId, typedSegments: segments, timeline, audioStartMs, ...(audio || {}) };
    savePending(bundle); // durable BEFORE the first network attempt
    sendBundle(bundle);
  });

  // ---------- dispatch pipeline: a FIXED checklist, defined once --------------
  // The steps from "stop recording" to "in the orchestrator's hands" are known
  // up front, so we render them all at dispatch time and flip each pending →
  // active → done in place as events arrive. Nothing appends, the panel never
  // grows or scrolls mid-run, and unexpected events are ignored rather than
  // dumped into the UI. Dynamic values (heard N, branch, work id) fill the
  // step's label on completion.
  const PIPELINE = [
    { id: "transcribe", idle: "Transcribe audio", doing: "Transcribing audio…" },
    { id: "comments", idle: "Detect comments", doing: "Listening for comments…" },
    { id: "pr", idle: "Load PR", doing: "Loading PR…" },
    { id: "context", idle: "Gather context", doing: "Gathering context…" },
    { id: "register", idle: "Register repo", doing: "Registering repo…" },
    { id: "file", idle: "File work item", doing: "Filing work item…" },
    { id: "handoff", idle: "Hand to the orchestrator", doing: "Handing off…" },
    { id: "work", idle: "Orchestrator working", doing: "Orchestrator working…" },
    { id: "trail", idle: "Post intent trail", doing: "Posting intent trail…" },
  ];
  let pipe = null; // active pipeline controller (null until dispatch)
  function renderPipeline() {
    statusEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "vp-pipeline";
    const rows = new Map();
    for (const s of PIPELINE) {
      const row = document.createElement("div");
      row.className = "vp-step pending";
      row.innerHTML = `<span class="vp-step-mark"></span><span class="vp-step-label"></span>`;
      row.querySelector(".vp-step-label").textContent = s.idle;
      wrap.appendChild(row);
      rows.set(s.id, row);
    }
    statusEl.appendChild(wrap);
    let activeId = null;
    const set = (id, state, text) => {
      const row = rows.get(id);
      if (!row) return;
      row.className = `vp-step ${state}`;
      if (text != null) row.querySelector(".vp-step-label").textContent = text;
      if (state === "active") activeId = id;
    };
    const labelOf = (id) => PIPELINE.find((p) => p.id === id) || {};
    return {
      activate: (id, text) => set(id, "active", text ?? labelOf(id).doing),
      complete: (id, text) => set(id, "done", text ?? labelOf(id).idle),
      note: (id, text) => set(id, "active", text), // keep active, update label
      failActive: (text) => activeId && set(activeId, "fail", text),
      completeRemaining: () =>
        PIPELINE.forEach((s) => {
          const r = rows.get(s.id);
          if (r && !r.classList.contains("done")) set(s.id, "done", labelOf(s.id).idle);
        }),
      has: (id) => rows.has(id),
    };
  }
  const plural = (n, w) => `${n} ${w}${Number(n) === 1 ? "" : "s"}`;

  function onEvent(ev) {
    const { stage, detail: d = {} } = ev;
    // Mirror every streamed bridge event into the client trace (the report reads
    // this even if the server-side trace.ndjson is unavailable). On error, stash
    // the origin code + loc the bridge forwarded so the Copy-diagnostic report
    // points straight at the failing code.
    trace(`stage.${stage}`, d);
    if (stage === "error")
      lastError = { message: d.message, code: d.code || "bridge.dispatch.error", loc: d.loc || null };
    if (stage === "result" || stage === "done") return done(d);
    if (stage === "agent-log") return;
    if (!pipe) return; // events are only meaningful once the pipeline is shown
    if (stage === "error") {
      pipe.failActive(`Failed — ${d.message || "error"}`);
      return;
    }
    switch (stage) {
      case "transcribing":
        pipe.activate("transcribe");
        break;
      case "transcribed":
        pipe.complete("transcribe");
        pipe.complete("comments", `Heard ${plural(d.count ?? 0, "comment")}`);
        pipe.activate("pr");
        break;
      case "pr-loaded":
        pipe.complete("pr", d.branch ? `Loaded PR · ${d.branch}` : "Loaded PR");
        pipe.activate("context");
        break;
      case "context": {
        const bits = [plural(d.segments ?? 0, "comment")];
        if (d.jiraKey) bits.push(d.jiraKey);
        if (d.checksSummary) bits.push(d.checksSummary);
        pipe.complete("context", `Context · ${bits.join(" · ")}`);
        pipe.activate("register");
        break;
      }
      case "project-ready":
        pipe.complete("register");
        pipe.activate("file");
        break;
      case "work-filed":
        pipe.complete("file", d.id ? `Filed ${d.id}` : "Filed work item");
        pipe.activate("handoff");
        break;
      case "dispatching":
        pipe.complete("handoff", "In the orchestrator's hands");
        pipe.activate("work");
        break;
      case "work-status":
        pipe.note("work", `Orchestrator working${d.status ? ` · ${d.status}` : ""}`);
        break;
      case "refinery":
        pipe.note("work", `Refinery${d.status ? ` · ${d.status}` : ""}`);
        break;
      // Commits landed on the PR branch — the ground-truth completion signal.
      // Advance past "Orchestrator working" immediately rather than waiting on
      // the poll/headline-matched `commenting` event (which may never fire).
      case "commits-landed":
        pipe.complete("work", d.count ? `Merged ${plural(d.count, "commit")}` : "Merged");
        pipe.activate("trail");
        break;
      case "commenting":
        pipe.complete("work");
        pipe.activate("trail");
        break;
      // Queued behind another dispatch on the same branch: say so on the active
      // step instead of spinning a silent "Registering repo…".
      case "branch-queued":
        pipe.note("register", `Queued behind an earlier dispatch${d.position ? ` · position ${d.position}` : ""}…`);
        break;
      case "branch-dispatch-start":
        pipe.activate("register");
        break;
      // re-signaled and anything else: ignored — the fixed checklist doesn't
      // react to every event.
      default:
        break;
    }
  }

  function done(r) {
    const ok = r.status === "done";
    if (pipe) {
      if (ok) pipe.completeRemaining();
      else pipe.failActive(`${r.status === "failed" ? "Failed" : "Incomplete"}`);
    }
    const box = document.createElement("div");
    box.className = `vp-result ${ok ? "ok" : "warn"}`;
    const head = document.createElement("div");
    head.className = "headline";
    head.textContent = `${ok ? "✅" : r.status === "failed" ? "⚠️" : "⏳"} ${r.summary}`;
    box.appendChild(head);
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `work item ${r.workItemId}${r.refinery ? ` · refinery ${r.refinery.status}` : ""}`;
    box.appendChild(sub);
    if (r.trailCommentUrl) {
      const a = document.createElement("a");
      a.className = "vp-link";
      a.href = r.trailCommentUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "see the comment on the PR →";
      box.appendChild(a);
    }
    const reload = document.createElement("button");
    reload.className = "vp-send";
    reload.textContent = "Refresh PR to see commits";
    reload.addEventListener("click", () => location.reload());
    box.appendChild(reload);
    clearEmpty();
    statusEl.appendChild(box);
    statusEl.scrollTop = statusEl.scrollHeight;
  }

  function line(text, isErr) {
    return logRow(text, { cls: isErr ? "err" : "" });
  }
  function escapeHtml(s) {
    return (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // ---------- recover a pending recording after a refresh/crash ---------------
  // On load, decide from the persisted state (bundle + hand-off marker) what to
  // show. A bundle that was never handed off is a genuine crash: surface it for
  // resend. A bundle already accepted by the orchestrator is NOT a crash — the
  // work runs server-side; a reload just raced the terminal event (#46), so we
  // show an "awaiting result" note, never a resend that would duplicate it.
  function recoveryHeader(pending) {
    const kb = Math.round(((pending.audioB64?.length || 0) * 0.75) / 1024);
    const ago = pending.savedAt ? Math.round((Date.now() - pending.savedAt) / 60000) : null;
    captureOpen = false;
    panel.hidden = false;
    pill.hidden = true;
    toggleBtn.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sent ✓";
    setContextChips();
    statusEl.innerHTML = "";
    return { kb, ago };
  }
  function showUndispatchedRecovery(pending) {
    const { kb, ago } = recoveryHeader(pending);
    trace("recover.undispatched", { savedAt: pending.savedAt || null, hasAudio: !!pending.audioB64 });
    logRow(
      `↻ Recovered an un-dispatched recording${ago != null ? ` from ${ago} min ago` : ""}${
        kb ? ` (~${kb}KB audio)` : ""
      }.`,
      { cls: "milestone" }
    );
    logRow("The last dispatch didn't complete. Resend it to the orchestrator, or discard.", { cls: "reassure" });
    const wrap = document.createElement("div");
    wrap.className = "vp-actions-row";
    const resend = document.createElement("button");
    resend.className = "vp-send";
    resend.textContent = "↻ Resend to orchestrator";
    resend.addEventListener("click", () => {
      wrap.remove();
      sessionId = pending.sessionId || sessionId;
      dispatched = true;
      trace("recover.resend", {});
      line("resending recovered recording…");
      sendBundle(pending);
    });
    const discard = document.createElement("button");
    discard.className = "vp-secondary";
    discard.textContent = "Discard";
    discard.addEventListener("click", () => {
      trace("recover.discard", {});
      clearPending();
      teardown();
      panel.hidden = true;
      pill.hidden = false;
    });
    wrap.appendChild(resend);
    wrap.appendChild(discard);
    statusEl.appendChild(wrap);
  }
  function showAwaitingResult(pending, workItemId) {
    const { ago } = recoveryHeader(pending);
    trace("recover.awaiting-result", { workItemId: workItemId || null, savedAt: pending.savedAt || null });
    logRow(
      `↻ This recording was handed to the orchestrator${workItemId ? ` (work item ${workItemId})` : ""}${
        ago != null ? `, ${ago} min ago` : ""
      }.`,
      { cls: "milestone" }
    );
    logRow(
      "It runs server-side — this reload just lost the live view, not the work. Check the PR for new commits; there's nothing to resend.",
      { cls: "reassure" }
    );
    const wrap = document.createElement("div");
    wrap.className = "vp-actions-row";
    const dismiss = document.createElement("button");
    dismiss.className = "vp-send";
    dismiss.textContent = "Got it";
    dismiss.addEventListener("click", () => {
      trace("recover.awaiting-dismiss", {});
      clearPending(); // handed off; the local bundle no longer serves recovery
      teardown();
      panel.hidden = true;
      pill.hidden = false;
    });
    wrap.appendChild(dismiss);
    statusEl.appendChild(wrap);
  }
  async function checkPendingOnLoad() {
    const [pending, handoff] = await Promise.all([loadPending(), loadHandoff()]);
    const decision = window.VoicePrRecovery.decideRecovery(pending, handoff);
    if (!decision.show) return;
    sessionId = pending.sessionId || sessionId; // tag recovery traces to the recovered session
    trace("recover.found", { mode: decision.mode, savedAt: pending.savedAt || null, hasAudio: !!pending.audioB64 });
    if (decision.mode === "awaiting-result") showAwaitingResult(pending, decision.workItemId);
    else showUndispatchedRecovery(pending);
  }
  checkPendingOnLoad();
})();
