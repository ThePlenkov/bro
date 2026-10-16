#!/usr/bin/env bash
# apiKeyHelper for a dogfood scratch repo — lazy-starts `bro serve` on
# 44928 bound to THIS repo, then prints the listener's session token
# from <git-common>/bro/serve.json. Self-contained on purpose: a
# scratch never shares port or token with the operator's own listener
# (44927) — its serve.json lives under this repo's git dir.
set -u

PORT=44928
URL="http://127.0.0.1:$PORT"

common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 1
serve="$common/bro/serve.json"
log="$common/bro/serve.log"

healthy() { curl -fsS --max-time 1 "$URL/api/v1/health" >/dev/null 2>&1; }

if ! healthy; then
  envfile="$HOME/.config/bro/provider.env"
  if [ -f "$envfile" ]; then set -a; . "$envfile"; set +a; fi
  BRO_PROVIDER_BACKEND=devin-acp-max setsid -f bro serve --port "$PORT" \
    </dev/null >>"$log" 2>&1
  for _ in $(seq 1 80); do healthy && break; sleep 0.25; done
fi

[ -f "$serve" ] && jq -r .token "$serve"
