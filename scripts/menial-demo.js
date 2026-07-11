#!/usr/bin/env node
// Dry-run the menial fast path against the bundled sample fixture.
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { applyMenialEdit, planMenialEdit } from "../lib/menial.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(root, "fixtures", "menial-sample.md");

process.env.VOICE_PR_MENIAL_FAST_PATH = "1";

const segments = [
  {
    text: process.argv[2] || "change this heading to PipelineABTreatment",
    file: "fixtures/menial-sample.md",
    line: 3,
    snippet: process.argv[3] || "MENIAL_SNIPPET_v1",
  },
];

const plan = planMenialEdit(segments);
if (!plan.eligible) {
  console.error(`menial plan rejected: ${plan.reason}`);
  process.exitCode = 1;
  process.exit();
}

const workspace = await mkdtemp(join(tmpdir(), "vp-menial-demo-"));
try {
  await mkdir(join(workspace, "fixtures"), { recursive: true });
  await cp(fixture, join(workspace, "fixtures", "menial-sample.md"));
  const samplePath = join(workspace, "fixtures", "menial-sample.md");
  const before = await readFile(samplePath, "utf8");
  const result = await applyMenialEdit({ plan, workspace });
  if (!result.applied) {
    console.error(`menial apply rejected: ${result.reason}`);
    process.exitCode = 1;
    process.exit();
  }

  const after = await readFile(samplePath, "utf8");
  console.log("menial fast path demo");
  console.log("---------------------");
  console.log(`speech:   "${segments[0].text}"`);
  console.log(`anchor:   ${segments[0].file} snippet="${segments[0].snippet}"`);
  console.log(`replace:  ${result.oldValue} → ${result.newValue}`);
  console.log("");
  console.log("before:");
  console.log(before.trimEnd());
  console.log("");
  console.log("after:");
  console.log(after.trimEnd());
  console.log("");
  console.log("Try it on a PR:");
  console.log("  1. VOICE_PR_MENIAL_FAST_PATH=1 npm run daemon:restart");
  console.log("  2. Open a PR Files changed view");
  console.log("  3. Select the exact text you want replaced in the diff");
  console.log('  4. Record: "change this to <new value>"');
  console.log("  5. Dispatch");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
