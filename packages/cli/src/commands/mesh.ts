/**
 * `bro mesh` — inter-rig work federation (specs/mesh/spec.md).
 *
 * m1 scope: identity + the peer list. `peers` manages the
 * `mesh.peers` config map; `me` prints this rig's derived (or pinned)
 * mesh:// URI. Request/lifecycle/wait land in later milestones.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitCommonDir, gitTry, loadConfig, withFileLock } from '@broject/core'
import {
  formatRigUri,
  meshInbox,
  parsePeer,
  parseRigUri,
  rigFromRemoteUrl,
  syncReplica,
} from '@broject/mesh'

const USAGE = `Usage: bro mesh <command> [args…]

Commands:
  me                      this rig's mesh:// URI — config pin or derived
                          from origin (exits 2 when unresolvable)
  peers list              configured peers (alias, rig, remote)
  peers add <alias> <rig> <remote>
                          bind a peer rig — a filesystem path is the
                          'local' binding (live store via bd -C), a git
                          URL is 'beads-remote' (dolt replica of
                          refs/dolt/data)
  peers remove <alias>    drop a peer binding
  pull                    refresh every beads-remote replica
  inbox [--json] [--no-pull]
                          requests addressed to this rig across peers —
                          pulls replicas first unless --no-pull
`

/** This rig's URI: the `mesh.rig` config pin wins (a repo whose origin
 *  isn't a forge URL can still be addressed); else derive from origin. */
export function selfRig(dir: string): string | null {
  const cfg = loadConfig(dir)
  if (cfg.mesh.rig !== undefined && parseRigUri(cfg.mesh.rig) !== null) {
    return cfg.mesh.rig
  }
  const origin = gitTry(['remote', 'get-url', 'origin'])
  if (origin.code !== 0) {
    return null
  }
  const rig = rigFromRemoteUrl(origin.out)
  return rig === null ? null : formatRigUri(rig)
}

interface MeshConfigFile {
  mesh?: { rig?: string; peers?: Record<string, { rig: string; remote: string }> }
  [k: string]: unknown
}

/** Mutate `bro.config.json` under a file lock. Two refusals: a TS
 *  config shadows anything we would write (edit `mesh.peers` there
 *  instead), and a malformed file must not be silently overwritten —
 *  the error propagates and the command exits non-zero. */
function withMeshConfig<T>(dir: string, mutate: (cfg: MeshConfigFile) => T): T {
  const ts = join(dir, 'bro.config.ts')
  if (existsSync(ts)) {
    throw new Error(`bro.config.ts shadows bro.config.json — edit mesh.peers in ${ts}`)
  }
  const path = join(dir, 'bro.config.json')
  return withFileLock(`${path}.lock`, () => {
    const cfg = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as MeshConfigFile)
      : ({} as MeshConfigFile)
    const out = mutate(cfg)
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`)
    return out
  })
}

function cmdPeersList(dir: string): void {
  const peers = loadConfig(dir).mesh.peers
  const aliases = Object.keys(peers).sort((a, b) => a.localeCompare(b))
  if (aliases.length === 0) {
    console.log('no peers — `bro mesh peers add <alias> <rig> <remote>` binds one')
    return
  }
  for (const alias of aliases) {
    const p = peers[alias]!
    console.log(`${alias}\t${p.rig}\t${p.remote}`)
  }
}

function cmdPeersAdd(dir: string, args: string[]): void {
  const [alias, rig, remote] = args
  if (alias === undefined || rig === undefined || remote === undefined) {
    console.error('usage: bro mesh peers add <alias> <rig> <remote>')
    process.exit(2)
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) {
    console.error(`error: peer alias "${alias}" — use letters, digits, ., _, -`)
    process.exit(2)
  }
  if (parseRigUri(rig) === null) {
    console.error(`error: peer rig "${rig}" is not a mesh://<org>/<repo> uri`)
    process.exit(2)
  }
  try {
    withMeshConfig(dir, (cfg) => {
      const mesh = cfg.mesh ?? {}
      const peers = { ...mesh.peers }
      if (peers[alias] !== undefined) {
        console.error(`error: peer "${alias}" already bound — remove it first`)
        process.exit(2)
      }
      peers[alias] = { rig, remote }
      cfg.mesh = { ...mesh, peers }
    })
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }
  console.log(`peer ${alias} → ${rig} (${remote})`)
}

function cmdPeersRemove(dir: string, args: string[]): void {
  const [alias] = args
  if (alias === undefined) {
    console.error('usage: bro mesh peers remove <alias>')
    process.exit(2)
  }
  try {
    withMeshConfig(dir, (cfg) => {
      const mesh = cfg.mesh ?? {}
      const peers = { ...mesh.peers }
      if (peers[alias] === undefined) {
        console.error(`error: no peer "${alias}"`)
        process.exit(2)
      }
      delete peers[alias]
      cfg.mesh = { ...mesh, peers }
    })
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }
  console.log(`peer ${alias} removed`)
}

function cmdMe(dir: string): void {
  const rig = selfRig(dir)
  if (rig === null) {
    console.error(
      'this rig is unaddressed: no mesh.rig pin in bro.config.json and origin is not a forge url — set "mesh": { "rig": "mesh://<org>/<repo>" }'
    )
    process.exit(2)
  }
  console.log(rig)
  const descriptor = join(dir, '.bro-rig.json')
  if (!existsSync(descriptor)) {
    console.error('hint: no .bro-rig.json descriptor — peers can still pull requests, but the rig is undiscoverable')
  }
}

function meshPeers(dir: string) {
  return Object.entries(loadConfig(dir).mesh.peers)
    .map(([alias, raw]) => parsePeer(alias, raw))
    .filter((p): p is NonNullable<typeof p> => p !== null)
}

function cmdPull(dir: string): void {
  const common = gitCommonDir(dir)
  if (common === null) {
    console.error('bro mesh: not inside a git repository')
    process.exit(2)
  }
  const peers = meshPeers(dir).filter((p) => p.transport === 'beads-remote')
  if (peers.length === 0) {
    console.log('no beads-remote peers — nothing to pull')
    return
  }
  let ok = 0
  for (const peer of peers) {
    const r = syncReplica(common, peer.alias, peer.remote)
    if (r.error !== undefined) {
      console.error(`! ${r.error}`)
    } else {
      ok++
    }
  }
  console.log(`pulled ${ok}/${peers.length} peer(s)`)
}

function cmdInbox(dir: string, args: string[]): void {
  const common = gitCommonDir(dir)
  if (common === null) {
    console.error('bro mesh: not inside a git repository')
    process.exit(2)
  }
  const rig = selfRig(dir)
  if (rig === null) {
    console.error('this rig is unaddressed — set mesh.rig or a forge-url origin (see `bro mesh me`)')
    process.exit(2)
  }
  const result = meshInbox(dir, meshPeers(dir), rig, common, {
    pull: !args.includes('--no-pull'),
  })
  for (const e of result.errors) {
    console.error(`! ${e}`)
  }
  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        result.requests.map((r) => ({
          peer: r.peer,
          bead: r.beadId,
          ...r.envelope,
          mismatch: r.mismatch || undefined,
        })),
        null,
        2,
      ),
    )
    return
  }
  if (result.requests.length === 0) {
    console.log(`inbox empty for ${rig}`)
    return
  }
  for (const r of result.requests) {
    const flag = r.mismatch ? `  ! from=${r.envelope.from} ≠ ${r.peerRig}` : ''
    console.log(`${r.peer}\t${r.beadId}\t${r.envelope.title}${flag}`)
  }
}

export function runMeshCommand(argv: string[]): void {
  const dir = process.cwd()
  const [verb, ...rest] = argv
  switch (verb) {
    case 'me':
      return cmdMe(dir)
    case 'peers': {
      const [sub, ...subArgs] = rest
      if (sub === 'list' || sub === undefined) {
        return cmdPeersList(dir)
      }
      if (sub === 'add') {
        return cmdPeersAdd(dir, subArgs)
      }
      if (sub === 'remove' || sub === 'rm') {
        return cmdPeersRemove(dir, subArgs)
      }
      break
    }
    case 'add':
      // `bro mesh peers add` reads better; tolerate `bro mesh add`
      return cmdPeersAdd(dir, rest)
    case 'list':
      return cmdPeersList(dir)
    case 'pull':
      return cmdPull(dir)
    case 'inbox':
      return cmdInbox(dir, rest)
    default:
      break
  }
  console.error(USAGE)
  process.exit(verb === undefined || verb === 'help' ? 0 : 2)
}
