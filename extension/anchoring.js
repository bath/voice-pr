(function (global) {
  const LINE = /^diff-([0-9a-f]+)([LR])(\d+)$/;
  const FILE = /^diff-([0-9a-f]+)$/;

  function createVoicePrAnchoring({ document, window = global.window } = {}) {
    if (!document) throw new Error("document is required");

    function fileMap() {
      const map = {};
      document.querySelectorAll('a[href^="#diff-"]').forEach((a) => {
        const m = (a.getAttribute("href") || "").match(/^#diff-([0-9a-f]+)$/);
        const path = (a.textContent || "").trim();
        if (m && path && !map[m[1]]) map[m[1]] = path;
      });
      return map;
    }

    // Nearest diff-line deep-link id to a node -> { hash, side, line }.
    function diffAnchor(el) {
      let node = el && (el.nodeType === 3 ? el.parentElement : el);
      if (!node) return null;
      let hash = null;
      for (let n = node, d = 0; n && n !== document.body && d < 8; n = n.parentElement, d++) {
        const m = (n.id || "").match(LINE);
        if (m) return { hash: m[1], side: m[2], line: +m[3] };
        const fm = (n.id || "").match(FILE);
        if (fm && !hash) hash = fm[1];
        const row = n.closest?.("tr");
        if (row) {
          const hit = [...row.querySelectorAll("[id]")].find((x) => LINE.test(x.id));
          if (hit) {
            const mm = hit.id.match(LINE);
            return { hash: mm[1], side: mm[2], line: +mm[3] };
          }
        }
      }
      return hash ? { hash, side: null, line: null } : null;
    }

    function fileOf(el) {
      const a = diffAnchor(el);
      if (a) {
        const p = fileMap()[a.hash];
        if (p) return p;
      }
      const f = el && (el.nodeType === 3 ? el.parentElement : el)?.closest?.("[data-tagsearch-path], .file, .js-file");
      return f
        ? f.getAttribute?.("data-tagsearch-path") ||
            f.querySelector?.(".file-header")?.getAttribute("data-path") ||
            f.querySelector?.("[data-path]")?.getAttribute("data-path") ||
            null
        : null;
    }

    function lineOf(el) {
      const a = diffAnchor(el);
      if (a && a.line != null) return a.line;
      const row = el && (el.nodeType === 3 ? el.parentElement : el)?.closest?.("tr");
      if (!row) return null;
      const nums = [...row.querySelectorAll("td.blob-num[data-line-number]")];
      const n = nums.length ? parseInt(nums[nums.length - 1].getAttribute("data-line-number"), 10) : NaN;
      return Number.isFinite(n) ? n : null;
    }

    function tokenAt(x, y) {
      const r = document.caretRangeFromPoint?.(x, y);
      const node = r?.startContainer;
      if (!node || node.nodeType !== 3) return null;
      const text = node.textContent || "";
      const isW = (c) => /[\w$.]/.test(c || "");
      let i = r.startOffset;
      if (!isW(text[i]) && !isW(text[i - 1])) return null;
      let a = i,
        b = i;
      while (a > 0 && isW(text[a - 1])) a--;
      while (b < text.length && isW(text[b])) b++;
      const tok = text.slice(a, b).trim().replace(/^\.+|\.+$/g, "");
      return tok && tok.length <= 60 ? tok : null;
    }

    function anchorAtPoint(x, y) {
      const el = document.elementFromPoint(x, y);
      const file = fileOf(el);
      if (!file) return null;
      return { file, line: lineOf(el), token: tokenAt(x, y) || null, x: Math.round(x), y: Math.round(y) };
    }

    function nearestNumberedLine(container, cy, hash) {
      let best = null,
        bestDist = Infinity;
      const nodes = container?.querySelectorAll?.("[id], td.blob-num[data-line-number]") || [];
      nodes.forEach((node) => {
        let line = null;
        const m = (node.id || "").match(LINE);
        if (m && (!hash || m[1] === hash)) line = +m[3];
        if (line == null && node.matches?.("td.blob-num[data-line-number]")) {
          const n = parseInt(node.getAttribute("data-line-number"), 10);
          if (Number.isFinite(n)) line = n;
        }
        if (line == null) return;
        const r = node.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - cy);
        if (d < bestDist) (bestDist = d), (best = { line, node });
      });
      return best;
    }

    // Viewport-center fallback (what's on screen if you didn't select/click).
    function anchorViewport() {
      const cy = window.innerHeight / 2;
      const el = document.elementFromPoint(Math.min(window.innerWidth / 2, 400), cy);
      const file = fileOf(el);
      if (!file) return { file: null, line: null };

      const a = diffAnchor(el);
      if (a?.hash) {
        const container = document.getElementById(`diff-${a.hash}`) || el;
        const nearest = nearestNumberedLine(container, cy, a.hash);
        if (nearest) return { file, line: nearest.line };
        return { file, line: a.line ?? null };
      }

      const f = el.closest?.("[data-tagsearch-path], .file, .js-file");
      const nearest = nearestNumberedLine(f, cy);
      return { file, line: nearest?.line ?? null };
    }

    function fmtAnchor(a) {
      if (!a || !a.file) return "no target - will infer from words";
      const range = a.endLine && a.endLine !== a.line ? `${a.line}-${a.endLine}` : a.line || "";
      return `${a.file}${range ? ":" + range : ""}${a.token ? ` \`${a.token}\`` : ""}`;
    }

    return {
      fileMap,
      diffAnchor,
      fileOf,
      lineOf,
      tokenAt,
      anchorAtPoint,
      anchorViewport,
      fmtAnchor,
    };
  }

  global.createVoicePrAnchoring = createVoicePrAnchoring;
})(globalThis);
