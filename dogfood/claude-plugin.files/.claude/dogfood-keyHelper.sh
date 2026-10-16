#!/usr/bin/env bash
# apiKeyHelper for a dogfood scratch repo — lazy-starts `bro serve` on
# 44928 bound to THIS repo, then prints the listener's session token
# from <git-common>/bro/serve.json. Self-contained on purpose: a
# scratch never shares port or token with the operator's own listener
# (44927) — its serve.json lives under this repo's git dir.
#
# Failures are LOUD (exit 1 + stderr): an empty stdout would hand the
# client an empty api key and every call would 401 with no cause.
set -u

PORT=44928
URL="http://127.0.0.1:$PORT"

common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 1
# the dir serve binds to — plain repo: <repo>/.git → <repo>; -P
# resolves symlinks to match node's process.cwd() on the serve side
repo=$(cd "$common/.." && pwd -P)
serve="$common/bro/serve.json"
log="$common/bro/serve.log"

health() {
  curl -fsS --max-time 1 "$URL/api/v1/health" 2>/dev/null || true
  return 0
}

h=$(health)
if [[ -n "$h" ]]; then
  # a healthy port that isn't THIS repo's serve is somebody else's —
  # its token won't match ours; refuse rather than hand out ours
  # blindly (two overlapping claude-plugin runs are not supported)
  [[ "$(printf '%s' "$h" | jq -r .dir 2>/dev/null)" == "$repo" ]] ||
    { echo "port $PORT serves a different repo — serialize claude-plugin runs" >&2; exit 1; }
else
  mkdir -p "$(dirname "$log")"
  envfile="$HOME/.config/bro/provider.env"
  if [[ -f "$envfile" ]]; then set -a; . "$envfile"; set +a; fi
  BRO_PROVIDER_BACKEND=devin-acp-max setsid -f bro serve --port "$PORT" \
    </dev/null >>"$log" 2>&1
  for _ in $(seq 1 80); do
    h=$(health)
    [[ -n "$h" ]] && break
    sleep 0.25
  done
  [[ -n "$h" ]] || { echo "bro serve never came up on $PORT — see $log" >&2; exit 1; }
fi

[[ -f "$serve" ]] || { echo "no serve.json at $serve" >&2; exit 1; }
jq -r .token "$serve"
