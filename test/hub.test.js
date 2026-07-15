import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const plain = (value) => JSON.parse(JSON.stringify(value));

// Minimal DOM shim — enough for hub.js's builder (createElement / createTextNode
// / appendChild / setAttribute / className / textContent / innerHTML). Records
// structure so tests can walk it. No jsdom dependency, same spirit as the pure
// recovery/anchors loaders.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this._class = "";
    this._text = "";
    this.innerHTML = "";
  }
  set className(v) { this._class = v; }
  get className() { return this._class; }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { this.children.push(c); return c; }
  // depth-first walk
  *walk() {
    for (const c of this.children) {
      yield c;
      if (c.walk) yield* c.walk();
    }
  }
  all(pred) { return [...this.walk()].filter(pred); }
  byAction(a) { return this.all((n) => n.attrs && n.attrs["data-vp-action"] === a); }
  hasClass(node, cls) { return (node._class || "").split(/\s+/).includes(cls); }
}
class FakeText {
  constructor(t) { this._text = t; }
  get textContent() { return this._text; }
}
const fakeDoc = {
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => new FakeText(t),
};

async function loadHub() {
  const source = await readFile(join(process.cwd(), "extension/hub.js"), "utf8");
  const context = { globalThis: {}, Date };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.VoicePrHub;
}

// ---- Law 2: classifyPrState — the registry job outranks the pending bundle ---

test("idle — no job, no pending", async () => {
  const { classifyPrState } = await loadHub();
  assert.deepEqual(plain(classifyPrState({})), { state: "idle" });
});

test("running job wins even when a stale pending bundle exists (Law 2)", async () => {
  const { classifyPrState } = await loadHub();
  const d = classifyPrState({
    job: { status: "running", prUrl: "x", label: "Working…" },
    pending: { audioB64: "abc" },
    handoff: { handedOff: true },
  });
  assert.equal(d.state, "running");
});

test("done / failed jobs classify from the registry", async () => {
  const { classifyPrState } = await loadHub();
  assert.equal(classifyPrState({ job: { status: "done" } }).state, "done");
  assert.equal(classifyPrState({ job: { status: "failed" } }).state, "failed");
  assert.equal(classifyPrState({ job: { status: "error" } }).state, "failed");
  assert.equal(classifyPrState({ job: { status: "queued" } }).state, "running");
});

test("no job + handed-off pending → awaiting (not a resend)", async () => {
  const { classifyPrState } = await loadHub();
  const d = classifyPrState({ pending: { audioB64: "z" }, handoff: { handedOff: true, agentId: "agent-9" } });
  assert.equal(d.state, "awaiting");
  assert.equal(d.agentId, "agent-9");
});

test("no job + un-handed-off pending → genuine draft-unsent recovery", async () => {
  const { classifyPrState } = await loadHub();
  assert.equal(classifyPrState({ pending: { audioB64: "z" } }).state, "draft-unsent");
});

// ---- Law 1: renderHub never produces an armed mic; record is one explicit tap -

test("hub always has exactly one explicit record action and never auto-arms", async () => {
  const { renderHub } = await loadHub();
  for (const decision of [{ state: "idle" }, { state: "done", job: { status: "done", prUrl: "p", summary: "ok", agentId: "agent-1" } }]) {
    const hub = renderHub(fakeDoc, { thisPr: { prUrl: "p", prNumber: 7 }, decision, fleet: [] });
    const recs = hub.byAction("record");
    assert.equal(recs.length, 1, "exactly one record affordance");
    assert.equal(recs[0].tag, "button", "record is a plain button, not an active recorder");
    // Nothing in the hub is a media element or an auto-start hook.
    assert.equal(hub.all((n) => n.tag === "audio" || n.tag === "video").length, 0);
  }
});

// ---- Law 3 + the state matrix render onto the right surface ------------------

test("idle hub shows an empty fleet and the record button", async () => {
  const { renderHub } = await loadHub();
  const hub = renderHub(fakeDoc, { thisPr: { prUrl: "p", prNumber: 3 }, decision: { state: "idle" }, fleet: [] });
  assert.equal(hub.byAction("record").length, 1);
  assert.ok(hub.all((n) => n._class === "vp-hub-empty").length === 1, "empty-fleet hint present");
});

test("fleet renders one row per PR, this PR highlighted, others jumpable", async () => {
  const { renderHub } = await loadHub();
  const fleet = [
    { prUrl: "https://github.com/o/r/pull/7", prNumber: 7, status: "running", label: "Working…", updatedAt: 3 },
    { prUrl: "https://github.com/o/r/pull/4", prNumber: 4, status: "done", label: "Added null-check", updatedAt: 2 },
    { prUrl: "https://github.com/o/r/pull/9", prNumber: 9, status: "failed", label: "Bridge closed", updatedAt: 1 },
  ];
  const hub = renderHub(fakeDoc, {
    thisPr: { prUrl: "https://github.com/o/r/pull/7", prNumber: 7 },
    decision: { state: "running", job: fleet[0] },
    fleet,
  });
  const rows = hub.all((n) => (n._class || "").startsWith("vp-hubjob"));
  assert.equal(rows.length, 3, "one row per PR");
  const self = rows.filter((r) => (r._class || "").includes("self"));
  assert.equal(self.length, 1, "exactly this PR is highlighted");
  assert.equal(self[0].getAttribute("data-vp-pr"), "https://github.com/o/r/pull/7");
  // Every row is a jump target (Law 3 — observing routes nowhere near record).
  assert.equal(hub.byAction("jump").length, 3);
});

test("done card exposes the trail link + dismiss; failed card exposes retry", async () => {
  const { renderHub } = await loadHub();
  const doneHub = renderHub(fakeDoc, {
    thisPr: { prUrl: "p", prNumber: 7 },
    decision: { state: "done", job: { status: "done", prUrl: "p", summary: "Fixed retry backoff", agentId: "agent-1", trailCommentUrl: "https://x/1" } },
    fleet: [{ prUrl: "p", prNumber: 7, status: "done", label: "Fixed retry backoff", updatedAt: 1 }],
  });
  assert.equal(doneHub.all((n) => n.tag === "a" && n.getAttribute("href") === "https://x/1").length, 1);
  // The card's own Dismiss button (a full vp-hubbtn). The terminal fleet row also
  // carries a compact ✕ clear (vp-hubclear) — both are dismiss actions, so scope
  // this assertion to the card button by class.
  assert.equal(doneHub.all((n) => (n._class || "").includes("vp-hubbtn") && n.getAttribute("data-vp-action") === "dismiss").length, 1);

  const failHub = renderHub(fakeDoc, {
    thisPr: { prUrl: "p", prNumber: 9 },
    decision: { state: "failed", job: { status: "failed", prUrl: "p", label: "Bridge closed — retry", error: "ECONNREFUSED" } },
    fleet: [{ prUrl: "p", prNumber: 9, status: "failed", label: "Bridge closed — retry", updatedAt: 1 }],
  });
  assert.equal(failHub.byAction("retry").length, 1);
});

test("done card surfaces only the compact Action summary", async () => {
  const { renderHub } = await loadHub();
  const hub = renderHub(fakeDoc, {
    thisPr: { prUrl: "p", prNumber: 7 },
    decision: {
      state: "done",
      job: {
        status: "done",
        prUrl: "p",
        summary: "Pushed one commit",
        actionSummary: { totalActions: 3, blockedEffects: 1 },
      },
    },
    fleet: [],
  });
  const summaries = hub.all((node) => (node._class || "").includes("vp-action-summary"));
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].textContent, "3 actions · 1 needs permission");
});

test("terminal fleet rows carry a ✕ clear; active rows do not", async () => {
  const { renderHub } = await loadHub();
  const fleet = [
    { prUrl: "https://github.com/o/r/pull/7", prNumber: 7, status: "running", label: "Working…", updatedAt: 3 },
    { prUrl: "https://github.com/o/r/pull/4", prNumber: 4, status: "done", label: "Done", updatedAt: 2 },
    { prUrl: "https://github.com/o/r/pull/9", prNumber: 9, status: "failed", label: "Failed", updatedAt: 1 },
  ];
  const hub = renderHub(fakeDoc, {
    thisPr: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 },
    decision: { state: "idle" },
    fleet,
  });
  const clears = hub.all((n) => (n._class || "").includes("vp-hubclear"));
  assert.equal(clears.length, 2, "one clear per terminal (done/failed) row, none on the running row");
  // each clear removes exactly its own PR
  assert.deepEqual(
    clears.map((c) => c.getAttribute("data-vp-pr")).sort(),
    ["https://github.com/o/r/pull/4", "https://github.com/o/r/pull/9"]
  );
});

test("section header shows Clear-finished only when a run has finished", async () => {
  const { renderHub } = await loadHub();
  const withFinished = renderHub(fakeDoc, {
    thisPr: { prUrl: "p", prNumber: 1 },
    decision: { state: "idle" },
    fleet: [{ prUrl: "p", prNumber: 1, status: "done", label: "Done", updatedAt: 1 }],
  });
  assert.equal(withFinished.byAction("clear-finished").length, 1);

  const allActive = renderHub(fakeDoc, {
    thisPr: { prUrl: "p", prNumber: 1 },
    decision: { state: "running", job: { status: "running", prUrl: "p" } },
    fleet: [{ prUrl: "p", prNumber: 1, status: "running", label: "Working…", updatedAt: 1 }],
  });
  assert.equal(allActive.byAction("clear-finished").length, 0, "no finished runs → no bulk clear");
});

test("draft-unsent hub shows resend + discard, no live job", async () => {
  const { renderHub } = await loadHub();
  const hub = renderHub(fakeDoc, {
    thisPr: { prUrl: "p", prNumber: 5 },
    decision: { state: "draft-unsent", pending: { audioB64: "AAAA" } },
    fleet: [],
  });
  assert.equal(hub.byAction("resend").length, 1);
  assert.equal(hub.byAction("discard").length, 1);
});

test("active count = running + queued (drives the toolbar badge)", async () => {
  const { isActive } = await loadHub();
  const fleet = [{ status: "running" }, { status: "queued" }, { status: "done" }, { status: "failed" }];
  assert.equal(fleet.filter((j) => isActive(j.status)).length, 2);
});

// ---- repo identity: a bare "#7" is useless across a multi-repo fleet ---------

test("repoOf extracts owner/repo from a PR url, empty when unparseable", async () => {
  const { repoOf } = await loadHub();
  assert.equal(repoOf({ prUrl: "https://github.com/acme/checkout/pull/7" }), "acme/checkout");
  assert.equal(repoOf({ prUrl: "https://github.com/acme/billing-api/pull/42" }), "acme/billing-api");
  assert.equal(repoOf({ prUrl: "not-a-url" }), "");
  assert.equal(repoOf({}), "");
});

test("fleet rows carry the repo identity, not just the PR number", async () => {
  const { renderHub } = await loadHub();
  const fleet = [
    { prUrl: "https://github.com/acme/checkout/pull/7", prNumber: 7, status: "running", label: "Working…", updatedAt: 2 },
    { prUrl: "https://github.com/acme/billing-api/pull/4", prNumber: 4, status: "done", label: "Fixed", updatedAt: 1 },
  ];
  const hub = renderHub(fakeDoc, {
    thisPr: { prUrl: "https://github.com/acme/checkout/pull/7", prNumber: 7 },
    decision: { state: "running", job: fleet[0] },
    fleet,
  });
  const repos = hub.all((n) => n._class === "vp-hubrepo").map((n) => n.textContent);
  assert.deepEqual(repos.sort(), ["acme/billing-api", "acme/checkout"]);
});

// ---- fleet count label: the leading number is never ambiguous ----------------

test("fleetCountLabel phrases the count without an ambiguous leading number", async () => {
  const { fleetCountLabel } = await loadHub();
  assert.equal(fleetCountLabel([]), "none");
  // one active job: "1 active", not the confusing "1 · 1 active"
  assert.equal(fleetCountLabel([{ status: "running" }]), "1 active");
  assert.equal(fleetCountLabel([{ status: "running" }, { status: "queued" }]), "2 active");
  // mixed fleet spells out both numbers
  assert.equal(fleetCountLabel([{ status: "running" }, { status: "done" }, { status: "failed" }]), "1 active · 3 total");
  // all terminal: no "active" at all
  assert.equal(fleetCountLabel([{ status: "done" }, { status: "failed" }]), "2 total");
});
