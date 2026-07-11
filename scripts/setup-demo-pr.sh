#!/usr/bin/env bash
#
# setup-demo-pr.sh — create (or reuse) a scratch repo and open a fresh PR with
# deliberate, speakable smells so you can demo voice-pr end-to-end without
# touching anything real.
#
# The PR introduces src/charge.js with:
#   - a retry loop with NO backoff        -> "make the retry loop back off exponentially"
#   - a badly named var `fooSvc`          -> "rename fooSvc to paymentClient"
#   - a missing null/validation check     -> "guard against a missing amount"
#   - an untested function                -> "add a test for chargeCard"
#
# Usage: bash scripts/setup-demo-pr.sh
set -euo pipefail

REPO="${DEMO_REPO:-voice-pr-demo}"
OWNER="$(gh api user -q .login)"
SLUG="$OWNER/$REPO"
STAMP="$(date +%m%d-%H%M%S)"
BRANCH="demo/feedback-$STAMP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo ">> owner=$OWNER repo=$REPO branch=$BRANCH"

# --- ensure the remote repo exists with a baseline main -----------------------
if ! gh repo view "$SLUG" >/dev/null 2>&1; then
  echo ">> creating $SLUG"
  git -C "$WORK" init -q -b main
  mkdir -p "$WORK/src"
  cat > "$WORK/README.md" <<'EOF'
# voice-pr-demo
Scratch repo for demoing voice-pr. Nothing here is real.
EOF
  cat > "$WORK/package.json" <<'EOF'
{ "name": "voice-pr-demo", "version": "0.0.0", "type": "module", "scripts": { "test": "node --test" } }
EOF
  cat > "$WORK/src/util.js" <<'EOF'
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
EOF
  git -C "$WORK" add -A
  git -C "$WORK" -c user.email=demo@localhost -c user.name=demo commit -qm "chore: baseline"
  gh repo create "$SLUG" --private --source "$WORK" --remote origin --push >/dev/null
  echo ">> created and pushed main"
else
  echo ">> reusing existing $SLUG"
  gh repo clone "$SLUG" "$WORK/clone" -- -q
  WORK="$WORK/clone"
fi

cd "$WORK"
git checkout -q main 2>/dev/null || true
git pull -q origin main 2>/dev/null || true
git checkout -q -b "$BRANCH"

# --- validation command the coding agent can discover and run ----------------
cat > build.sh <<'EOF'
#!/bin/sh
# no build step for this demo
exit 0
EOF
cat > test.sh <<'EOF'
#!/bin/sh
set -e
npm test
EOF
chmod +x build.sh test.sh

# --- the PR's feature code: deliberately rough ------------------------------
mkdir -p src
cat > src/charge.js <<'EOF'
import { sleep } from "./util.js";

// Charges a card, retrying on transient failure.
export async function chargeCard(fooSvc, card, amount) {
  let attempts = 0;
  let lastErr;
  while (attempts < 5) {
    try {
      return await fooSvc.charge(card, amount);
    } catch (err) {
      lastErr = err;
      attempts++;
      // no backoff — hammers the downstream service
      await sleep(200);
    }
  }
  throw lastErr;
}
EOF

git add -A
git -c user.email=demo@localhost -c user.name=demo commit -qm "feat: add chargeCard with retry"
git push -q -u origin "$BRANCH"

PR_URL="$(gh pr create --repo "$SLUG" --base main --head "$BRANCH" \
  --title "feat: add chargeCard with retry" \
  --body "Adds a card-charge helper with retry. Reviewing my own work — will leave voice feedback." \
  | tail -1)"

echo ""
echo "============================================================"
echo " Demo PR ready:"
echo "   $PR_URL"
echo ""
echo " Try speaking (or typing) into voice-pr:"
echo "   \"Make the retry loop use exponential backoff instead of a"
echo "    fixed sleep, rename fooSvc to paymentClient everywhere, and"
echo "    add a null check that throws if amount is missing. Also that"
echo "    thing with the widget — just make it nicer.\""
echo ""
echo " (the last item is intentionally vague -> clarification comment)"
echo "============================================================"
