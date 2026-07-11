import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyMenialEdit,
  menialFastPathEnabled,
  parseExplicitReplaceIntent,
  parseMenialReplaceIntent,
  parseSnippetReplaceIntent,
  planMenialEdit,
  tryMenialEdit,
} from "../lib/menial.js";

const segment = {
  text: "change this heading to PipelineABTreatment",
  file: "docs/sample.md",
  line: 3,
  snippet: "PipelineIsDead",
};

test("menial fast path is disabled unless explicitly enabled", () => {
  const previous = process.env.VOICE_PR_MENIAL_FAST_PATH;
  delete process.env.VOICE_PR_MENIAL_FAST_PATH;
  assert.equal(menialFastPathEnabled(), false);
  assert.equal(planMenialEdit([segment]).reason, "disabled");
  process.env.VOICE_PR_MENIAL_FAST_PATH = previous;
});

test("parseMenialReplaceIntent accepts common replace phrasing", () => {
  assert.deepEqual(parseSnippetReplaceIntent("change this to Foo"), { newValue: "Foo" });
  assert.deepEqual(parseExplicitReplaceIntent("change Purpose to Intent"), {
    oldValue: "Purpose",
    newValue: "Intent",
  });
  assert.deepEqual(parseExplicitReplaceIntent("Change Miller to George."), {
    oldValue: "Miller",
    newValue: "George",
  });
  assert.equal(parseMenialReplaceIntent("refactor the whole module"), null);
});

test("planMenialEdit requires one anchored snippet segment", () => {
  const previous = process.env.VOICE_PR_MENIAL_FAST_PATH;
  process.env.VOICE_PR_MENIAL_FAST_PATH = "1";
  assert.equal(planMenialEdit([]).reason, "requires exactly one segment");
  assert.equal(planMenialEdit([segment, segment]).reason, "requires exactly one segment");
  assert.equal(planMenialEdit([{ ...segment, file: null }]).reason, "missing file anchor");
  assert.equal(
    planMenialEdit([
      { ...segment, text: "change this to PipelineABTreatment", snippet: "" },
    ]).reason,
    "missing snippet anchor"
  );
  assert.equal(
    planMenialEdit([
      {
        text: "change this to Miller is awesome",
        file: "README.md",
        line: 2,
      },
    ]).reason,
    "missing snippet anchor"
  );
  assert.equal(
    planMenialEdit([
      {
        text: "change the first line to say Miller is awesome",
        file: "README.md",
        line: 2,
      },
    ]).reason,
    "explicit old value too vague"
  );
  const explicit = planMenialEdit([
    { text: "Change Purpose to Intent", file: "README.md", line: 10 },
  ]);
  assert.equal(explicit.eligible, true);
  assert.equal(explicit.oldValue, "Purpose");
  assert.equal(explicit.newValue, "Intent");
  assert.equal(explicit.lineScoped, true);
  const plan = planMenialEdit([segment]);
  assert.equal(plan.eligible, true);
  assert.equal(plan.oldValue, "PipelineIsDead");
  assert.equal(plan.newValue, "PipelineABTreatment");
  process.env.VOICE_PR_MENIAL_FAST_PATH = previous;
});

test("applyMenialEdit replaces a unique snippet in the worktree", async () => {
  const previous = process.env.VOICE_PR_MENIAL_FAST_PATH;
  process.env.VOICE_PR_MENIAL_FAST_PATH = "1";
  const dir = await mkdtemp(join(tmpdir(), "vp-menial-"));
  try {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "sample.md"), "# Title\n\nPipelineIsDead\n");
    const plan = planMenialEdit([segment]);
    const result = await applyMenialEdit({ plan, workspace: dir });
    assert.equal(result.applied, true);
    const updated = await readFile(join(dir, "docs", "sample.md"), "utf8");
    assert.match(updated, /PipelineABTreatment/);
    assert.doesNotMatch(updated, /PipelineIsDead/);
  } finally {
    process.env.VOICE_PR_MENIAL_FAST_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyMenialEdit replaces on an anchored line without a snippet", async () => {
  const previous = process.env.VOICE_PR_MENIAL_FAST_PATH;
  process.env.VOICE_PR_MENIAL_FAST_PATH = "1";
  const dir = await mkdtemp(join(tmpdir(), "vp-menial-"));
  try {
    await writeFile(
      join(dir, "README.md"),
      "# Title\n\n## Purpose\n\nMiller was here.\n"
    );
    const plan = planMenialEdit([
      { text: "Change Purpose to Intent", file: "README.md", line: 3 },
    ]);
    const result = await applyMenialEdit({ plan, workspace: dir });
    assert.equal(result.applied, true);
    const updated = await readFile(join(dir, "README.md"), "utf8");
    assert.match(updated, /## Intent/);
    assert.doesNotMatch(updated, /## Purpose/);
    assert.match(updated, /Miller was here/);
  } finally {
    process.env.VOICE_PR_MENIAL_FAST_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyMenialEdit refuses ambiguous multi-match snippets", async () => {
  const previous = process.env.VOICE_PR_MENIAL_FAST_PATH;
  process.env.VOICE_PR_MENIAL_FAST_PATH = "1";
  const dir = await mkdtemp(join(tmpdir(), "vp-menial-"));
  try {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(
      join(dir, "docs", "sample.md"),
      "PipelineIsDead and PipelineIsDead again\n"
    );
    const result = await tryMenialEdit({ segments: [segment], workspace: dir });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "old value is not unique in file");
  } finally {
    process.env.VOICE_PR_MENIAL_FAST_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
