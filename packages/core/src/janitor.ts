/**
 * Janitor — retention and reaping for agent state (bro-f6zp,
 * specs/sessions/bro-f6zp.md). Everything under `<git-common>/bro/` was
 * write-only: session markers, mailbox cursors, agent homes, lock
 * debris, and append-only logs accumulated forever. The janitor is a
 * function, not a process — `runJanitor` runs as a side effect of
 * `bro watch`'s tick (and dry-runs inside `bro doctor`), so reaping
 * rides an existing cadence instead of a new daemon.
 *
 * Reap rules, condensed:
 *  - agent homes follow the registry entry — a recorded death
 *    (stopped/exitStatus) older than DEAD_RETENTION_MS drops the entry
 *    and its `agents/<id>.*` files; files no entry points at are debris
 *  - session-scoped files need an owner or an expiry — a session with
 *    no registry-present marker (dead owner or past TTL) AND whose
 *    `.work` detail names no existing path loses its
 *    markers/hinted/fired/cursor; markerless cursors reap on
 *    drain-idleness; everything reaps on the TTL floor
 *  - a lock whose token names a dead pid is garbage — the filelock
 *    steals it on acquire, the janitor removes the file
 *  - append-only logs cap by size regardless of liveness, tail kept
 *    in place so a held-fd writer's inode never unlinks under it
 *
 * Fail-open throughout: an unreadable dir or a racy unlink is a skipped
 * file, never a crash — the janitor is housekeeping, not a gate.
 */
import {
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  readAgentRegistry,
  writeAgentRegistry,
  acquireAgentRegistryLock,
  type AgentRegistryEntry,
} from './agents.ts'
import { acquireFileLock } from './filelock.ts'
import { gitTry } from './git.ts'
import { DROP_TTL_MS } from './notify.ts'
import { markerLive, pidAlive } from './proc.ts'

/** Marker presence window — mirrors commands/hooks.ts. A session counts
 *  as registry-present while ANY marker could still arm a gate:
 *  owner pid alive, or ownerless mtime inside MARKER_TTL_MS
 *  (readArmed's cutoff). Reaping is more destructive than parallel
 *  detection — which calls ownerless markers dead past a day — so the
 *  sweep uses the armed-state bar, not the detection one: an ownerless
 *  2-day-old marker still represents a session that might resume and
 *  needs its stop gate. Only a dead owner or the TTL itself clears it. */
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A recorded-dead registry entry keeps its slot this long — fleet and
 *  `bro agents status` need the death visible before the audit trail
 *  unlinks. Same scale as the marker TTL. */
const DEAD_RETENTION_MS = MARKER_TTL_MS
/** Markerless-session cursor floor — a live session's postTool rewrites
 *  its `.seen` cursor on every drain; untouched for a day it belongs to
 *  nobody. Reaping loses nothing: the drops it dedups expire in
 *  DROP_TTL_MS anyway. (24h — the cursor's own mtime is the heartbeat,
 *  a weaker signal than a marker, so it gets the shorter bar.) */
const CURSOR_IDLE_MS = 24 * 60 * 60 * 1000
/** Absolute cursor floor — mirrors notify.ts's private SEEN_TTL_MS. */
const SEEN_TTL_MS = MARKER_TTL_MS
/** Append-only cap: past MAX, keep the newest whole-line KEEP tail. */
const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP_BYTES = 512 * 1024
/** Floor for lock-adjacent and mailbox tmp debris — a sibling older
 *  than this is crash residue, not an in-flight write (mirrors
 *  filelock's staged-token sweep). */
const DEBRIS_FLOOR_MS = 60_000

export interface JanitorReaped {
  markers: number
  hinted: number
  fired: number
  cursors: number
  drops: number
  agentFiles: number
  locks: number
  debris: number
  trace: number
}

export interface JanitorReport {
  dryRun: boolean
  /** Session ids swept as dead (markers + hinted + fired + cursor). */
  sessions: string[]
  /** molSteps whose registry entry was removed. */
  agentEntries: string[]
  /** Individual files unlinked, per debris class. */
  reaped: JanitorReaped
  /** Logs tail-capped for size — live files, not reaped ones. */
  truncated: { path: string; bytes: number }[]
}

/** Registry access the agent sweep needs — injectable so tests and the
 *  bare-dir path run without git resolution; `runJanitor` binds the
 *  real store. */
export interface JanitorDeps {
  readRegistry(): Record<string, AgentRegistryEntry>
  writeRegistry(reg: Record<string, AgentRegistryEntry>): void
  /** The shared occupancy/registry lock — `agents.json.lock`. */
  registryLock(): () => void
}

export interface JanitorOpts {
  dryRun?: boolean
  now?: number
}

interface Ctx {
  bro: string
  now: number
  dryRun: boolean
  report: JanitorReport
  deps: JanitorDeps
  /** agentIds with a live registry entry — sweepAgents fills it,
   *  capLogs consults it so an orphan's .log reaps rather than caps. */
  liveAgentIds: Set<string>
}

const emptyReport = (dryRun: boolean): JanitorReport => ({
  dryRun,
  sessions: [],
  agentEntries: [],
  reaped: {
    markers: 0,
    hinted: 0,
    fired: 0,
    cursors: 0,
    drops: 0,
    agentFiles: 0,
    locks: 0,
    debris: 0,
    trace: 0,
  },
  truncated: [],
})

/** `<git-common>` for dir — the same resolution notify/agents use. */
function commonDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  if (common !== '') {
    return common
  }
  const rel = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
  return rel.code === 0 && rel.out.trim() !== '' ? resolve(dir, rel.out.trim()) : null
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function statOf(path: string): { mtimeMs: number; size: number; isFile: boolean } | null {
  try {
    const st = statSync(path)
    return { mtimeMs: st.mtimeMs, size: st.size, isFile: st.isFile() }
  } catch {
    return null
  }
}

function firstLine(path: string): string | undefined {
  try {
    const raw = readFileSync(path, 'utf8')
    const nl = raw.indexOf('\n')
    return nl === -1 ? raw : raw.slice(0, nl)
  } catch {
    return undefined
  }
}

/** Unlink with a counter — a vanished file is a raced reaper and counts
 *  nothing. Callers revalidate liveness right before this; a file
 *  recreated between scan and delete is live, not debris. */
function reap(ctx: Ctx, path: string, kind: keyof JanitorReaped): void {
  if (!ctx.dryRun) {
    try {
      rmSync(path, { force: true })
    } catch {
      // raced removal or a permissions wall — a failed unlink is skipped
      // debris, not a janitor failure
      return
    }
  }
  ctx.report.reaped[kind] += 1
}

// --- session sweep ----------------------------------------------------------------

interface MarkerScan {
  file: string
  aspect: string
  mtimeMs: number
  live: boolean
}

/** `<sid>.<aspect>` — split on the LAST dot: sanitized sids may carry
 *  dots, aspects are single words (act/task/work/convoy/…). */
function splitMarker(f: string): { sid: string; aspect: string } | null {
  const m = /^([\w.-]+)\.([A-Za-z][\w-]*)$/.exec(f)
  return m === null ? null : { sid: m[1]!, aspect: m[2]! }
}

/** Detail lines after the stamp line of a `.work` marker — slugs, bead
 *  ids, worktree paths; only absolute paths can prove a worktree. */
function workDetailPaths(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => isAbsolute(l))
  } catch {
    return []
  }
}

/** Dead sessions lose their scattered files — top-level markers,
 *  hinted/fired side files, the notify cursor. Trace journals stay:
 *  they are the postmortem record `bro learn` reads, not coordination
 *  state, so they reap on TTL/size only. A file stamped at-or-after
 *  `now` was recreated mid-sweep by a resuming session — live, skip. */
function reapSessionFiles(ctx: Ctx, sid: string, markers: MarkerScan[]): void {
  const hooks = join(ctx.bro, 'hooks')
  for (const m of markers) {
    const path = join(hooks, m.file)
    const st = statOf(path)
    // revalidate right before the rm — a session resuming can re-arm a
    // marker between the scan and the delete; a fresh stamp means live
    if (st !== null && !markerLive(firstLine(path), st.mtimeMs, MARKER_TTL_MS, ctx.now)) {
      reap(ctx, path, 'markers')
    }
  }
  const fresh = (path: string): boolean => {
    const st = statOf(path)
    return st !== null && st.isFile && st.mtimeMs < ctx.now
  }
  for (const f of listDir(join(hooks, 'hinted'))) {
    const path = join(hooks, 'hinted', f)
    if (f.startsWith(`${sid}.`) && fresh(path)) {
      reap(ctx, path, 'hinted')
    }
  }
  const fired = join(hooks, 'fired', sid)
  if (fresh(fired)) {
    reap(ctx, fired, 'fired')
  }
  const cursor = join(ctx.bro, 'notify', `.seen-${sid}`)
  if (fresh(cursor)) {
    reap(ctx, cursor, 'cursors')
  }
}

function sweepSessions(ctx: Ctx): Set<string> {
  const hooks = join(ctx.bro, 'hooks')
  const bySid = new Map<string, MarkerScan[]>()
  const sids = new Set<string>()
  // one scan does TTL floor + liveness grouping — a marker past the TTL
  // is residue whatever its owner says (readArmed's cutoff agrees), but
  // its liveness still counts toward the session's dead verdict
  for (const f of listDir(hooks)) {
    const parts = splitMarker(f)
    if (parts === null) {
      continue
    }
    const path = join(hooks, f)
    const st = statOf(path)
    if (st === null || !st.isFile) {
      continue
    }
    sids.add(parts.sid)
    const live = markerLive(firstLine(path), st.mtimeMs, MARKER_TTL_MS, ctx.now)
    const list = bySid.get(parts.sid) ?? []
    list.push({ file: f, aspect: parts.aspect, mtimeMs: st.mtimeMs, live })
    bySid.set(parts.sid, list)
    if (ctx.now - st.mtimeMs > MARKER_TTL_MS) {
      reap(ctx, path, 'markers')
    }
  }

  // the sweep runs inside the shared occupancy lock — the same lock a
  // `.work` arm holds — so a resuming session cannot re-arm between the
  // dead verdict and the unlink (per-file revalidation is the
  // belt-and-suspenders for the aspects arms don't lock)
  const release = ctx.deps.registryLock()
  try {
    for (const [sid, markers] of bySid) {
      if (markers.some((m) => m.live)) {
        continue
      }
      // dead — but the bead's conjunction wants the worktree gone too: a
      // `.work` detail pointing at a surviving absolute path means the
      // checkout outlived the session and a resume may still claim it
      const workAlive = markers
        .filter((m) => m.aspect === 'work')
        .some((m) => workDetailPaths(join(hooks, m.file)).some((p) => existsSync(p)))
      if (workAlive) {
        continue
      }
      reapSessionFiles(ctx, sid, markers)
      ctx.report.sessions.push(sid)
    }
  } finally {
    release()
  }
  return sids
}

// --- mailbox ------------------------------------------------------------------------

function sweepMailbox(ctx: Ctx, markerSids: Set<string>): void {
  const notify = join(ctx.bro, 'notify')
  const dead = new Set(ctx.report.sessions)
  for (const f of listDir(notify)) {
    const path = join(notify, f)
    const st = statOf(path)
    if (st === null || !st.isFile) {
      continue
    }
    const age = ctx.now - st.mtimeMs
    if (f.startsWith('.seen-')) {
      const sid = f.slice('.seen-'.length)
      // dead sessions already reaped via sweepSessions (dry-run counts
      // there); a markerless session's only heartbeat IS the cursor's
      // mtime — a live session's postTool rewrites it on every drain,
      // so idle means ownerless — and the absolute TTL floor covers
      // the rest
      const reapable =
        (!dead.has(sid) && !markerSids.has(sid) && age > CURSOR_IDLE_MS) ||
        age > SEEN_TTL_MS
      if (reapable) {
        reap(ctx, path, 'cursors')
      }
    } else if (f.endsWith('.tmp')) {
      if (age > DEBRIS_FLOOR_MS) {
        reap(ctx, path, 'debris')
      }
    } else if (f.endsWith('.txt') && !f.startsWith('.') && age > DROP_TTL_MS) {
      // expired drops reap on the next drain anyway — a mailbox nobody
      // drains shouldn't wait for one
      reap(ctx, path, 'drops')
    }
  }
}

// --- agent registry + homes ----------------------------------------------------------

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** When the recorded death happened — `.exit` mtime is the wrapper's
 *  own death timestamp; spawnedAt and the newest home-file mtime are
 *  the fallbacks. Null when nothing can age it — an unverifiable entry
 *  keeps its slot rather than being guessed dead. */
function deadSince(agentsDir: string, entry: AgentRegistryEntry): number | null {
  if (!SAFE_AGENT_ID.test(entry.agentId)) {
    return null // a tampered id can't be trusted to locate its own files
  }
  const exitSt = statOf(join(agentsDir, `${entry.agentId}.exit`))
  if (exitSt !== null) {
    return exitSt.mtimeMs
  }
  const spawned = typeof entry.spawnedAt === 'string' ? Date.parse(entry.spawnedAt) : Number.NaN
  if (!Number.isNaN(spawned)) {
    return spawned
  }
  let newest = 0
  for (const f of listDir(agentsDir)) {
    if (f.startsWith(`${entry.agentId}.`)) {
      newest = Math.max(newest, statOf(join(agentsDir, f))?.mtimeMs ?? 0)
    }
  }
  return newest > 0 ? newest : null
}

function sweepAgents(ctx: Ctx): void {
  const agentsDir = join(ctx.bro, 'agents')
  const before = ctx.deps.readRegistry()
  const deadKeys: string[] = []
  for (const [molStep, e] of Object.entries(before)) {
    // only RECORDED deaths reap — a live or merely-lost entry's
    // liveness is the connector's probe, not the janitor's guess
    if (e.stopped !== true && typeof e.exitStatus !== 'number') {
      continue
    }
    const since = deadSince(agentsDir, e)
    if (since !== null && ctx.now - since > DEAD_RETENTION_MS) {
      deadKeys.push(molStep)
    }
  }

  let after = before
  if (deadKeys.length > 0) {
    const release = ctx.deps.registryLock()
    try {
      const cur = ctx.deps.readRegistry()
      let changed = false
      for (const k of deadKeys) {
        const orig = before[k]
        const c = cur[k]
        // revalidate inside the lock — a respawn that reused the entry
        // (same molStep, new generation) owns it now
        if (
          c === undefined ||
          orig === undefined ||
          c.agentId !== orig.agentId ||
          c.spawnedAt !== orig.spawnedAt
        ) {
          continue
        }
        delete cur[k]
        changed = true
        ctx.report.agentEntries.push(k)
      }
      if (changed && !ctx.dryRun) {
        ctx.deps.writeRegistry(cur)
      }
      after = changed ? cur : before
    } finally {
      release()
    }
  }

  ctx.liveAgentIds = new Set(
    Object.values(after)
      .map((e) => e.agentId)
      .filter((id) => SAFE_AGENT_ID.test(id))
  )
  // files no live entry points at are debris — the `<agentId>.*`
  // naming makes the whole home one unlink set, no extra bookkeeping
  for (const f of listDir(agentsDir)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\..+$/.exec(f)
    if (m === null || ctx.liveAgentIds.has(m[1]!)) {
      continue
    }
    const path = join(agentsDir, f)
    const st = statOf(path)
    // an mtime at-or-after the scan start is a file a respawn recreated
    // mid-sweep — its new entry may not be in our snapshot yet
    if (st === null || !st.isFile || st.mtimeMs >= ctx.now) {
      continue
    }
    reap(ctx, path, 'agentFiles')
  }
}

// --- lock debris ------------------------------------------------------------------------

/** `*.lock` whose `<pid>:<rand>` token names a dead pid — the filelock
 *  would steal it on next acquire; the janitor removes the file itself.
 *  An unverifiable token gets the TTL floor — a week-old lock is
 *  abandoned whatever its token said. `*.cap-*` captured instances and
 *  `*.tmp` staged writes reap past the debris floor. */
function sweepLocks(ctx: Ctx): void {
  for (const f of listDir(ctx.bro)) {
    const path = join(ctx.bro, f)
    const st = statOf(path)
    if (st === null || !st.isFile) {
      continue
    }
    const age = ctx.now - st.mtimeMs
    if (f.endsWith('.lock')) {
      const pid = Number((firstLine(path)?.trim() ?? '').split(':')[0])
      if (Number.isInteger(pid) && pid > 0) {
        if (!pidAlive(pid)) {
          reap(ctx, path, 'locks')
        }
      } else if (age > MARKER_TTL_MS) {
        reap(ctx, path, 'locks')
      }
    } else if (f.includes('.cap-') || f.endsWith('.tmp')) {
      if (age > DEBRIS_FLOOR_MS) {
        reap(ctx, path, 'debris')
      }
    }
  }
}

// --- size caps ----------------------------------------------------------------------------

/** Tail-cap one file in place: read the newest whole-line KEEP tail,
 *  write it at offset 0, ftruncate. In-place, never tmp+rename — a
 *  spawned agent holds its `.log` fd open and a rename would strand
 *  every later byte on a dead inode. A held-fd writer's next write
 *  lands past the new EOF as a sparse hole — a bounded, legible scar
 *  vs unbounded growth. */
function capFile(ctx: Ctx, path: string, size: number): void {
  const keep = Math.min(LOG_KEEP_BYTES, size)
  if (ctx.dryRun) {
    ctx.report.truncated.push({ path, bytes: size - keep })
    return
  }
  let fd: number
  try {
    fd = openSync(path, 'r+')
  } catch {
    return
  }
  try {
    const buf = Buffer.alloc(keep)
    const n = readSync(fd, buf, 0, keep, size - keep)
    let tail = buf.subarray(0, n)
    const nl = tail.indexOf(0x0a)
    if (nl >= 0 && nl + 1 < tail.length) {
      tail = tail.subarray(nl + 1) // whole lines — a partial first line reads as noise
    }
    writeSync(fd, tail, 0, tail.length, 0)
    ftruncateSync(fd, tail.length)
    ctx.report.truncated.push({ path, bytes: size - tail.length })
  } catch {
    // a racing writer or a read error — skip; the cap retries next tick
  } finally {
    try {
      closeSync(fd)
    } catch {
      // nothing to do
    }
  }
}

/** Uncapped append-only files bro owns: trace journals, agent logs, the
 *  judge verdict journal. act-checks.jsonl is absent — it self-caps.
 *  Agent logs cap only while their entry lives — an orphan's .log is
 *  debris to unlink, not a file to trim. */
function capLogs(ctx: Ctx): void {
  for (const f of listDir(join(ctx.bro, 'hooks', 'trace'))) {
    capIfLarge(ctx, join(ctx.bro, 'hooks', 'trace', f), f.endsWith('.jsonl'))
  }
  for (const f of listDir(join(ctx.bro, 'judge'))) {
    capIfLarge(ctx, join(ctx.bro, 'judge', f), f.endsWith('.jsonl'))
  }
  for (const f of listDir(join(ctx.bro, 'agents'))) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.log$/.exec(f)
    if (m !== null && ctx.liveAgentIds.has(m[1]!)) {
      capIfLarge(ctx, join(ctx.bro, 'agents', f), true)
    }
  }
}

function capIfLarge(ctx: Ctx, path: string, capped: boolean): void {
  if (!capped) {
    return
  }
  const st = statOf(path)
  if (st !== null && st.isFile && st.size > LOG_MAX_BYTES) {
    capFile(ctx, path, st.size)
  }
}

/** TTL floor for the files the session sweep doesn't own: hinted and
 *  fired files of markerless sessions (dead sessions' files already
 *  reaped with the sweep), and trace journals — TTL only, session
 *  death never reaps the postmortem record. */
function sweepTtlFloors(ctx: Ctx): void {
  const hooks = join(ctx.bro, 'hooks')
  const floors: [string, keyof JanitorReaped][] = [
    [join(hooks, 'hinted'), 'hinted'],
    [join(hooks, 'fired'), 'fired'],
    [join(hooks, 'trace'), 'trace'],
  ]
  for (const [dir, kind] of floors) {
    for (const f of listDir(dir)) {
      const path = join(dir, f)
      const st = statOf(path)
      if (st !== null && st.isFile && ctx.now - st.mtimeMs > MARKER_TTL_MS) {
        reap(ctx, path, kind)
      }
    }
  }
}

/** The full walk over `<git-common>/bro/` — every pass is best-effort;
 *  a broken one degrades to a partial report, never a crash. */
export function janitorBroDir(
  bro: string,
  deps: JanitorDeps,
  opts: JanitorOpts = {}
): JanitorReport {
  const ctx: Ctx = {
    bro,
    now: opts.now ?? Date.now(),
    dryRun: opts.dryRun === true,
    report: emptyReport(opts.dryRun === true),
    deps,
    liveAgentIds: new Set(),
  }
  let markerSids = new Set<string>()
  const run = (fn: () => void): void => {
    try {
      fn()
    } catch {
      // a throwing pass must not kill the heartbeat — next pass runs
    }
  }
  run(() => {
    markerSids = sweepSessions(ctx)
  })
  run(() => sweepMailbox(ctx, markerSids))
  run(() => sweepAgents(ctx))
  run(() => sweepTtlFloors(ctx))
  run(() => sweepLocks(ctx))
  run(() => capLogs(ctx))
  return ctx.report
}

/** Run the janitor for `dir`'s repo — null outside a git worktree
 *  (there is no shared state dir to walk). Each call is one complete
 *  reap; the cadence owner decides how often to call it. */
export function runJanitor(dir: string, opts: JanitorOpts = {}): JanitorReport | null {
  const common = commonDir(dir)
  if (common === null) {
    return null
  }
  return janitorBroDir(
    join(common, 'bro'),
    {
      readRegistry: () => readAgentRegistry(dir),
      writeRegistry: (reg) => writeAgentRegistry(dir, reg),
      registryLock: () => acquireAgentRegistryLock(dir),
    },
    opts
  )
}

/** File-backed deps for a bare `<common>/bro` dir — tests and any
 *  caller working on a state dir that isn't reachable through git. */
export function fileBackedJanitorDeps(bro: string): JanitorDeps {
  const reg = join(bro, 'agents.json')
  return {
    readRegistry() {
      try {
        const v = JSON.parse(readFileSync(reg, 'utf8')) as unknown
        return typeof v === 'object' && v !== null && !Array.isArray(v)
          ? (v as Record<string, AgentRegistryEntry>)
          : {}
      } catch {
        return {}
      }
    },
    writeRegistry(r) {
      const tmp = `${reg}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`)
      renameSync(tmp, reg)
    },
    registryLock() {
      try {
        return acquireFileLock(`${reg}.lock`, { label: 'agents.json lock' })
      } catch {
        return () => {}
      }
    },
  }
}

/** Did the pass actually remove or truncate anything — the "silent
 *  janitor" check: callers print only when this is true. */
export function janitorDidWork(r: JanitorReport): boolean {
  return (
    r.sessions.length > 0 ||
    r.agentEntries.length > 0 ||
    Object.values(r.reaped).some((n) => n > 0) ||
    r.truncated.length > 0
  )
}

/** One-line summary for a heartbeat's attention list — counts, with
 *  the session ids named when the list is short. */
export function janitorLine(r: JanitorReport): string {
  const parts: string[] = []
  if (r.sessions.length > 0) {
    const named =
      r.sessions.length <= 4 ? ` (${r.sessions.join(', ')})` : ` (${r.sessions.length} ids)`
    parts.push(`${r.sessions.length} dead session(s)${named}`)
  }
  if (r.agentEntries.length > 0) {
    parts.push(`${r.agentEntries.length} agent entr${r.agentEntries.length === 1 ? 'y' : 'ies'}`)
  }
  const files =
    r.reaped.markers +
    r.reaped.hinted +
    r.reaped.fired +
    r.reaped.cursors +
    r.reaped.drops +
    r.reaped.trace +
    r.reaped.debris +
    r.reaped.locks
  if (files > 0) {
    parts.push(`${files} file(s)`)
  }
  if (r.reaped.agentFiles > 0) {
    parts.push(`${r.reaped.agentFiles} agent file(s)`)
  }
  if (r.truncated.length > 0) {
    parts.push(`capped ${r.truncated.length} log(s)`)
  }
  const verb = r.dryRun ? 'would reap' : 'reaped'
  return parts.length === 0 ? '' : `janitor: ${verb} ${parts.join(', ')}`
}
