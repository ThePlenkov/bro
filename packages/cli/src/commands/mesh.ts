/**
 * `bro mesh` — inter-rig work federation (specs/mesh/spec.md).
 *
 * m1 scope: identity + the peer list. `peers` manages the
 * `mesh.peers` config map; `me` prints this rig's derived (or pinned)
 * mesh:// URI. Request/lifecycle/wait land in later milestones.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitTry, loadConfig } from '@broject/core'
import { formatRigUri, parseRigUri, rigFromRemoteUrl } from '@broject/mesh'

const USAGE = `Usage: bro mesh <command> [args…]

Commands:
  me                      this rig's mesh:// URI — config pin or derived
                          from origin (exits 2 when unresolvable)
  peers list              configured peers (alias, rig, remote)
  peers add <alias> <rig> <remote>
                          bind a peer rig to a git remote — the remote's
                          refs/dolt/data is what 'beads-remote' pulls
  peers remove <alias>    drop a peer binding
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

function readConfigFile(dir: string): MeshConfigFile {
  const path = join(dir, 'bro.config.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MeshConfigFile
  } catch {
    return {}
  }
}

function writeConfigFile(dir: string, cfg: MeshConfigFile): void {
  writeFileSync(join(dir, 'bro.config.json'), `${JSON.stringify(cfg, null, 2)}\n`)
}

function cmdPeersList(dir: string): void {
  const peers = loadConfig(dir).mesh.peers
  const aliases = Object.keys(peers).sort()
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
  const cfg = readConfigFile(dir)
  const mesh = cfg.mesh ?? {}
  const peers = { ...(mesh.peers ?? {}) }
  if (peers[alias] !== undefined) {
    console.error(`error: peer "${alias}" already bound — remove it first`)
    process.exit(2)
  }
  peers[alias] = { rig, remote }
  cfg.mesh = { ...mesh, peers }
  writeConfigFile(dir, cfg)
  console.log(`peer ${alias} → ${rig} (${remote})`)
}

function cmdPeersRemove(dir: string, args: string[]): void {
  const [alias] = args
  if (alias === undefined) {
    console.error('usage: bro mesh peers remove <alias>')
    process.exit(2)
  }
  const cfg = readConfigFile(dir)
  const mesh = cfg.mesh ?? {}
  const peers = { ...(mesh.peers ?? {}) }
  if (peers[alias] === undefined) {
    console.error(`error: no peer "${alias}"`)
    process.exit(2)
  }
  delete peers[alias]
  cfg.mesh = { ...mesh, peers }
  writeConfigFile(dir, cfg)
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
    default:
      break
  }
  console.error(USAGE)
  process.exit(verb === undefined || verb === 'help' ? 0 : 2)
}
