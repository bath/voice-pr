// Toolbar popup (D1) — the fleet, reachable from any tab. Pure read of the
// central `voicepr:jobs` registry the background worker maintains; clicking a
// row jumps to that PR's tab (or opens it). It reuses hub.js's shared status
// vocabulary so the popup and the in-page hub can never drift.
(function () {
  const JOBS_KEY = "voicepr:jobs";
  const { STATUS_META, prNumberOf, repoOf, fleetCountLabel } = window.VoicePrHub;
  const root = document.getElementById("vp-popup-root");

  function render(jobs) {
    const arr = Object.values(jobs || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    root.innerHTML = "";

    const head = document.createElement("div");
    head.className = "vp-popup-head";
    const title = document.createElement("span");
    title.className = "vp-popup-title";
    title.textContent = "🎙 voice-pr";
    const count = document.createElement("span");
    count.className = "vp-popup-count";
    count.textContent = arr.length ? fleetCountLabel(arr) : "idle";
    head.append(title, count);
    root.appendChild(head);

    if (!arr.length) {
      const e = document.createElement("div");
      e.className = "vp-popup-empty";
      e.textContent = "No background work. Open a PR and record to dispatch some.";
      root.appendChild(e);
      return;
    }

    const list = document.createElement("div");
    list.className = "vp-hub-list";
    for (const job of arr) {
      const meta = STATUS_META[job.status] || { dot: "queue" };
      const row = document.createElement("button");
      row.className = "vp-hubjob";
      const dot = document.createElement("span");
      dot.className = `vp-hubdot ${meta.dot}`;
      const repo = repoOf(job);
      const main = document.createElement("div");
      main.className = "vp-hubmain";
      const top = document.createElement("div");
      top.className = "vp-hubtop";
      if (repo) {
        const r = document.createElement("span");
        r.className = "vp-hubrepo";
        r.textContent = repo;
        top.appendChild(r);
      }
      const pr = document.createElement("span");
      pr.className = "vp-hubpr";
      pr.textContent = `#${prNumberOf(job)}`;
      top.appendChild(pr);
      const label = document.createElement("div");
      label.className = "vp-hublabel";
      label.textContent = job.label || meta.verb || "…";
      main.append(top, label);
      const jump = document.createElement("span");
      jump.className = "vp-hubjump";
      jump.textContent = "↗";
      row.append(dot, main, jump);
      row.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "focus-pr", prUrl: job.prUrl, tabId: job.originTabId }, () => window.close());
      });
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  chrome.storage.local.get(JOBS_KEY, (o) => render(o?.[JOBS_KEY] || {}));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c[JOBS_KEY]) render(c[JOBS_KEY].newValue || {});
  });
})();
