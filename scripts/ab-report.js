#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { summarizeExperiment } from "../lib/ab.js";

const tracePath =
  process.argv[2] ||
  join(homedir(), ".voice-pr", "bridge.ndjson");
const source = await readFile(tracePath, "utf8");
const events = source
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

process.stdout.write(
  `${JSON.stringify(
    {
      source: tracePath,
      generatedAt: new Date().toISOString(),
      variants: summarizeExperiment(events),
    },
    null,
    2
  )}\n`
);
