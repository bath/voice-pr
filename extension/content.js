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
  let recog = null;
  let anchorTimer = null;

  // ---------- viewport anchoring ----------------------------------------------
  // What file+line is centered on screen right now? Targets GitHub's diff DOM;
  // degrades to {file, null} or {null, null} if it can't resolve (agent infers).
  function anchorNow() {
    const cy = window.innerHeight / 2;
    let el = document.elementFromPoint(Math.min(window.innerWidth / 2, 400), cy);
    const fileEl = el && el.closest("[data-tagsearch-path], .file, .js-file, copy-path");
    if (!fileEl) return { file: null, line: null };
    const path =
      fileEl.getAttribute && fileEl.getAttribute("data-tagsearch-path")
        ? fileEl.getAttribute("data-tagsearch-path")
        : fileEl.querySelector?.(".file-header")?.getAttribute("data-path") ||
          fileEl.querySelector?.("[data-path]")?.getAttribute("data-path") ||
          null;
    let best = null,
      bestDist = Infinity;
    fileEl.querySelectorAll?.("td.blob-num[data-line-number]").forEach((td) => {
      const r = td.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - cy);
      if (d < bestDist) {
        bestDist = d;
        best = td;
      }
    });
    const line = best ? parseInt(best.getAttribute("data-line-number"), 10) : null;
    return { file: path, line: Number.isFinite(line) ? line : null };
  }
  const fmtAnchor = (a) =>
    a.file ? `${a.file}${a.line ? ":" + a.line : ""}` : "no on-screen location";

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
        <button id="vp-toggle" class="vp-rec">❚❚ Pause</button>
        <button id="vp-send" class="vp-send" disabled>Stop &amp; dispatch →</button>
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

  // One click = open + start recording immediately (context loads in parallel).
  pill.addEventListener("click", () => {
    panel.hidden = false;
    pill.hidden = true;
    loadContext();
    start();
  });
  $("#vp-close").addEventListener("click", () => {
    if (recording) stop();
    panel.hidden = true;
    pill.hidden = false;
  });

  function renderSegments() {
    segEl.innerHTML = segments
      .map(
        (s) =>
          `<li><span class="vp-loc">${s.file ? fmtAnchor(s) : "unanchored"}</span>${escapeHtml(
            s.text
          )}</li>`
      )
      .join("");
    sendBtn.disabled = segments.length === 0;
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

  // ---------- speech ----------------------------------------------------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let liveInterim = "";
  function paintLooking() {
    if (!recording) return (lookingEl.textContent = "");
    lookingEl.innerHTML = liveInterim
      ? `<span class="vp-interim">“${escapeHtml(liveInterim)}”</span>`
      : `<span class="vp-dim">🔴 listening · looking at ${escapeHtml(fmtAnchor(anchorNow()))}</span>`;
  }
  function start() {
    if (recording) return;
    recording = true;
    liveInterim = "";
    toggleBtn.textContent = "❚❚ Pause";
    toggleBtn.classList.add("vp-recording");
    paintLooking();
    anchorTimer = setInterval(paintLooking, 350);
    if (SR) {
      recog = new SR();
      recog.continuous = true;
      recog.interimResults = true; // live text as you speak → feels responsive
      recog.lang = "en-US";
      recog.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) addSegment(r[0].transcript);
          else interim += r[0].transcript;
        }
        liveInterim = interim;
      };
      recog.onerror = (ev) => {
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed")
          lookingEl.innerHTML = `<span class="vp-warn">mic blocked — click the 🔒 in the address bar to allow the mic, or just type comments</span>`;
      };
      recog.onend = () => {
        if (recording) try { recog.start(); } catch {}
      };
      try { recog.start(); } catch {}
    } else {
      lookingEl.innerHTML = `<span class="vp-warn">no Web Speech API in this browser — type your comments</span>`;
    }
  }
  function stop() {
    recording = false;
    liveInterim = "";
    toggleBtn.textContent = "● Resume";
    toggleBtn.classList.remove("vp-recording");
    clearInterval(anchorTimer);
    lookingEl.textContent = "";
    if (recog) try { recog.stop(); } catch {}
  }
  toggleBtn.addEventListener("click", () => (recording ? stop() : start()));
  typeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      addSegment(typeEl.value);
      typeEl.value = "";
    }
  });

  // ---------- hand off to the orchestrator ------------------------------------
  sendBtn.addEventListener("click", async () => {
    if (recording) stop();
    sendBtn.disabled = true;
    toggleBtn.disabled = true;
    statusEl.hidden = false;
    statusEl.innerHTML = `<div class="vp-line">handing ${segments.length} comment(s) to the orchestrator…</div>
      <div class="vp-reassure">You can close this tab — the PR updates in a few minutes.</div>`;
    try {
      const port = chrome.runtime.connect({ name: "session" });
      port.onMessage.addListener((ev) => {
        if (ev.stage === "_end") return port.disconnect();
        onEvent(ev);
      });
      port.postMessage({ prRef: prUrl, segments });
    } catch (e) {
      line(`error: ${e.message}`, true);
    }
  });

  const STAGE = {
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
