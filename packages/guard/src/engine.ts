/**
 * The guard engine — collect → evaluate → budget → fired-set, per hook
 * event (spec: specs/sessions/bro-nkn6.md). Pure prompt contributions:
 * the output is `bro guard <name>: <say>` lines; guards never block,
 * never run anything, never write state unless `record` is set (the
 * hooks emit paths). `bro guard test` runs the same evaluation with
 * `record: false` — a read on the engine, safe mid-session.
 *
 * The fired set is learn's: `<git-common>/bro/hooks/fired/<session>`,
 * one id per line under `${fired}.lock` — `guard:<name>` entries share
 * the file so the two injection planes can't disagree on dedup. No
 * session id → no fired set → guards don't fire (the learn rule).
 */
import {
  collectGuards,
  GUARD_DEFAULT_BUDGET,
  GUARD_SAY_MAX_CHARS,
  GUARD_SAY_MAX_LINES,
  withFileLock,
} from '@broject/core'
import type { ConnectorCtx, Guard, GuardEvent } from '@broject/core'
import {
  firedCounts,
  firedFile,
  hooksDir,
  matchKeys,
  recordFired,
} from '@broject/learn'
import type { MatchContext } from '@broject/learn'
import type { GuardConfig } from './config.ts'
import { DEFAULT_GUARD_CONFIG } from './config.ts'
import { evalState, liveState } from './probes.ts'
import type { ClauseVerdict, LiveState, NamedProbe } from './probes.ts'

export interface GuardEvalOpts {
  dir: string
  /** '' when the hook payload has no session — emit paths then emit
   *  nothing (unbudgeted nudges are the failure the rule prevents);
   *  `test` still evaluates and reports the budget row as unrecorded. */
  sessionId: string
  event: GuardEvent
  /** MatchContext builder — called once, lazily, only when some
   *  event-eligible guard declares `match` (the trace tail read is
   *  skipped for match-free guard sets). */
  mctx: () => Promise<MatchContext>
  /** Armed-aspect reader — lazy for the same reason (`armed`-only
   *  guards never pay for a marker scan they don't need). */
  armed?: () => Set<string>
  /** bro.config `guard.defs` — already section-normalized. */
  defs?: Guard[]
  cfg?: GuardConfig
  /** Engine-registered named probes — closed registry, see probes.ts. */
  probes?: Record<string, NamedProbe>
  /** Emit path: append `guard:<name>` to the fired set under the lock.
   *  `bro guard test` passes false — it reads, never records. */
  record?: boolean
}

/** One guard's evaluation — clause rows in declaration order. */
export interface GuardVerdict {
  name: string
  source: string
  clauses: ClauseVerdict[]
  /** Fires this session so far / allowed (`when.budget` default 1). */
  fired: number
  budget: number
  fire: boolean
  /** The rendered line when fire — `bro guard <name>: <say>` bounded. */
  line?: string
}

export interface GuardRun {
  lines: string[]
  verdicts: GuardVerdict[]
}

const guardId = (name: string): string => `guard:${name}`

/** `say` stays a fragment — bounded at GUARD_SAY_MAX_CHARS /
 *  GUARD_SAY_MAX_LINES with an ellipsis marker. */
export function renderSay(say: string): string {
  const lines = say.split('\n')
  let out = lines.slice(0, GUARD_SAY_MAX_LINES).join('\n')
  if (lines.length > GUARD_SAY_MAX_LINES) {
    out += '\n…'
  }
  if (out.length > GUARD_SAY_MAX_CHARS) {
    out = `${out.slice(0, GUARD_SAY_MAX_CHARS)}…`
  }
  return out
}

const renderLine = (g: Guard): string =>
  `bro guard ${g.name}: ${renderSay(g.say)}${g.when.judge !== undefined ? ' (unjudged)' : ''}`

/** Deterministic clauses — `on`, `match.*`, `state.*` — one row each,
 *  evaluated lazily (mctx/LiveState resolve at most once per run). The
 *  budget row is appended by the caller: its count differs between live
 *  emit (locked re-read) and `guard test` (read-only). */
async function evalClauses(
  g: Guard,
  event: GuardEvent,
  lazies: { mctx: () => Promise<MatchContext>; live: () => LiveState },
  probes: Record<string, NamedProbe>,
  dir: string
): Promise<ClauseVerdict[]> {
  const on: ClauseVerdict = { clause: 'on', ok: g.when.on.includes(event), detail: event }
  const clauses: ClauseVerdict[] = [on]
  if (!on.ok) {
    return clauses
  }
  if (g.when.match !== undefined) {
    const ctx = await lazies.mctx()
    for (const k of matchKeys(g.when.match, ctx)) {
      clauses.push({ clause: `match.${k.key}`, ok: k.ok })
    }
  }
  if (g.when.state !== undefined) {
    clauses.push(...evalState(g.when.state, dir, lazies.live(), probes))
  }
  if (g.when.judge !== undefined) {
    // veto-only and abstains everywhere until nkn6.4 wires the facade —
    // it cannot suppress yet, so the row is informational
    clauses.push({ clause: 'judge', ok: true, detail: 'abstained — veto lands in bro-nkn6.4' })
  }
  return clauses
}

/** Evaluate every resolved guard against this event. `record: true`
 *  wraps the budget check + fired-set append in learn's file lock so
 *  concurrent hook processes can't double-fire a budget-1 guard. */
export async function runGuards(opts: GuardEvalOpts): Promise<GuardRun> {
  const cfg = opts.cfg ?? DEFAULT_GUARD_CONFIG
  if (!cfg.enabled) {
    return { lines: [], verdicts: [] }
  }
  const collected = collectGuards({ dir: opts.dir, sessionId: opts.sessionId } as ConnectorCtx, opts.defs ?? [])
  const guards = collected.filter((c): c is { source: string; guard: Guard } => c.guard !== undefined)
  if (guards.length === 0) {
    return { lines: [], verdicts: [] }
  }
  const fired = (() => {
    if (opts.sessionId === '') {
      return null
    }
    const hooks = hooksDir(opts.dir)
    return hooks === null ? null : firedFile(hooks, opts.sessionId)
  })()
  let mctxCache: Promise<MatchContext> | null = null
  const lazies = {
    mctx: () => (mctxCache ??= opts.mctx()),
    live: (() => {
      let l: LiveState | null = null
      return () => (l ??= liveState(opts.dir, opts.armed))
    })(),
  }

  // phase 1 — deterministic clauses (on → match.* → state.* → judge note)
  const verdicts: GuardVerdict[] = []
  for (const { source, guard } of guards) {
    const budget = guard.when.budget ?? GUARD_DEFAULT_BUDGET
    const clauses = await evalClauses(guard, opts.event, lazies, opts.probes ?? {}, opts.dir)
    verdicts.push({ name: guard.name, source, clauses, fired: 0, budget, fire: false })
  }

  // phase 2 — budget rows + emission, inside the fired lock when recording
  const counts = fired === null ? new Map<string, number>() : firedCounts(fired)
  const emit = (): void => {
    let emitted = 0
    for (const v of verdicts) {
      const g = guards.find((x) => x.guard.name === v.name)!.guard
      const used = counts.get(guardId(v.name)) ?? 0
      v.fired = used
      // every phase-1 clause must hold — a failed on/match/state clause
      // leaves the budget untouched
      if (!v.clauses.every((c) => c.ok)) {
        continue
      }
      if (used >= v.budget) {
        v.clauses.push({ clause: 'budget', ok: false, detail: `${used}/${v.budget} spent` })
        continue
      }
      if (fired === null) {
        v.clauses.push({ clause: 'budget', ok: false, detail: 'no session — unrecorded guards never fire' })
        continue
      }
      if (emitted >= cfg.maxPerEvent) {
        v.clauses.push({ clause: 'cap', ok: false, detail: `maxPerEvent ${cfg.maxPerEvent}` })
        continue
      }
      v.fire = true
      v.line = renderLine(g)
      v.clauses.push({ clause: 'budget', ok: true, detail: `${used + 1}/${v.budget}` })
      counts.set(guardId(v.name), used + 1)
      emitted++
    }
  }

  if (opts.record === true && fired !== null) {
    const firedPath = fired
    const run = (): void => {
      // re-read inside the lock — another hook may have fired meanwhile
      const fresh = firedCounts(firedPath)
      for (const [k, n] of fresh) {
        counts.set(k, n)
      }
      emit()
      const ids = verdicts.filter((v) => v.fire).map((v) => guardId(v.name))
      if (ids.length > 0) {
        recordFired(firedPath, ids)
      }
    }
    try {
      withFileLock(`${fired}.lock`, run, { waitMs: 2_000, label: 'guard fired lock' })
    } catch {
      run() // lock timeout degrades to the unlocked race, never a stall
    }
  } else {
    emit()
  }
  return {
    lines: verdicts.filter((v) => v.line !== undefined).map((v) => v.line!),
    verdicts,
  }
}
