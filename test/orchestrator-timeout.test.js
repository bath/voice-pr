import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCli } from "./helpers/fake-cli.js";

// Timeout derivation needs its own process: DISPATCH_TIMEOUT_MS is read once at
// import time. A negative window makes the very first `Date.now() - started`
// exceed it, so trackWorkItem returns `timeout` on entry — deterministic, with
// no reliance on wall-clock delays or real sleeps.
const ROOT = mkdtempSync(join(tmpdir(), "vp-orch-timeout-"));
process.env.VOICE_PR_ARCHIVE_DIR = join(ROOT, "sessions");
process.env.VOICE_PR_POLL_MS = "1";
process.env.VOICE_PR_DISPATCH_MS = "-1";
process.env.VOICE_PR_CONTAINER = "codingagent";

const fake = installFakeCli(["docker"]);
const { trackWorkItem } = await import("../lib/orchestrator.js");

test("trackWorkItem returns timeout when the dispatch window elapses before a terminal state", async () => {
  fake.setRules([
    { cmd: "docker", pattern: "mg show", code: 0, stdout: "Status: available" },
    { cmd: "docker", pattern: "refinery history", code: 0, stdout: "[]" },
  ]);
  const events = [];
  const outcome = await trackWorkItem("ca-11f8", "/w/r", (stage, detail) => events.push({ stage, detail }));
  assert.equal(outcome.status, "timeout");
  fake.cleanup();
});
