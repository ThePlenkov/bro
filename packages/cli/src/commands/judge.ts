/**
 * `bro judge decide --state <file|-> --questions <file>` — the judge
 * connector's smoke path (spec: specs/sessions/bro-f4ot.2-judge.md,
 * milestone bro-f4ot.2.2). One decide() call over the resolved chain
 * (primary → `judge.fallback` escalation), printing answers, model,
 * latency, and usage. stats/replay land in later milestones.
 *
 * The smoke test exercises the connector, not the mode gate — it runs
 * whatever `judge.mode` says; `mode` governs consumers (annotation),
 * not explicit invocation.
 */
import { readFileSync } from 'node:fs'
import { ensureAuth, JudgeUnavailable } from '@broject/core'
import type { DecideResult, JudgeAnswer, JudgeQuestion } from '@broject/core'
import { appendRow, judgeConfig, judgeFacade } from '@broject/judge'
import { flag } from './args.ts'
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
  ensureAuth('judge', { dir }, { connector, prefer: loadBroConfig().connectors })
  const state = loadState(stateRef)
  const questions = loadQuestions(questionsRef)
  try {
    const res = await judgeFacade(dir, { connector }).decide(state, questions)
    // shadow mode journals every decide() a bro command makes — the
    // smoke path included, under its own kind so stats keep it out of
    // the act-thread agreement set
    if (judgeConfig(dir).judge.mode === 'shadow') {
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

export async function runJudgeCommand(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (sub === 'decide') {
    await decide(argv.slice(1))
    return
  }
  console.error(
    sub === undefined
      ? 'usage: bro judge decide --state <file|-> --questions <file> [--connector <name>] [--json]'
      : `unknown judge subcommand: ${sub} — available: decide`
  )
  process.exit(2)
}
