#!/usr/bin/env bash
# prechange.sh — verify the working copy is up to date with origin before
# applying any changes. More than one developer works on this repo, so
# building on stale code (or silently diverging from origin) is a real risk.
#
# On success, records a baseline (branch + local/origin SHAs) in
# .git/PRECHANGE_STATE for postchange.sh to compare against later.
#
# Usage: bash prechange.sh
#
# Exit codes:
#   0 — safe to proceed (up to date, fast-forwarded cleanly, or ahead-only)
#   1 — environment problem (not a repo, detached HEAD, fetch failed)
#   2 — blocking situation that needs a human decision (dirty tree behind
#       origin, or local/origin have diverged) — do NOT proceed with changes
#       until this is resolved; surface it to the developer instead.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

STATE_FILE=".git/PRECHANGE_STATE"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "prechange: not inside a git repository." >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = "HEAD" ]; then
  echo "prechange: repository is in a detached HEAD state — resolve this before continuing." >&2
  exit 1
fi

echo "prechange: current branch is '$branch'"

dirty=0
if [ -n "$(git status --porcelain)" ]; then
  dirty=1
  echo "prechange: working tree has uncommitted changes:"
  git status --short
else
  echo "prechange: working tree is clean."
fi

# Records the baseline this run confirmed safe, for postchange.sh to diff
# against once the agent is done making changes.
write_state() {
  local origin_sha="$1"
  {
    echo "PRECHANGE_BRANCH=\"$branch\""
    echo "PRECHANGE_LOCAL_SHA=\"$(git rev-parse HEAD)\""
    echo "PRECHANGE_ORIGIN_SHA=\"$origin_sha\""
    echo "PRECHANGE_TIMESTAMP=\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  } > "$STATE_FILE"
}

echo "prechange: fetching from origin..."
if ! fetch_err=$(git fetch origin "$branch" 2>&1); then
  echo "prechange: could not fetch from origin (offline, or no remote configured)." >&2
  echo "$fetch_err" >&2
  exit 1
fi

if ! git rev-parse --verify -q "origin/$branch" >/dev/null; then
  echo "prechange: no 'origin/$branch' — this branch doesn't exist on the remote yet. Safe to proceed."
  write_state ""
  exit 0
fi

local_rev=$(git rev-parse HEAD)
remote_rev=$(git rev-parse "origin/$branch")

if [ "$local_rev" = "$remote_rev" ]; then
  echo "prechange: up to date with origin/$branch. Safe to proceed."
  write_state "$remote_rev"
  exit 0
fi

ahead=$(git rev-list --count "origin/$branch..HEAD")
behind=$(git rev-list --count "HEAD..origin/$branch")

echo "prechange: local is $ahead commit(s) ahead and $behind commit(s) behind origin/$branch."

if [ "$behind" -eq 0 ]; then
  echo "prechange: ahead only, not behind — safe to proceed. Remember to push your work."
  write_state "$remote_rev"
  exit 0
fi

if [ "$dirty" -eq 1 ]; then
  echo "prechange: STOP — behind origin AND the working tree is dirty." >&2
  echo "prechange: resolve or commit local changes and pull manually before making further changes." >&2
  exit 2
fi

if [ "$ahead" -gt 0 ]; then
  echo "prechange: STOP — local and origin/$branch have diverged ($ahead ahead, $behind behind)." >&2
  echo "prechange: do not auto-merge. Surface this to the developer before proceeding." >&2
  exit 2
fi

echo "prechange: behind origin/$branch by $behind commit(s), working tree clean — fast-forwarding..."
if git merge --ff-only "origin/$branch"; then
  echo "prechange: updated to latest origin/$branch. Safe to proceed."
  write_state "$(git rev-parse "origin/$branch")"
  exit 0
else
  echo "prechange: fast-forward failed unexpectedly — do not proceed, surface this to the developer." >&2
  exit 2
fi
