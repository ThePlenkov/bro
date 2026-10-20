/**
 * `bro request` mechanics — the same-machine delivery path
 * (specs/cross-repo/bro-oam4). A target resolves in order: peer
 * alias → mesh:// URI → explicit path → local-peer remote basename →
 * sibling checkout. Resolution to a live checkout means the request
 * is DELIVERED — `bd create` writes the envelope bead into the
 * target's own store, pinned with `export:<id>` so the worker's
 * `bd ship` releases the requester's `external:<rig>:<id>` dep.
 * Everything else is the plain own-store post (`bro mesh request`).
 *
 * Sovereignty: same-machine checkouts are a shared trust domain —
 * the writer provably has filesystem access already; only envelope
 * beads are written, never code/branches/config.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { withFileLock } from '@broject/core'
import {
  formatRigUri,
  parseRigDescriptor,
  parseRigUri,
  selfRig,
} from './identity.ts'
import { localCheckout, type MeshPeer } from './peers.ts'
import { postEnvelope, type PostInput } from './post.ts'

export interface ResolvedTarget {
  /** the rig the envelope's `to` names */
  rig: string
  /** live checkout when delivery applies — absent → own-store post */
  checkout?: string
  /** the binding the target resolved through (alias/basename case) */
  peer?: MeshPeer
  /** advisory — .bro-rig.json disagrees with the resolved rig */
  rigWarning?: string
}

export interface ResolveResult {
  target?: ResolvedTarget
  /** a bare `<name>` matched several `name--*` siblings — caller
   *  lists them verbatim and exits 2 */
  ambiguous?: string[]
  error?: string
}

/** Does `path` name a beads-backed checkout? */
function isCheckout(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory() && existsSync(join(path, '.beads'))
}

function targetForCheckout(checkout: string, peer?: MeshPeer): ResolvedTarget | { error: string } {
  const rig = selfRig(checkout)
  if (rig === null) {
    return {
      error:
        `target rig is unaddressed: no mesh.rig pin in ${checkout}/bro.config.json ` +
        'and origin is not a forge url — set "mesh": { "rig": "mesh://<org>/<repo>" } there',
    }
  }
  const t: ResolvedTarget = { rig, checkout, peer }
  const descriptorPath = join(checkout, '.bro-rig.json')
  if (existsSync(descriptorPath)) {
    try {
      const descriptor = parseRigDescriptor(
        JSON.parse(readFileSync(descriptorPath, 'utf8')) as unknown,
      )
      if (descriptor !== null && descriptor.rig !== rig) {
        t.rigWarning = `.bro-rig.json declares ${descriptor.rig} but the rig resolves to ${rig} — addressing ${rig}`
      }
    } catch {
      // a malformed descriptor is a discovery-hint failure — advisory only
    }
  }
  return t
}

function wrap(t: ResolvedTarget | { error: string }): ResolveResult {
  return 'error' in t ? { error: t.error } : { target: t }
}

function localCheckoutTarget(peer: MeshPeer, arg: string): ResolveResult {
  const checkout = localCheckout(peer.remote)
  if (checkout === null) {
    return { error: `peer "${arg}" checkout ${peer.remote} does not resolve` }
  }
  return wrap(targetForCheckout(checkout, peer))
}

function resolveAlias(arg: string, peers: MeshPeer[]): ResolveResult | null {
  const byAlias = peers.find((p) => p.alias === arg)
  if (byAlias === undefined) {
    return null
  }
  if (byAlias.transport !== 'local') {
    return { target: { rig: byAlias.rig, peer: byAlias } }
  }
  return localCheckoutTarget(byAlias, arg)
}

function resolveUri(arg: string): ResolveResult | null {
  const uri = parseRigUri(arg)
  return uri === null ? null : { target: { rig: formatRigUri(uri) } }
}

function resolveExplicit(dir: string, arg: string): ResolveResult | null {
  const explicit =
    arg.includes('/') || arg === '.' || arg === '..' || arg.startsWith('./') || arg.startsWith('../')
  if (!explicit) {
    return null
  }
  const path = isAbsolute(arg) ? arg : resolve(dir, arg)
  if (!isCheckout(path)) {
    return { error: `${arg} is not a beads checkout (no .beads/ under ${path})` }
  }
  return wrap(targetForCheckout(path))
}

function resolveBasename(arg: string, peers: MeshPeer[]): ResolveResult | null {
  const byName = peers.find(
    (p) => p.transport === 'local' && basename(localCheckout(p.remote) ?? p.remote) === arg,
  )
  return byName === undefined ? null : localCheckoutTarget(byName, byName.alias)
}

function unresolved(arg: string): ResolveResult {
  return {
    error:
      `cannot resolve "${arg}" — no peer alias, mesh:// uri, checkout path, ` +
      'or sibling checkout matches (see `bro mesh peers list`)',
  }
}

function resolveSibling(dir: string, arg: string): ResolveResult {
  const parent = dirname(dir)
  if (parent === dir) {
    return unresolved(arg)
  }
  let siblings: string[] = []
  try {
    siblings = readdirSync(parent)
  } catch {
    siblings = []
  }
  const bare = join(parent, arg)
  if (siblings.includes(arg) && isCheckout(bare)) {
    return wrap(targetForCheckout(bare))
  }
  const candidates = siblings
    .filter((s) => s.startsWith(`${arg}--`))
    .map((s) => join(parent, s))
    .filter(isCheckout)
  if (candidates.length > 1) {
    return { ambiguous: candidates }
  }
  return candidates.length === 1 ? wrap(targetForCheckout(candidates[0]!)) : unresolved(arg)
}

/** Resolve `<repo-or-alias>` against bindings, then the filesystem —
 *  the spec order: alias → URI → path → peer-remote basename →
 *  sibling checkouts. */
export function resolveTarget(dir: string, arg: string, peers: MeshPeer[]): ResolveResult {
  return (
    resolveAlias(arg, peers) ??
    resolveUri(arg) ??
    resolveExplicit(dir, arg) ??
    resolveBasename(arg, peers) ??
    resolveSibling(dir, arg)
  )
}

/** Deliver a request envelope INTO the target checkout's store —
 *  same fields as a posted envelope plus `export:<id>` (bd's
 *  capability marker — the worker's `bd ship` turns it into the
 *  `provides:<id>` a dep-resolving bd waits on). The external_ref
 *  names the TARGET rig: the bead lives there. */
export function deliverRequest(
  checkout: string,
  input: Omit<PostInput, 'dir' | 'kind' | 'thread' | 'beadRig' | 'extraLabels' | 'pinStore'>,
): { id?: string; error?: string } {
  return postEnvelope({
    dir: checkout,
    pinStore: true,
    ...input,
    kind: 'request',
    thread: '',
    beadRig: input.to,
    extraLabels: ['export:{id}'],
  })
}

export interface MeshConfigFile {
  mesh?: {
    rig?: string
    peers?: Record<string, { rig: string; remote: string; transport?: string; login?: string }>
  }
  [k: string]: unknown
}

/** Mutate `bro.config.json` under a file lock. Two refusals: a TS
 *  config shadows anything we would write (edit `mesh.peers` there
 *  instead), and a malformed file must not be silently overwritten —
 *  the error propagates and the command exits non-zero. */
export function withMeshConfig<T>(dir: string, mutate: (cfg: MeshConfigFile) => T): T {
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
    const tmp = join(dir, `.bro.config.json.tmp.${process.pid}`)
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`)
    renameSync(tmp, path)
    return out
  })
}

/** Upsert `mesh.peers[<alias>] = { rig, remote: <checkout> }` for a
 *  delivered target — the binding is what makes `bro mesh wait`,
 *  `inbox`, and the anchor store reachable later. An alias already
 *  bound, or a binding already naming this checkout, is left
 *  untouched. */
export function ensurePeerBinding(
  dir: string,
  alias: string,
  rig: string,
  checkout: string,
): { added: boolean; error?: string; note?: string } {
  try {
    // the whole check-and-set rides inside the file lock — reading
    // outside it would let two invocations both pass the guard and a
    // second alias bind the same checkout twice
    return withMeshConfig(dir, (cfg) => {
      const peers = { ...cfg.mesh?.peers }
      const existing = peers[alias]
      if (existing !== undefined) {
        // idempotent only when the alias already names THIS checkout —
        // an alias bound elsewhere is a conflict the caller must name
        return localCheckout(existing.remote) === checkout
          ? { added: false }
          : { added: false, error: `peer "${alias}" is already bound to ${existing.remote}` }
      }
      const boundTo = Object.entries(peers).find(
        ([, p]) => localCheckout(p.remote) === checkout
      )?.[0]
      if (boundTo !== undefined) {
        // reachable already — `mesh wait`/inbox resolve through the
        // existing alias; the caller still hears which name holds it
        return { added: false, note: `peer "${boundTo}" already binds ${checkout}` }
      }
      peers[alias] = { rig, remote: checkout }
      cfg.mesh = { ...cfg.mesh, peers }
      return { added: true }
    })
  } catch (e) {
    return { added: false, error: e instanceof Error ? e.message : String(e) }
  }
}
