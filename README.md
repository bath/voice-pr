# voice-pr

Speak while reviewing your GitHub PR. The extension anchors speech to the diff
while a local Cursor coding agent preloads the PR, Jira context, repository, and
relevant code. When recording stops, local Whisper transcribes the audio and the
already-warm agent interprets the fuzzy requests, edits, validates, commits, and
pushes to the PR branch.

## Pipeline

```text
Chrome extension
  record starts ──► POST /api/warm
                    resolve PR + Jira key + CI
                    prepare cached worktree
                    Cursor SDK agent analyzes PR/diff/files

  record stops  ──► POST /api/dispatch
                    local Whisper transcription
                    timestamp → file:line anchoring
                    same agent interprets + edits + tests
                    commit + push to PR head
                    bridge posts intent-trail comment
```

There is no orchestrator, work-item queue, mayor, polecat, refinery, or direct
LLM call. The harness is two turns on one durable Cursor SDK agent:

1. **Warm turn:** analyze everything expensive without editing.
2. **Execution turn:** translate anchored speech into actionable changes,
   confidence-gate it, and execute.

Interpretation and execution share one turn after transcription. This preserves
the coding-agent harness without paying for another model round trip.

## Success metric

The primary metric is:

```text
stop-to-patch = patchReadyAt - recordingStoppedAt
```

Each result includes:

- `warmMs`
- `warmWaitMs` — warm work still on the critical path after recording stopped
- `executionMs`
- `stopToPatchMs`

Compare median and p95 `stopToPatchMs` against cold-path recordings. Patch
acceptance, stale-branch failures, and wasted abandoned warm sessions are
guardrails.

## Requirements

- Node.js **22.13+**
- `CURSOR_API_KEY`
- Authenticated `gh` CLI with push access to the PR repository
- `ffmpeg`
- `whisper-cli` and a local whisper.cpp model
- Chrome

Install:

```bash
npm install
brew install ffmpeg whisper-cpp
mkdir -p ~/.cache/whisper
curl -fsSL -o ~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
export CURSOR_API_KEY="cursor_..."
```

## Run

```bash
npm start
```

Then load `extension/` as an unpacked Chrome extension and open a GitHub PR's
Files changed view.

Experimental gaze tracking stays on-device, but the extension does **not** vendor WebGazer's face-model assets.
Its first run may fetch those assets from the model hosts explicitly listed in
the extension CSP.

For an always-on macOS bridge:

```bash
export CURSOR_API_KEY="cursor_..."  # captured in ~/.voice-pr/cursor-api-key (0600)
npm run daemon:install
npm run daemon:status
npm run daemon:restart
npm run daemon:logs
```

## Runtime design

`server.js` exposes:

- `POST /api/warm` — starts workspace preparation and agent analysis at record
  start; returns PR context immediately after the warm job is accepted.
- `POST /api/dispatch` — transcribes, anchors, and sends the final instructions
  to that same agent while streaming NDJSON progress.
- `GET /api/preflight` — checks Whisper, GitHub auth, and Cursor SDK auth.
- `GET /api/context` and `POST /api/transcribe` — standalone diagnostic paths.

The bridge binds only to `127.0.0.1`, accepts browser requests only from Chrome
extension origins, and caps request bodies at 100 MB.

`lib/agent.js` owns the hot agent:

- Bare repository mirrors live under `~/.voice-pr/repo-cache`.
- Session worktrees live under `~/.voice-pr/workspaces`.
- Concurrent recordings can warm independently.
- Final writes to the same PR branch remain serialized.
- The branch is fetched again before execution; only fast-forward drift is
  accepted.
- A completed session is idempotent in-process.
- Warm agents expire after 30 minutes by default.

The local agent loads Cursor user, team, and plugin settings so existing
Jira/MCP context can be consulted during pre-warm. Repository-controlled project
settings are excluded, the warm turn runs in plan mode, and the managed worktree
is verified unchanged before execution. It never force-pushes, rebases, or
amends.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `4100` | Local bridge port |
| `CURSOR_API_KEY` | required | Cursor SDK authentication |
| `VOICE_PR_MODEL` | `composer-2.5` with `fast=true` | Cursor model ID override; setting it disables the default Fast parameter |
| `VOICE_PR_AGENT_TTL_MS` | `1800000` | Abandoned warm-agent lifetime |
| `VOICE_PR_WORKSPACE_DIR` | `~/.voice-pr/workspaces` | Session worktrees |
| `VOICE_PR_REPO_CACHE_DIR` | `~/.voice-pr/repo-cache` | Bare repository mirrors |
| `VOICE_PR_WHISPER_BIN` | `whisper-cli` | whisper.cpp binary |
| `VOICE_PR_WHISPER_MODEL` | `~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin` | Model |
| `VOICE_PR_ARCHIVE_DIR` | `~/.voice-pr/sessions` | Audio, transcripts, results, traces |

## Validation and diagnostics

```bash
npm run check
npm run trace
npm run trace <sessionId>
```

The extension saves a pending recording until the agent returns a terminal
result. Session audio, transcript, timing events, result, and structured trace
remain under `~/.voice-pr/sessions/<sessionId>/`.
