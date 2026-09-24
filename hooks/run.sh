#!/bin/sh
# Plugin hook launcher — resolves bro without depending on PATH:
#   1. built dist reachable from this checkout (local/dev installs — the
#      plugin's own code, so hook behavior tracks the checkout; found by
#      walking up from the plugin dir so adapters under plugins/<c>/bro/
#      resolve the repo root too)
#   2. `bro` on PATH — but only if it actually has the hooks subcommand
#      (`bro hooks` with no event is a silent no-op; an older bro fails
#      the probe instead of failing every hook)
#   3. published package via npx, pinned to the plugin's own version
#      (gen:plugins keeps it in sync with plugin.json)
#
# Fail-open contract: nothing here may stall or fail the session —
# commands run (not exec'd), a failed candidate falls through to the
# next, and the script always exits 0.
set -u

# each client exports its own plugin-root var — take whichever exists.
# a relative or nonexistent root is untrusted input: canonicalize an
# absolute root, and fall back to this script's own dir otherwise so the
# walk-up can't wander off CWD and execute an unrelated dist.
SCRIPT_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"
ROOT="${DEVIN_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}}"
case "$ROOT" in
  /*) ROOT="$(CDPATH='' cd -- "$ROOT" 2>/dev/null && pwd)" ;;
  *)  ROOT= ;;
esac
[ -n "$ROOT" ] || ROOT="$SCRIPT_ROOT"

# walk up for a built CLI — adapter dirs live below the repo root.
# break on the fixed point so a relative/malformed root can't spin.
DIR="$ROOT"
while [ ! -f "$DIR/packages/cli/dist/index.js" ]; do
  PARENT="$(dirname -- "$DIR")"
  [ "$PARENT" = "$DIR" ] && break
  DIR="$PARENT"
done

if [ -f "$DIR/packages/cli/dist/index.js" ] && command -v node >/dev/null 2>&1; then
  node "$DIR/packages/cli/dist/index.js" hooks "$@" && exit 0
fi
if command -v bro >/dev/null 2>&1 && bro hooks >/dev/null 2>&1; then
  bro hooks "$@" && exit 0
fi
if command -v npx >/dev/null 2>&1; then
  # --prefer-offline: warm npm cache wins over the network, so a slow
  # fetch can't eat the whole hook timeout
  npx -y --prefer-offline "@theplenkov/bro@0.2.1" hooks "$@" || true
fi
exit 0
