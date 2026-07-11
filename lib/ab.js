export function summarizeExperiment(events) {
  const sessions = new Map();
  for (const event of events) {
    if (!event?.sessionId) continue;
    if (event.code === "bridge.dispatch.start") {
      sessions.set(event.sessionId, {
        variant: event.detail?.pipelineVariant || "prewarm-legacy",
        result: null,
        failed: false,
      });
    } else if (event.code === "result") {
      const session = sessions.get(event.sessionId) || {
        variant:
          event.detail?.metrics?.pipelineVariant || "prewarm-legacy",
        result: null,
        failed: false,
      };
      session.variant =
        event.detail?.metrics?.pipelineVariant || session.variant;
      session.result = event.detail;
      sessions.set(event.sessionId, session);
    } else if (event.code === "bridge.dispatch.error") {
      const session = sessions.get(event.sessionId) || {
        variant: event.detail?.pipelineVariant || "unknown",
        result: null,
        failed: false,
      };
      session.failed = true;
      sessions.set(event.sessionId, session);
    }
  }

  const groups = new Map();
  for (const session of sessions.values()) {
    const group = groups.get(session.variant) || {
      variant: session.variant,
      started: 0,
      completed: 0,
      failed: 0,
      commitRuns: 0,
      staleHeadRefreshes: 0,
      latencies: [],
    };
    group.started++;
    if (session.failed) group.failed++;
    if (session.result) {
      group.completed++;
      if (session.result.commits?.length) group.commitRuns++;
      if (session.result.metrics?.staleHeadRefresh)
        group.staleHeadRefreshes++;
      if (Number.isFinite(session.result.metrics?.stopToPatchMs))
        group.latencies.push(session.result.metrics.stopToPatchMs);
    }
    groups.set(session.variant, group);
  }

  return [...groups.values()]
    .map((group) => ({
      variant: group.variant,
      started: group.started,
      completed: group.completed,
      failed: group.failed,
      commitAcceptanceRate:
        group.started > 0 ? group.commitRuns / group.started : null,
      staleHeadRefreshes: group.staleHeadRefreshes,
      medianStopToPatchMs: percentile(group.latencies, 0.5),
      p95StopToPatchMs: percentile(group.latencies, 0.95),
    }))
    .sort((a, b) => a.variant.localeCompare(b.variant));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
