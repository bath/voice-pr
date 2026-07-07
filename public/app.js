// voice-pr client: speech capture + streaming batch progress.
const $ = (id) => document.getElementById(id);
const prInput = $("pr");
const talkBtn = $("talk");
const transcriptEl = $("transcript");
const fireBtn = $("fire");
const hint = $("hint");
const statusEl = $("status");
const statusLine = $("status-line");
const spinner = $("spinner");
const logEl = $("log");
const resultEl = $("result");
const listeningEl = $("listening");

// --- persist the PR field -------------------------------------------------
prInput.value = localStorage.getItem("voice-pr:pr") || "";
prInput.addEventListener("input", () =>
  localStorage.setItem("voice-pr:pr", prInput.value)
);

// --- speech recognition ---------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let recording = false;
let finalText = "";

if (SR) {
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = "en-US";
  recog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + " ";
      else interim += r[0].transcript;
    }
    transcriptEl.value = (finalText + interim).trim();
    refreshFire();
  };
  recog.onerror = (e) => {
    hint.textContent = `mic error: ${e.error}`;
    stopRecording();
  };
  recog.onend = () => {
    if (recording) recog.start(); // keep alive until user stops
  };
} else {
  talkBtn.disabled = true;
  hint.textContent = "Voice needs Chrome — you can type your feedback instead.";
}

function startRecording() {
  if (!recog || recording) return;
  finalText = transcriptEl.value ? transcriptEl.value + " " : "";
  recording = true;
  talkBtn.classList.add("recording");
  talkBtn.setAttribute("aria-pressed", "true");
  listeningEl.hidden = false;
  try {
    recog.start();
  } catch {}
}
function stopRecording() {
  if (!recording) return;
  recording = false;
  talkBtn.classList.remove("recording");
  talkBtn.setAttribute("aria-pressed", "false");
  listeningEl.hidden = true;
  try {
    recog.stop();
  } catch {}
  refreshFire();
}
function toggleRecording() {
  recording ? stopRecording() : startRecording();
}

talkBtn.addEventListener("click", toggleRecording);
// Spacebar as push/toggle — but not while typing in a field.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  e.preventDefault();
  toggleRecording();
});

transcriptEl.addEventListener("input", () => {
  finalText = transcriptEl.value + " ";
  refreshFire();
});
function refreshFire() {
  fireBtn.disabled = !(prInput.value.trim() && transcriptEl.value.trim());
}
prInput.addEventListener("input", refreshFire);

// --- fire the batch -------------------------------------------------------
fireBtn.addEventListener("click", async () => {
  stopRecording();
  const prRef = prInput.value.trim();
  const transcript = transcriptEl.value.trim();
  if (!prRef || !transcript) return;

  fireBtn.disabled = true;
  resultEl.hidden = true;
  resultEl.innerHTML = "";
  logEl.innerHTML = "";
  statusEl.hidden = false;
  spinner.classList.remove("stopped");
  setStatus("sending…");

  try {
    const res = await fetch("/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prRef, transcript }),
    });
    await readStream(res.body, handleEvent);
  } catch (e) {
    setStatus(`error: ${e.message}`, true);
  } finally {
    fireBtn.disabled = false;
  }
});

async function readStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

const STAGE_TEXT = {
  parsed: () => "parsing PR reference…",
  "pr-loaded": (d) => `loaded PR: ${d.title} (branch ${d.branch})`,
  cloning: (d) => `checking out ${d.branch} in an isolated worktree…`,
  "agent-start": (d) => `agent working through your feedback (${d.model})…`,
  "agent-done": () => "agent finished — reviewing what it did…",
  manifest: (d) => `${d.committed} change(s) made, ${d.unclear} need clarification`,
  pushing: (d) => `pushing commits to ${d.branch}…`,
  commenting: (d) => `commenting on ${d.file}:${d.line}…`,
  clarifying: (d) => `noting ${d.count} unclear item(s) for you…`,
  // orchestrator backend
  "project-ready": (d) => `repo registered with the orchestrator (${d.path})`,
  "work-filed": (d) => `filed work item ${d.id} into the orchestrator`,
  dispatching: (d) => `mailed the mayor to dispatch work item ${d.id}…`,
  "work-status": (d) => `work item ${d.id}: ${d.status}`,
  "re-signaled": (d) => `mayor was slow — re-mailed dispatch-ready for ${d.id}`,
  refinery: (d) => `refinery: ${d.status}`,
};

function handleEvent(ev) {
  const { stage, detail } = ev;
  if (stage === "result") return renderResult(detail);
  if (stage === "error") return setStatus(`error: ${detail.message}`, true);

  if (stage === "agent-log") {
    if (detail.line) appendLog(detail.line, "agent");
    return;
  }
  const fn = STAGE_TEXT[stage];
  const msg = fn ? fn(detail || {}) : stage;
  setStatus(msg);
  appendLog(`[${ev.t ?? "?"}s] ${msg}`);
}

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.className = isError ? "error" : "";
  if (isError) spinner.classList.add("stopped");
}
function appendLog(text, cls = "") {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderResult(r) {
  spinner.classList.add("stopped");
  const esc = (s) =>
    (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  if (r.backend === "orchestrator") return renderOrchestratorResult(r, esc);

  setStatus(`done in a couple minutes — ${r.summary || "handled your feedback"}`);
  let html = `<h2>✅ Ready to review</h2>`;
  html += `<p class="summary"><a href="${r.pr.url}" target="_blank">${esc(
    r.pr.title
  )}</a> — ${r.committed.length} committed, ${r.needsClarification.length} need you</p>`;

  if (r.committed.length) {
    html += `<div class="section-label">Committed & commented</div><ul>`;
    for (const c of r.committed) {
      const link = c.commentUrl
        ? ` · <a href="${c.commentUrl}" target="_blank">comment</a>`
        : "";
      html += `<li class="card done">
        <div class="title">${esc(c.title)}</div>
        <div class="meta">${esc(c.file)}:${c.line} · ${(c.commit || "").slice(0, 8)}${link}</div>
        <div class="rationale">${esc(c.rationale)}</div>
      </li>`;
    }
    html += `</ul>`;
  }

  if (r.needsClarification.length) {
    html += `<div class="section-label">Needs your clarification</div><ul>`;
    for (const u of r.needsClarification) {
      html += `<li class="card unclear">
        <div class="title">${esc(u.title)}</div>
        <div class="rationale">${esc(u.clarification)}</div>
      </li>`;
    }
    html += `</ul>`;
    if (r.clarificationCommentUrl)
      html += `<p class="summary" style="margin-top:10px"><a href="${r.clarificationCommentUrl}" target="_blank">See the clarification comment on the PR →</a></p>`;
  }

  resultEl.innerHTML = html;
  resultEl.hidden = false;
}

function renderOrchestratorResult(r, esc) {
  const ok = r.status === "done";
  const icon = ok ? "✅" : r.status === "failed" ? "⚠️" : "⏳";
  setStatus(`${r.summary}`, r.status === "failed");
  const refLine = r.refinery
    ? `refinery: <code>${esc(r.refinery.status)}</code>${
        r.refinery.branch ? ` (${esc(r.refinery.branch)})` : ""
      }`
    : "no refinery record";
  resultEl.innerHTML = `
    <h2>${icon} Orchestrator: ${esc(r.status)}</h2>
    <p class="summary"><a href="${r.pr.url}" target="_blank">${esc(
      r.pr.title
    )}</a> — merged onto <code>${esc(r.pr.branch)}</code></p>
    <ul>
      <li class="card ${ok ? "done" : "unclear"}">
        <div class="title">Work item <code>${esc(r.workItemId)}</code></div>
        <div class="meta">${refLine}</div>
        <div class="rationale">${esc(r.summary)}</div>
      </li>
    </ul>
    ${
      r.trailCommentUrl
        ? `<p class="summary" style="margin-top:10px"><a href="${r.trailCommentUrl}" target="_blank">See the intent-trail comment on the PR →</a></p>`
        : ""
    }
    <p class="summary" style="margin-top:10px">Ran through the containerized pogo loop (mayor → polecat → refinery). Open the PR to see the merged commits.</p>`;
  resultEl.hidden = false;
}

refreshFire();
