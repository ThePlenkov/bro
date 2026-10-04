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
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { gitTry, loadConfig, sessionTaskClaims, taskStore } from '@broject/core'
import type { Connector, ConnectorCtx } from '@broject/core'
import { learnSection, type LearnConfig } from './config.ts'
import type { HookEvent, Lesson } from './lesson.ts'
import {
  parseTraceLine,
  triggerMatches,
  type MatchContext,
  type TraceEntry,
} from './match.ts'
import { listLessons } from './store.ts'

/** Fired-set/trace files share the arming markers' lifecycle — residue
 *  past a week is a dead session's. */
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How much journal a probe evaluates — deep enough for the session's
 *  recent work, shallow enough to stay a tail read. */
const TRACE_TAIL_LINES = 100

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

/** The newest trace file that isn't this session's — the previous
 *  session's tail a fresh session can still match lessons against
 *  ("when resumable": a resuming session's own file IS the previous
 *  one only when no events landed yet, which a same-named skip can't
 *  tell apart — new-session matching uses other sessions' traces). */
function previousTraceFile(hooks: string, sessionId: string): string | null {
  try {
    const dir = join(hooks, 'trace')
    const mine = `${safeId(sessionId)}.jsonl`
    let best: { path: string; mtime: number } | null = null
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || f === mine) {
        continue
      }
      try {
        const p = join(dir, f)
        const mtime = statSync(p).mtimeMs
        if (mtime >= Date.now() - STATE_TTL_MS && (best === null || mtime > best.mtime)) {
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
function sessionContextText(ctx: ConnectorCtx): string {
  const parts: string[] = []
  const top = gitTry(['-C', ctx.dir, 'rev-parse', '--show-toplevel'])
  parts.push(`repo:${basename(top.code === 0 && top.out.trim() !== '' ? top.out.trim() : ctx.dir)}`)
  const br = gitTry(['-C', ctx.dir, 'branch', '--show-current'])
  if (br.code === 0 && br.out.trim() !== '') {
    parts.push(`branch:${br.out.trim()}`)
  }
  try {
    const store = taskStore(ctx.dir)
    for (const id of sessionTaskClaims(ctx)) {
      const row = store.get(id)
      if (row) {
        parts.push(
          `claimed:${[row.id, row.title ?? '', ...(row.labels ?? [])].join(' ')}`.trim()
        )
      }
    }
    for (const row of store.list({ status: 'in_progress' })) {
      // mol steps are beads whose parent is the molecule — the id's
      // `-mol-` segment covers stores that don't report parent
      if (row.id.includes('-mol-') || (row.parent ?? '').includes('-mol-')) {
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
 *  restarts don't re-fire. */
function inject(
  lessons: Lesson[],
  event: HookEvent,
  mctx: MatchContext,
  cfg: LearnConfig,
  fired: string
): string[] {
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
    return { hooks, sid, cfg, lessons: listLessons(ctx.dir).lessons }
  } catch {
    return null
  }
}

export const learnConnector: Connector = {
  name: 'learn',
  hooks: () => ({
    sessionStart(ctx) {
      const p = probeCtx(ctx)
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
        { text: `${sessionContextText(ctx)}\n${tail.raw}`, trace: tail.entries },
        p.cfg,
        firedFile(p.hooks, p.sid)
      )
    },
    promptSubmit(ctx, prompt) {
      const p = probeCtx(ctx)
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
    postTool(ctx) {
      const p = probeCtx(ctx)
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
