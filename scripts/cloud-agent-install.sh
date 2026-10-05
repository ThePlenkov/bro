#!/usr/bin/env bash
set -euo pipefail

# Node ≥22.18 is required for native .ts execution (gen-pack, bro.config.ts).
export PATH="/usr/local/bin:${PATH:-}"

NODE_MIN_MINOR=18
need_node() {
  node -e '
    const p = process.versions.node.split(".").map(Number);
    const ok = p[0] > 22 || (p[0] === 22 && p[1] >= 18) || p[0] >= 24;
    process.exit(ok ? 0 : 1);
  '
}

if ! need_node 2>/dev/null; then
  NODE_VERSION="${NODE_VERSION:-22.23.3}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | sudo tar -xJ -C /usr/local --strip-components=1 --no-same-owner
  hash -r
fi

if ! command -v bd >/dev/null 2>&1; then
  sudo npm install -g @beads/bd --no-audit --no-fund
fi

npm ci --no-audit --no-fund
