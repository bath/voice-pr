import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadAnchors() {
  const source = await readFile(join(process.cwd(), "extension/anchors.js"), "utf8");
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.VoicePrAnchors;
}

class FakeElement {
  constructor(tag = "div", { id = "", attrs = {}, text = "", classes = [], rect = null } = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attrs = { ...attrs };
    this.textContent = text;
    this.classes = new Set(classes);
    this.rect = rect || { top: 0, bottom: 0, left: 0, width: 0, height: 0 };
    this.children = [];
    this.parentElement = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    if (name === "id") return this.id;
    return this.attrs[name] ?? null;
  }

  matches(selector) {
    return selector.split(",").some((part) => this.matchesOne(part.trim()));
  }

  matchesOne(selector) {
    if (!selector) return false;
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector === "tr") return this.tagName === "TR";
    if (selector === '[role="row"]' || selector === "[role='row']") return this.attrs.role === "row";
    if (selector === '[id^="diff-"]') return this.id.startsWith("diff-");
    if (selector === '[data-tagsearch-path]') return this.attrs["data-tagsearch-path"] != null;
    if (selector === "[data-path]") return this.attrs["data-path"] != null;
    if (selector === "[data-line-number]") return this.attrs["data-line-number"] != null;
    if (selector === ".file" || selector === ".js-file") return this.classes.has(selector.slice(1));
    if (selector === ".file-header[data-path]")
      return this.classes.has("file-header") && this.attrs["data-path"] != null;
    if (selector === 'a[href^="#diff-"]')
      return this.tagName === "A" && String(this.attrs.href || "").startsWith("#diff-");
    if (selector === "td.blob-num[data-line-number]")
      return this.tagName === "TD" && this.classes.has("blob-num") && this.attrs["data-line-number"] != null;
    if (selector === "td.blob-code") return this.tagName === "TD" && this.classes.has("blob-code");
    return false;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const hits = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) hits.push(child);
        visit(child);
      }
    };
    visit(this);
    return hits;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
    this.pointElement = null;
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  elementFromPoint() {
    return this.pointElement;
  }
}

function reactChangesFixture() {
  const doc = new FakeDocument();
  doc.body.appendChild(new FakeElement("a", { attrs: { href: "#diff-abcd1234" }, text: "src/App.jsx" }));
  const file = doc.body.appendChild(
    new FakeElement("div", {
      id: "diff-abcd1234",
      attrs: { "data-tagsearch-path": "src/App.jsx" },
    })
  );
  const line = file.appendChild(
    new FakeElement("div", {
      id: "diff-abcd1234R42",
      rect: { top: 90, bottom: 110, left: 12, width: 500, height: 20 },
    })
  );
  let leaf = line;
  for (let i = 0; i < 12; i++) leaf = leaf.appendChild(new FakeElement("span"));
  doc.pointElement = leaf;
  return { doc, leaf };
}

test("anchor resolver follows React changes deep-link ids beyond shallow ancestors", async () => {
  const { createAnchorResolver } = await loadAnchors();
  const { doc, leaf } = reactChangesFixture();
  const resolver = createAnchorResolver(doc, { innerWidth: 800, innerHeight: 200 });

  assert.deepEqual(plain(resolver.diffAnchor(leaf)), { hash: "abcd1234", side: "R", line: 42 });
  assert.equal(resolver.fileOf(leaf), "src/App.jsx");
  assert.equal(resolver.lineOf(leaf), 42);
  assert.deepEqual(plain(resolver.anchorAtPoint(100, 100)), {
    file: "src/App.jsx",
    line: 42,
    hash: "abcd1234",
    side: "R",
    x: 100,
    y: 100,
  });
});

test("anchorViewport and highlight geometry work without classic td.blob-code rows", async () => {
  const { createAnchorResolver } = await loadAnchors();
  const { doc } = reactChangesFixture();
  doc.pointElement = new FakeElement("div");
  const resolver = createAnchorResolver(doc, { innerWidth: 800, innerHeight: 200 });

  assert.deepEqual(plain(resolver.anchorViewport()), {
    file: "src/App.jsx",
    line: 42,
    hash: "abcd1234",
    side: "R",
  });

  doc.pointElement = doc.querySelector("#diff-abcd1234R42");
  assert.equal(resolver.highlightRectAtPoint(100, 100).height, 20);
});

test("timeline clock captures only while a session is open", async () => {
  const { createTimelineClock } = await loadAnchors();
  let now = 1000;
  const clock = createTimelineClock({ now: () => now });

  assert.equal(clock.push("click", { file: "ignored.js" }), null);
  clock.open();
  now += 75;
  assert.deepEqual(plain(clock.push("click", { file: "src/App.jsx", line: 42 })), {
    t: 75,
    src: "click",
    file: "src/App.jsx",
    line: 42,
  });
  clock.close();
  now += 25;
  assert.equal(clock.push("move", { file: "ignored.js" }), null);
});

