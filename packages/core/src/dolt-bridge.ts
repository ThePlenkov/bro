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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** Redact embedded userinfo and query/fragment before a URL lands in
 *  sync output — the remote needs the raw URL, notes and warnings do
 *  not, and credentials also hide in `?token=`/`#…` tails. Global
 *  because git/bd stderr embeds the failing URL mid-line, not at
 *  offset 0. */
export const displayUrl = (u: string): string =>
  u
    .replace(/(:\/\/)[^@/\s]+@/g, '$1***@')
    .replace(/(:\/\/[^\s?#]*)[?#][^\s]*/g, '$1…')

/** A remote source reaching a git argv must not parse as an option —
 *  `-`-leading input is rejected outright (`--upload-pack=<cmd>` in a
 *  "url" slot runs arbitrary code). Sources here are URLs or absolute
 *  paths, so a leading dash is never legitimate input. */
const argvSafe = (s: string): boolean => s !== '' && !s.startsWith('-')

export function mirrorPathFor(beadsDir: string, remoteName: string): string {
  return join(beadsDir, `dolt-mirror-${safeName(remoteName)}.git`)
}

const fileUrl = (p: string): string => `git+${pathToFileURL(p).href}`

/** Bare-init the mirror and pin its `origin` to the upstream URL —
 *  idempotent; a drifted URL is set-url'd back. */
function ensureMirror(mirror: string, upstream: string): string | null {
  if (!argvSafe(upstream)) {
    return `option-shaped upstream refused: ${displayUrl(upstream)}`
  }
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
      ? gitTry(['-C', mirror, 'remote', 'set-url', 'origin', '--', upstream], PROBE_MS)
      : gitTry(['-C', mirror, 'remote', 'add', 'origin', '--', upstream], PROBE_MS)
  return r.code === 0 ? null : r.err || `git remote exited ${r.code}`
}

/** Point the dolt remote at the mirror's `git+file://` URL — remove+add
 *  (bd offers no set-url). The remote name is preserved: it is the
 *  default-remote name every other consumer already uses. A failed
 *  remove is not fatal — the adoption path adds a remote that was never
 *  there, and a stale entry surfaces on the add anyway. A failed add
 *  after a successful remove re-adds `original` — provisioning failure
 *  leaves the remote as found, not deleted. */
function repointRemote(
  probe: BdProbe,
  name: string,
  url: string,
  original?: string
): string | null {
  const rm = probe(['dolt', 'remote', 'remove', name], PROBE_MS)
  const add = probe(['dolt', 'remote', 'add', name, url], PROBE_MS)
  if (add.code === 0) {
    return null
  }
  const why = add.err || add.out || `exit ${add.code}`
  const err = `dolt remote add ${name}: ${displayUrl(why)}`
  if (rm.code === 0 && original !== undefined) {
    const back = probe(['dolt', 'remote', 'add', name, original], PROBE_MS)
    if (back.code !== 0) {
      return `${err}; restore of the original remote failed too — ${name} is left removed`
    }
  }
  return err
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
    const err =
      ensureMirror(mirror, upstream) ??
      repointRemote(probe, remote.name, fileUrl(mirror), remote.url)
    if (err !== null) {
      notes.push(`warning: cannot bridge ${remote.name} — ${displayUrl(err)}`)
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

/** Zero-remote adoption: bd's own adoption would clone git `origin`
 *  into a dead git+https remote — provision a mirror and an `origin`
 *  dolt remote through the bridge instead, so first sync works. */
function adoptOrigin(
  probe: BdProbe,
  beadsDir: string | undefined,
  notes: string[]
): DoltBridge | null {
  if (beadsDir === undefined) {
    return null
  }
  const origin = gitTry(['-C', dirname(beadsDir), 'remote', 'get-url', 'origin'], PROBE_MS)
  const upstream = origin.code === 0 ? gitUpstream(origin.out.trim()) : null
  if (upstream === null) {
    return null
  }
  return bridgeFor(probe, { name: 'origin', url: `git+${upstream}` }, beadsDir, notes)
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
    const adopted = adoptOrigin(probe, beadsDir, plan.notes)
    if (adopted !== null) {
      plan.args = ['--remote', 'origin']
      plan.bridges.push(adopted)
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
  if (b !== undefined) {
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
    return displayUrl(firstLine(refs.err || `exit ${refs.code}`))
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
  return r.code === 0 ? null : displayUrl(firstLine(r.err || `exit ${r.code}`))
}

/** Publish the mirror's dolt refs upstream — never forced (a non-ff
 *  rejection means another replica won; the state stays in the dolt
 *  store and re-merges next cycle). Only refs that exist are pushed.
 *  `pin` binds a ref's push source to an already-validated sha — a
 *  concurrent sync can move the ref between the health check and this
 *  publish, and the unpinned form would ship the unchecked replacement.
 *  Returns the error line, or null on success / nothing to send. */
export function bridgePublish(
  bridge: DoltBridge,
  opts?: { pin?: ReadonlyMap<string, string> }
): string | null {
  const refs = gitTry(
    ['-C', bridge.mirror, 'for-each-ref', '--format=%(refname)', ...LOCAL_REF_PATTERNS],
    PROBE_MS
  )
  if (refs.code !== 0) {
    return displayUrl(firstLine(refs.err || `exit ${refs.code}`))
  }
  const names = refs.out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (names.length === 0) {
    return null
  }
  const r = gitTry(
    ['-C', bridge.mirror, 'push', 'origin', ...names.map((n) => `${opts?.pin?.get(n) ?? n}:${n}`)],
    GIT_NET_MS
  )
  return r.code === 0 ? null : displayUrl(firstLine(r.err || `exit ${r.code}`))
}

// --- manifest integrity (spec: specs/bro-orcdv.md) -------------------------
// A dolt git remote publishes the noms store as a flat tree under
// refs/dolt/data — a `manifest` file plus one file per table, named by
// hash (archive tables carry a `.darc` suffix). Dolt's git push path can
// write a manifest naming tables it never uploaded: that head boots no
// replica — `bd bootstrap` dies 'Blob not found'. Observed 2026-10-16 on
// this repo's own origin (head 67b62f4 listed b9rv3prlplb1q1oqh06aevausvdnccgv,
// absent from the tree; kept under refs/dolt/backup/67b62f4). These probes
// read the tree real git already fetched — the mirror post-push, or a
// scratch repo's FETCH_HEAD in doctor.

export const DOLT_DATA_REF = 'refs/dolt/data'

/** Verdict on one dolt store head (git ref or plain noms dir). `missing`
 *  is the corruption signal; `error` means the head can't be verified —
 *  absent ref, unreadable/foreign manifest — never proof of corruption. */
export interface DoltHeadHealth {
  /** resolved head sha — '' for an absent ref or a plain-dir probe */
  head: string
  /** tables the manifest lists — 0 when unreadable */
  tables: number
  /** manifest ids absent from the file set */
  missing: string[]
  /** why the head can't be verified */
  error?: string
}

/** The v5 manifest's table names — `5:__DOLT__:<lock>:<root>:<extra>:`
 *  then name:count pairs (zero pairs is a healthy empty store). Any
 *  other layout throws: an unverifiable format is reported as `error`,
 *  never as corruption. Table names are rendered verbatim by doctor
 *  and sync warnings, so anything outside printable ASCII rejects the
 *  manifest — a hostile remote cannot inject terminal controls through
 *  a `missing` list. */
export function manifestTables(text: string): string[] {
  const f = text.trim().split(':')
  if (f[f.length - 1] === '') {
    f.pop() // tolerate a stray trailing ':' — not the real form
  }
  if (f[0] !== '5' || f[1] !== '__DOLT__' || f.length < 5 || (f.length - 5) % 2 !== 0) {
    throw new Error('unrecognized manifest layout')
  }
  const names = f.slice(5).filter((_, i) => i % 2 === 0)
  if (!names.every((n) => /^[\x21-\x7e]+$/.test(n))) {
    throw new Error('unrecognized manifest layout')
  }
  return names
}

/** Manifest-vs-file-set diff — `<id>` is satisfied by `<id>` or its
 *  `.darc` archive (dolt may upload either form). */
function missingTables(tables: string[], files: Set<string>): string[] {
  return tables.filter((t) => !files.has(t) && !files.has(`${t}.darc`))
}

/** A dolt data ref already local in gitDir — rev-parse + one ls-tree +
 *  the manifest blob. Zero network: sync checks the mirror post-push,
 *  doctor checks FETCH_HEAD after its own fetch. */
export function doltHeadHealth(gitDir: string, ref: string): DoltHeadHealth {
  const head = gitTry(['-C', gitDir, 'rev-parse', '--verify', `${ref}^{commit}`], PROBE_MS)
  if (head.code !== 0) {
    return { head: '', tables: 0, missing: [], error: `no ${ref}` }
  }
  const sha = head.out.trim()
  // default ls-tree form `mode type sha\tname`, NUL-framed — a table
  // name must resolve to a regular file (blob), never a tree/gitlink:
  // a directory carrying the manifest's name is NOT the table file
  const tree = gitTry(['-C', gitDir, 'ls-tree', '-z', sha], PROBE_MS)
  if (tree.code !== 0) {
    return { head: sha, tables: 0, missing: [], error: firstLine(tree.err) || 'ls-tree failed' }
  }
  const man = gitTry(['-C', gitDir, 'show', `${sha}:manifest`], PROBE_MS)
  if (man.code !== 0) {
    return { head: sha, tables: 0, missing: [], error: 'head carries no manifest' }
  }
  let tables: string[]
  try {
    tables = manifestTables(man.out)
  } catch (err) {
    return {
      head: sha,
      tables: 0,
      missing: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const files = new Set(
    tree.out
      .split('\0')
      .filter((l) => /^100(?:644|755) blob /.test(l))
      .map((l) => l.slice(l.indexOf('\t') + 1))
      .filter((l) => l !== '')
  )
  return { head: sha, tables: tables.length, missing: missingTables(tables, files) }
}

/** A file remote pointing at a plain noms dir (manifest at top level,
 *  no git plumbing) — verified on the filesystem, same verdict shape. */
export function doltDirHealth(dir: string): DoltHeadHealth {
  let text: string
  try {
    text = readFileSync(join(dir, 'manifest'), 'utf8')
  } catch {
    return { head: '', tables: 0, missing: [], error: 'no manifest' }
  }
  let tables: string[]
  try {
    tables = manifestTables(text)
  } catch (err) {
    return {
      head: '',
      tables: 0,
      missing: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
  let files: Set<string>
  try {
    files = new Set(
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    )
  } catch {
    return { head: '', tables: tables.length, missing: [], error: `unreadable ${dir}` }
  }
  return { head: '', tables: tables.length, missing: missingTables(tables, files) }
}

/** The nearest ancestor of `from` whose manifest is self-consistent —
 *  the report's last-good head. History must already be local (deepen
 *  first); an unverifiable ancestor is skipped, never trusted. `cap`
 *  bounds the walk. */
export function lastGoodDoltHead(gitDir: string, from: string, cap = 64): string | null {
  const list = gitTry(['-C', gitDir, 'rev-list', from, `--max-count=${cap + 1}`], PROBE_MS)
  if (list.code !== 0) {
    return null
  }
  for (const sha of list.out.split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(1)) {
    const h = doltHeadHealth(gitDir, sha)
    if (h.error === undefined && h.missing.length === 0) {
      return sha
    }
  }
  return null
}

/** Where a dolt remote's data actually lives, fetchable by real git:
 *  the stripped URL for git schemes; for a file-shaped target that is a
 *  bare repo carrying `origin` (the bridge mirror), that upstream —
 *  the mirror's cache is not the truth; else the path itself. null for
 *  non-git schemes (dolthub:, aws:, …). */
export function doltRemoteSrc(remote: DoltRemote): string | null {
  const upstream = gitUpstream(remote.url)
  if (upstream !== null) {
    return upstream
  }
  const target = fileTargetPath(remote.url)
  if (target === null) {
    return null
  }
  return mirrorUpstream(target) ?? target
}

const DOLT_DEEPEN = 64

/** Probe a remote's data ref over real git. `ls-remote` first — no ref
 *  means nothing was published (healthy, nothing to verify); a failure
 *  is transport (offline/auth), surfaced as `error`. The fetch is a
 *  scratch bare repo at `--depth=1 --filter=blob:none` — commit + tree
 *  objects only, the manifest blob lazy-fetches on read — so the check
 *  costs ~1 RTT regardless of store size. On a corrupt head, deepens
 *  and walks ancestors for `lastGood`. */
export function probeDoltRemote(
  src: string,
  opts?: { deepen?: number }
): DoltHeadHealth & { lastGood?: string } {
  if (!argvSafe(src)) {
    return { head: '', tables: 0, missing: [], error: `option-shaped remote source refused: ${displayUrl(src)}` }
  }
  const ls = gitTry(['ls-remote', '--', src, DOLT_DATA_REF], GIT_NET_MS)
  if (ls.code !== 0) {
    return {
      head: '',
      tables: 0,
      missing: [],
      error: displayUrl(firstLine(ls.err)) || `git ls-remote exited ${ls.code}`,
    }
  }
  if (!ls.out.split(/\s+/)[0]?.trim()) {
    return { head: '', tables: 0, missing: [] } // no data ref — nothing published yet
  }
  let scratch: string
  try {
    scratch = mkdtempSync(join(tmpdir(), 'bro-dolt-probe-'))
  } catch (e) {
    // tmpdir gone/unwritable is an unverifiable probe, not a doctor crash
    return {
      head: '',
      tables: 0,
      missing: [],
      error: `mkdtemp: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  try {
    const init = gitTry(['init', '--bare', '-q', scratch], PROBE_MS)
    // a NAMED remote — blob:none lazy fetches need promisor wiring,
    // which exists only as remote.<name>.promisor
    const add = gitTry(['-C', scratch, 'remote', 'add', 'origin', '--', src], PROBE_MS)
    if (init.code !== 0 || add.code !== 0) {
      return {
        head: '',
        tables: 0,
        missing: [],
        error: firstLine(init.err || add.err) || 'scratch repo setup failed',
      }
    }
    gitTry(['-C', scratch, 'config', 'remote.origin.promisor', 'true'], PROBE_MS)
    gitTry(['-C', scratch, 'config', 'remote.origin.partialclonefilter', 'blob:none'], PROBE_MS)
    const f = gitTry(
      ['-C', scratch, 'fetch', '--depth=1', '--filter=blob:none', '--no-tags', 'origin', DOLT_DATA_REF],
      GIT_NET_MS
    )
    if (f.code !== 0) {
      return {
        head: '',
        tables: 0,
        missing: [],
        error: displayUrl(firstLine(f.err)) || `git fetch exited ${f.code}`,
      }
    }
    const health = doltHeadHealth(scratch, 'FETCH_HEAD')
    if (health.missing.length === 0) {
      return health
    }
    const deepen = opts?.deepen ?? DOLT_DEEPEN
    const d = gitTry(
      ['-C', scratch, 'fetch', `--deepen=${deepen}`, '--filter=blob:none', '--no-tags', 'origin', DOLT_DATA_REF],
      GIT_NET_MS
    )
    if (d.code === 0) {
      const lastGood = lastGoodDoltHead(scratch, health.head, deepen)
      return lastGood === null ? health : { ...health, lastGood }
    }
    return health
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
