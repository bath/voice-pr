(function (global) {
  const LINE_ID = /^diff-([0-9a-f]+)([LR])(\d+)$/i;
  const FILE_ID = /^diff-([0-9a-f]+)$/i;

  function parseDiffAnchorId(id) {
    const value = String(id || "");
    let m = value.match(LINE_ID);
    if (m) return { hash: m[1], side: m[2], line: Number(m[3]) };
    m = value.match(FILE_ID);
    return m ? { hash: m[1], side: null, line: null } : null;
  }

  function cssEscape(value) {
    return global.CSS?.escape ? global.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
  }

  function cleanPath(value) {
    const path = String(value || "").replace(/\s+/g, " ").trim();
    if (!path || path.startsWith("#") || /^diff-[0-9a-f]+/i.test(path)) return null;
    if (/^(view|show|hide|expand|collapse|load|copy|changed|file)$/i.test(path)) return null;
    return path.length <= 500 ? path : null;
  }

  function pathFromElement(el) {
    if (!el) return null;
    for (const attr of ["data-tagsearch-path", "data-file-name", "data-path", "title", "aria-label"]) {
      const path = cleanPath(el.getAttribute?.(attr));
      if (path) return path;
    }
    for (const sel of [
      "[data-tagsearch-path]",
      "[data-file-name]",
      ".file-info a[title]",
      ".file-header[data-path]",
      ".file-header [data-path]",
      "[data-path]",
      "a[title]",
    ]) {
      const path = pathFromElement(el.querySelector?.(sel));
      if (path) return path;
    }
    const tag = String(el.tagName || el.tag || "").toLowerCase();
    if (tag === "a" || el.matches?.(".file-info, .file-header")) {
      const ownText = cleanPath(el.textContent);
      if (ownText) return ownText;
    }
    return null;
  }

  function createTimelineClock({ now = () => Date.now() } = {}) {
    let open = false;
    let startedAt = 0;
    let events = [];
    return {
      open() {
        open = true;
        startedAt = now();
        events = [];
        return startedAt;
      },
      close() {
        open = false;
      },
      reset() {
        events = [];
      },
      push(src, anchor = {}) {
        if (!open) return null;
        const event = { t: Math.max(0, now() - startedAt), src, ...(anchor || {}) };
        events.push(event);
        return event;
      },
      events() {
        return events;
      },
      get isOpen() {
        return open;
      },
      get startedAt() {
        return startedAt;
      },
    };
  }

  // Aggregates per-line attention over a session: how long each file:line sat
  // near the viewport center (dwell weight) and how many times the user came
  // back to it (revisit). Pure/testable — content.js ticks it on a timer with
  // anchorViewport(), the HUD reads topN() for a live "most-attended" list.
  function attentionKey(anchor) {
    if (!anchor || !anchor.file || anchor.line == null) return null;
    return `${anchor.file}:${anchor.line}`;
  }

  function createAttentionTracker({ now = () => Date.now() } = {}) {
    const lines = new Map(); // key -> { file, line, weight, visits }
    let lastKey = null;
    let lastAt = null;

    function tick(anchor) {
      const t = now();
      const key = attentionKey(anchor);

      if (lastKey && lastAt != null) {
        const dt = t - lastAt;
        if (dt > 0 && dt < 15000) {
          const prev = lines.get(lastKey);
          if (prev) prev.weight += dt;
        }
      }
      lastAt = t;

      let revisit = false;
      if (key) {
        let entry = lines.get(key);
        if (!entry) {
          entry = { file: anchor.file, line: anchor.line, weight: 0, visits: 1 };
          lines.set(key, entry);
        } else if (key !== lastKey) {
          entry.visits += 1;
          revisit = true;
        }
      }
      lastKey = key;
      return { key, revisit };
    }

    function weightOf(anchor) {
      return lines.get(attentionKey(anchor))?.weight ?? 0;
    }

    function topN(n = 5) {
      return [...lines.values()]
        .sort((a, b) => b.weight - a.weight || b.visits - a.visits)
        .slice(0, n)
        .map((entry) => ({ ...entry }));
    }

    function reset() {
      lines.clear();
      lastKey = null;
      lastAt = null;
    }

    return { tick, weightOf, topN, reset };
  }

  function createAnchorResolver(doc = global.document, win = global.window || global) {
    const all = (selector, root = doc) => Array.from(root?.querySelectorAll?.(selector) || []);

    function fileMap() {
      const map = {};
      const add = (hash, path) => {
        if (hash && path && !map[hash]) map[hash] = path;
      };

      all('a[href^="#diff-"]').forEach((a) => {
        const parsed = parseDiffAnchorId((a.getAttribute("href") || "").slice(1));
        add(parsed?.hash, pathFromElement(a));
      });

      all('[id^="diff-"]').forEach((el) => {
        const parsed = parseDiffAnchorId(el.id);
        if (!parsed?.hash || map[parsed.hash]) return;
        const container = el.closest?.("[data-tagsearch-path], [data-file-name], [data-path], .file, .js-file") || el;
        add(parsed.hash, pathFromElement(container));
      });

      return map;
    }

    function nearestLineAnchor(root) {
      const hit = all("[id]", root).find((el) => parseDiffAnchorId(el.id)?.line != null);
      return hit ? parseDiffAnchorId(hit.id) : null;
    }

    function diffAnchor(node) {
      let el = node && (node.nodeType === 3 ? node.parentElement : node);
      if (!el) return null;
      let file = null;
      for (let n = el, depth = 0; n && n !== doc.body && depth < 24; n = n.parentElement, depth++) {
        const parsed = parseDiffAnchorId(n.id);
        if (parsed?.line != null) return parsed;
        if (parsed?.hash && !file) file = parsed;

        const row = n.closest?.("tr, [role='row'], [role=\"row\"], [data-line-number]");
        const rowHit = nearestLineAnchor(row);
        if (rowHit?.line != null) return rowHit;
      }
      const childHit = nearestLineAnchor(el);
      return childHit?.line != null ? childHit : file;
    }

    function fileOf(el) {
      const anchor = diffAnchor(el);
      if (anchor?.hash) {
        const path = fileMap()[anchor.hash];
        if (path) return path;
      }
      return pathFromElement(el?.closest?.("[data-tagsearch-path], [data-file-name], [data-path], .file, .js-file"));
    }

    function lineOf(el) {
      const anchor = diffAnchor(el);
      if (anchor?.line != null) return anchor.line;

      const node = el && (el.nodeType === 3 ? el.parentElement : el);
      const own = Number(node?.getAttribute?.("data-line-number"));
      if (Number.isFinite(own)) return own;

      const row = node?.closest?.("tr, [role='row'], [role=\"row\"], [data-line-number]");
      const rowLine = Number(row?.getAttribute?.("data-line-number"));
      if (Number.isFinite(rowLine)) return rowLine;

      const nums = all("td.blob-num[data-line-number], [data-line-number]", row || node)
        .map((n) => Number(n.getAttribute("data-line-number")))
        .filter(Number.isFinite);
      return nums.length ? nums[nums.length - 1] : null;
    }

    function lineElementForAnchor(anchor) {
      if (!anchor?.hash || anchor.line == null) return null;
      const side = anchor.side || "R";
      return (
        doc.querySelector?.(`#${cssEscape(`diff-${anchor.hash}${side}${anchor.line}`)}`) ||
        doc.querySelector?.(`#${cssEscape(`diff-${anchor.hash}R${anchor.line}`)}`) ||
        doc.querySelector?.(`#${cssEscape(`diff-${anchor.hash}L${anchor.line}`)}`)
      );
    }

    function lineElements() {
      return all('[id^="diff-"]').filter((el) => parseDiffAnchorId(el.id)?.line != null);
    }

    function lineElementAtPoint(x, y) {
      const el = doc.elementFromPoint?.(x, y);
      const classic = el?.closest?.("td.blob-code");
      if (classic) return classic;
      const anchor = diffAnchor(el);
      return lineElementForAnchor(anchor) || (parseDiffAnchorId(el?.id)?.line != null ? el : null);
    }

    function highlightRectAtPoint(x, y) {
      const rect = lineElementAtPoint(x, y)?.getBoundingClientRect?.();
      return rect && rect.width >= 0 && rect.height >= 0 ? rect : null;
    }

    function anchorAtPoint(x, y) {
      const el = doc.elementFromPoint?.(x, y);
      const file = fileOf(el);
      if (!file) return null;
      const anchor = diffAnchor(el) || {};
      return {
        file,
        line: lineOf(el),
        hash: anchor.hash || null,
        side: anchor.side || null,
        x: Math.round(x),
        y: Math.round(y),
      };
    }

    function anchorViewport() {
      const cy = win.innerHeight / 2;
      for (const x of [Math.min(win.innerWidth / 2, 400), win.innerWidth * 0.35, win.innerWidth * 0.65]) {
        const anchor = anchorAtPoint(x, cy);
        if (anchor?.file) return { file: anchor.file, line: anchor.line, hash: anchor.hash, side: anchor.side };
      }

      let best = null;
      let bestDist = Infinity;
      lineElements().forEach((el) => {
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.bottom < 0 || rect.top > win.innerHeight) return;
        const dist = Math.abs((rect.top + rect.bottom) / 2 - cy);
        if (dist < bestDist) {
          best = el;
          bestDist = dist;
        }
      });
      if (best) {
        const anchor = diffAnchor(best) || {};
        return { file: fileOf(best), line: lineOf(best), hash: anchor.hash || null, side: anchor.side || null };
      }
      return { file: null, line: null };
    }

    return {
      fileMap,
      diffAnchor,
      fileOf,
      lineOf,
      anchorAtPoint,
      anchorViewport,
      highlightRectAtPoint,
      lineElementForAnchor,
    };
  }

  global.VoicePrAnchors = {
    parseDiffAnchorId,
    createAnchorResolver,
    createTimelineClock,
    createAttentionTracker,
  };
})(globalThis);
