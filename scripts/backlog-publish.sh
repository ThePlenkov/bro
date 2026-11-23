#!/usr/bin/env bash
# backlog-publish.sh — publish the beads backlog onto refs/bro/data plus
# its raw-readable heads twin so the site `/backlog` page can read it
# without the rate-limited GitHub API at page load.
#
# Steps: dolt clone (cached) → node scripts/backlog-export.ts → commit
# backlog.json on top of the data ref tip via plumbing (never touches the
# worktree or the user's index). Skips the push when the blob is unchanged.
#
# Required env: GIT_REPO (owner/repo or a remote URL), optional DOLT_DIR
# to reuse a clone, REMOTE (default origin) inside a git worktree.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Self-contained dolt install: pinned version + sha256, so the script
# needs no pre-provisioned binary. Skipped when dolt is already on PATH.
DOLT_VERSION="2.1.7"
DOLT_SHA256="15983e811341ed94e5d47fbfc41d2f57d8c7aa65eee511d25a3c3fd5477e28e7"
if ! command -v dolt >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/dolthub/dolt/releases/download/v${DOLT_VERSION}/dolt-linux-amd64.tar.gz" \
    -o "$WORK/dolt.tgz" # NOSONAR — verified against DOLT_SHA256 below
  echo "$DOLT_SHA256  $WORK/dolt.tgz" | sha256sum -c -
  mkdir -p "$WORK/dolt-bin"
  tar -xzf "$WORK/dolt.tgz" -C "$WORK/dolt-bin" --strip-components=2 dolt-linux-amd64/bin
  export PATH="$WORK/dolt-bin:$PATH"
fi

# GIT_REPO accepts owner/repo, a https URL, or an ssh URL — normalize to a slug
REPO_SLUG="${GIT_REPO:-ThePlenkov/bro}"
REPO_SLUG="${REPO_SLUG#git+}"
REPO_SLUG="${REPO_SLUG#https://github.com/}"
REPO_SLUG="${REPO_SLUG#git@github.com:}"
REPO_SLUG="${REPO_SLUG%.git}"

DOLT_DIR="${DOLT_DIR:-$WORK/dolt-repo}"
if [[ -d "$DOLT_DIR/.dolt" ]]; then
  # fetch alone leaves the working set behind — pull advances HEAD; a
  # failed pull (diverged or offline) falls back to a fresh clone under
  # WORK, never deleting the caller's own directory
  if ! (cd "$DOLT_DIR" && dolt pull >/dev/null 2>&1); then
    DOLT_DIR="$WORK/dolt-repo-fresh"
  fi
fi
if [[ ! -d "$DOLT_DIR/.dolt" ]]; then
  dolt clone "git+https://github.com/${REPO_SLUG}.git" "$DOLT_DIR" >/dev/null
fi

node "$ROOT/scripts/backlog-export.ts" "$DOLT_DIR" "$WORK/backlog.json"

# --- commit backlog.json onto the data ref, plumbing only ---
INDEX="$WORK/index"
export GIT_INDEX_FILE="$INDEX"
DATA_REF="refs/bro/data"
# heads twin of the same commit — raw.githubusercontent serves branches
# without the API quota the ref-resolution call costs every page load
BRANCH_REF="refs/heads/bro-data"
REMOTE="${REMOTE:-origin}"

# plumbing commits still want an identity — runners may not configure one
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-bro-bot}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-bro-bot@users.noreply.github.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-bro-bot}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-bro-bot@users.noreply.github.com}"

fetch_tip() {
  git -C "$ROOT" fetch --quiet "$REMOTE" "$DATA_REF" || true
  TIP="$(git -C "$ROOT" rev-parse --verify --quiet FETCH_HEAD || true)"
}

BLOB="$(git -C "$ROOT" hash-object -w "$WORK/backlog.json")"

issues_blob() { # hash the issues array only — generated_at always differs
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).issues)))" | git -C "$ROOT" hash-object --stdin
}

fetch_tip
if [[ -n "$TIP" ]]; then
  NEW_CORE="$(issues_blob < "$WORK/backlog.json")"
  OLD_CORE="$(git -C "$ROOT" show "$TIP:.agents/backlog.json" 2>/dev/null | issues_blob || true)"
  if [[ "$OLD_CORE" == "$NEW_CORE" ]]; then
    echo "backlog-publish: $DATA_REF already carries this backlog — nothing to push"
    exit 0
  fi
fi

# build the commit on top of whatever TIP is current right now — the loop
# below re-runs this after every rejected push, so the tree always carries
# the ref's latest files plus our refreshed backlog.json
publish_commit() {
  if [[ -n "$TIP" ]]; then
    git -C "$ROOT" read-tree "$TIP"
    git -C "$ROOT" update-index --add --cacheinfo "100644,$BLOB,.agents/backlog.json"
    git -C "$ROOT" commit-tree "$(git -C "$ROOT" write-tree)" -p "$TIP" \
      -m "bro data: backlog snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    git -C "$ROOT" read-tree --empty
    git -C "$ROOT" update-index --add --cacheinfo "100644,$BLOB,.agents/backlog.json"
    git -C "$ROOT" commit-tree "$(git -C "$ROOT" write-tree)" \
      -m "bro data: backlog snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
}

COMMIT="$(publish_commit)"
for attempt in 1 2 3; do
  if git -C "$ROOT" push "$REMOTE" "$COMMIT:$DATA_REF"; then
    echo "backlog-publish: pushed backlog.json to $DATA_REF ($COMMIT)"
    # the heads twin is best-effort and pushed separately — a rejected
    # branch push (protected-branch rules, per-ref policies) must not
    # re-enter the retry loop and diverge the two refs
    if git -C "$ROOT" push "$REMOTE" "$COMMIT:$BRANCH_REF"; then
      echo "backlog-publish: mirrored to $BRANCH_REF"
    else
      echo "warning: could not mirror $COMMIT to $BRANCH_REF — raw fallback still reads $DATA_REF" >&2
    fi
    exit 0
  fi
  if [[ "$attempt" -eq 3 ]]; then
    echo "backlog-publish: push rejected after 3 attempts" >&2
    exit 1
  fi
  # someone else advanced the ref — re-parent our commit onto their tip
  fetch_tip
  COMMIT="$(publish_commit)"
done
