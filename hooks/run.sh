#!/bin/sh
# Plugin hook launcher — resolves bro without depending on PATH:
#   1. `bro` on PATH (user-installed or npm-linked)
#   2. built dist inside this plugin checkout (local/dev installs)
#   3. published package via npx (git-installed plugin)
set -u

ROOT="${DEVIN_PLUGIN_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"

if command -v bro >/dev/null 2>&1; then
  exec bro hooks "$@"
elif [ -f "$ROOT/packages/cli/dist/index.js" ]; then
  exec node "$ROOT/packages/cli/dist/index.js" hooks "$@"
else
  exec npx -y @theplenkov/bro hooks "$@"
fi
