import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const content = await readFile(
  new URL("../extension/content.js", import.meta.url),
  "utf8"
);
const background = await readFile(
  new URL("../extension/background.js", import.meta.url),
  "utf8"
);
const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

function between(source, start, finish) {
  const from = source.indexOf(start);
  const to = source.indexOf(finish, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing finish marker: ${finish}`);
  return source.slice(from, to);
}

test("passive PR load schedules deterministic preparation only", () => {
  const init = between(content, "function initSurface()", "initSurface();");
  const prepare = between(content, "function preparePage()", "function warmAgent()");
  assert.match(init, /schedulePagePreparation\(\)/);
  assert.match(prepare, /type: "prepare"/);
  assert.match(prepare, /type: "preflight"/);
  assert.doesNotMatch(prepare, /type: "warm"/);
  assert.doesNotMatch(prepare, /getUserMedia|MediaRecorder|warmAgent\(|start\(\)/);
});

test("microphone and Cursor warm remain behind explicit capture", () => {
  const capture = between(
    content,
    "function enterCapture()",
    "function enterDispatchView()"
  );
  assert.match(capture, /warmAgent\(\)/);
  assert.match(capture, /start\(\)/);
});

test("background routes preparation and warm to separate endpoints", () => {
  const prepare = between(
    background,
    'if (msg?.type === "prepare")',
    '// Record-start pre-warm'
  );
  const warm = between(
    background,
    'if (msg?.type === "warm")',
    "// record-start context enrichment"
  );
  assert.match(prepare, /\/api\/prepare/);
  assert.doesNotMatch(prepare, /\/api\/warm/);
  assert.match(warm, /\/api\/warm/);
});

test("server preparation handler cannot start an inference session", () => {
  const prepare = between(
    server,
    "async function handlePrepare",
    "async function handleTranscribe"
  );
  assert.match(prepare, /preparePr\(/);
  assert.doesNotMatch(prepare, /warmSession\(|agentRuntime\.(warm|execute)/);
});

test("dispatch UI and fleet consume warm-wait heartbeat events", () => {
  assert.match(content, /case "agent-warm-waiting"/);
  assert.match(content, /Waiting for agent setup/);
  assert.match(background, /case "agent-warm-waiting"/);
});
