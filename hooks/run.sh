#!/bin/sh
# Plugin hook launcher — resolves bro without depending on PATH:
#   1. built dist inside this plugin checkout (local/dev installs — the
#      plugin's own code, so hook behavior tracks the checkout)
#   2. `bro` on PATH (user-installed or npm-linked)
#   3. published package via npx, major-pinned (git-installed plugin)
set -u

ROOT="${DEVIN_PLUGIN_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"

if [ -f "$ROOT/packages/cli/dist/index.js" ]; then
  exec node "$ROOT/packages/cli/dist/index.js" hooks "$@"
elif command -v bro >/dev/null 2>&1; then
  exec bro hooks "$@"
else
  exec npx -y @theplenkov/bro@0 hooks "$@"
fi
