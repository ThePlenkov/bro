/**
 * dolt-remote git bridge (spec: specs/bro-wxgt3.md) — `bd sync` dead-ends
 * whenever its remote needs real-git auth: dolt's go-git transport cannot
 * run credential helpers, read `~/.git-credentials`, use ssh-agent, or
 * prompt — so `git+https`/`git+ssh` remotes fail `failed to get remote db`
 * in every environment that isn't a desktop session.
 *
 * The bridge keeps auth entirely in the user's git layer: each git-scheme
 * dolt remote is repointed at a managed local bare mirror
 * (`<beads>/dolt-mirror-<name>.git` → `git+file://…`), and `bd sync` gets
 * wrapped in `git fetch`/`git push` legs over the mirror's `origin` —
 * real git carries `refs/dolt/*` and `refs/heads/__dolt_remote_info__`
 * across the wire dolt itself cannot authenticate.
 *
 * Everything degrades to today's behavior: bridge legs are best-effort
 * (a failed fetch still lets `bd sync` reconcile the local mirror), and
 * provisioning failure leaves the remote untouched — `bd sync` then
 * fails exactly as it did before the bridge existed.
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gitTry } from './git.ts'

/** The bd run signature the TaskStore threads through — tests inject
 *  scripted answers; git calls are real (mirrors live under tmp dirs). */
export interface BdProbe {
  (args: string[], ms: number): { code: number; out: string; err: string }
}

export interface DoltRemote {
  name: string
  url: string
}

/** One bridged remote: the dolt-side name, the local bare repo dolt
 *  talks to, and the upstream git URL real git relays it to. */
export interface DoltBridge {
  remote: string
  mirror: string
  upstream: string
}

/** What `bd sync` should look like this cycle. `args` extends the bare
 *  invocation (`[]` = let bd pick/adopt its default); `bridges` are the
 *  mirrors to refresh beforehand and publish afterward; `notes` are
 *  provisioning/degradation lines the caller merges into its output. */
export interface DoltSyncPlan {
  args: string[]
  bridges: DoltBridge[]
  notes: string[]
}

const PROBE_MS = 15_000
const GIT_NET_MS = 60_000

/** The namespaces dolt publishes on a git remote — the data refs plus
 *  its remote bookkeeping branch. Enumerated per leg (ls-remote /
 *  for-each-ref) rather than globbed: an explicit refspec for a ref the
 *  other side lacks fails the whole command. ls-remote patterns are
 *  tail-matched globs; for-each-ref takes prefixes. */
const LS_REMOTE_PATTERNS = ['refs/dolt/*', 'refs/heads/__dolt_remote_info__']
const LOCAL_REF_PATTERNS = ['refs/dolt/', 'refs/heads/__dolt_remote_info__']

/** `bd dolt remote list` — `--json` first, the padded `name  url` text
 *  form as fallback. null when bd can't answer at all (pre-dolt bd):
 *  callers degrade to the bare `bd sync` they already had. */
export function listDoltRemotes(probe: BdProbe): DoltRemote[] | null {
  const j = probe(['dolt', 'remote', 'list', '--json'], PROBE_MS)
  if (j.code === 0) {
    try {
      const rows = JSON.parse(j.out) as unknown
      if (Array.isArray(rows)) {
        return rows
          .map((r) => r as { name?: unknown; url?: unknown })
          .filter(
            (r): r is { name: string; url: string } =>
              typeof r.name === 'string' && typeof r.url === 'string' && r.name !== '' && r.url !== ''
          )
          .map((r) => ({ name: r.name, url: r.url }))
      }
    } catch {
      // fall through to the text parse
    }
  }
  const t = probe(['dolt', 'remote', 'list'], PROBE_MS)
  if (t.code !== 0) {
    return null
  }
  const remotes: DoltRemote[] = []
  for (const line of t.out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s*$/.exec(line)
    if (m !== null) {
      remotes.push({ name: m[1]!, url: m[2]! })
    }
  }
  return remotes
}

/** The upstream git URL a remote URL hides, when its scheme needs
 *  real-git auth — the `git+` prefix stripped. `git+file`, `file`,
 *  local paths and dolt-native schemes answer null (reachable as-is). */
export function gitUpstream(remoteUrl: string): string | null {
  const inner = remoteUrl.startsWith('git+') ? remoteUrl.slice(4) : remoteUrl
  if (/^(https?|ssh|git):\/\//i.test(inner)) {
    return inner
  }
  // scp-like ssh — git@host:org/repo
  if (/^[\w.%+-]+@[\w.-]+:/.test(inner)) {
    return inner
  }
  return null
}

/** A `git+file://`/`file://`/plain-path remote target as an fs path,
 *  or null when the URL isn't file-shaped. */
export function fileTargetPath(remoteUrl: string): string | null {
  const inner = remoteUrl.startsWith('git+') ? remoteUrl.slice(4) : remoteUrl
  try {
    if (inner.startsWith('file://')) {
      return fileURLToPath(inner)
    }
  } catch {
    return null
  }
  return isAbsolute(inner) ? inner : null
}

/** A file-remote target counts as bridged when it is a bare git repo
 *  carrying an `origin` remote — the hand-rolled evac mirror becomes
 *  the managed shape without repointing. A plain directory (or a
 *  working checkout — never bare) stays a local remote. */
function mirrorUpstream(mirror: string): string | null {
  if (!existsSync(join(mirror, 'HEAD'))) {
    return null
  }
  const bare = gitTry(['-C', mirror, 'rev-parse', '--is-bare-repository'], PROBE_MS)
  if (bare.code !== 0 || bare.out.trim() !== 'true') {
    return null
  }
  const origin = gitTry(['-C', mirror, 'remote', 'get-url', 'origin'], PROBE_MS)
  return origin.code === 0 && origin.out.trim() !== '' ? origin.out.trim() : null
}

const safeName = (name: string): string => name.replace(/[^\w.-]/g, '_')

/** Redact embedded userinfo before a URL lands in sync output — the
 *  remote needs the raw URL, notes and warnings do not. */
const displayUrl = (u: string): string => u.replace(/^([\w+.-]+:\/\/)[^@/\s]+@/, '$1***@')

export function mirrorPathFor(beadsDir: string, remoteName: string): string {
  return join(beadsDir, `dolt-mirror-${safeName(remoteName)}.git`)
}

const fileUrl = (p: string): string => `git+${pathToFileURL(p).href}`

/** Bare-init the mirror and pin its `origin` to the upstream URL —
 *  idempotent; a drifted URL is set-url'd back. */
function ensureMirror(mirror: string, upstream: string): string | null {
  if (!existsSync(join(mirror, 'HEAD'))) {
    const init = gitTry(['init', '--bare', '-q', mirror], PROBE_MS)
    if (init.code !== 0) {
      return init.err || `git init exited ${init.code}`
    }
  }
  const cur = gitTry(['-C', mirror, 'remote', 'get-url', 'origin'], PROBE_MS)
  if (cur.code === 0 && cur.out.trim() === upstream) {
    return null
  }
  const r =
    cur.code === 0
      ? gitTry(['-C', mirror, 'remote', 'set-url', 'origin', upstream], PROBE_MS)
      : gitTry(['-C', mirror, 'remote', 'add', 'origin', upstream], PROBE_MS)
  return r.code === 0 ? null : r.err || `git remote exited ${r.code}`
}

/** Point the dolt remote at the mirror's `git+file://` URL — remove+add
 *  (bd offers no set-url). The remote name is preserved: it is the
 *  default-remote name every other consumer already uses. A failed
 *  remove is not fatal — the adoption path adds a remote that was never
 *  there, and a stale entry surfaces on the add anyway. */
function repointRemote(probe: BdProbe, name: string, url: string): string | null {
  probe(['dolt', 'remote', 'remove', name], PROBE_MS)
  const add = probe(['dolt', 'remote', 'add', name, url], PROBE_MS)
  return add.code === 0 ? null : `dolt remote add ${name}: ${add.err || add.out || `exit ${add.code}`}`
}

/** The store's real `.beads` dir — `bd where` answers it regardless of
 *  the caller's checkout (linked worktrees share the store through the
 *  git common dir). `hint` is the caller's guessed `.beads` path. */
function storePath(probe: BdProbe, hint?: string): string | undefined {
  const w = probe(['where', '--json'], PROBE_MS)
  if (w.code === 0) {
    try {
      const path = (JSON.parse(w.out) as { path?: unknown }).path
      if (typeof path === 'string' && path !== '') {
        return path
      }
    } catch {
      // non-json where — use the hint
    }
  }
  return hint !== undefined && existsSync(hint) ? hint : undefined
}

/** Provision one remote's bridge when it needs one. Returns the bridge
 *  (existing mirrors are honored in place), or null for remotes dolt
 *  reaches natively — and for git-scheme remotes whose provisioning
 *  failed (left untouched: the sync error they produce is today's). */
function bridgeFor(
  probe: BdProbe,
  remote: DoltRemote,
  beadsDir: string | undefined,
  notes: string[]
): DoltBridge | null {
  const upstream = gitUpstream(remote.url)
  if (upstream !== null) {
    if (beadsDir === undefined) {
      notes.push(`warning: cannot bridge ${remote.name} — store dir unresolvable`)
      return null
    }
    const mirror = mirrorPathFor(beadsDir, remote.name)
    const err = ensureMirror(mirror, upstream) ?? repointRemote(probe, remote.name, fileUrl(mirror))
    if (err !== null) {
      notes.push(`warning: cannot bridge ${remote.name} — ${err}`)
      return null
    }
    notes.push(`bridge: repointed ${remote.name} → ${fileUrl(mirror)} (upstream ${displayUrl(upstream)})`)
    return { remote: remote.name, mirror, upstream }
  }
  const target = fileTargetPath(remote.url)
  if (target !== null) {
    const up = mirrorUpstream(target)
    if (up !== null) {
      return { remote: remote.name, mirror: target, upstream: up }
    }
  }
  return null
}

/** Resolve what `bd sync` should run this cycle. Remote inspection or
 *  store-dir resolution failure degrades to the bare invocation — the
 *  pre-bridge behavior, never worse. */
export function doltSyncPlan(probe: BdProbe, beadsDirHint?: string): DoltSyncPlan {
  const plan: DoltSyncPlan = { args: [], bridges: [], notes: [] }
  const remotes = listDoltRemotes(probe)
  if (remotes === null) {
    return plan // bd can't enumerate remotes — bare sync, as today
  }
  const beadsDir = storePath(probe, beadsDirHint)
  const bridges = new Map<string, DoltBridge>()
  for (const r of remotes) {
    const b = bridgeFor(probe, r, beadsDir, plan.notes)
    if (b !== null) {
      bridges.set(r.name, b)
    }
  }
  if (remotes.length === 0) {
    // bd's adoption would clone git origin into a dead git+https remote —
    // adopt through the bridge instead so first sync works
    if (beadsDir !== undefined) {
      const origin = gitTry(['-C', dirname(beadsDir), 'remote', 'get-url', 'origin'], PROBE_MS)
      const upstream = origin.code === 0 ? gitUpstream(origin.out.trim()) : null
      if (upstream !== null) {
        const adopted = bridgeFor(probe, { name: 'origin', url: `git+${upstream}` }, beadsDir, plan.notes)
        if (adopted !== null) {
          plan.args = ['--remote', 'origin']
          plan.bridges.push(adopted)
        }
      }
    }
    return plan
  }
  const def =
    remotes.find((r) => r.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : undefined)
  if (def === undefined) {
    // several remotes, none the conventional default — bd picks; every
    // bridged remote still gets its mirror legs
    plan.bridges.push(...bridges.values())
    return plan
  }
  plan.args = ['--remote', def.name]
  const b = bridges.get(def.name)
  if (b !== null && b !== undefined) {
    plan.bridges.push(b)
  }
  return plan
}

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim() !== '')?.trim() ?? s

/** Refresh the mirror from upstream — forced updates (the mirror's
 *  copy is a rendezvous pointer a local publish may have moved ahead
 *  of upstream; non-force fetch would refuse to restore upstream's
 *  view before the next merge). Best-effort: a failed leg (offline,
 *  auth, transient) leaves `bd sync` reconciling the mirror's last
 *  state — still better than no sync. Returns the error line, or null
 *  on success / nothing upstream yet. */
export function bridgeFetch(bridge: DoltBridge): string | null {
  const refs = gitTry(
    ['-C', bridge.mirror, 'ls-remote', 'origin', ...LS_REMOTE_PATTERNS],
    GIT_NET_MS
  )
  if (refs.code !== 0) {
    return firstLine(refs.err || `exit ${refs.code}`)
  }
  const names = refs.out
    .split('\n')
    .map((l) => l.split(/\s+/)[1]?.trim() ?? '')
    .filter((l) => l !== '')
  if (names.length === 0) {
    return null
  }
  const r = gitTry(
    ['-C', bridge.mirror, 'fetch', '--force', '--no-tags', 'origin', ...names.map((n) => `+${n}:${n}`)],
    GIT_NET_MS
  )
  return r.code === 0 ? null : firstLine(r.err || `exit ${r.code}`)
}

/** Publish the mirror's dolt refs upstream — never forced (a non-ff
 *  rejection means another replica won; the state stays in the dolt
 *  store and re-merges next cycle). Only refs that exist are pushed.
 *  Returns the error line, or null on success / nothing to send. */
export function bridgePublish(bridge: DoltBridge): string | null {
  const refs = gitTry(
    ['-C', bridge.mirror, 'for-each-ref', '--format=%(refname)', ...LOCAL_REF_PATTERNS],
    PROBE_MS
  )
  if (refs.code !== 0) {
    return firstLine(refs.err || `exit ${refs.code}`)
  }
  const names = refs.out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (names.length === 0) {
    return null
  }
  const r = gitTry(['-C', bridge.mirror, 'push', 'origin', ...names.map((n) => `${n}:${n}`)], GIT_NET_MS)
  return r.code === 0 ? null : firstLine(r.err || `exit ${r.code}`)
}
