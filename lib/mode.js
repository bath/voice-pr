export const MODES = Object.freeze({
  AUTHOR: "author",
  REVIEWER: "reviewer",
});

export function normalizeMode(mode = MODES.AUTHOR) {
  const value = String(mode || MODES.AUTHOR).trim().toLowerCase();
  if (value === MODES.AUTHOR) return MODES.AUTHOR;
  if (value === MODES.REVIEWER || value === "review") return MODES.REVIEWER;
  throw new Error(`invalid mode "${mode}" (expected "author" or "reviewer")`);
}

export function isReviewerMode(mode) {
  return normalizeMode(mode) === MODES.REVIEWER;
}
