import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const content = await readFile(
  new URL("../extension/content.js", import.meta.url),
  "utf8"
);
const manifest = JSON.parse(
  await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")
);

async function loadTimer() {
  const source = await readFile(
    new URL("../extension/timer.js", import.meta.url),
    "utf8"
  );
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.VoicePrTimer;
}

test("elapsed timer runs from recording stop and accepts server-authoritative latency", async () => {
  const { createElapsedTimer } = await loadTimer();
  let now = 1_000;
  let scheduled = null;
  let cancelled = null;
  const ticks = [];
  const timer = createElapsedTimer({
    now: () => now,
    setInterval: (callback) => {
      scheduled = callback;
      return 42;
    },
    clearInterval: (id) => {
      cancelled = id;
    },
    onTick: (elapsed, state) => ticks.push({ elapsed, running: state.running }),
  });

  timer.start(750);
  assert.equal(timer.elapsed(), 250);
  now = 2_250;
  scheduled();
  assert.equal(timer.elapsed(), 1_500);
  assert.equal(timer.stop(1_234), 1_234);
  assert.equal(cancelled, 42);
  assert.deepEqual(ticks.at(-1), { elapsed: 1_234, running: false });
});

test("elapsed timer does not restart during dispatch retries and reset clears it", async () => {
  const { createElapsedTimer } = await loadTimer();
  let now = 5_000;
  let schedules = 0;
  const timer = createElapsedTimer({
    now: () => now,
    setInterval: () => ++schedules,
    clearInterval: () => {},
  });

  timer.start(4_000);
  now = 8_000;
  timer.start(7_500);
  assert.equal(schedules, 1);
  timer.stop();
  assert.equal(timer.elapsed(), 4_000);
  timer.reset();
  assert.equal(timer.elapsed(), 0);
  assert.equal(timer.running(), false);
});

test("capture UI wires stop-to-commit timing before content script startup", () => {
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("timer.js") < scripts.indexOf("content.js"));
  assert.match(
    content,
    /const recordingStoppedAt = Date\.now\(\);\s+startCommitTimer\(recordingStoppedAt\)/
  );
  assert.match(
    content,
    /case "agent-finished":\s+finishCommitTimer\(d\.commits \? \(d\.published \? "landed" : "local"\) : "no-commit"\)/
  );
  assert.match(content, /receipt\.published \? "landed" : "local"/);
  assert.match(content, /r\.metrics\?\.stopToPatchMs/);
});
