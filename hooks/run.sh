#!/bin/sh
# Plugin hook launcher — resolves bro without depending on PATH:
#   1. built dist inside this plugin checkout (local/dev installs — the
#      plugin's own code, so hook behavior tracks the checkout)
#   2. `bro` on PATH — but only if it actually has the hooks subcommand
#      (`bro hooks` with no event is a silent no-op; an older bro fails
#      the probe instead of failing every hook)
#   3. published package via npx, major-pinned (git-installed plugin)
#
# Fail-open contract: nothing here may stall or fail the session —
# commands run (not exec'd) and the script always exits 0.
set -u

ROOT="${DEVIN_PLUGIN_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"

if [ -f "$ROOT/packages/cli/dist/index.js" ] && command -v node >/dev/null 2>&1; then
  node "$ROOT/packages/cli/dist/index.js" hooks "$@" || true
elif command -v bro >/dev/null 2>&1 && bro hooks >/dev/null 2>&1; then
  bro hooks "$@" || true
elif command -v npx >/dev/null 2>&1; then
  npx -y @theplenkov/bro@0 hooks "$@" || true
fi
exit 0
