/**
 * `bro mesh` — inter-rig work federation (specs/mesh/spec.md).
 *
 * m1 scope: identity + the peer list. `peers` manages the
 * `mesh.peers` config map; `me` prints this rig's derived (or pinned)
 * mesh:// URI. Request/lifecycle/wait land in later milestones.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  bd,
  bdAt,
  facade,
  gitCommonDir,
  hasHelpFlag,
  loadConfig,
  printUsage,
  taskStore,
  taskStoreAt,
} from '@broject/core'
import {
  acceptWanted,
  claimWanted,
  completeWanted,
  formatRigUri,
  issueKey,
  localCheckout,
  MESH_VERSION,
  meshInbox,
  meshThread,
  parseGithubRemote,
  parsePeer,
  parseRigUri,
  postComment,
  postEnvelope,
  rejectWanted,
  selfRig,
  wireDep,
  syncReplica,
  withMeshConfig,
  type MeshEnvelope,
  type MeshKind,
  type MeshRef,
  type MeshPeer,
} from '@broject/mesh'

const USAGE = `Usage: bro mesh <command> [args…]

Commands:
  me                      this rig's mesh:// URI — config pin or derived
                          from origin (exits 2 when unresolvable)
  peers list              configured peers (alias, rig, remote)
  peers add <alias> <rig> <remote> [--login L]
                          bind a peer rig — a filesystem path is the
                          'local' binding (live store via bd -C), a git
                          URL is 'beads-remote' (dolt replica of
                          refs/dolt/data), a github repo url is 'github'
                          (issue+comment transport; --login pins the
                          account whose records prove the peer), a
                          wl:// board is 'wasteland'
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

function cmdPeersList(dir: string): void {
  const peers = loadConfig(dir).mesh.peers
  const aliases = Object.keys(peers).sort((a, b) => a.localeCompare(b))
  if (aliases.length === 0) {
    console.log('no peers — `bro mesh peers add <alias> <rig> <remote>` binds one')
    return
  }
  for (const alias of aliases) {
    const p = peers[alias]!
    console.log(`${alias}\t${p.rig}\t${p.remote}${p.login !== undefined ? `\tlogin:${p.login}` : ''}`)
  }
}

/** The binding write — refuses an occupied alias inside the same
 *  config mutation so the check and the set stay atomic. */
function bindPeer(dir: string, b: { alias: string; rig: string; remote: string; login?: string }): void {
  try {
    withMeshConfig(dir, (cfg) => {
      const mesh = cfg.mesh ?? {}
      const peers = { ...mesh.peers }
      if (peers[b.alias] !== undefined) {
        console.error(`error: peer "${b.alias}" already bound — remove it first`)
        process.exit(2)
      }
      peers[b.alias] = { rig: b.rig, remote: b.remote, ...(b.login !== undefined ? { login: b.login } : {}) }
      cfg.mesh = { ...mesh, peers }
    })
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }
}

function cmdPeersAdd(dir: string, args: string[]): void {
  const [alias = '', rig = '', remote = ''] = args
  // positional — a non-empty <remote> implies the two before it
  if (remote === '') {
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
  bindPeer(dir, { alias, rig, remote, login: flagValue(args, '--login') })
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

export function meshPeers(dir: string): MeshPeer[] {
  return Object.entries(loadConfig(dir).mesh.peers)
    .map(([alias, raw]) => parsePeer(alias, raw))
    .filter((p): p is NonNullable<typeof p> => p !== null)
}

/** One coalesced mailbox/bus drop when requests addressed to us are
 *  visible — the fixed key supersedes a pending drop, so polling loops
 *  can't spam sessions (the notify connector drains it mid-turn).
 *  Best-effort: a misconfigured events connector or a failed publish
 *  must not break pull/inbox. */
function announceInbox(dir: string, rig: string, n: number): void {
  if (n === 0) {
    return
  }
  try {
    const events = facade('events', { dir }, { prefer: loadConfig(dir).connectors })
    void events
      .publish({
        topic: 'mesh',
        kind: 'info',
        payload: `${n} mesh request(s) addressed to ${rig} — \`bro mesh inbox\``,
        key: 'mesh-inbox',
        // anonymous keyed publishes coalesce nothing — the mesh plane
        // pins its name so a later announce still supersedes this one
        source: 'mesh',
      })
      .catch(() => {})
  } catch {
    // events facade unresolvable — notification is advisory only
  }
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
    announceInbox(dir, rig, meshInbox(dir, meshPeers(dir), { selfRig: rig, gitCommon: common, pull: false }).requests.length)
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
  const result = meshInbox(dir, meshPeers(dir), {
    selfRig: rig,
    gitCommon: common,
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
          unbound: r.unbound || undefined,
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
    const unbound = r.unbound === true ? `  ! from=${r.envelope.from} unbound` : ''
    console.log(`${r.peer}\t${r.beadId}\t${r.envelope.title}${flag}${unbound}`)
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

export function parseRefs(args: string[], flag: string): MeshRef[] {
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

export function flagValue(args: string[], flag: string): string | undefined {
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
  const state = meshThread(dir, peers, thread, { gitCommon: common, pull })
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
/** The role/stage checks share one context — kind, this rig, the
 *  reduced thread state, and the anchor request the verb acts on. */
interface LifecycleCtx {
  kind: MeshKind
  rig: string
  state: ReturnType<typeof meshThread>
  thread: string
  request: MeshEnvelope
}

/** `claim`/`result` are the worker's verbs — only the addressed rig
 *  may run them, and only at the matching stage. */
function workerTarget(ctx: LifecycleCtx): string {
  const { kind, rig, state, thread, request } = ctx
  if (request.to !== rig) {
    console.error(`error: thread "${thread}" is addressed to ${request.to}, not this rig (${rig})`)
    process.exit(2)
  }
  const expected = kind === 'claim' ? 'posted' : 'claimed'
  if (state.stage !== expected) {
    const verb = kind === 'result' ? 'done' : kind
    console.error(`error: cannot ${verb} thread "${thread}" in stage "${state.stage}"`)
    process.exit(2)
  }
  return state.provenance[request.id] ?? request.from
}

/** `accept`/`reject` are the requester's verbs — only the request's
 *  sender may run them, and only once a result is submitted. */
function requesterTarget(ctx: LifecycleCtx): string {
  const { kind, rig, state, thread, request } = ctx
  const senderOf = (e: { id: string; from: string }): string => state.provenance[e.id] ?? e.from
  if (senderOf(request) !== rig) {
    console.error(`error: only the requester (${senderOf(request)}) can ${kind} thread "${thread}"`)
    process.exit(2)
  }
  if (state.stage !== 'submitted') {
    console.error(`error: nothing to ${kind} — no result submitted on thread "${thread}" yet`)
    process.exit(2)
  }
  const worker = [...state.envelopes].reverse().find((e) => e.kind === 'result')
  if (worker === undefined) {
    console.error(`error: no result record on thread "${thread}"`)
    process.exit(2)
  }
  return senderOf(worker)
}

function lifecycleTarget(
  kind: MeshKind,
  rig: string,
  state: ReturnType<typeof meshThread>,
  thread: string
): string {
  const request = state.request
  if (request === undefined) {
    console.error(`error: no request for thread "${thread}" — not in own store or any peer replica`)
    process.exit(2)
  }
  if (state.stage === 'accepted' || state.stage === 'rejected') {
    console.error(`error: thread "${thread}" is already ${state.stage}`)
    process.exit(2)
  }
  const ctx: LifecycleCtx = { kind, rig, state, thread, request }
  return kind === 'claim' || kind === 'result' ? workerTarget(ctx) : requesterTarget(ctx)
}

/** A foreign anchor's `.beads` pins over ambient BEADS_DIR — the
 *  caller's env belongs to its own store; an own anchor honors the
 *  ambient pin (a spawned worker's shared store) */
function anchorStore(anchor: string, dir: string) {
  return anchor !== dir ? taskStoreAt(join(anchor, '.beads')) : taskStore(anchor)
}

// the thread's home is the anchor store — a `local` peer binding
// names the checkout the request was delivered into; own store
// otherwise (pull topology: verdicts ship on the author's side)
function resolveAnchor(dir: string, state: ReturnType<typeof meshThread>, thread: string): string {
  if (state.requestPeer?.transport !== 'local') {
    return dir
  }
  const checkout = localCheckout(state.requestPeer.remote)
  if (checkout === null) {
    console.error(
      `error: thread "${thread}" anchors at ${state.requestPeer.remote} — the checkout does not resolve`
    )
    process.exit(2)
  }
  return checkout
}

// delivered threads carry `export:<thread>` — `done` ships the
// capability so the requester's `external:` dep can release. The
// guard is the pin itself: pull-topology threads anchor on stores
// whose request bead has no export:, and shipping there would only
// fail. `bd ship` refuses an open bead — `done` IS the completion, so
// the lifecycle closes the anchor request first (never --force: the
// close is the honest record, force would release the dep on work the
// store still calls open)
function shipCapability(anchor: string, dir: string, thread: string): void {
  let bead: { id: string; labels?: string[]; status?: string } | undefined
  try {
    bead = anchorStore(anchor, dir).get<{ id: string; labels?: string[]; status?: string }>(thread)
  } catch (e) {
    console.error(
      `! result posted but the anchor bead could not be read — capability NOT shipped ` +
        `(${e instanceof Error ? e.message : String(e)})`
    )
    return
  }
  if (bead?.labels?.includes(`export:${thread}`) !== true) {
    return
  }
  try {
    if (bead.status !== 'closed') {
      bdAnchor(anchor, dir, ['close', thread])
    }
    bdAnchor(anchor, dir, ['ship', thread])
  } catch {
    console.error(
      `! result posted but capability not shipped — close the request bead, then \`bd -C ${anchor} ship ${thread}\``
    )
  }
}

/** bd on the anchor store — pinned `bdAt` for foreign checkouts, the
 *  ambient-env `bd` for our own (the pin contract: own-store env is
 *  the caller's contract, a stale worktree `.beads` must not win). */
function bdAnchor(anchor: string, dir: string, args: string[]): void {
  if (anchor !== dir) {
    const r = bdAt(join(anchor, '.beads'), args)
    if (r.code !== 0 || !r.ran) {
      throw new Error(r.err || 'bd unreachable')
    }
    return
  }
  bd(args, anchor)
}

/** Github side of the remote write — the envelope rides an issue
 *  comment on the thread's issue; the bound peer is what the far
 *  side provenance-checks against, so a missing binding warns. */
function ghLifecycle(ctx: {
  peers: MeshPeer[]
  thread: string
  repo: { owner: string; repo: string }
  env: MeshEnvelope
}): string | undefined {
  const peer = ctx.peers.find((p) => {
    const r = parseGithubRemote({ remote: p.remote })
    return p.transport === 'github' && r?.owner === ctx.repo.owner && r?.repo === ctx.repo.repo
  })
  if (peer === undefined) {
    console.error(
      `! ${ctx.repo.owner}/${ctx.repo.repo}: no github peer binding — the far side can't provenance-check this record`
    )
  }
  return postComment({ thread: ctx.thread, env: ctx.env }).error
}

/** Wasteland side of the remote write — the matching `wl` move on
 *  the board the request's record arrived over (first binding only
 *  as fallback). */
function wlLifecycle(ctx: {
  kind: MeshKind
  wl: string
  peers: MeshPeer[]
  requestPeer?: MeshPeer
  evidence?: MeshRef[]
  body?: string
}): string | undefined {
  const wlPeer =
    ctx.requestPeer?.transport === 'wasteland'
      ? ctx.requestPeer
      : ctx.peers.find((p) => p.transport === 'wasteland')
  if (wlPeer === undefined) {
    console.error('! no wasteland peer binding — writing to the default commons')
  }
  const t = { remote: wlPeer?.remote ?? '', id: ctx.wl }
  if (ctx.kind === 'claim') {
    return claimWanted(t).error
  }
  if (ctx.kind === 'result') {
    return completeWanted({ ...t, evidence: ctx.evidence }).error
  }
  return ctx.kind === 'accept' ? acceptWanted(t).error : rejectWanted({ ...t, body: ctx.body }).error
}

/** The remote leg's plumbing in one record — callers build it once,
 *  the transport branches read fields off it. */
interface RemoteCtx {
  dir: string
  kind: MeshKind
  rig: string
  state: ReturnType<typeof meshThread>
  thread: string
  to: string
  peers: MeshPeer[]
  rest: string[]
}

/** The remote envelope — id/thread name the remote plane's record,
 *  title/body/evidence inherit the verb's flags. */
function remoteEnv(ctx: {
  kind: MeshKind
  rig: string
  to: string
  remoteThread: string
  title?: string
  body?: string
  evidence?: MeshRef[]
}): MeshEnvelope {
  return {
    v: MESH_VERSION,
    id: `${ctx.remoteThread}#${ctx.kind}`,
    kind: ctx.kind,
    thread: ctx.remoteThread,
    from: ctx.rig,
    to: ctx.to,
    title: `${ctx.kind === 'result' ? 'result' : ctx.kind}: ${ctx.title}`,
    body: ctx.body ?? '',
    refs: [],
    terms: {},
    evidence: ctx.evidence ?? [],
  }
}

/** Everything a remote write needs — the caller's plumbing plus the
 *  verb flags and the envelope it just built. */
interface RemoteWrite {
  ctx: RemoteCtx
  plane: { gh?: string; wl?: string }
  env: MeshEnvelope
  evidence?: MeshRef[]
  body?: string
}

/** The transport write — github takes precedence when the thread has
 *  both planes. Exits 1 on a remote error, before any mirror. */
function writeRemote(w: RemoteWrite): void {
  const { ctx, plane, env, evidence, body } = w
  const ghRepo = plane.gh === undefined ? null : issueKey({ thread: plane.gh }).repo
  let remoteErr: string | undefined
  if (plane.gh !== undefined && ghRepo !== null) {
    remoteErr = ghLifecycle({ peers: ctx.peers, thread: plane.gh, repo: ghRepo, env })
  } else if (plane.wl !== undefined) {
    remoteErr = wlLifecycle({
      kind: ctx.kind,
      wl: plane.wl,
      peers: ctx.peers,
      requestPeer: ctx.state.requestPeer,
      evidence,
      body,
    })
  }
  if (remoteErr !== undefined) {
    console.error(`error: ${remoteErr}`)
    process.exit(1)
  }
}

/** Own-store mirror of the remote write — the beads-side alias
 *  anchors it into the same reduction. */
function mirrorRemote(w: RemoteWrite): void {
  const { ctx, plane, env, evidence, body } = w
  const anchorThread = ctx.state.threads.find((t) => t !== plane.gh && t !== plane.wl) ?? ctx.thread
  const mirror = postEnvelope({
    dir: ctx.dir,
    kind: ctx.kind,
    thread: anchorThread,
    from: ctx.rig,
    to: ctx.to,
    title: env.title,
    body,
    evidence,
  })
  if (mirror.error !== undefined) {
    console.error(`! remote record posted but the mirror bead failed: ${mirror.error}`)
  }
  console.log(
    `${ctx.kind} → ${env.thread}${mirror.id !== undefined ? ` (mirror ${mirror.id})` : ''}`
  )
}

function postRemote(ctx: RemoteCtx, plane: { gh?: string; wl?: string }): void {
  const { kind, rig, state, to, rest } = ctx
  const evidence = kind === 'result' ? parseRefs(rest, '--ev') : undefined
  const body = flagValue(rest, '--body')
  const env = remoteEnv({
    kind,
    rig,
    to,
    remoteThread: plane.gh ?? plane.wl ?? '',
    title: state.request?.title,
    body,
    evidence,
  })
  writeRemote({ ctx, plane, env, evidence, body })
  mirrorRemote({ ctx, plane, env, evidence, body })
}

/** Remote planes (specs/cross-repo/bro-kim1e) — the record lands on
 *  the transport's own channel: an issue comment carrying the
 *  envelope on github, the matching `wl` move on wasteland. A mirror
 *  bead still lands in OUR store so the local reduction keeps a
 *  complete record of what we wrote. Returns false when the thread
 *  anchors on no remote plane — the caller runs the store leg. */
function remoteLifecycle(ctx: RemoteCtx): boolean {
  const plane = {
    gh: ctx.state.threads.find((t) => issueKey({ thread: t }).repo !== null),
    wl: ctx.state.threads.find((t) => /^w-\w+$/i.test(t)),
  }
  if (plane.gh === undefined && plane.wl === undefined) {
    return false
  }
  postRemote(ctx, plane)
  return true
}

function cmdLifecycle(dir: string, kind: MeshKind, args: string[]): void {
  const [thread, ...rest] = args
  if (thread === undefined) {
    console.error(`usage: bro mesh ${kind === 'result' ? 'done' : kind} <thread>`)
    process.exit(2)
  }
  const { rig, state } = threadAnchor(dir, thread, !args.includes('--no-pull'))
  const peers = meshPeers(dir)
  const request = state.request
  if (request === undefined) {
    console.error(`error: no request for thread "${thread}" — not in own store or any peer replica`)
    process.exit(2)
  }
  const to = lifecycleTarget(kind, rig, state, thread)
  if (remoteLifecycle({ dir, kind, rig, state, thread, to, peers, rest })) {
    return
  }

  const anchor = resolveAnchor(dir, state, thread)

  const posted = postEnvelope({
    dir: anchor,
    pinStore: anchor !== dir,
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

  if (kind === 'result') {
    shipCapability(anchor, dir, thread)
  }
}

function cmdWait(dir: string, args: string[]): void {
  const [thread] = args
  if (thread === undefined) {
    console.error('usage: bro mesh wait <thread> [--json] [--no-pull]')
    process.exit(2)
  }
  const { common, peers } = commonSetup(dir)
  const state = meshThread(dir, peers, thread, { gitCommon: common, pull: !args.includes('--no-pull') })
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
  if (verb !== undefined && hasHelpFlag(rest)) {
    printUsage(USAGE, 0)
  }
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
  printUsage(
    USAGE,
    verb === undefined || verb === 'help' || verb === '--help' || verb === '-h' ? 0 : 2,
  )
}
