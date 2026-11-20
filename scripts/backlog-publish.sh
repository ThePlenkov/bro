#!/usr/bin/env bash
# backlog-publish.sh — publish the beads backlog onto refs/bro/data so the
# site `/backlog` page can read it through the GitHub API at page load.
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
  tar -xzf "$WORK/dolt.tgz" -C "$WORK/dolt-bin" --strip-components=1 dolt-linux-amd64/bin
  export PATH="$WORK/dolt-bin:$PATH"
fi

DOLT_DIR="${DOLT_DIR:-$WORK/dolt-repo}"
if [[ -d "$DOLT_DIR/.dolt" ]]; then
  (cd "$DOLT_DIR" && dolt fetch origin 'refs/dolt/data:refs/remotes/origin/dolt/data' >/dev/null 2>&1 || dolt pull >/dev/null)
else
  dolt clone "git+https://github.com/${GIT_REPO:-ThePlenkov/bro}.git" "$DOLT_DIR" >/dev/null
fi

node "$ROOT/scripts/backlog-export.ts" "$DOLT_DIR" "$WORK/backlog.json"

# --- commit backlog.json onto the data ref, plumbing only ---
INDEX="$WORK/index"
export GIT_INDEX_FILE="$INDEX"
DATA_REF="refs/bro/data"
REMOTE="${REMOTE:-origin}"

git -C "$ROOT" fetch --quiet "$REMOTE" "$DATA_REF" || true
TIP="$(git -C "$ROOT" rev-parse --verify --quiet FETCH_HEAD || true)"
BLOB="$(git -C "$ROOT" hash-object -w "$WORK/backlog.json")"

issues_blob() { # hash the issues array only — generated_at always differs
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).issues)))" | git -C "$ROOT" hash-object --stdin
}

if [[ -n "$TIP" ]]; then
  NEW_CORE="$(issues_blob < "$WORK/backlog.json")"
  OLD_CORE="$(git -C "$ROOT" show "$TIP:.agents/backlog.json" 2>/dev/null | issues_blob || true)"
  if [[ "$OLD_CORE" == "$NEW_CORE" ]]; then
    echo "backlog-publish: $DATA_REF already carries this backlog — nothing to push"
    exit 0
  fi
  git -C "$ROOT" read-tree "$TIP"
fi
git -C "$ROOT" update-index --add --cacheinfo "100644,$BLOB,.agents/backlog.json"
TREE="$(git -C "$ROOT" write-tree)"
if [[ -n "$TIP" ]]; then
  COMMIT="$(git -C "$ROOT" commit-tree "$TREE" -p "$TIP" -m "bro data: backlog snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)")"
else
  COMMIT="$(git -C "$ROOT" commit-tree "$TREE" -m "bro data: backlog snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)")"
fi

git -C "$ROOT" push "$REMOTE" "$COMMIT:$DATA_REF"
echo "backlog-publish: pushed backlog.json to $DATA_REF ($COMMIT)"
