# voice-pr

**Scroll your PR diff in Chrome and talk. Walk away. Come back to commits.**

You're on your PR's *Files changed* tab. You hit record, scroll through the
diff, and just say what you think — "this retry needs backoff… rename this
var… why are we fetching twice here." Each comment is **anchored to the file+line
you were looking at when you said it**, enriched with the ticket / Slack / CI
context, batched into one task, and handed to your **orchestrator** to do the
work. Minutes later the PR has real commits.

```
  Chrome extension on the PR page
    ● record → scroll + talk → each chunk anchored to the viewport's file:line
        │  (+ auto-pull: Jira ticket, Slack threads, CI status)
        ▼  POST /api/dispatch
  local bridge (this Node server)  ──►  pogo orchestrator
        │                                 mayor → polecat (worktree) → refinery
        │                                 └─ commits merged onto the PR branch
        ▼
  bridge posts the intent-trail comment on the PR after the merge
```

The front-end is a **Chrome extension** (`extension/`) that lives on the GitHub
PR page; the Node server is only a **local bridge** it talks to.

The extension is a content script (`content.js`, the PR-page UI + viewport
anchoring) plus a **background service worker** (`background.js`) that makes the
bridge calls. That split is load-bearing: Chrome blocks a content script from
fetching the `localhost` loopback directly, so all bridge traffic goes through
the worker (extension context, covered by `host_permissions`). Verified live in
Chrome — injection, viewport anchoring on GitHub's real diff DOM, the context
call, and session streaming all exercised end-to-end.

## The design (decided in a grill-me session)

| Decision | Choice |
|---|---|
| **Who speaks** | The PR **author**, dictating changes to their **own** PR. |
| **Source of truth** | The **pushed head branch** — exactly what you see on GitHub. You're in a browser, not editing locally, so there's no working-tree collision. |
| **What comments are for** | An **anchored intent trail**: each committed change gets a comment pinned to the line, explaining why it changed and linking the commit. They stay as a record. |
| **Confident items** | Real edits, **one commit per item**, pushed to the branch. |
| **Unclear items** | **Not acted on.** Batched into one comment saying your direction wasn't clear enough — so a wrong guess never lands silently. |
| **Activation** | **Explicit, hub-first** — opening the panel lands on the *hub* (your dispatched-work fleet), never a live mic. Recording is one deliberate tap (or ⌥⇧R). Opening is never consenting. |
| **Anchoring** | **Auto from viewport** — each spoken chunk pins to the `file:line` centered on screen when you said it. Say "over in utils…" and the agent follows meaning over the anchor. |
| **Context** | On session start the bridge detects the **Jira key** + **CI status**; the polecat pulls the **ticket** and **Slack** threads via its MCP tools at work-time. |
| **Execution** | Via the **orchestrator** (mayor → polecat in a worktree → refinery merge onto the PR branch). Never force-pushes, rebases, or amends. |
| **Safety net** | Everything lands as **commits you review before merge**; unclear work is surfaced as a comment, not guessed. |

## The two-minds hub (D3 + D1)

voice-pr does two jobs that pull in opposite directions: **create** (dictate
changes into *this* PR — instant, in-context) and **monitor** (watch the fleet
of work you've dispatched across *all* PRs — ambient, glanceable). Earlier they
shared one door that opened straight into a live mic, so a reload or a glance
could arm recording or report live work as "lost."

The fix (the "one door, two rooms" memo's recommendation):

- **Hub-first (D3).** Opening the panel lands on the hub — a monitor surface
  showing every PR with work in flight, this PR's own job highlighted, each
  state rendered as its own card. **Record on this PR** sits on top; recording is
  a deliberate tap that expands into the capture view. The default is always to
  *show*, never to *capture*.
- **A global badge (D1).** The active-job count is mirrored onto the toolbar
  icon (and a compact popup), so it's visible on **any** tab — even a non-GitHub
  one — the moment the in-page panel is collapsed.

Three invariants hold regardless (see `extension/hub.js`):

1. **Opening is not consenting** — loading, reloading, or opening the panel
   never starts capture; the mic arms only on an explicit record action.
2. **Running is not lost** — on load the hub consults the central job registry
   *before* the saved-pending key, so an in-flight or finished job reattaches
   and mirrors live; a resend is offered only for a draft with no job behind it.
3. **Observing is first-class** — the fleet and every status card are pure show;
   none route through, or hint at, the record flow.

The hub is a pure render of state (`VoicePrHub.renderHub`), so every screen is
unit-testable (`test/hub.test.js`) and screenshot-able without a browser. See
the whole state matrix rendered at once:

```bash
# open the real components, driven by fixtures, for every state
open scripts/hub-gallery.html
```

## Quick start (Chrome extension)

```bash
# 1. Start the bridge (talks to gh + your orchestrator container)
node server.js                      # → http://localhost:4100
```

2. Load the extension **once**: open `chrome://extensions`, turn on
   **Developer mode**, click **Load unpacked**, and pick the `extension/`
   folder. (Chrome won't let anything auto-install a local extension — this one
   manual step is unavoidable.)
3. Open any PR's **Files changed** tab on GitHub. A **🎙️ Review with voice**
   pill appears bottom-right.
4. Click it → the **hub** opens: your fleet of dispatched work across every PR,
   with this PR's own job highlighted, and a **Record on this PR** button on top.
   Opening never arms the mic — the hub is a monitor, first.
5. Tap **Record on this PR** (or the pill's ⏺, or press **⌥⇧R**) → scroll and
   talk. Each comment shows the `file:line` it anchored to. (First time, Chrome
   asks for mic permission on github.com. No mic / not Chrome? Type comments
   into the box instead — same result.)
6. **Dispatch →**. Close the tab if you want; the PR updates in a few minutes.
   The hub reattaches to the running job on reload, and the toolbar-icon badge
   shows the live active-job count on **any** tab. Click the icon for the fleet
   without a PR tab open.

Experimental gaze runs WebGazer inside a transparent `chrome-extension://`
overlay, not in the GitHub content-script world. That keeps webcam permission
and model execution on the extension origin while the content script receives
only viewport coordinates for diff anchoring. Webcam frames stay local; this PR
does **not** vendor WebGazer's face-model assets for a fully offline/zero-network
first run, so the extension CSP and host permissions still allow the current
WebGazer model hosts (`tfhub.dev`, `kaggle.com`, and `storage.googleapis.com`).

The extension always routes through the **orchestrator** backend, so the bridge
must be able to reach your pogo container (see below).

## Speech-to-text: local Whisper (private, accurate)

Transcription runs **locally** through `whisper.cpp` on the bridge — audio never
leaves the machine (right call for PR code). The extension records audio + an
anchor timeline; on stop it hands both to the bridge, which transcribes with
Whisper (segment timestamps) and maps each spoken phrase back to the file/line/
selection that was active when you said it.

Setup (one-time):
```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/.cache/whisper
curl -fsSL -o ~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```
`large-v3-turbo-q5_0` (~547MB) runs faster-than-realtime on Apple Silicon and is
far more accurate than the browser's Web Speech API for technical speech. Swap
the model via `VOICE_PR_WHISPER_MODEL`.

## Requirements

- **Node ≥ 20** (bridge uses only built-ins — no `npm install`).
- **`gh` CLI**, authenticated with push access to the target repo.
- **`whisper-cli` + `ffmpeg`** + a GGML model (see above) for transcription.
- A running **pogo orchestrator container** (`codingagent`) — see "orchestrator
  backend" below.
- **Chrome** for the extension + mic.

## Run

```bash
node server.js            # → http://localhost:4100  (set PORT to change)
```

That's the bridge. Load the extension (see Quick start), open a PR's **Files
changed** tab, record, and talk. Progress streams live in the PR-page panel, but
the whole point is you can close the tab — it runs asynchronously and the PR
updates in a few minutes.

### Try it against a throwaway PR

```bash
npm run demo              # creates bath-tub/voice-pr-demo + opens a fresh PR
```

It prints a PR URL and a suggested thing to say (with one deliberately vague
item so you can see the clarification path). Nothing real is touched.

## How it works

1. **`server.js`** — dependency-free Node HTTP bridge. Exposes the four
   endpoints the extension calls (`/api/context`, `/api/preflight`,
   `/api/transcribe`, `/api/dispatch`) and streams session progress back as
   newline-delimited JSON. `/api/dispatch` transcribes the recording and runs the
   session end-to-end server-side, so it completes even if you close the tab.
2. **`extension/`** — the PR-page UI (`content.js`), viewport anchoring
   (`anchors.js`), gaze overlay (`gaze.js`), and the bridge-calling service
   worker (`background.js`).
3. **`lib/pipeline.js`** — `runSession`: parse PR → `gh pr view` → detect the
   Jira key + CI status → build the orchestrator work-item body → file it and
   track it to a merge → post the anchored intent-trail comment via `gh`.
4. **`lib/prompt.js`** — `buildSessionBody`: instructs the polecat to segment the
   anchored comments, confidence-gate each one, make one commit per confident
   item, and leave anything too vague for a clarification note.
5. **`lib/github.js`** — PR parsing + `gh` operations.

## Orchestrator backend

voice-pr is a **producer of work items** for a locally running pogo orchestrator
container (mayor → polecat → refinery). The adapter (`lib/orchestrator.js`,
transport = `docker exec`):

1. **Clones** the PR's repo into the container workspace on the head branch and
   registers it (`pogo project add`).
2. **Files a work item** — `mg new --repo <container-path> --branch <PR-head>
   --assignee mayor --tag source=voice-pr`. Setting `--branch` to the PR head is
   the key: the refinery's merge `--target` becomes the PR branch, so the
   polecat's commits land **on the PR**.
3. **Nudges the mayor** to run a coordination cycle now (`pogo nudge mayor`).
4. **Tracks** the item (`mg show`, `pogo refinery history`) through
   claim → commit → refinery gates → fast-forward merge, emitting the same
   progress-event shape the UI already renders.

The work-item body (`buildSessionBody`) carries the voice-pr conventions into the
polecat: segment the anchored comments, confidence-gate, one commit per confident
item, and call out anything too vague as needing clarification. The voice-pr
bridge posts the intent-trail comment on the PR after it observes the merge (the
polecat can't — pogod reaps it the moment the merge lands). The polecat template
already owns the claim / commit / `refinery submit` / done protocol.

**Orchestrator credential note (operational):** the pogo container's Claude auth
is wired in at `docker run` time (an OAuth token copied into a bind-mounted
file, or `ANTHROPIC_API_KEY`). OAuth tokens expire — if the mayor/polecats log
`API Error: 401 Invalid authentication credentials`, refresh the mounted file
(`security find-generic-password -s "Claude Code-credentials" -w >
~/.codingagent/secrets/claude-credentials.json`) and restart the mayor
(`pogo agent stop mayor`; pogod respawns it). Injecting a real
`ANTHROPIC_API_KEY` avoids the expiry entirely.

## Config

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `4100` | HTTP port |
| `VOICE_PR_CONTAINER` | `codingagent` | orchestrator container name |
| `VOICE_PR_WORKSPACE` | `/home/pogo/workspace` | repo checkout root inside the container |
| `VOICE_PR_DISPATCH_MS` | `720000` | how long to track a work item before returning |
| `VOICE_PR_WHISPER_BIN` | `whisper-cli` | whisper.cpp binary |
| `VOICE_PR_WHISPER_MODEL` | `~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin` | GGML model path |
| `VOICE_PR_ARCHIVE_DIR` | `~/.voice-pr/sessions` | where session fixtures + traces are saved |
| `VOICE_PR_LOG_MAX_BYTES` | `5000000` | rotate the global `bridge.ndjson` past this size |
| `VOICE_PR_TRACE_EXEC` | _(unset)_ | mirror `exec.*` child-process events to the console too (they're always in the NDJSON logs); off by default to keep the poll loop from spamming the terminal |

## Session archive (fixtures)

Every session is saved under `VOICE_PR_ARCHIVE_DIR/<sessionId>/` for replay,
test cases, and examples:
- `audio.<ext>` — the raw recording
- `transcript.json` — raw text, anchored segments, whisper segment timestamps, the anchor timeline
- `session.json` — the dispatched segments, every orchestrator progress event, and the final result
- `trace.ndjson` — the full structured trace of the session (see below)

The `sessionId` (minted by the extension at record-start) correlates the
recording, its transcript, and the orchestrator run it produced.

## Traceability (point an AI agent at any session)

Everything the program does — a request, a child process, a stage transition, an
error — is recorded as one structured NDJSON line so you can hand a failed
recording to an AI agent and have it walk **symptom → code → fix** with no
guessing. Just say: _"look at my most recent recording and figure out what
happened."_

```sh
npm run trace                 # dump the most recent session, agent-formatted
npm run trace <sessionId>     # a specific session
npm run trace --list          # recent sessions, newest first
npm run trace <id> --json     # raw parsed records
```

Each record carries:
- **`sessionId`** — the same id that names the recording on disk, tying audio,
  transcript, and every downstream event together.
- **`code`** — a stable dotted event name (e.g. `exec.fail`, `bridge.dispatch.error`).
  Every code is a **literal string in the source** — `git grep` it and you land on
  the exact emit site. This is the invariant that makes the trace naively mappable.
- **`loc`** — `file:line` of the emit call, captured from the stack. For the layer
  that actually shells out (`lib/exec.js`), `exec.fail` records also carry the
  child process's stderr — usually the smoking gun.

Where it all lands (local only — nothing is uploaded, and the public repo never
commits recordings/transcripts/logs):
- `~/.voice-pr/sessions/<id>/trace.ndjson` — one session's full trace
- `~/.voice-pr/bridge.ndjson` — global rolling log across sessions
- `~/.voice-pr/last-session.json` — pointer to the most recent session

Propagation is ambient (`AsyncLocalStorage`): a request opens one trace scope and
every layer beneath it — the pipeline, the orchestrator, each child process —
logs to that session automatically. The Chrome panel keeps its own client-side
trail (in `chrome.storage`, surviving a tab refresh); **any error surfaces a
"Copy diagnostic report" button** whose clipboard payload includes the failure,
the correlation id, where the logs live, the event trail, and an explicit prompt
telling an AI agent exactly how to find the fault in the code.

## Known MVP limits (next passes)

- **Same-repo PRs only** — fork/cross-repo head branches are rejected (would
  need a remote-add + push-to-fork path).
- **Confidence ≠ correctness.** The agent can be confidently wrong; the backstop
  is that everything is a reviewable commit, never an auto-merge. The refinery
  gates the commits before merge, but review remains the final safety check.
- **No concurrency control** — fire a second session before the first finishes and
  two work items race on the same branch. Real version needs a per-branch queue.
- **One commit per item** assumes items are independent; overlapping edits to the
  same lines aren't ordered.
- **Extension anchoring targets GitHub's current diff DOM** — if the mic is
  blocked by a page `Permissions-Policy` or GitHub restructures the diff markup,
  anchoring degrades to file-only or no anchor (the agent then infers location
  from the words + context). The typed-comment box always works as a fallback.
- **Context depth is delegated** — the bridge only detects the Jira key + CI
  cheaply; the actual ticket/Slack reads happen inside the polecat via MCP, so
  they only enrich the work, not the live UI. A richer live "context found"
  panel would need the bridge itself to hold those integrations.
