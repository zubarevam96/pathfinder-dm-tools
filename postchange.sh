#!/usr/bin/env bash
# postchange.sh — verify nothing else landed, locally or on origin, while the
# agent was applying changes. Always run this after the agent finishes making
# changes, before asking the developer to test/confirm and before any
# eventual commit/push.
#
# Compares the current state against the baseline prechange.sh recorded in
# .git/PRECHANGE_STATE. That baseline records the local and origin commit
# the repo was at when the agent started — if either has moved since, this
# script reports it so the developer can decide what to do. It never
# resolves drift itself (no auto-commit, no auto-merge).
#
# This mainly guards against: (a) the agent committing when it shouldn't
# have per this repo's workflow rules, and (b) another developer pushing to
# origin while the agent was mid-task. Local commits aren't automatically
# treated as a mistake, though — legitimate intermediate commits (e.g. to
# checkpoint a quality fix) can happen, so this reports rather than blocks;
# what matters is that the developer sees it before anything is pushed.
#
# Usage: bash postchange.sh
#
# Exit codes:
#   0 — clean: no local commits appeared, origin hasn't moved since baseline.
#   1 — no baseline found, or fetch failed; best-effort report only.
#   2 — drift detected (new local commit(s) and/or origin moved). Details are
#       printed above; surface them to the developer before committing/pushing.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

STATE_FILE=".git/PRECHANGE_STATE"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "postchange: not inside a git repository." >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
echo "postchange: current branch is '$branch'"

if [ -n "$(git status --porcelain)" ]; then
  echo "postchange: working tree has uncommitted changes:"
  git status --short
else
  echo "postchange: working tree is clean."
fi

if [ ! -f "$STATE_FILE" ]; then
  echo "postchange: no prechange.sh baseline found ($STATE_FILE missing)." >&2
  echo "postchange: run prechange.sh before changes next time for an accurate delta check." >&2
  echo "postchange: falling back to a plain status report."
  if fetch_err=$(git fetch origin "$branch" 2>&1); then
    if git rev-parse --verify -q "origin/$branch" >/dev/null; then
      ahead=$(git rev-list --count "origin/$branch..HEAD")
      behind=$(git rev-list --count "HEAD..origin/$branch")
      echo "postchange: local is $ahead commit(s) ahead and $behind commit(s) behind origin/$branch."
    fi
  else
    echo "postchange: could not fetch from origin." >&2
    echo "$fetch_err" >&2
  fi
  exit 1
fi

# shellcheck disable=SC1090
source "$STATE_FILE"

if [ "$branch" != "${PRECHANGE_BRANCH:-}" ]; then
  echo "postchange: branch changed since prechange.sh ran ('${PRECHANGE_BRANCH:-?}' -> '$branch')." >&2
  echo "postchange: baseline no longer applies — treat this as unverified, surface it to the developer." >&2
  exit 2
fi

status=0

current_local_sha=$(git rev-parse HEAD)
if [ "$current_local_sha" != "${PRECHANGE_LOCAL_SHA:-}" ]; then
  echo "postchange: NOTE — local commit(s) appeared since prechange.sh ran:"
  git log --oneline "${PRECHANGE_LOCAL_SHA}..$current_local_sha"
  status=2
fi

echo "postchange: fetching from origin..."
if fetch_err=$(git fetch origin "$branch" 2>&1); then
  if git rev-parse --verify -q "origin/$branch" >/dev/null; then
    current_origin_sha=$(git rev-parse "origin/$branch")
    if [ -z "${PRECHANGE_ORIGIN_SHA:-}" ]; then
      echo "postchange: NOTE — origin/$branch didn't exist at prechange time and now does."
      status=2
    elif [ "$current_origin_sha" != "$PRECHANGE_ORIGIN_SHA" ]; then
      echo "postchange: NOTE — origin/$branch moved since prechange.sh ran (someone else likely pushed):"
      git log --oneline "${PRECHANGE_ORIGIN_SHA}..$current_origin_sha" 2>/dev/null \
        || echo "  (baseline commit not found locally — origin history may have been rewritten)"
      status=2
    fi
  fi
else
  echo "postchange: could not fetch from origin — cannot confirm origin is unchanged." >&2
  echo "$fetch_err" >&2
  [ "$status" -eq 0 ] && status=1
fi

if [ "$status" -eq 0 ]; then
  echo "postchange: clean — no local commits appeared, origin unchanged since prechange.sh. Safe to proceed to developer confirmation."
else
  echo "postchange: surface the notes above to the developer before committing/pushing." >&2
fi

exit "$status"
