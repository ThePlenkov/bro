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
import type {
  ConnectorCtx,
  DecideResult,
  Guard,
  GuardEvent,
  JudgeFacade,
  JudgeQuestion,
  Verdict,
} from '@broject/core'
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
import { evalState, liveState, mapPool } from './probes.ts'
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
  /** `when.judge` wiring — lazy: resolved at most once per run and only
   *  when a judge-clause guard's deterministic clauses pass. Absent or
   *  resolving to undefined = abstain (the judge is off/unconfigured). */
  judge?: () => GuardJudgeInput | undefined
}

/** The judge seam's knobs — assembled by the caller from judge config
 *  so the engine stays free of @broject/judge imports. */
export interface GuardJudgeInput {
  facade: JudgeFacade
  /** Below this answer confidence the clause abstains (judge.confidence). */
  confidence: number
  /** decide() calls bound per run (judge.maxDecisionsPerRun). */
  maxDecisions: number
  /** kind:'guard' verdict sink — set on live emit paths only; `bro
   *  guard test` leaves it off so a read never journals. */
  journal?: (v: Verdict) => void
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

/** Phase-1 fan-out cap — guard defs are unbounded config (plus every
 *  connector's contribution) and each may shell out, so the sweep stays
 *  parallel under a pool instead of launching all probes at once.
 *  `maxPerEvent` bounds emissions, never the work behind them. */
export const EVAL_FANOUT = 8

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
  `bro guard ${g.name}: ${renderSay(g.say)}`

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
    clauses.push(...(await evalState(g.when.state, dir, lazies.live(), probes)))
  }
  return clauses
}

/** Default veto bar — a noul is P(should fire); below half the guard
 *  is suppressed. `when.judge.threshold` overrides. */
const GUARD_JUDGE_VETO = 0.5

/** An abstain verdict — every non-answer path ends as ok:true. */
function abstain(clauses: ClauseVerdict[], detail: string): void {
  clauses.push({ clause: 'judge', ok: true, detail: `abstained — ${detail}` })
}

/** Lazy-resolve the judge input once per run — a wedged resolution
 *  (no judge connector, bad provider pin) abstains like judge.mode:off,
 *  never a veto. Returns undefined after pushing the abstain clause. */
function resolveJudgeInput(
  judge: () => GuardJudgeInput | undefined,
  input: { value: GuardJudgeInput | undefined; resolved: boolean },
  clauses: ClauseVerdict[]
): GuardJudgeInput | undefined {
  if (!input.resolved) {
    input.resolved = true
    try {
      input.value = judge()
    } catch (err) {
      abstain(clauses, `resolution threw: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
  }
  if (input.value === undefined) {
    abstain(clauses, 'judge off')
  }
  return input.value
}

/** Journal the decided answer — observability: a write failure loses
 *  a row, never the verdict and never the other guards' lines. */
function journalGuardDecision(
  g: Guard,
  j: GuardJudgeInput,
  question: JudgeQuestion,
  res: DecideResult
): void {
  try {
    j.journal?.({
      ts: new Date().toISOString(),
      kind: 'guard',
      subject: { threadId: `guard:${g.name}` },
      questions: { fire: question },
      answers: res.answers,
      model: res.model,
      latencyMs: res.latencyMs,
      ...(res.usage?.costUsd !== undefined ? { costUsd: res.usage.costUsd } : {}),
    })
  } catch {
    // see doc — the row is the only thing at stake here
  }
}

/** The one `noul` question a judge clause asks (spec: bro-nkn6 —
 *  veto-only). Runs only when the deterministic `when` already passed
 *  — a guard the diff never triggered never spends a decision.
 *  Abstains (ok:true row) on: no judge input, decision budget spent,
 *  JudgeUnavailable/any throw, low-confidence answer. A real answer
 *  journals as kind:'guard' — suppression accuracy needs both sides. */
async function evalJudge(
  g: Guard,
  event: GuardEvent,
  clauses: ClauseVerdict[],
  judge: () => GuardJudgeInput | undefined,
  input: { value: GuardJudgeInput | undefined; resolved: boolean },
  decisions: { used: number }
): Promise<void> {
  const j = resolveJudgeInput(judge, input, clauses)
  if (j === undefined) {
    return
  }
  if (decisions.used >= j.maxDecisions) {
    abstain(clauses, `decision budget spent (${j.maxDecisions}/run)`)
    return
  }
  const question = {
    type: 'noul' as const,
    instructions: g.when.judge!.question,
    criteria: { true: `guard '${g.name}' fires`, false: 'suppressed this time' },
  }
  // the evidence the judge reads — which clauses held and with what
  // detail, the event, the bounded `say` (JsonValue-safe by shape)
  const state = {
    guard: g.name,
    event,
    say: renderSay(g.say),
    clauses: clauses.map((c) => ({ clause: c.clause, ok: c.ok, detail: c.detail ?? null })),
  }
  decisions.used += 1
  let res: DecideResult
  try {
    res = await j.facade.decide(state, { fire: question })
  } catch (err) {
    abstain(clauses, `${err instanceof Error ? err.message : err}`)
    return
  }
  const a = res.answers.fire
  const threshold = g.when.judge!.threshold ?? GUARD_JUDGE_VETO
  if (a === undefined || a.type !== 'noul') {
    abstain(clauses, 'no noul answer')
    return
  }
  if (res.lowConfidence.includes('fire') || a.confidence < j.confidence) {
    abstain(clauses, `confidence ${a.confidence} < ${j.confidence}`)
    return
  }
  journalGuardDecision(g, j, question, res)
  if (a.noul < threshold) {
    clauses.push({
      clause: 'judge',
      ok: false,
      detail: `vetoed — noul ${a.noul} < ${threshold}`,
    })
    return
  }
  clauses.push({ clause: 'judge', ok: true, detail: `noul ${a.noul} ≥ ${threshold}` })
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

  // phase 1 — deterministic clauses (on → match.* → state.*), defs in
  // parallel but pooled at EVAL_FANOUT: state probes shell out
  // (spec-drift's tasks.get is a ~1s bd spawn), so a serial loop stacks
  // per-def latencies into the post-tool spikes while an unbounded
  // fan-out turns a large config into a spawn storm. mapPool keeps
  // verdicts in declaration order — the shared lazies are memoized
  // promises/sync-caches, safe under concurrent reads, and budget
  // accounting below is untouched.
  const verdicts: GuardVerdict[] = await mapPool(EVAL_FANOUT, guards, async ({ source, guard }) => ({
    name: guard.name,
    source,
    clauses: await evalClauses(guard, opts.event, lazies, opts.probes ?? {}, opts.dir),
    fired: 0,
    budget: guard.when.budget ?? GUARD_DEFAULT_BUDGET,
    fire: false,
  }))

  // phase 1.5 — judge clauses: one noul per guard whose deterministic
  // clauses all pass; veto-only, abstains fail-open (spec: bro-nkn6).
  // A declared clause always earns a row — an unwired/absent judge is
  // an 'abstained' verdict, not silence
  const judgeInput: { value: GuardJudgeInput | undefined; resolved: boolean } = {
    value: undefined,
    resolved: false,
  }
  const decisions = { used: 0 }
  const resolveJudge = opts.judge ?? (() => undefined)
  for (const v of verdicts) {
    const g = guards.find((x) => x.guard.name === v.name)!.guard
    if (g.when.judge === undefined || !v.clauses.every((c) => c.ok)) {
      continue
    }
    await evalJudge(g, opts.event, v.clauses, resolveJudge, judgeInput, decisions)
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
