import assert from "node:assert/strict";
import test from "node:test";
import { summarizeExperiment } from "../lib/ab.js";

function event(sessionId, code, detail = {}) {
  return { sessionId, code, detail };
}

test("A/B report groups latency and safety signals by pipeline variant", () => {
  const events = [
    event("control-1", "bridge.dispatch.start", {
      pipelineVariant: "prewarm",
    }),
    event("control-1", "result", {
      commits: [{ oid: "a" }],
      metrics: {
        pipelineVariant: "prewarm",
        stopToPatchMs: 56_000,
        staleHeadRefresh: false,
      },
    }),
    event("control-2", "bridge.dispatch.start", {
      pipelineVariant: "prewarm",
    }),
    event("control-2", "bridge.dispatch.error"),
    event("treatment-1", "bridge.dispatch.start", {
      pipelineVariant: "single-turn",
    }),
    event("treatment-1", "result", {
      commits: [{ oid: "b" }],
      metrics: {
        pipelineVariant: "single-turn",
        stopToPatchMs: 20_000,
        staleHeadRefresh: true,
      },
    }),
  ];

  assert.deepEqual(summarizeExperiment(events), [
    {
      variant: "prewarm",
      started: 2,
      completed: 1,
      failed: 1,
      commitAcceptanceRate: 0.5,
      staleHeadRefreshes: 0,
      medianStopToPatchMs: 56_000,
      p95StopToPatchMs: 56_000,
    },
    {
      variant: "single-turn",
      started: 1,
      completed: 1,
      failed: 0,
      commitAcceptanceRate: 1,
      staleHeadRefreshes: 1,
      medianStopToPatchMs: 20_000,
      p95StopToPatchMs: 20_000,
    },
  ]);
});
