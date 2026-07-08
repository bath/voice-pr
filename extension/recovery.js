// voice-pr crash-recovery decision — the one rule that decides what the on-load
// recovery UI does, factored out of content.js so it can be unit-tested without
// a browser (see test/recovery.test.js, loaded the same way anchors.js is).
//
// The subtlety this fixes (#46): a saved pending bundle alone does NOT mean the
// recording was never dispatched. The dispatch stream runs server-side and
// survives the tab disconnecting, so a hard reload (e.g. GitHub's full reload
// when you return to "Files changed") can race the terminal result event — the
// bundle key is still there only because the client never received the "done"
// event, not because the work was never sent. Once the orchestrator accepts the
// hand-off we persist a marker; recovery consults it so a handed-off bundle
// resumes as "awaiting result" instead of falsely offering a resend (which
// would re-file a duplicate work item).
(function (global) {
  // pending: the saved bundle record (or null). handoff: the persisted
  // hand-off marker (or null) — present once the orchestrator accepted the work.
  // Returns { show, mode, workItemId? }:
  //   { show:false, mode:"none" }            no saved bundle — nothing to do
  //   { show:true,  mode:"awaiting-result" } handed off; work runs server-side
  //   { show:true,  mode:"undispatched" }    genuine crash: saved, never sent
  function decideRecovery(pending, handoff) {
    if (!pending) return { show: false, mode: "none" };
    if (handoff && handoff.handedOff) {
      return { show: true, mode: "awaiting-result", workItemId: handoff.workItemId || null };
    }
    return { show: true, mode: "undispatched" };
  }

  global.VoicePrRecovery = { decideRecovery };
})(globalThis);
