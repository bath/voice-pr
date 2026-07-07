import assert from "node:assert/strict";
import test from "node:test";

import { anchorSegments } from "../lib/transcribe.js";

test("anchors audio segments using the audio-start session offset", () => {
  const timeline = [
    { t: 100, file: "before.js", line: 1 },
    { t: 1400, file: "recording.js", line: 8, token: "target" },
    { t: 4000, file: "later.js", line: 21 },
  ];

  const anchored = anchorSegments([{ start: 0.5, end: 0.9, text: "fix this" }], timeline, {
    offsetMs: 1000,
  });

  assert.deepEqual(anchored, [
    {
      text: "fix this",
      file: "recording.js",
      line: 8,
      endLine: null,
      snippet: null,
      token: "target",
    },
  ]);
});

test("keeps existing zero-offset anchoring behavior", () => {
  const anchored = anchorSegments(
    [{ start: 2, end: 3, text: "rename this" }],
    [
      { t: 0, file: "early.js", line: 2 },
      { t: 1900, file: "current.js", line: 5 },
    ]
  );

  assert.equal(anchored[0].file, "current.js");
  assert.equal(anchored[0].line, 5);
});

test("preserves the first timeline anchor as a conservative fallback", () => {
  const anchored = anchorSegments([{ start: 0, text: "handle empty state" }], [
    { t: 900, file: "src/Fallback.jsx", line: 7 },
  ]);

  assert.equal(anchored[0].file, "src/Fallback.jsx");
  assert.equal(anchored[0].line, 7);
});

test("carries dwell weight and capture source onto segments when present", () => {
  const anchored = anchorSegments([{ start: 1, text: "this line is slow" }], [
    { t: 900, file: "src/Hot.jsx", line: 12, weight: 4200, via: "viewport" },
  ]);

  assert.equal(anchored[0].weight, 4200);
  assert.equal(anchored[0].via, "viewport");
});

test("omits weight/via when the source anchor does not carry them (backward compatible)", () => {
  const anchored = anchorSegments([{ start: 1, text: "plain anchor" }], [
    { t: 900, file: "src/Plain.jsx", line: 3 },
  ]);

  assert.equal("weight" in anchored[0], false);
  assert.equal("via" in anchored[0], false);
});
