// voice-pr hub — the "one door, two rooms" surface, factored out of content.js
// so it can be unit-tested (test/hub.test.js) and screenshotted (scripts/
// hub-gallery.html) without a browser, chrome APIs, or a live orchestrator.
// Same load pattern as anchors.js / recovery.js: a pure module hung off the
// global as `VoicePrHub`.
//
// The design this implements is the D3 + D1 recommendation from the "one door,
// two rooms" memo:
//
//   D3 — hub-first. Opening the panel lands on a *monitor* surface (the fleet of
//        dispatched work), never on a live microphone. Recording is a deliberate
//        action launched FROM the hub with one tap.
//   D1 — a global signal (the toolbar badge; see background.js) so the active
//        count survives a collapsed panel and is visible on any tab.
//
// Two invariants live here, as pure decisions the caller renders around:
//   Law 1  "opening is not consenting" — renderHub NEVER produces a recording
//          control that is armed; the only path to the mic is an explicit
//          [data-vp-action="record"] button the caller wires to capture mode.
//   Law 2  "running is not lost" — classifyPrState consults the central job
//          registry BEFORE the saved-pending key, so an in-flight or finished
//          job reattaches instead of masquerading as a lost recording.
//   Law 3  "observing is first-class" — the fleet list and every status card are
//          pure show; none of them route through, or hint at, the record flow.
//
// renderHub is deliberately free of event listeners: every actionable element
// carries data-vp-action (+ data-vp-pr where relevant) and the caller attaches a
// single delegated handler. That keeps this module inert enough to render into a
// bare jsdom-less document for screenshots.
(function (global) {
  // ---- status vocabulary (mirrors background.js patchForEvent) --------------
  // dot: css modifier on the fleet-row indicator. term: is this a terminal state.
  const STATUS_META = {
    queued: { dot: "queue", term: false, verb: "Queued" },
    running: { dot: "run", term: false, verb: "Working" },
    done: { dot: "done", term: true, verb: "Done" },
    failed: { dot: "fail", term: true, verb: "Failed" },
    error: { dot: "fail", term: true, verb: "Failed" },
  };
  const isActive = (status) => status === "running" || status === "queued";
  const isTerminal = (status) => !!(STATUS_META[status] && STATUS_META[status].term);

  function prNumberOf(job) {
    if (job && job.prNumber != null) return String(job.prNumber);
    const m = /\/pull\/(\d+)/.exec((job && job.prUrl) || "");
    return m ? m[1] : "?";
  }

  // owner/repo from a PR url — the load-bearing identity when the fleet spans
  // many repos, where a bare "#7" tells you nothing about which project it is.
  function repoOf(job) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec((job && job.prUrl) || "");
    return m ? m[1] : "";
  }

  // The fleet count, phrased so the leading number is never ambiguous. "1 · 1
  // active" (what does the first 1 mean?) becomes "1 active"; a mixed fleet reads
  // "3 active · 6 total"; an all-terminal fleet reads "6 total".
  function fleetCountLabel(fleet) {
    const n = (fleet || []).length;
    if (!n) return "none";
    const active = fleet.filter((j) => isActive(j.status)).length;
    if (active === n) return `${active} active`;
    if (active) return `${active} active · ${n} total`;
    return `${n} total`;
  }

  function fmtAge(ts, now) {
    if (!ts) return "";
    const mins = Math.round(((now || nowMs()) - ts) / 60000);
    if (mins <= 0) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  }
  // Date.now via an indirection so the module is trivially stubbable in tests.
  function nowMs() {
    return typeof Date !== "undefined" ? Date.now() : 0;
  }

  // ---- Law 2: the single on-load / on-change state decision -----------------
  // Given this PR's central job record (or null), its saved pending bundle (or
  // null), and the hand-off marker (or null), decide which state-matrix row the
  // PR is in. The job registry is authoritative: a live or terminal job for this
  // PR always wins over a stale pending bundle, because the dispatch stream runs
  // server-side and outlives the tab — a saved bundle is NOT proof the work was
  // never sent. Only when there is no job at all does the pending bundle decide
  // between "handed off, awaiting result" and a genuine "never dispatched" crash.
  //
  // Returns { state, job?, pending?, workItemId? } where state is one of:
  //   idle | running | done | failed | awaiting | draft-unsent
  function classifyPrState({ job, pending, handoff } = {}) {
    const status = job && job.status;
    if (status === "running" || status === "queued") return { state: "running", job };
    if (status === "done") return { state: "done", job };
    if (status === "failed" || status === "error") return { state: "failed", job };
    // No live/terminal job in the registry for this PR.
    if (pending) {
      if (handoff && handoff.handedOff)
        return { state: "awaiting", pending, workItemId: handoff.workItemId || null };
      return { state: "draft-unsent", pending };
    }
    return { state: "idle" };
  }

  // ---- tiny DOM builder (no framework) --------------------------------------
  function makeEl(doc) {
    return function el(tag, attrs, children) {
      const node = doc.createElement(tag);
      if (attrs)
        for (const [k, v] of Object.entries(attrs)) {
          if (v == null || v === false) continue;
          if (k === "class") node.className = v;
          else if (k === "text") node.textContent = v;
          else if (k === "html") node.innerHTML = v;
          else node.setAttribute(k, v === true ? "" : String(v));
        }
      for (const c of [].concat(children || []))
        if (c != null) node.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
      return node;
    };
  }

  // A single fleet row: status dot, PR number, one-line label, jump affordance.
  // `self` marks this-PR so the hub can highlight your own work in the fleet.
  function fleetRow(el, job, { self = false } = {}) {
    const meta = STATUS_META[job.status] || { dot: "queue" };
    const repo = repoOf(job);
    // Two lines: repo identity + PR number on top, the work label below. Across
    // a multi-repo fleet the repo is what tells the rows apart, so it leads.
    const ident = el("div", { class: "vp-hubtop" }, [
      repo ? el("span", { class: "vp-hubrepo", text: repo }) : null,
      el("span", { class: "vp-hubpr", text: `#${prNumberOf(job)}` }),
    ]);
    const row = el(
      "div",
      { class: "vp-hubjob" + (self ? " self" : ""), "data-vp-action": "jump", "data-vp-pr": job.prUrl, role: "button", tabindex: "0" },
      [
        el("span", { class: `vp-hubdot ${meta.dot}` }),
        el("div", { class: "vp-hubmain" }, [
          ident,
          el("div", { class: "vp-hublabel", text: job.label || (meta.verb || "…") }),
        ]),
        el("span", { class: "vp-hubjump", "aria-hidden": "true", text: "↗" }),
      ]
    );
    return row;
  }

  // The result / error / recovery card shown for THIS PR above the fleet. Pure
  // presentation + data-actions; the caller wires the buttons.
  function thisPrCard(el, decision, prNumber, now) {
    const { state, job, pending, workItemId } = decision;
    if (state === "done") {
      const card = el("div", { class: "vp-hubcard ok" }, [
        el("div", { class: "vp-hubcard-head", text: `✅ ${job.summary || job.label || "Done"}` }),
        el("div", { class: "vp-hubcard-sub", text: `work item ${job.workItemId || "—"}${job.refinery ? ` · refinery ${job.refinery}` : ""}` }),
      ]);
      if (job.trailCommentUrl)
        card.appendChild(
          el("a", { class: "vp-hublink", href: job.trailCommentUrl, target: "_blank", rel: "noopener", text: "see the comment on the PR →" })
        );
      card.appendChild(
        el("div", { class: "vp-hubcard-actions" }, [
          el("button", { class: "vp-hubbtn ghost", "data-vp-action": "dismiss", "data-vp-pr": job.prUrl, text: "Dismiss" }),
        ])
      );
      return card;
    }
    if (state === "failed") {
      const card = el("div", { class: "vp-hubcard fail" }, [
        el("div", { class: "vp-hubcard-head", text: `⚠️ ${job.label || job.summary || "Dispatch failed"}` }),
        el("div", { class: "vp-hubcard-sub", text: job.error ? String(job.error).slice(0, 160) : "The recording is saved — you can retry it." }),
        el("div", { class: "vp-hubcard-actions" }, [
          el("button", { class: "vp-hubbtn", "data-vp-action": "retry", "data-vp-pr": job.prUrl, text: "↻ Retry dispatch" }),
          el("button", { class: "vp-hubbtn ghost", "data-vp-action": "dismiss", "data-vp-pr": job.prUrl, text: "Dismiss" }),
        ]),
      ]);
      return card;
    }
    if (state === "draft-unsent") {
      const kb = Math.round(((pending && pending.audioB64 && pending.audioB64.length) || 0) * 0.75 / 1024);
      return el("div", { class: "vp-hubcard warn" }, [
        el("div", { class: "vp-hubcard-head", text: "↻ Recovered an un-dispatched recording" }),
        el("div", {
          class: "vp-hubcard-sub",
          text: `The last dispatch didn't complete${kb ? ` (~${kb}KB audio)` : ""} — nothing lost. Resend it, or discard.`,
        }),
        el("div", { class: "vp-hubcard-actions" }, [
          el("button", { class: "vp-hubbtn", "data-vp-action": "resend", text: "↻ Resend to orchestrator" }),
          el("button", { class: "vp-hubbtn ghost", "data-vp-action": "discard", text: "Discard" }),
        ]),
      ]);
    }
    if (state === "awaiting") {
      return el("div", { class: "vp-hubcard" }, [
        el("div", { class: "vp-hubcard-head", text: "↻ Handed to the orchestrator" }),
        el("div", {
          class: "vp-hubcard-sub",
          text: `This recording${workItemId ? ` (work item ${workItemId})` : ""} runs server-side — the reload just lost the live view, not the work.`,
        }),
        el("div", { class: "vp-hubcard-actions" }, [
          el("button", { class: "vp-hubbtn ghost", "data-vp-action": "discard", text: "Got it" }),
        ]),
      ]);
    }
    return null; // idle / running need no extra card (running shows in the fleet)
  }

  // ---- the hub itself --------------------------------------------------------
  // state = {
  //   thisPr: { prUrl, prNumber },
  //   decision: <classifyPrState result>,
  //   fleet: [ jobRecord... ],   // whole registry (this PR included)
  //   now?: <ms>,
  // }
  // Returns a single element the caller drops into the panel body. Every
  // interactive node is a [data-vp-action]; renderHub attaches NO listeners.
  function renderHub(doc, state) {
    const el = makeEl(doc);
    const { thisPr = {}, decision = { state: "idle" }, fleet = [], now } = state || {};
    const prNumber = thisPr.prNumber != null ? String(thisPr.prNumber) : prNumberOf({ prUrl: thisPr.prUrl });
    const thisRepo = repoOf({ prUrl: thisPr.prUrl });

    const hub = el("div", { class: "vp-hub", "data-vp-hub": "1" });

    // (D3) The record affordance on top — one explicit tap into capture. Law 1:
    // this is the ONLY armed-mic path, and it is never auto-triggered.
    const running = decision.state === "running";
    hub.appendChild(
      el("button", { class: "vp-hub-record", "data-vp-action": "record", title: "Start a voice recording on this PR (⇧⌥R)" }, [
        el("span", { class: "vp-hub-record-dot", "aria-hidden": "true" }),
        el("span", { class: "vp-hub-record-text", text: running ? "Record again on this PR" : "Record on this PR" }),
        el("span", { class: "vp-hub-record-pr", text: thisRepo ? `${thisRepo} #${prNumber}` : `#${prNumber}` }),
      ])
    );

    // This-PR status / result / recovery card (done | failed | draft | awaiting).
    const card = thisPrCard(el, decision, prNumber, now);
    if (card) hub.appendChild(card);

    // (Law 3) The fleet — pure monitor. Section header with the same count the
    // toolbar badge shows, then one row per PR with this PR highlighted.
    hub.appendChild(
      el("div", { class: "vp-hub-sectlabel" }, [
        el("span", { text: "Background work" }),
        el("span", { class: "vp-hub-count", text: fleetCountLabel(fleet) }),
      ])
    );

    if (!fleet.length) {
      hub.appendChild(el("div", { class: "vp-hub-empty", text: "No work in flight. Record on this PR to dispatch some." }));
    } else {
      const list = el("div", { class: "vp-hub-list" });
      // This PR first (highlighted), then everything else newest-first.
      const sorted = fleet
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const selfUrl = thisPr.prUrl;
      const self = sorted.filter((j) => j.prUrl === selfUrl);
      const others = sorted.filter((j) => j.prUrl !== selfUrl);
      for (const j of self) list.appendChild(fleetRow(el, j, { self: true }));
      for (const j of others) list.appendChild(fleetRow(el, j));
      hub.appendChild(list);
    }

    return hub;
  }

  global.VoicePrHub = {
    classifyPrState,
    renderHub,
    // exported for the toolbar-badge count + tests
    isActive,
    isTerminal,
    prNumberOf,
    repoOf,
    fleetCountLabel,
    fmtAge,
    STATUS_META,
  };
})(globalThis);
