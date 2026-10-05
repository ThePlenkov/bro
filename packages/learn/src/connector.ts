/**
 * The `learn` connector — lesson injection for the agent lifecycle
 * (spec: specs/sessions/bro-f4ot.1-learn.md). Three probes, all
 * fail-open and budget-capped like every connector probe:
 *
 *   sessionStart  match `on: session-start` lessons against session
 *                 context — repo, branch, this session's claimed beads,
 *                 in-progress mol steps, the previous session's trace
 *                 tail when resumable
 *   promptSubmit  match `terms` against the raw prompt — the highest-
 *                 precision trigger
 *   postTool      match commands/paths/tools/errors/terms against the
 *                 session trace the hooks layer journals
 *
 * A lesson fires at most `trigger.budget` (default 1) times per session —
 * the fired set is one lesson id per appended line in
 * `<git-common>/bro/hooks/fired/<session>`. `fired/` and `trace/` are
 * subdirs of the marker dir, never flat files: `readArmed` scans
 * `<session>.*` entries as gate aspects, so dedup/journal state beside
 * the markers would arm phantom aspects on every event.
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  gitTry,
  loadConfig,
  markerLive,
  sessionTaskClaims,
  taskStoreAsync,
  withFileLock,
} from '@broject/core'
import type { Connector, ConnectorCtx, TaskRow } from '@broject/core'
import { learnSection, type LearnConfig } from './config.ts'
import type { HookEvent, Lesson } from './lesson.ts'
import {
  parseTraceLine,
  triggerMatches,
  type MatchContext,
  type TraceEntry,
} from './match.ts'
import { listLessons, listLessonsAsync } from './store.ts'

/** Fired-set/trace files share the arming markers' lifecycle — residue
 *  past a week is a dead session's. */
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How much journal a probe evaluates — deep enough for the session's
 *  recent work, shallow enough to stay a tail read. */
const TRACE_TAIL_LINES = 100

/** "Live" for previous-trace exclusion — the same day-window the
 *  parallel-work nudge uses: an owned marker stays live while its pid
 *  does, an ownerless one only inside the window. */
const LIVE_SESSION_MS = 24 * 60 * 60 * 1000

const safeId = (s: string): string => s.replace(/[^\w.-]/g, '_')

/** `<git-common>/bro/hooks` — shared across linked worktrees like the
 *  marker dir it sits beside. null outside a repo. */
function hooksDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
  if (r.code !== 0 || r.out.trim() === '') {
    return null
  }
  // --git-common-dir is relative ('.git') in the main worktree —
  // resolve against ctx.dir, never cwd (same rule as sessionTaskClaims)
  return join(resolve(dir, r.out.trim()), 'bro', 'hooks')
}

const traceFile = (hooks: string, sessionId: string): string =>
  join(hooks, 'trace', `${safeId(sessionId)}.jsonl`)

const firedFile = (hooks: string, sessionId: string): string =>
  join(hooks, 'fired', safeId(sessionId))

interface TraceTail {
  entries: TraceEntry[]
  /** the raw lines — the `terms` haystack for trace-text matches */
  raw: string
}

/** The last TRACE_TAIL_LINES journal entries — malformed lines skip. */
function readTraceTail(path: string, max = TRACE_TAIL_LINES): TraceTail {
  try {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-max)
    return {
      entries: lines
        .map(parseTraceLine)
        .filter((e): e is TraceEntry => e !== null),
      raw: lines.join('\n'),
    }
  } catch {
    return { entries: [], raw: '' }
  }
}

/** True when the session behind `safe` (an already-sanitized id) is
 *  provably alive — any `<safe>.<aspect>` marker reading live proves
 *  it. No markers → unverifiable → not-live: an advisory resume tail
 *  beats silence. `markerLive` is the same read otherLiveWork makes:
 *  an owned marker lives while its pid does, an ownerless one inside
 *  the day window. */
function sessionStillLive(hooks: string, safe: string, now: number): boolean {
  try {
    for (const f of readdirSync(hooks)) {
      if (!f.startsWith(`${safe}.`)) {
        continue
      }
      try {
        const p = join(hooks, f)
        const st = statSync(p)
        if (!st.isFile()) {
          continue
        }
        const first = readFileSync(p, 'utf8').split('\n', 1)[0]
        if (markerLive(first, st.mtimeMs, LIVE_SESSION_MS, now)) {
          return true
        }
      } catch {
        // unreadable marker — skip
      }
    }
  } catch {
    // no marker dir — nothing proves live
  }
  return false
}

/** The newest trace file that isn't this session's — the previous
 *  session's tail a fresh session can still match lessons against
 *  ("when resumable": a resuming session's own file IS the previous
 *  one only when no events landed yet, which a same-named skip can't
 *  tell apart — new-session matching uses other sessions' traces).
 *  A provably-live session's trace is concurrent work, not a resume
 *  tail, and is skipped. */
function previousTraceFile(hooks: string, sessionId: string): string | null {
  try {
    const dir = join(hooks, 'trace')
    const mine = `${safeId(sessionId)}.jsonl`
    const now = Date.now()
    let best: { path: string; mtime: number } | null = null
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || f === mine) {
        continue
      }
      if (sessionStillLive(hooks, f.slice(0, -'.jsonl'.length), now)) {
        continue
      }
      try {
        const p = join(dir, f)
        const mtime = statSync(p).mtimeMs
        if (mtime >= now - STATE_TTL_MS && (best === null || mtime > best.mtime)) {
          best = { path: p, mtime }
        }
      } catch {
        // unreadable entry — skip
      }
    }
    return best?.path ?? null
  } catch {
    return null // no trace dir yet
  }
}

/** lesson id → fires this session — one line per fire in the fired
 *  file, so budget is a line count. */
function firedCounts(path: string): Map<string, number> {
  const counts = new Map<string, number>()
  try {
    for (const id of readFileSync(path, 'utf8').split('\n')) {
      const k = id.trim()
      if (k !== '') {
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    }
  } catch {
    // no fired file yet — nothing has fired
  }
  return counts
}

/** Append one line per fired lesson — O_APPEND keeps concurrent
 *  post-tool hooks from tearing a record; restarts re-read the file so
 *  a fired lesson stays fired. Stale fired files prune on the marker
 *  TTL. */
function recordFired(path: string, ids: string[]): void {
  try {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
    appendFileSync(path, ids.map((id) => `${id}\n`).join(''))
    const cutoff = Date.now() - STATE_TTL_MS
    for (const f of readdirSync(dir)) {
      try {
        const p = join(dir, f)
        if (statSync(p).mtimeMs < cutoff) {
          rmSync(p, { force: true })
        }
      } catch {
        // prune is best-effort
      }
    }
  } catch {
    // a lost fired record re-fires at most budget times — never a stall
  }
}

function learnConfig(dir: string): LearnConfig {
  try {
    // loadConfig returns BroConfig & Record<string, unknown> — the
    // registered section schema normalizes `learn` on every exit path
    return (loadConfig(dir, { learn: learnSection }) as Record<string, unknown>)
      .learn as LearnConfig
  } catch {
    return learnSection(undefined)
  }
}

/** The session-start haystack — repo name, branch, this session's
 *  claimed beads (id + title + labels), in-progress mol steps. Each
 *  component is independently fail-open: a dead bd or a non-repo dir
 *  degrades the text, it doesn't kill the probe. */
async function sessionContextText(ctx: ConnectorCtx): Promise<string> {
  const parts: string[] = []
  const top = gitTry(['-C', ctx.dir, 'rev-parse', '--show-toplevel'])
  parts.push(`repo:${basename(top.code === 0 && top.out.trim() !== '' ? top.out.trim() : ctx.dir)}`)
  const br = gitTry(['-C', ctx.dir, 'branch', '--show-current'])
  if (br.code === 0 && br.out.trim() !== '') {
    parts.push(`branch:${br.out.trim()}`)
  }
  try {
    const store = taskStoreAsync(ctx.dir)
    // claim rows, the mol-id set, and the in-progress list overlap —
    // N claimed beads are N bd show spawns that only cost one latency
    const claims = [...sessionTaskClaims(ctx)]
    const [rows, molRows, inProgress] = await Promise.all([
      Promise.all(claims.map((id) => store.get(id).catch(() => undefined))),
      store.list({ type: 'molecule', all: true }).catch((): TaskRow[] | null => null),
      store.list({ status: 'in_progress' }),
    ])
    for (const row of rows) {
      if (row) {
        parts.push(
          `claimed:${[row.id, row.title ?? '', ...(row.labels ?? [])].join(' ')}`.trim()
        )
      }
    }
    // mol steps are children of a molecule-typed bead — the task
    // relationship is the contract; the `-mol-` id/parent substring is
    // the fallback for stores that can't enumerate types or parents
    const molIds: Set<string> | null =
      molRows === null ? null : new Set(molRows.map((r) => r.id))
    for (const row of inProgress) {
      const isStep =
        (molIds !== null && row.parent !== undefined && molIds.has(row.parent)) ||
        row.id.includes('-mol-') ||
        (molIds === null && (row.parent ?? '').includes('-mol-'))
      if (isStep) {
        parts.push(`mol-step:${`${row.id} ${row.title ?? ''}`.trim()}`)
      }
    }
  } catch {
    // a dead task store degrades context to repo+branch — never fatal
  }
  return parts.join('\n')
}

/** Absolute trace paths match repo-relative globs — a lesson's
 *  `paths: ['specs/**']` names the repo, not the filesystem. Paths
 *  outside ctx.dir keep their absolute form. */
function relativize(dir: string, entries: TraceEntry[]): TraceEntry[] {
  return entries.map((e) => ({
    ...e,
    paths: e.paths?.map((p) => {
      if (!isAbsolute(p)) {
        return p
      }
      const rel = relative(dir, p)
      return rel.startsWith('..') ? p : rel
    }),
  }))
}

/** Match → budget → emit, shared by all three probes. A lesson is
 *  eligible when the event is in `on`, its source passes the config
 *  filter, it hasn't spent its per-session budget, and its match keys
 *  hit. Emitted ids are appended to the fired set — re-probes and
 *  restarts don't re-fire.
 *
 *  The count-check-append is ONE critical section: concurrent post-tool
 *  hooks are separate processes, and without the lock two of them read
 *  the same fired count and both emit a budget-1 lesson. The lock is
 *  best-effort — a timeout degrades to the unlocked race, never a
 *  stalled hook. */
function inject(
  lessons: Lesson[],
  event: HookEvent,
  mctx: MatchContext,
  cfg: LearnConfig,
  fired: string
): string[] {
  const run = (): string[] => {
    const counts = firedCounts(fired)
    const lines: string[] = []
    const firedNow: string[] = []
    for (const l of lessons) {
      if (lines.length >= cfg.maxInject) {
        break
      }
      if (!l.trigger.on.includes(event)) {
        continue
      }
      if (cfg.sources.length > 0 && !cfg.sources.includes(l.source)) {
        continue
      }
      const used = counts.get(l.id) ?? 0
      if (used >= (l.trigger.budget ?? 1)) {
        continue
      }
      if (!triggerMatches(l.trigger, mctx)) {
        continue
      }
      lines.push(`bro learn ${l.id}: ${l.lesson}`)
      counts.set(l.id, used + 1)
      firedNow.push(l.id)
    }
    if (firedNow.length > 0) {
      recordFired(fired, firedNow)
    }
    return lines
  }
  try {
    return withFileLock(`${fired}.lock`, run, {
      waitMs: 2_000,
      label: 'learn fired lock',
    })
  } catch {
    return run()
  }
}

// --- lesson list snapshot ------------------------------------------------------
// probeCtx runs `listLessons` — a full `bd kv list` subprocess — on
// every hook landing, and hook events are fresh processes so an
// in-process cache can't help. The snapshot is a file under the hooks
// dir keyed on the store's write barometer: every bd mutation bumps an
// embedded-dolt noms manifest, reads don't. A store without that
// layout (server-mode bd, a scripted fake, no .beads at all) yields no
// stamp and every probe reads live — the cache only ever skips a
// subprocess, it never invents an answer.

interface LessonSnapshot {
  /** resolved `.beads` dir + each embeddeddolt manifest's mtime:size */
  stamp: string
  lessons: Lesson[]
}

/** `.beads` for this ctx — BEADS_DIR when an agent spawn pinned it,
 *  else the sibling of the common git dir (the main checkout; linked
 *  worktrees share it). null when neither resolves. */
function beadsDir(dir: string): string | null {
  const env = process.env.BEADS_DIR
  if (env !== undefined && env !== '') {
    return env
  }
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.code !== 0 || r.out.trim() === '') {
    return null
  }
  return join(dirname(r.out.trim()), '.beads')
}

/** `<beads>/embeddeddolt/<db>/.dolt/noms/manifest` mtime+size for every
 *  db dir — bumped on any bd write, so a snapshot keyed on it cannot
 *  be stale (issue writes over-invalidate, which is safe). null means
 *  "no recognizable embeddeddolt store" → read live every probe. */
function storeStamp(dir: string): string | null {
  const beads = beadsDir(dir)
  if (beads === null) {
    return null
  }
  const parts: string[] = []
  try {
    for (const db of readdirSync(join(beads, 'embeddeddolt'))) {
      try {
        const st = statSync(join(beads, 'embeddeddolt', db, '.dolt', 'noms', 'manifest'))
        if (st.isFile()) {
          parts.push(`${db}:${st.mtimeMs}:${st.size}`)
        }
      } catch {
        // not a db dir / unreadable entry — try the next
      }
    }
  } catch {
    return null // no embeddeddolt dir — not a cacheable layout
  }
  if (parts.length === 0) {
    return null
  }
  parts.sort((a, b) => a.localeCompare(b))
  return `${beads}|${parts.join('|')}`
}

const snapshotFile = (hooks: string): string => join(hooks, 'cache', 'lessons.json')

function listLessonsCached(dir: string, hooks: string): Lesson[] {
  const stamp = storeStamp(dir)
  const file = snapshotFile(hooks)
  const hit = readSnapshot(file, stamp)
  if (hit !== null) {
    return hit
  }
  const lessons = listLessons(dir).lessons
  writeSnapshot(file, stamp, lessons)
  return lessons
}

async function listLessonsCachedAsync(dir: string, hooks: string): Promise<Lesson[]> {
  const stamp = storeStamp(dir)
  const file = snapshotFile(hooks)
  const hit = readSnapshot(file, stamp)
  if (hit !== null) {
    return hit
  }
  const lessons = (await listLessonsAsync(dir)).lessons
  writeSnapshot(file, stamp, lessons)
  return lessons
}

function readSnapshot(file: string, stamp: string | null): Lesson[] | null {
  if (stamp === null) {
    return null
  }
  try {
    const snap = JSON.parse(readFileSync(file, 'utf8')) as LessonSnapshot
    return snap.stamp === stamp && Array.isArray(snap.lessons) ? snap.lessons : null
  } catch {
    // absent or torn snapshot — refresh below
    return null
  }
}

function writeSnapshot(file: string, stamp: string | null, lessons: Lesson[]): void {
  if (stamp === null) {
    return
  }
  try {
    // tmp+rename — a racing hook process can observe the file
    // mid-write; a torn snapshot just re-reads live next time
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ stamp, lessons } satisfies LessonSnapshot))
    renameSync(tmp, file)
  } catch {
    // a lost snapshot costs one extra subprocess next probe — never a stall
  }
}

/** Shared probe preface — session id, hooks dir, config, store. null
 *  means "emit nothing": no session id leaves the fired set homeless
 *  (an unbudgeted post-tool lesson would nudge on every tool landing),
 *  and a wedged store must yield zero lines, not a stalled hook — the
 *  collectLines wrapper would catch a throw anyway, but a missing bd
 *  is expected off-repo and shouldn't even warn. */
function probeCtx(ctx: ConnectorCtx): {
  hooks: string
  sid: string
  cfg: LearnConfig
  lessons: Lesson[]
} | null {
  const sid = ctx.sessionId ?? ''
  if (sid === '') {
    return null
  }
  const hooks = hooksDir(ctx.dir)
  if (hooks === null) {
    return null
  }
  const cfg = learnConfig(ctx.dir)
  if (!cfg.enabled) {
    return null
  }
  try {
    return { hooks, sid, cfg, lessons: listLessonsCached(ctx.dir, hooks) }
  } catch {
    return null
  }
}

/** Async probeCtx — the lesson store read is a bd spawn; in a parallel
 *  probe sweep its sync form freezes every sibling's timeout timer. */
async function probeCtxAsync(ctx: ConnectorCtx): Promise<{
  hooks: string
  sid: string
  cfg: LearnConfig
  lessons: Lesson[]
} | null> {
  const sid = ctx.sessionId ?? ''
  if (sid === '') {
    return null
  }
  const hooks = hooksDir(ctx.dir)
  if (hooks === null) {
    return null
  }
  const cfg = learnConfig(ctx.dir)
  if (!cfg.enabled) {
    return null
  }
  try {
    return { hooks, sid, cfg, lessons: await listLessonsCachedAsync(ctx.dir, hooks) }
  } catch {
    return null
  }
}

export const learnConnector: Connector = {
  name: 'learn',
  hooks: () => ({
    async sessionStart(ctx) {
      const p = await probeCtxAsync(ctx)
      if (p === null) {
        return []
      }
      const prev = previousTraceFile(p.hooks, p.sid)
      const tail = prev !== null ? readTraceTail(prev) : { entries: [], raw: '' }
      return inject(
        p.lessons,
        'session-start',
        // the previous session's tail is context too — terms may match
        // what it was doing ("mid-merge") as well as the repo's shape
        { text: `${await sessionContextText(ctx)}\n${tail.raw}`, trace: relativize(ctx.dir, tail.entries) },
        p.cfg,
        firedFile(p.hooks, p.sid)
      )
    },
    async promptSubmit(ctx, prompt) {
      const p = await probeCtxAsync(ctx)
      if (p === null) {
        return []
      }
      const tail = readTraceTail(traceFile(p.hooks, p.sid))
      return inject(
        p.lessons,
        'prompt-submit',
        { text: prompt, trace: tail.entries },
        p.cfg,
        firedFile(p.hooks, p.sid)
      )
    },
    async postTool(ctx) {
      const p = await probeCtxAsync(ctx)
      if (p === null) {
        return []
      }
      const tail = readTraceTail(traceFile(p.hooks, p.sid))
      return inject(
        p.lessons,
        'post-tool',
        { text: tail.raw, trace: relativize(ctx.dir, tail.entries) },
        p.cfg,
        firedFile(p.hooks, p.sid)
      )
    },
  }),
}
