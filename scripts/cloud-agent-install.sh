#!/usr/bin/env bash
set -euo pipefail

# Node ≥22.18 is required for native .ts execution (gen-pack, bro.config.ts).
export PATH="/usr/local/bin:${PATH:-}"

need_node() {
  node -e '
    const p = process.versions.node.split(".").map(Number);
    const ok = p[0] > 22 || (p[0] === 22 && p[1] >= 18) || p[0] >= 24;
    process.exit(ok ? 0 : 1);
  '
}

if ! need_node 2>/dev/null; then
  NODE_VERSION="${NODE_VERSION:-22.23.3}"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)        NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  NODE_DIST="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  NODE_TARBALL="$(mktemp)"
  trap 'rm -f "$NODE_TARBALL"' EXIT
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz" -o "$NODE_TARBALL"
  NODE_SHA256="${NODE_SHA256:-$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    | awk -v f="${NODE_DIST}.tar.xz" '$2 == f { print $1 }')}"
  if [ -z "$NODE_SHA256" ]; then
    echo "No checksum found for ${NODE_DIST}.tar.xz" >&2; exit 1
  fi
  echo "${NODE_SHA256}  ${NODE_TARBALL}" | sha256sum --check -
  sudo tar -xJf "$NODE_TARBALL" -C /usr/local --strip-components=1 --no-same-owner
  hash -r
fi

if ! command -v bd >/dev/null 2>&1; then
  sudo npm install -g @beads/bd --no-audit --no-fund
fi

npm ci --no-audit --no-fund
