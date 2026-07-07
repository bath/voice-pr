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
        <div id="vp-ready" class="vp-ready" hidden></div>
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
    readyEl = $("#vp-ready"),
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
  });
  document.addEventListener("click", (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== menuBtn) closeMenu();
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
    // reserve the banner slot immediately (no empty → pop-in on open)
    setReady("checking", "Checking you can record & submit…");
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
    teardown(); // closing cancels the current session; reopening starts fresh
    panel.hidden = true;
    pill.hidden = false;
  });

  // ---------- end-to-end preflight (part of dev view) -------------------------
  // Verify the whole dispatch chain is live BEFORE you start talking, so you
  // never record into a dead bridge. The full checklist is rendered UP FRONT —
  // every stage present and pending — then each row ticks from ✗ to ✓ in place
  // as results come back, so nothing pops in one at a time.
  const PREFLIGHT_STAGES = ["bridge", "ffmpeg", "whisper", "whisper model", "gh auth", "orchestrator"];

  // The readiness banner — shown to EVERY user at record-start, not just dev.
  // It answers one question before you invest time talking: can this session
  // actually record and submit? Green auto-collapses; a problem stays put with a
  // Recheck button. Dev view additionally renders the per-check breakdown below.
  // The banner keeps a fixed slot the whole time the panel is open (no
  // appear/collapse), so its state changes in place without moving anything.
  function setReady(state, text, opts = {}) {
    readyEl.hidden = false;
    readyEl.className = `vp-ready ${state}`;
    readyEl.innerHTML = "";
    const msg = document.createElement("span");
    msg.className = "vp-ready-msg";
    msg.textContent = text;
    readyEl.appendChild(msg);
    if (opts.recheck) {
      const b = document.createElement("button");
      b.className = "vp-ready-recheck";
      b.textContent = "Recheck";
      b.addEventListener("click", () => runPreflight());
      readyEl.appendChild(b);
    }
  }

  async function runPreflight() {
    setReady("checking", "Checking you can record & submit…");
    let resp;
    try {
      resp = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "preflight" }, resolve));
    } catch (e) {
      resp = { ok: false, error: String(e) };
    }
    if (!resp || !resp.ok || !resp.json) {
      setReady("warn", "Bridge not reachable — start it with `npm run serve`. You can record, but dispatch will fail.", {
        recheck: true,
      });
    } else if (resp.json.ok) {
      setReady("ok", "Ready — bridge, Whisper, GitHub & orchestrator all good.");
    } else {
      const failing = resp.json.checks.filter((c) => !c.ok);
      const d = failing[0]?.detail ? ` — ${failing[0].detail}` : "";
      setReady(
        "warn",
        `Not ready: ${failing.map((c) => c.name).join(", ")}${d}. Fix before recording — dispatch will fail.`,
        { recheck: true }
      );
    }
    if (devOn) preflightDetail(resp); // full per-check breakdown, dev only
  }

  function preflightDetail(resp) {
    debugEl.hidden = false;
    let box = debugEl.querySelector(".vp-preflight");
    if (!box) {
      box = document.createElement("div");
      box.className = "vp-preflight";
      debugEl.prepend(box);
    }
    const j = resp && resp.ok ? resp.json : null;
    const head = `<div class="vp-dbgrow"><b>${
      !j ? "✗ bridge not reachable — npm run serve" : j.ok ? "✅ ready — you can record & submit" : "⚠️ not ready — fix the ✗ items"
    }</b></div>`;
    const rows = PREFLIGHT_STAGES.map((name) => {
      const c = j ? j.checks.find((x) => x.name === name) : null;
      const ok = j ? !!(c && c.ok) : false;
      const detail = c ? c.detail : name === "bridge" ? "not reachable" : "bridge down";
      return `<div class="vp-dbgrow vp-preflight-row ${ok ? "ok" : "vp-warn"}">${ok ? "✓" : "✗"} ${name}${
        detail ? ` — ${escapeHtml(detail)}` : ""
      }</div>`;
    }).join("");
    box.innerHTML = head + rows;
  }
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
    lookingEl.innerHTML = `<span class="vp-warn">gaze unavailable: ${escapeHtml(String(message))}</span>`;
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
    } catch {
      lookingEl.innerHTML = `<span class="vp-warn">mic blocked — allow it (🔒 in the address bar), then reopen the panel</span>`;
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
      logRow("❚❚ paused", { cls: "milestone", ts: Date.now() - recStart });
    } else {
      paused = false;
      recording = true;
      try { mediaRecorder.resume(); } catch {}
      anchorTimer = setInterval(() => (paintLooking(), logTrail(), pushTimeline("scroll")), 1200);
      toggleBtn.textContent = "⏸";
      toggleBtn.title = "Pause recording";
      toggleBtn.classList.add("vp-recording");
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
  function savePending(bundle) {
    try { chrome.storage?.local?.set({ [PENDING_KEY]: { ...bundle, savedAt: Date.now() } }); } catch {}
  }
  function clearPending() {
    try { chrome.storage?.local?.remove(PENDING_KEY); } catch {}
  }
  function loadPending() {
    return new Promise((resolve) => {
      try { chrome.storage?.local?.get(PENDING_KEY, (o) => resolve(o?.[PENDING_KEY] || null)); }
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
      port.onMessage.addListener((ev) => {
        if (ev.stage === "_end") {
          try { port.disconnect(); } catch {}
          if (!gotResult) offerRetry(bundle, "the bridge closed before finishing — is the voice-pr server up?");
          return;
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
  // A self-contained error report the user can paste straight back for a fix:
  // the failure + session metadata + the full log feed as shown.
  function buildErrorReport(why, bundle) {
    const kb = Math.round(((bundle?.audioB64?.length || 0) * 0.75) / 1024);
    const log = [...statusEl.querySelectorAll(".vp-logrow")].map((r) => r.textContent.trim()).join("\n");
    return [
      "voice-pr dispatch error",
      `error: ${why}`,
      `pr: ${prUrl}`,
      `session: ${sessionId}`,
      `bridge: ${BRIDGE}`,
      `timeline events: ${bundle?.timeline?.length ?? timeline.length}, typed: ${bundle?.typedSegments?.length ?? segments.length}${kb ? `, audio ~${kb}KB` : ""}`,
      `ua: ${navigator.userAgent}`,
      "",
      "log:",
      log || "(empty)",
    ].join("\n");
  }
  function makeCopyButton(getText, label = "⧉ Copy error") {
    const b = document.createElement("button");
    b.className = "vp-secondary";
    b.textContent = label;
    b.addEventListener("click", async () => {
      const ok = await copyText(getText());
      b.textContent = ok ? "Copied ✓" : "Copy failed — select the text";
      setTimeout(() => (b.textContent = label), 1800);
    });
    return b;
  }

  function offerRetry(bundle, why) {
    dispatched = false; // let the user try again without re-recording
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
    wrap.appendChild(makeCopyButton(() => buildErrorReport(why, bundle)));
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

  // ---------- recover an un-dispatched recording after a refresh/crash --------
  // On load, if a previous dispatch never confirmed, surface it: the audio +
  // timeline + typed comments are all still here. Resend without re-recording.
  async function checkPendingOnLoad() {
    const pending = await loadPending();
    if (!pending) return;
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
      line("resending recovered recording…");
      sendBundle(pending);
    });
    const discard = document.createElement("button");
    discard.className = "vp-secondary";
    discard.textContent = "Discard";
    discard.addEventListener("click", () => {
      clearPending();
      teardown();
      panel.hidden = true;
      pill.hidden = false;
    });
    wrap.appendChild(resend);
    wrap.appendChild(discard);
    statusEl.appendChild(wrap);
  }
  checkPendingOnLoad();
})();
