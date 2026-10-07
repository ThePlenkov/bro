/**
 * `bro mesh` — inter-rig work federation (specs/mesh/spec.md).
 *
 * m1 scope: identity + the peer list. `peers` manages the
 * `mesh.peers` config map; `me` prints this rig's derived (or pinned)
 * mesh:// URI. Request/lifecycle/wait land in later milestones.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { facade, gitCommonDir, gitTry, loadConfig, withFileLock } from '@broject/core'
import {
  formatRigUri,
  meshInbox,
  meshThread,
  parsePeer,
  parseRigUri,
  postEnvelope,
  rigFromRemoteUrl,
  wireDep,
  syncReplica,
  type MeshKind,
  type MeshRef,
  type MeshPeer,
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
  request <rig> <title> [--body T] [--priority N] [--ref K:R]… [--for BEAD]
                          post a request envelope on the local beads
                          store — the target rig pulls it; --for blocks
                          a local bead on external:<rig>:<id>
  claim <thread>          worker verb: bind this rig to the thread
  done <thread> [--ev K:R]…
                          worker verb: submit the result + evidence
  accept|reject <thread> [--body T]
                          requester verdicts on a submitted result
  wait <thread> [--json] [--no-pull]
                          point-check the thread's stage across own
                          store and peer replicas
`

/** This rig's URI: the `mesh.rig` config pin wins (a repo whose origin
 *  isn't a forge URL can still be addressed); else derive from origin. */
export function selfRig(dir: string): string | null {
  const cfg = loadConfig(dir)
  if (cfg.mesh.rig !== undefined && parseRigUri(cfg.mesh.rig) !== null) {
    return formatRigUri(parseRigUri(cfg.mesh.rig)!)
  }
  const origin = gitTry(['-C', dir, 'remote', 'get-url', 'origin'])
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
    // atomic write: temp file in the same dir + rename, so a crash
    // mid-write can't leave a truncated config
    const tmp = join(dir, '.bro.config.json.tmp')
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`)
    renameSync(tmp, path)
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

/** One coalesced mailbox/bus drop when requests addressed to us are
 *  visible — the fixed key supersedes a pending drop, so polling loops
 *  can't spam sessions (the notify connector drains it mid-turn). */
function announceInbox(dir: string, rig: string, n: number): void {
  if (n === 0) {
    return
  }
  const events = facade('events', { dir }, { prefer: loadConfig(dir).connectors })
  void events
    .publish({
      topic: 'mesh',
      kind: 'info',
      payload: `${n} mesh request(s) addressed to ${rig} — \`bro mesh inbox\``,
      key: 'mesh-inbox',
    })
    .then(() => {})
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
  const rig = selfRig(dir)
  if (rig !== null) {
    announceInbox(dir, rig, meshInbox(dir, meshPeers(dir), rig, common, { pull: false }).requests.length)
  }
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
  announceInbox(dir, rig, result.requests.length)
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

function requireRig(dir: string): string {
  const rig = selfRig(dir)
  if (rig === null) {
    console.error('this rig is unaddressed — set mesh.rig or a forge-url origin (see `bro mesh me`)')
    process.exit(2)
  }
  return rig
}

function parseRefs(args: string[], flag: string): MeshRef[] {
  const out: MeshRef[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) {
      const v = args[++i]!
      const colon = v.indexOf(':')
      const kind = colon === -1 ? '' : v.slice(0, colon)
      const ref = v.slice(colon + 1)
      if (kind !== 'bead' && kind !== 'url' && kind !== 'pr') {
        console.error(`error: ${flag} wants <bead|url|pr>:<ref> — got "${v}"`)
        process.exit(2)
      }
      if (ref === '') {
        console.error(`error: empty ref in "${v}"`)
        process.exit(2)
      }
      out.push({ kind, ref })
    }
  }
  return out
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

function commonSetup(dir: string): { rig: string; common: string; peers: MeshPeer[] } {
  const common = gitCommonDir(dir)
  if (common === null) {
    console.error('bro mesh: not inside a git repository')
    process.exit(2)
  }
  return { rig: requireRig(dir), common, peers: meshPeers(dir) }
}

function cmdRequest(dir: string, args: string[]): void {
  const { rig } = commonSetup(dir)
  const [to, titleText, ...rest] = args
  const target = to !== undefined ? parseRigUri(to) : null
  if (target === null || titleText === undefined || titleText.startsWith('--')) {
    console.error('usage: bro mesh request <rig> <title> [--body T] [--priority N] [--ref K:R]…')
    process.exit(2)
  }
  const body = flagValue(rest, '--body')
  const prio = flagValue(rest, '--priority')
  const priority = prio === undefined ? undefined : Number.parseInt(prio, 10)
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 4)) {
    console.error('error: --priority wants 0-4')
    process.exit(2)
  }
  const posted = postEnvelope({
    dir,
    kind: 'request',
    // a request's thread is its own bead id — postEnvelope fills it
    thread: '',
    from: rig,
    to: formatRigUri(target),
    title: titleText,
    body,
    refs: parseRefs(rest, '--ref'),
    priority,
  })
  if (posted.error !== undefined) {
    console.error(`error: ${posted.error}`)
    process.exit(1)
  }
  console.log(`request ${posted.id} → ${formatRigUri(target)}`)
  const waiting = flagValue(rest, '--for')
  if (waiting !== undefined) {
    const depErr = wireDep(dir, waiting, formatRigUri(target), posted.id ?? '')
    if (depErr !== undefined) {
      console.error(`! request posted but dep wiring failed: ${depErr}`)
    } else {
      console.log(`${waiting} now blocked by external:${formatRigUri(target)}:${posted.id}`)
    }
  }
  console.log(`thread: ${posted.id} — track it with \`bro mesh wait ${posted.id}\``)
}

/** Find the thread's request envelope — own store first, then peers.
 *  The `to` a reply needs is always the other side's `from`. */
function threadAnchor(dir: string, thread: string, pull: boolean) {
  const { rig, common, peers } = commonSetup(dir)
  const state = meshThread(dir, peers, thread, common, { pull })
  if (state.request === undefined) {
    for (const e of state.errors) {
      console.error(`! ${e}`)
    }
    console.error(`error: no request for thread "${thread}" — not in own store or any peer replica`)
    process.exit(2)
  }
  return { rig, state }
}

/** The reply target for a lifecycle verb — the other side's rig,
 *  resolved through peer-binding provenance when the record arrived
 *  over a replica (the binding is the authoritative sender) and the
 *  envelope's own `from` for own-store rows. Exits 2 with a precise
 *  reason when the verb is illegal for the thread's stage or this
 *  rig's role. */
function lifecycleTarget(
  kind: MeshKind,
  rig: string,
  state: ReturnType<typeof meshThread>,
  thread: string
): string {
  const request = state.request!
  if (state.stage === 'accepted' || state.stage === 'rejected') {
    console.error(`error: thread "${thread}" is already ${state.stage}`)
    process.exit(2)
  }
  const senderOf = (e: { id: string; from: string }): string => state.provenance[e.id] ?? e.from
  const verb = kind === 'result' ? 'done' : kind
  if (kind === 'claim' || kind === 'result') {
    if (request.to !== rig) {
      console.error(`error: thread "${thread}" is addressed to ${request.to}, not this rig (${rig})`)
      process.exit(2)
    }
    const expected = kind === 'claim' ? 'posted' : 'claimed'
    if (state.stage !== expected) {
      console.error(`error: cannot ${verb} thread "${thread}" in stage "${state.stage}"`)
      process.exit(2)
    }
    return senderOf(request)
  }
  if (senderOf(request) !== rig) {
    console.error(`error: only the requester (${senderOf(request)}) can ${kind} thread "${thread}"`)
    process.exit(2)
  }
  if (state.stage !== 'submitted') {
    console.error(`error: nothing to ${kind} — no result submitted on thread "${thread}" yet`)
    process.exit(2)
  }
  const worker = [...state.envelopes].reverse().find((e) => e.kind === 'result')!
  return senderOf(worker)
}

function cmdLifecycle(dir: string, kind: MeshKind, args: string[]): void {
  const [thread, ...rest] = args
  if (thread === undefined) {
    console.error(`usage: bro mesh ${kind === 'result' ? 'done' : kind} <thread>`)
    process.exit(2)
  }
  const { rig, state } = threadAnchor(dir, thread, !args.includes('--no-pull'))
  const request = state.request!
  const to = lifecycleTarget(kind, rig, state, thread)

  const posted = postEnvelope({
    dir,
    kind,
    thread,
    from: rig,
    to,
    title: `${kind === 'result' ? 'result' : kind}: ${request.title}`,
    body: flagValue(rest, '--body'),
    evidence: kind === 'result' ? parseRefs(rest, '--ev') : undefined,
  })
  if (posted.error !== undefined) {
    console.error(`error: ${posted.error}`)
    process.exit(1)
  }
  console.log(`${kind} ${posted.id} → ${to} (thread ${thread})`)
}

function cmdWait(dir: string, args: string[]): void {
  const [thread] = args
  if (thread === undefined) {
    console.error('usage: bro mesh wait <thread> [--json] [--no-pull]')
    process.exit(2)
  }
  const { common, peers } = commonSetup(dir)
  const state = meshThread(dir, peers, thread, common, { pull: !args.includes('--no-pull') })
  for (const e of state.errors) {
    console.error(`! ${e}`)
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ thread, stage: state.stage, turn: state.turn, envelopes: state.envelopes }, null, 2))
    return
  }
  if (state.request === undefined) {
    console.log(`${thread}: no request visible — pull peers or check the id`)
    process.exit(1)
  }
  const next = state.turn === undefined ? 'done' : `${state.turn}'s move`
  console.log(`${thread}: ${state.stage} — ${next} (${state.envelopes.length} envelope(s))`)
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
    case 'request':
      return cmdRequest(dir, rest)
    case 'claim':
      return cmdLifecycle(dir, 'claim', rest)
    case 'done':
      return cmdLifecycle(dir, 'result', rest)
    case 'accept':
      return cmdLifecycle(dir, 'accept', rest)
    case 'reject':
      return cmdLifecycle(dir, 'reject', rest)
    case 'wait':
      return cmdWait(dir, rest)
    default:
      break
  }
  console.error(USAGE)
  process.exit(verb === undefined || verb === 'help' ? 0 : 2)
}
