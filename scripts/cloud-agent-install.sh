#!/usr/bin/env bash
set -euo pipefail

# Node ≥22.18 is required for native .ts execution (gen-pack, bro.config.ts).
export PATH="/usr/local/bin:${PATH:-}"

fetch() { curl --proto '=https' --tlsv1.2 -fsSL "$@"; }

need_node() {
  node -e '
    const p = process.versions.node.split(".").map(Number);
    const ok = (p[0] === 22 && p[1] >= 18) || (p[0] === 23 && p[1] >= 6) || p[0] >= 24;
    process.exit(ok ? 0 : 1);
  '
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

if ! need_node 2>/dev/null; then
  NODE_VERSION="${NODE_VERSION:-22.23.3}"
  case "$(uname -m)" in
    x86_64)        NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  NODE_DIST="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  NODE_TARBALL="$WORKDIR/${NODE_DIST}.tar.xz"
  fetch "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz" -o "$NODE_TARBALL"
  NODE_SHA256="${NODE_SHA256:-$(fetch "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    | awk -v f="${NODE_DIST}.tar.xz" '$2 == f { print $1 }')}"
  if [[ -z $NODE_SHA256 ]]; then
    echo "No checksum found for ${NODE_DIST}.tar.xz" >&2; exit 1
  fi
  echo "${NODE_SHA256}  ${NODE_TARBALL}" | sha256sum --check -
  sudo tar -xJf "$NODE_TARBALL" -C /usr/local --strip-components=1 --no-same-owner
  hash -r
fi

if ! command -v bd >/dev/null 2>&1; then
  BD_VERSION="${BD_VERSION:-1.3.1}"
  case "$(uname -m)" in
    x86_64)        BD_ARCH=amd64 ;;
    aarch64|arm64) BD_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  BD_DIST="beads_${BD_VERSION}_linux_${BD_ARCH}"
  BD_TARBALL="$WORKDIR/${BD_DIST}.tar.gz"
  fetch "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/${BD_DIST}.tar.gz" -o "$BD_TARBALL"
  BD_SHA256="${BD_SHA256:-$(fetch "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/checksums.txt" \
    | awk -v f="${BD_DIST}.tar.gz" '$2 == f { print $1 }')}"
  if [[ -z $BD_SHA256 ]]; then
    echo "No checksum found for ${BD_DIST}.tar.gz" >&2; exit 1
  fi
  echo "${BD_SHA256}  ${BD_TARBALL}" | sha256sum --check -
  sudo tar -xzf "$BD_TARBALL" -C /usr/local/bin --no-same-owner bd
fi

# --ignore-scripts matches publish.yml/release.yml: dep lifecycle scripts are
# a supply-chain surface, and the repo builds fine without them.
npm ci --no-audit --no-fund --ignore-scripts
