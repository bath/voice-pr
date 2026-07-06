import assert from "node:assert/strict";
import test from "node:test";
import { FixtureDocument, el, text } from "./fixtures/dom-fixture.js";

await import("../extension/anchoring.js");

function createAnchoring(document, window = { innerWidth: 1000, innerHeight: 400 }) {
  return globalThis.createVoicePrAnchoring({ document, window });
}

function addSidebarPath(document, hash, path) {
  document.body.appendChild(el("a", { href: `#diff-${hash}` }, [text(path)]));
}

test("anchors React /changes diff cells via deep-link ids and sidebar file map", () => {
  const document = new FixtureDocument();
  const code = text("expect(payment.status).toBe('paid');");
  const codeCell = el("span", { class: "blob-code" }, [code]);
  const line = el("div", { id: "diff-a1b2c3R8", rect: { top: 190, bottom: 210 } }, [codeCell]);

  addSidebarPath(document, "a1b2c3", "src/payment.test.js");
  document.body.appendChild(el("div", { id: "diff-a1b2c3" }, [line]));
  document.pointElement = codeCell;
  document.caretRange = { startContainer: code, startOffset: 8 };

  const anchoring = createAnchoring(document);

  assert.deepEqual(anchoring.diffAnchor(codeCell), { hash: "a1b2c3", side: "R", line: 8 });
  assert.equal(anchoring.fileOf(codeCell), "src/payment.test.js");
  assert.equal(anchoring.lineOf(codeCell), 8);
  assert.deepEqual(anchoring.anchorAtPoint(321.4, 199.8), {
    file: "src/payment.test.js",
    line: 8,
    token: "payment.status",
    x: 321,
    y: 200,
  });
});

test("uses nearest React /changes line when viewport points at the file container", () => {
  const document = new FixtureDocument();
  const hash = "d4e5f6";
  const container = el("div", { id: `diff-${hash}` }, [
    el("div", { id: `diff-${hash}R11`, rect: { top: 130, bottom: 150 } }, [text("old")]),
    el("div", { id: `diff-${hash}R12`, rect: { top: 190, bottom: 210 } }, [text("target")]),
    el("div", { id: `diff-${hash}R13`, rect: { top: 260, bottom: 280 } }, [text("new")]),
  ]);

  addSidebarPath(document, hash, "src/changes-view.js");
  document.body.appendChild(container);
  document.pointElement = container;

  const anchoring = createAnchoring(document);

  assert.deepEqual(anchoring.diffAnchor(container), { hash, side: null, line: null });
  assert.deepEqual(anchoring.anchorViewport(), { file: "src/changes-view.js", line: 12 });
});

test("keeps classic /files data attributes as a fallback", () => {
  const document = new FixtureDocument();
  const code = text("return total;");
  const codeCell = el("td", { class: "blob-code" }, [code]);
  const row = el("tr", {}, [
    el("td", { class: "blob-num", "data-line-number": "41" }),
    el("td", { class: "blob-num", "data-line-number": "42" }),
    codeCell,
  ]);
  const file = el("div", { "data-tagsearch-path": "lib/payment.js", class: "file" }, [row]);

  document.body.appendChild(file);

  const anchoring = createAnchoring(document);

  assert.equal(anchoring.fileOf(code), "lib/payment.js");
  assert.equal(anchoring.lineOf(code), 42);
});
