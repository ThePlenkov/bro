/**
 * `bro learn <verb>` — the lesson store (spec:
 * specs/sessions/bro-f4ot.1-learn.md). Lessons live in `bd kv` under
 * the `learn/` prefix; this command is the CRUD surface — matcher,
 * capture, probe, and promote land in later milestones.
 *
 *   add --lesson "…" --on <event> [--on …] --evidence <kind>:<ref> [--evidence …]
 *        [--match-terms …] [--match-commands …] [--match-paths …]
 *        [--match-tools …] [--match-errors] [--budget N]
 *   list [--json] [--source …] [--confidence …]
 *   show <id>
 *   forget <id>
 */
import { checkBeads } from '@broject/core'
import {
  deriveConfidence,
  deleteLesson,
  EVIDENCE_KINDS,
  getLesson,
  HOOK_EVENTS,
  lessonId,
  listLessons,
  putLesson,
} from '@broject/learn'
import type { Evidence, HookEvent, Lesson } from '@broject/learn'
import { flag, flagAll, positionals } from './args.ts'

function usage(exitCode = 1): never {
  console.error(`Usage: bro learn <command> [args…]

Commands:
  add      Store a lesson — --lesson and ≥1 --evidence required
  list     All lessons [--json] [--source X] [--confidence X]
  show     One lesson as JSON: bro learn show learn-<slug>
  forget   Remove a lesson: bro learn forget learn-<slug>

add flags:
  --lesson TEXT        the rule — imperative, quotable as one line (required)
  --on EVENT           hook event, repeatable: ${HOOK_EVENTS.join(' | ')} (required ≥1)
  --match-terms V      substring triggers vs prompt/trace text (repeatable)
  --match-commands V   exec command prefixes in the trace (repeatable)
  --match-paths V      globs vs touched paths (repeatable)
  --match-tools V      tool names in the trace (repeatable)
  --match-errors       fire when the trace shows a failed tool landing
  --budget N           max fires per session (default 1)
  --evidence K:R       where it was learned, repeatable — kind: ${EVIDENCE_KINDS.join(' | ')} (required ≥1)`)
  process.exit(exitCode)
}

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--lesson',
  '--on',
  '--match-terms',
  '--match-commands',
  '--match-paths',
  '--match-tools',
  '--budget',
  '--evidence',
  '--source',
  '--confidence',
])

const learnPositionals = (argv: string[]): string[] => positionals(argv, VALUE_FLAGS)

function fail(msg: string, code = 2): never {
  console.error(`error: ${msg}`)
  process.exit(code)
}

/** `--on post-tool` / `--on a,b` → validated hook events, deduped. */
function hookEvents(values: string[]): HookEvent[] {
  const out: HookEvent[] = []
  for (const v of values.flatMap((s) => s.split(','))) {
    const e = v.trim()
    if (e === '') continue
    if (!(HOOK_EVENTS as readonly string[]).includes(e)) {
      fail(`--on must be one of: ${HOOK_EVENTS.join(', ')} — got "${e}"`)
    }
    if (!out.includes(e as HookEvent)) out.push(e as HookEvent)
  }
  return out
}

/** `--evidence bead:bro-abc` — kind:ref, both halves required. */
function evidence(values: string[]): Evidence[] {
  return values.map((v) => {
    const i = v.indexOf(':')
    const kind = i < 0 ? '' : v.slice(0, i)
    const ref = i < 0 ? '' : v.slice(i + 1).trim()
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind) || ref === '') {
      fail(`--evidence must be <kind>:<ref>, kind one of: ${EVIDENCE_KINDS.join(', ')} — got "${v}"`)
    }
    return { kind: kind as Evidence['kind'], ref }
  })
}

function warnSkipped(skipped: { key: string; problems: string[] }[]): void {
  for (const s of skipped) {
    console.error(`warning: skipped ${s.key} — ${s.problems[0]}`)
  }
}

function cmdAdd(argv: string[]): void {
  const text = flag(argv, '--lesson')
  if (text === undefined || text.trim() === '') {
    fail('--lesson is required')
  }
  const on = hookEvents(flagAll(argv, '--on'))
  if (on.length === 0) {
    fail('--on is required (≥1 of: ' + HOOK_EVENTS.join(', ') + ')')
  }
  const ev = evidence(flagAll(argv, '--evidence'))
  if (ev.length === 0) {
    fail('--evidence is required — a lesson must cite where it was learned')
  }
  const budgetRaw = flag(argv, '--budget')
  const budget = budgetRaw === undefined ? undefined : Number(budgetRaw)
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 1)) {
    fail('--budget must be a positive integer')
  }
  const terms = flagAll(argv, '--match-terms')
  const commands = flagAll(argv, '--match-commands')
  const paths = flagAll(argv, '--match-paths')
  const tools = flagAll(argv, '--match-tools')
  const match = {
    ...(terms.length > 0 ? { terms } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(argv.includes('--match-errors') ? { errors: true } : {}),
  }
  const lesson: Lesson = {
    id: lessonId(text),
    trigger: {
      on,
      ...(Object.keys(match).length > 0 ? { match } : {}),
      ...(budget !== undefined ? { budget } : {}),
    },
    lesson: text.trim(),
    evidence: ev,
    confidence: deriveConfidence(ev),
    source: 'manual',
    createdAt: new Date().toISOString(),
  }
  if (getLesson(lesson.id) !== null) {
    fail(`${lesson.id} already exists — forget it first, or the rule is already stored`, 1)
  }
  putLesson(lesson)
  console.log(lesson.id)
}

function cmdList(argv: string[]): void {
  const json = argv.includes('--json')
  const sources = new Set(flagAll(argv, '--source'))
  const confidences = new Set(flagAll(argv, '--confidence'))
  const { lessons, skipped } = listLessons()
  warnSkipped(skipped)
  const rows = lessons.filter(
    (l) =>
      (sources.size === 0 || sources.has(l.source)) &&
      (confidences.size === 0 || confidences.has(l.confidence))
  )
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  for (const l of rows) {
    console.log(`${l.id}\t${l.confidence}\t${l.source}\t${l.trigger.on.join(',')}\t${l.lesson}`)
  }
}

function cmdShow(argv: string[]): void {
  const [id] = learnPositionals(argv)
  if (id === undefined) {
    fail('usage: bro learn show <learn-id>')
  }
  const lesson = getLesson(id.replace(/^learn\//, ''))
  if (lesson === null) {
    fail(`no lesson ${id}`, 1)
  }
  console.log(JSON.stringify(lesson, null, 2))
}

function cmdForget(argv: string[]): void {
  const [id] = learnPositionals(argv)
  if (id === undefined) {
    fail('usage: bro learn forget <learn-id>')
  }
  const normalized = id.replace(/^learn\//, '')
  if (getLesson(normalized) === null) {
    fail(`no lesson ${id}`, 1)
  }
  deleteLesson(normalized)
  console.log(`forgot ${normalized}`)
}

export function runLearnCommand(argv: string[]): void {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    usage(cmd === undefined ? 1 : 0)
  }
  checkBeads()
  switch (cmd) {
    case 'add':
      cmdAdd(rest)
      return
    case 'list':
      cmdList(rest)
      return
    case 'show':
      cmdShow(rest)
      return
    case 'forget':
      cmdForget(rest)
      return
    default:
      console.error(`error: unknown learn command "${cmd}"`)
      usage()
  }
}
