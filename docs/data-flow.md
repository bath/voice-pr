# User-to-commit data flow

This is the happy path from a developer opening a pull request to a voice-driven
commit landing on that pull request's head branch. It distinguishes captured
evidence from inferred intent and shows which component is allowed to publish.

```mermaid
sequenceDiagram
    autonumber
    actor User as Developer
    participant Page as PR content script
    participant Worker as Extension worker
    participant Bridge as Local bridge
    participant Local as Local stores / worktree
    participant Agent as Cursor agent
    participant Harness as Action harness
    participant GitHub as GitHub PR

    rect rgb(242, 247, 255)
        Note over User,GitHub: Before recording: deterministic preparation
        User->>Page: Open a pull request
        Page->>Worker: PR URL
        Worker->>Bridge: POST /api/prepare { prRef }
        Bridge->>GitHub: Read PR metadata, head, and checks
        GitHub-->>Bridge: PR context + current head SHA
        Bridge->>Local: Refresh mirror and prepare PR-head worktree
    end

    rect rgb(250, 247, 240)
        Note over User,GitHub: While recording: capture evidence; perform zero inference
        User->>Page: Select scope and start recording
        Page->>Worker: { sessionId, prRef, recordStartedAt }
        Worker->>Bridge: POST /api/warm
        Bridge->>Local: Lease prepared worktree
        Bridge->>Agent: Create idle agent in that worktree
        loop While the developer reviews the diff
            User->>Page: Speak, point, select, and scroll
            Page->>Page: Accumulate audio + timestamped anchors
        end
    end

    rect rgb(242, 250, 244)
        Note over User,GitHub: After Dispatch: the single inference and publication path
        User->>Page: Dispatch
        Page->>Worker: audio + timeline + typed Utterances + scope
        Worker->>Bridge: POST /api/dispatch (streaming NDJSON response)
        Bridge->>Local: Archive raw audio, timeline, and trace
        Bridge->>Bridge: Whisper audio into timed transcript segments
        Bridge->>Bridge: Join segment timestamps to file / line anchors
        Bridge->>Local: Load open Actions for this user and PR
        Bridge->>Agent: Anchored Utterances + PR context + open Actions + allowed capabilities
        Agent->>Harness: record_action_plan(candidate Action Plan)
        Harness->>Harness: Validate schema, provenance, dependencies, and capabilities
        Harness->>Harness: Apply user scope and spoken narrowing directives
        Harness->>Local: Append Operations, Actions, and planned Effects
        Harness-->>Agent: Authorized Action Plan
        Agent->>Local: Inspect, edit, validate, and create a coherent commit
        Agent-->>Harness: Finished run + committed worktree
        Harness->>Harness: Require a plan, clean worktree, and authorized create_commit Effect
        Harness->>GitHub: Push authorized commit to the current PR branch
        GitHub-->>Harness: Remote head matches expected commit
        Harness->>Local: Record create_commit and push_current_pr Effect receipts
        opt update_current_pr is authorized
            Harness->>GitHub: Post asynchronous intent-trail comment
            Harness->>Local: Record comment Effect receipt
        end
        Harness-->>Bridge: Result + Action summary + timing metrics
        Bridge-->>Worker: NDJSON progress and terminal result
        Worker-->>Page: Compact success or precise exception
        Page-->>User: Commit landed on the PR head
    end
```

## Data boundaries

| Data | Transformation | Durable location | Shared with collaborators |
|---|---|---|---|
| Audio + attention timeline | Whisper produces timed text; timestamps select the active file/line anchor | `~/.voice-pr/sessions/<sessionId>/` | No |
| Anchored Utterances | The single agent turn compiles them into Operations, Actions, and proposed Effects | Session archive and user-local Action history | No |
| Action Plan | The harness validates it and applies the Authorization Envelope before any publication | Session archive plus `~/.voice-pr/actions/` | No |
| Workspace changes | The agent edits, validates, and commits in an isolated prepared worktree | `~/.voice-pr/workspaces/` until cleanup | Only after an authorized push |
| Commit + intent trail | The harness pushes and verifies the commit, then optionally posts the comment | GitHub PR head and PR conversation | Yes |
| Effect receipts | The harness records evidence that authorized Effects completed | `~/.voice-pr/actions/` | No |

The commit is considered landed only after the harness verifies that the remote
PR head equals the expected local commit. The agent never pushes directly and
spoken commentary never expands the selected Authorization Envelope.
