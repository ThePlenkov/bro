/**
 * `bro judge decide --state <file|-> --questions <file>` — the judge
 * connector's smoke path (spec: specs/sessions/bro-f4ot.2-judge.md,
 * milestone bro-f4ot.2.2). One decide() call over the resolved chain
 * (primary → `judge.fallback` escalation), printing answers, model,
 * latency, and usage.
 *
 * `bro judge stats [--since <iso>] [--json]` — the shadow report
 * (milestone bro-f4ot.2.4): agreement matrix (judge action vs recorded
 * outcome), calibration buckets, latency/cost — including spend per
 * provider+model — over the verdict journal.
 *
 * `bro judge replay [--pr <n>… | --merged-since <iso>]` — the dogfood
 * pass (milestone bro-f4ot.2.5): re-judge archived review threads from
 * merged PRs, journal replay verdicts carrying their inferred outcomes,
 * then print the replay-scoped stats — the accuracy report the bead
 * publishes.
 *
 * The smoke test exercises the connector, not the mode gate — it runs
 * whatever `judge.mode` says; `mode` governs consumers (annotation),
 * not explicit invocation.
 */
import { readFileSync } from 'node:fs'
import { ensureAuth, JudgeUnavailable, requireProviderSurface, reviewHost } from '@broject/core'
import type { DecideResult, JudgeAnswer, JudgeQuestion } from '@broject/core'
import {
  appendRow,
  computeStats,
  formatStats,
  judgeConfig,
  judgeFacade,
  providerJudgeAuth,
  providerKeyField,
  readJournal,
  replayMergedThreads,
  synthesizedProviders,
} from '@broject/judge'
import { flag, flagAll } from './args.ts'
import { loadBroConfig } from '../plugins.ts'

const QUESTION_TYPES = ['choice', 'score', 'noul'] as const

/** `--state` value → the decide() payload: '-' reads stdin; JSON-shaped
 *  content goes in structured (state may be a string, object, or array);
 *  anything else is the raw string. */
export function loadState(spec: string): unknown {
  const text = spec === '-' ? readFileSync(0, 'utf8') : readFileSync(spec, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** JudgeText on the wire: a plain string or structured JSON (object or
 *  array) — never null, never a bare number/boolean. */
const isJudgeText = (v: unknown): boolean =>
  typeof v === 'string' || (typeof v === 'object' && v !== null)

/** Per-type criteria contract — one problem message or none. */
function criteriaProblem(id: string, o: Record<string, unknown>): string | undefined {
  const c = o.criteria
  if (o.type === 'choice') {
    if (typeof c !== 'object' || c === null || Array.isArray(c) || Object.keys(c).length === 0) {
      return `"${id}".criteria must be a non-empty option map for choice`
    }
    if (!Object.values(c).every((v) => v === null || isJudgeText(v))) {
      return `"${id}".criteria values must be text, structured JSON, or null`
    }
    return undefined
  }
  if (o.type === 'score') {
    if (!Array.isArray(c) || c.length < 2 || c.length > 10) {
      return `"${id}".criteria must be a 2–10 level array for score`
    }
    if (!c.every(isJudgeText)) {
      return `"${id}".criteria entries must be text or structured JSON`
    }
    return undefined
  }
  if (o.type === 'noul' && c !== undefined) {
    const bad =
      typeof c !== 'object' ||
      c === null ||
      Array.isArray(c) ||
      !Object.entries(c).every(
        ([k, v]) => (k === 'true' || k === 'false') && isJudgeText(v)
      )
    if (bad) {
      return `"${id}".criteria must be a {true?, false?} text map for noul`
    }
  }
  return undefined
}

function questionProblems(id: string, q: unknown): string[] {
  const o = (typeof q === 'object' && q !== null ? q : {}) as Record<string, unknown>
  const problems: string[] = []
  if (!(QUESTION_TYPES as readonly unknown[]).includes(o.type)) {
    problems.push(`"${id}".type must be one of ${QUESTION_TYPES.join('|')}`)
  }
  if (!isJudgeText(o.instructions)) {
    problems.push(`"${id}".instructions must be a string or structured JSON`)
  }
  const crit = criteriaProblem(id, o)
  if (crit !== undefined) {
    problems.push(crit)
  }
  return problems
}

/** `--questions` file → the typed map, validated against the contract —
 *  a malformed file exits 2 like other arg errors. */
export function loadQuestions(path: string): Record<string, JudgeQuestion> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(
      `error: --questions ${path}: ${err instanceof Error ? err.message : err}`
    )
    process.exit(2)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('error: --questions must be a JSON object: {"<id>": {…}}')
    process.exit(2)
  }
  const problems = Object.entries(parsed).flatMap(([id, q]) => questionProblems(id, q))
  if (problems.length > 0) {
    console.error(`error: --questions invalid:\n  ${problems.join('\n  ')}`)
    process.exit(2)
  }
  return parsed as Record<string, JudgeQuestion>
}

function fmtAnswer(a: JudgeAnswer): string {
  switch (a.type) {
    case 'choice':
      return `choice ${JSON.stringify(a.choice)}`
    case 'score':
      return `score ${a.score}`
    case 'noul':
      return `noul ${a.noul}`
  }
}

function render(res: DecideResult): void {
  const low = new Set(res.lowConfidence)
  for (const [qid, a] of Object.entries(res.answers)) {
    const dim = low.has(qid) ? ' (low confidence)' : ''
    console.log(`${qid}: ${fmtAnswer(a)} conf=${a.confidence.toFixed(2)} by ${a.decidedBy}${dim}`)
  }
  const usage =
    res.usage !== undefined
      ? [
          res.usage.inputTokens !== undefined ? `${res.usage.inputTokens} in-tokens` : undefined,
          res.usage.costUsd !== undefined ? `$${res.usage.costUsd}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  const usageTail = usage !== '' ? ` · ${usage}` : ''
  console.log(`model ${res.model} · ${res.latencyMs}ms${usageTail}`)
  if (res.lowConfidence.length > 0) {
    console.log(`low confidence: ${res.lowConfidence.join(', ')}`)
  }
}

/** Provider-mode auth preflight — the entry's apiKeyEnv is the probe,
 *  not a connector's; an unresolvable name is the startup error the
 *  spec wants, not a silent fallthrough. */
function providerModeAuth(dir: string): void {
  const { judge: jcfg, providers } = judgeConfig(dir)
  try {
    const entry = requireProviderSurface(
      synthesizedProviders(jcfg, providers),
      jcfg.provider!,
      'call'
    )
    const problem = providerJudgeAuth(
      jcfg.provider!,
      entry,
      providerKeyField(jcfg.provider!, providers)
    )
    if (problem !== null) {
      console.error(`error: ${problem}`)
      process.exit(1)
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** shadow mode journals every decide() a bro command makes — the smoke
 *  path included, under its own kind so stats keep it out of the
 *  act-thread agreement set. */
function journalDecide(
  dir: string,
  questions: Record<string, JudgeQuestion>,
  res: DecideResult
): void {
  if (judgeConfig(dir).judge.mode !== 'shadow') {
    return
  }
  appendRow(dir, {
    ts: new Date().toISOString(),
    kind: 'judge-decide',
    subject: {},
    questions,
    answers: res.answers,
    model: res.model,
    latencyMs: res.latencyMs,
    ...(res.usage?.costUsd !== undefined ? { costUsd: res.usage.costUsd } : {}),
    ...(res.lowConfidence.length > 0 ? { lowConfidence: res.lowConfidence } : {}),
  })
}

/** Judge backend auth — provider mode probes the named entry's own
 *  apiKeyEnv (a missing legacy key would be the wrong field to name);
 *  connector mode keeps the legacy probe. */
function judgeAuth(
  dir: string,
  connector: string | undefined,
  prefer: Record<string, string>
): void {
  if (judgeConfig(dir).judge.provider !== undefined && connector === undefined) {
    providerModeAuth(dir)
  } else {
    ensureAuth('judge', { dir }, { connector, prefer })
  }
}

async function decide(argv: string[]): Promise<void> {
  const stateRef = flag(argv, '--state')
  const questionsRef = flag(argv, '--questions')
  const connector = flag(argv, '--connector')
  const asJson = argv.includes('--json')
  if (stateRef === undefined || questionsRef === undefined) {
    console.error(
      'usage: bro judge decide --state <file|-> --questions <file> [--connector <name>] [--json]'
    )
    process.exit(2)
  }
  const dir = process.cwd()
  judgeAuth(dir, connector, loadBroConfig().connectors)
  const state = loadState(stateRef)
  const questions = loadQuestions(questionsRef)
  try {
    const res = await judgeFacade(dir, { connector }).decide(state, questions)
    journalDecide(dir, questions, res)
    if (asJson) {
      console.log(JSON.stringify(res, null, 2))
    } else {
      render(res)
    }
  } catch (err) {
    // a wedged judge is "no verdict" — the message carries the
    // remediation (missing key, out of credits, timed out)
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`error: ${err instanceof JudgeUnavailable ? 'judge unavailable — ' : ''}${msg}`)
    process.exit(1)
  }
}

/** ISO-8601 date or datetime — `YYYY-MM-DD` with optional `T` time that
 *  must carry a `Z`/offset so parsing is host-TZ independent. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/
const isIso = (v: string): boolean => {
  if (!ISO_RE.test(v) || !Number.isFinite(Date.parse(v))) return false
  // Date.parse normalizes out-of-range days ('2025-02-31' -> Mar 3) —
  // reject dates that do not exist on the calendar
  const year = Number(v.slice(0, 4))
  const month = Number(v.slice(5, 7))
  const day = Number(v.slice(8, 10))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= (daysInMonth[month - 1] ?? 0)
}

/** `bro judge stats` — reads only: the journal is the input, no
 *  backend is touched, so no auth and no connector resolution. */
function stats(argv: string[]): void {
  const STATS_FLAGS = new Set(['--json', '--replay'])
  const unknown: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a === '--since') {
      i += 1 // consumes its value
    } else if (!STATS_FLAGS.has(a) && !a.startsWith('--since=')) {
      unknown.push(a)
    }
  }
  if (unknown.length > 0) {
    console.error(`error: unknown stats option(s): ${unknown.join(', ')}`)
    process.exit(2)
  }
  const since = flag(argv, '--since')
  const asJson = argv.includes('--json')
  const replay = argv.includes('--replay')
  // ISO shape required — Date.parse also accepts locale strings like
  // 'January 1, 2025' that resolve to local midnight, so the same input
  // would filter differently per time zone
  if (since !== undefined && !isIso(since)) {
    console.error(`error: --since must be an ISO timestamp — got ${JSON.stringify(since)}`)
    process.exit(2)
  }
  const s = computeStats(readJournal(process.cwd()), { since, replay })
  if (asJson) {
    console.log(JSON.stringify(s, null, 2))
    return
  }
  console.log(formatStats(s, { since, replay }))
}

const REPLAY_VALUE_FLAGS = new Set(['--pr', '--merged-since', '--limit', '--connector'])

/** Replay's option set — anything else exits 2 before a backend is
 *  touched. `--name=value` counts as one arg; a bare value flag
 *  consumes the next. */
function checkReplayArgs(argv: string[]): void {
  const unknown: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    const name = a.split('=')[0]!
    if (REPLAY_VALUE_FLAGS.has(name)) {
      if (a === name) {
        i += 1 // separate-value form consumes its value
      }
      continue
    }
    if (a !== '--json') {
      unknown.push(a)
    }
  }
  if (unknown.length > 0) {
    console.error(`error: unknown replay option(s): ${unknown.join(', ')}`)
    process.exit(2)
  }
}

/** `bro judge replay` — the dogfood pass (spec §CLI): re-judge archived
 *  threads from merged PRs on the live chain, journal the verdicts as
 *  replay:true rows carrying their inferred outcomes, then print the
 *  replay-scoped stats report. The journal rows ARE the artifact —
 *  replay writes them regardless of judge.mode (replay:true keeps
 *  them out of live stats either way). */
async function replay(argv: string[]): Promise<void> {
  checkReplayArgs(argv)
  const prFlags = flagAll(argv, '--pr')
  const prs = prFlags
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map((v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`error: --pr expects PR numbers — got ${JSON.stringify(v)}`)
        process.exit(2)
      }
      return n
    })
  if (prFlags.length > 0 && prs.length === 0) {
    console.error('error: --pr was given but named no PR numbers')
    process.exit(2)
  }
  const mergedSince = flag(argv, '--merged-since')
  if (mergedSince !== undefined && !isIso(mergedSince)) {
    console.error(
      `error: --merged-since must be an ISO timestamp — got ${JSON.stringify(mergedSince)}`
    )
    process.exit(2)
  }
  const limitRaw = flag(argv, '--limit')
  const limit =
    limitRaw === undefined
      ? undefined
      : (() => {
          const n = Number(limitRaw)
          if (!Number.isInteger(n) || n <= 0) {
            console.error(`error: --limit expects a positive integer — got ${JSON.stringify(limitRaw)}`)
            process.exit(2)
          }
          return n
        })()
  const connector = flag(argv, '--connector')
  const asJson = argv.includes('--json')

  const dir = process.cwd()
  const prefer = loadBroConfig().connectors
  ensureAuth('reviews', { dir }, { prefer })
  judgeAuth(dir, connector, prefer)
  const rev = reviewHost(dir, prefer)
  const judge = judgeFacade(dir, { connector })
  const res = await replayMergedThreads({
    dir,
    repo: rev.resolveRepo([]),
    rev,
    judge,
    prs: prs.length > 0 ? prs : undefined,
    mergedSince,
    limit,
    budget: judgeConfig(dir).judge.maxDecisionsPerRun,
    onProgress: (msg) => console.error(msg),
  })
  console.error(
    `judge replay: ${res.prs} merged PR(s) · ${res.threads} thread(s) · ` +
      `${res.candidates} classifiable · ${res.judged} judged · ${res.cached} cached · ` +
      `${res.excluded} excluded · ${res.failed} failed · ${res.skipped} over budget`
  )
  // the report is the replay set's stats — the artifact reviewers read
  const s = computeStats(readJournal(dir), { replay: true })
  if (asJson) {
    console.log(JSON.stringify({ replay: res, stats: s }, null, 2))
    return
  }
  console.log(formatStats(s, { replay: true }))
}

const JUDGE_USAGE =
  'usage: bro judge <decide|stats|replay>\n' +
  '  bro judge decide --state <file|-> --questions <file> [--connector <name>] [--json]\n' +
  '  bro judge stats [--since <iso>] [--json] [--replay]\n' +
  '  bro judge replay [--pr <n>[,<n>…]…] [--merged-since <iso>] [--limit <n>] [--connector <name>] [--json]'

export async function runJudgeCommand(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (sub === 'decide') {
    await decide(argv.slice(1))
    return
  }
  if (sub === 'stats') {
    stats(argv.slice(1))
    return
  }
  if (sub === 'replay') {
    await replay(argv.slice(1))
    return
  }
  console.error(
    sub === undefined ? JUDGE_USAGE : `unknown judge subcommand: ${sub}\n${JUDGE_USAGE}`
  )
  process.exit(2)
}
