/**
 * `bro learn <verb>` — the lesson store (spec:
 * specs/sessions/bro-f4ot.1-learn.md). Lessons live in `bd kv` under
 * the `learn/` prefix; this command is the CRUD surface — the matcher
 * and connector live in @broject/learn, promote is still pending.
 *
 *   add --lesson "…" --on <event> [--on …] --evidence <kind>:<ref> [--evidence …]
 *        [--match-terms …] [--match-commands …] [--match-paths …]
 *        [--match-tools …] [--match-errors] [--budget N]
 *   list [--json] [--source …] [--confidence …]
 *   show <id>
 *   forget <id>
 *   capture [--source drill|retro|act|mol|all] [--mol ID] [--dry-run] [--json]
 *   probe <question> [--lesson "…" --on … --match-… …] [--session ID] [--json]
 */
import { checkBeads } from '@broject/core'
import {
  CAPTURE_SOURCES,
  captureLessons,
  CONFIDENCES,
  deriveConfidence,
  deleteLesson,
  EVIDENCE_KINDS,
  getLesson,
  HOOK_EVENTS,
  LESSON_SOURCES,
  lessonId,
  lessonIds,
  listLessons,
  probeQuestion,
  probeTrigger,
  putLesson,
  recordProbeAnswer,
  withStoreLock,
} from '@broject/learn'
import type {
  CaptureSource,
  Evidence,
  HookEvent,
  Lesson,
  LessonTrigger,
  TriggerMatch,
} from '@broject/learn'
import { flag, flagAll, positionals } from './args.ts'

function usage(exitCode = 1): never {
  console.error(`Usage: bro learn <command> [args…]

Commands:
  add      Store a lesson — --lesson and ≥1 --evidence required
  list     All lessons [--json] [--source X] [--confidence X]
  show     One lesson as JSON: bro learn show learn-<slug>
  forget   Remove a lesson: bro learn forget learn-<slug>
  capture  Harvest finished artifacts into lessons
           [--source drill|retro|act|mol|all] [--mol ID] [--dry-run] [--json]
  probe    Store-first query: bro learn probe <question>
           hit → print ranked lessons; miss → question + candidates, gap logged
           phase 2 stores the answer: --lesson "…" [--on E…] [--match-… …]

add flags:
  --lesson TEXT        the rule — imperative, quotable as one line (required)
  --on EVENT           hook event, repeatable: ${HOOK_EVENTS.join(' | ')} (required ≥1)
  --match-terms V      substring triggers vs prompt/trace text (repeatable)
  --match-commands V   exec command prefixes in the trace (repeatable)
  --match-paths V      globs vs touched paths (repeatable)
  --match-tools V      tool names in the trace (repeatable)
  --match-errors       fire when the trace shows a failed tool landing
  --budget N           max fires per session (default 1)
  --evidence K:R       where it was learned, repeatable — kind: ${EVIDENCE_KINDS.join(' | ')} (required ≥1)

probe flags:
  --session ID         attribute the probe to a session (default: the
                       newest live session marker, else 'cli')
  --json               machine-readable phase-1 result
  --lesson/--on/--match-…/--budget/--evidence  phase 2 — as add, but
                       --evidence is optional (session + question auto-record)`)
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
  '--mol',
  '--session',
])

/** Options each verb accepts — a `--name=value` spelling counts as the
 *  same option (flag() honors it; flagAll's gap is bro-mzb9 debt). */
const KNOWN_FLAGS: Record<string, ReadonlySet<string>> = {
  add: new Set([
    '--lesson',
    '--on',
    '--match-terms',
    '--match-commands',
    '--match-paths',
    '--match-tools',
    '--match-errors',
    '--budget',
    '--evidence',
  ]),
  list: new Set(['--json', '--source', '--confidence']),
  show: new Set(),
  forget: new Set(),
  capture: new Set(['--source', '--mol', '--dry-run', '--json']),
  probe: new Set([
    '--lesson',
    '--on',
    '--match-terms',
    '--match-commands',
    '--match-paths',
    '--match-tools',
    '--match-errors',
    '--budget',
    '--evidence',
    '--session',
    '--json',
  ]),
}

const learnPositionals = (argv: string[]): string[] => positionals(argv, VALUE_FLAGS)

/** A misspelled option is a typo, not input — writes fail closed. */
function rejectUnknownFlags(sub: string, rest: string[]): void {
  const known = KNOWN_FLAGS[sub] ?? new Set<string>()
  for (const arg of rest) {
    if (arg.startsWith('--') && !known.has(arg.split('=')[0]!)) {
      console.error(`error: unknown option "${arg}" for learn ${sub}`)
      process.exit(2)
    }
  }
}

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

/** The --match-* cluster, shared by add and probe's phase 2. */
function matchFlags(argv: string[]): TriggerMatch {
  const terms = flagAll(argv, '--match-terms')
  const commands = flagAll(argv, '--match-commands')
  const paths = flagAll(argv, '--match-paths')
  const tools = flagAll(argv, '--match-tools')
  return {
    ...(terms.length > 0 ? { terms } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(boolFlag(argv, '--match-errors') ? { errors: true } : {}),
  }
}

function budgetFlag(argv: string[]): number | undefined {
  const raw = flag(argv, '--budget')
  const budget = raw === undefined ? undefined : Number(raw)
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 1)) {
    fail('--budget must be a positive integer')
  }
  return budget
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
  const budget = budgetFlag(argv)
  const match = matchFlags(argv)
  // the contract is one imperative line — a pasted multi-line rule
  // would spill `list` output into continuation rows
  const rule = text.trim().replace(/\s+/g, ' ')
  const lesson: Lesson = {
    id: lessonId(rule),
    trigger: {
      on,
      ...(Object.keys(match).length > 0 ? { match } : {}),
      ...(budget !== undefined ? { budget } : {}),
    },
    lesson: rule,
    evidence: ev,
    confidence: deriveConfidence(ev),
    source: 'manual',
    createdAt: new Date().toISOString(),
  }
  // validation before checkBeads — a missing flag must report itself,
  // not a beads setup error
  checkBeads()
  // check-and-write under the store lock — a concurrent capture/probe
  // merge between the read and the write could be overwritten otherwise
  // (bd kv has no CAS). lessonIds, not getLesson — a corrupt key squats
  // its id too, and dedup must refuse it the same way
  withStoreLock(undefined, () => {
    if (lessonIds().has(lesson.id)) {
      fail(`${lesson.id} already exists — forget it first, or the rule is already stored`, 1)
    }
    putLesson(lesson)
  })
  console.log(lesson.id)
}

function enumFlag(argv: string[], name: string, allowed: readonly string[]): Set<string> {
  const values = flagAll(argv, name)
  for (const v of values) {
    if (!allowed.includes(v)) {
      fail(`${name} must be one of: ${allowed.join(', ')} — got "${v}"`)
    }
  }
  return new Set(values)
}

function cmdList(argv: string[]): void {
  if (learnPositionals(argv).length > 0) {
    fail(`usage: bro learn list [--json] [--source X] [--confidence X]`)
  }
  const json = argv.includes('--json')
  const sources = enumFlag(argv, '--source', LESSON_SOURCES)
  const confidences = enumFlag(argv, '--confidence', CONFIDENCES)
  checkBeads()
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

function oneId(argv: string[], sub: string): string {
  const pos = learnPositionals(argv)
  if (pos.length !== 1) {
    fail(`usage: bro learn ${sub} <learn-id>`)
  }
  return pos[0]!.replace(/^learn\//, '')
}

function cmdShow(argv: string[]): void {
  const id = oneId(argv, 'show')
  checkBeads()
  const lesson = getLesson(id)
  if (lesson === null) {
    fail(`no lesson ${id}`, 1)
  }
  console.log(JSON.stringify(lesson, null, 2))
}

function cmdForget(argv: string[]): void {
  const id = oneId(argv, 'forget')
  checkBeads()
  if (getLesson(id) === null) {
    fail(`no lesson ${id}`, 1)
  }
  deleteLesson(id)
  console.log(`forgot ${id}`)
}

/** `--source drill|retro|act|mol|all` — repeatable, 'all' folds to every
 *  source (mol still needs --mol; it can't harvest an unnamed molecule). */
function captureSources(argv: string[]): CaptureSource[] | undefined {
  const values = flagAll(argv, '--source')
  if (values.length === 0) {
    return undefined
  }
  const allowed = [...CAPTURE_SOURCES, 'all']
  const out = new Set<CaptureSource>()
  for (const v of values.flatMap((s) => s.split(','))) {
    const s = v.trim()
    if (s === '') continue
    if (!allowed.includes(s)) {
      fail(`--source must be one of: ${allowed.join(', ')} — got "${s}"`)
    }
    if (s === 'all') {
      for (const src of CAPTURE_SOURCES) out.add(src)
    } else {
      out.add(s as CaptureSource)
    }
  }
  if (out.size === 0) {
    fail('--source requires at least one source')
  }
  return [...out]
}

/** Boolean flags accept the bare and `=true|false` spellings — anything
 *  else fails closed rather than silently writing on a typo'd value. */
function boolFlag(argv: string[], name: string): boolean {
  const occurrences = argv.filter((a) => a === name || a.startsWith(`${name}=`))
  if (occurrences.length > 1) {
    fail(`${name} may be given only once`)
  }
  const arg = occurrences[0]
  if (arg === undefined) return false
  if (arg === name) return true
  const v = arg.slice(name.length + 1)
  if (v !== 'true' && v !== 'false') {
    fail(`${name} must be true|false — got "${v}"`)
  }
  return v === 'true'
}

function cmdCapture(argv: string[]): void {
  if (learnPositionals(argv).length > 0) {
    fail(`usage: bro learn capture [--source X] [--mol ID] [--dry-run] [--json]`)
  }
  const sources = captureSources(argv)
  const mol = flag(argv, '--mol')
  const dryRun = boolFlag(argv, '--dry-run')
  const json = boolFlag(argv, '--json')
  if (mol === undefined && sources?.includes('mol')) {
    fail('--source mol requires --mol <id> — name the molecule to harvest')
  }
  if (mol !== undefined && sources !== undefined && !sources.includes('mol')) {
    fail('--mol given but mol is not in --source — the molecule would never run')
  }
  checkBeads()
  const { plan } = captureLessons({
    ...(sources !== undefined ? { sources } : {}),
    ...(mol !== undefined ? { mol } : {}),
    dryRun,
  })
  if (json) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  const verb = dryRun ? 'would capture' : 'captured'
  for (const w of plan.write) {
    const l = w.lesson
    console.log(
      `${verb} ${l.id}\t${l.source}\t${l.trigger.on.join(',')}\t` +
        `${l.evidence.length} evidence\t${l.lesson}`
    )
  }
  const mergeVerb = dryRun ? 'would merge' : 'merged'
  for (const m of plan.merge) {
    console.log(`${mergeVerb} ${m.lesson.id}\t+${m.added.length} evidence\t${m.lesson.lesson}`)
  }
  for (const s of plan.skipped) {
    console.error(`skip ${s.origin} — ${s.reason}`)
  }
  if (plan.write.length === 0 && plan.merge.length === 0) {
    console.log('nothing to capture')
  }
}

/** Phase-2 flags — meaningless on a query; reject rather than drop. */
const PHASE2_FLAGS: readonly string[] = [
  '--on',
  '--match-terms',
  '--match-commands',
  '--match-paths',
  '--match-tools',
  '--match-errors',
  '--budget',
  '--evidence',
]

/** Phase 1 — the store-first query. Ends the command via exitCode —
 *  never process.exit, which would truncate the output just printed. */
function probePhase1(argv: string[], question: string, sessionId?: string): void {
  const stray = argv.find((a) => PHASE2_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)))
  if (stray !== undefined) {
    fail(`${stray.split('=')[0]} records an answer — it needs --lesson`)
  }
  // flag errors must beat a beads setup error — validate --json
  // before checkBeads (and before a miss can log a gap)
  const json = boolFlag(argv, '--json')
  checkBeads()
  const res = probeQuestion(question, { ...(sessionId !== undefined ? { sessionId } : {}) })
  warnSkipped(res.skipped)
  // exitCode, not process.exit — a hard exit mid-flush truncates piped
  // output (the hits the caller just printed)
  if (json) {
    console.log(JSON.stringify(res, null, 2))
    process.exitCode = res.hits.length > 0 ? 0 : 1
    return
  }
  if (res.hits.length > 0) {
    for (const h of res.hits) {
      const l = h.lesson
      console.log(`${l.id}\t${l.confidence}\t${l.source}\t${l.trigger.on.join(',')}\t${l.lesson}`)
    }
    process.exitCode = 0
    return
  }
  console.log(`probe: ${res.question}`)
  for (const c of res.candidates) {
    console.log(`  ${c}`)
  }
  console.log(
    'no stored lesson — investigate, then store the answer: ' +
      `bro learn probe "${res.question}" --lesson "…"`
  )
  process.exitCode = 1
}

/** The phase-2 trigger — explicit flags win; absent them the question's
 *  own terms index the answer (the question IS the trigger). A bare
 *  --budget is a policy on that trigger, never a reason to fire on
 *  everything. */
function probePhase2Trigger(
  question: string,
  on: HookEvent[],
  match: TriggerMatch,
  budget?: number
): LessonTrigger {
  if (on.length > 0 || Object.keys(match).length > 0) {
    return {
      // structured keys still evaluate on these events — both probes'
      // contexts carry a trace tail
      on: on.length > 0 ? on : ['session-start', 'prompt-submit'],
      ...(Object.keys(match).length > 0 ? { match } : {}),
      ...(budget !== undefined ? { budget } : {}),
    }
  }
  const base = probeTrigger(question)
  if (base === undefined) {
    fail('probe needs a trigger — give --on/--match-* or a question with usable terms')
  }
  return { ...base, ...(budget !== undefined ? { budget } : {}) }
}

/**
 * `probe <question>` — the two-phase query (spec §Probe).
 * Phase 1 ranks stored lessons against the question's terms: hits print
 * ranked and exit 0 (the knowledge was already paid for). A miss prints
 * the question plus gathered candidates and logs it to the fired set as
 * an open gap — exit 1 (grep semantics: found / not found / 2 = usage).
 * `--lesson` switches to phase 2: store the distilled answer as a
 * `source: probe` lesson; evidence auto-records the probe session and
 * the question itself, explicit --evidence adds citations on top.
 */
function cmdProbe(argv: string[]): void {
  const pos = learnPositionals(argv)
  const question = pos.join(' ').trim()
  if (question === '') {
    fail(`usage: bro learn probe <question> [--lesson "…" --on … --match-… …]`)
  }
  const sessionId = flag(argv, '--session')
  const answer = flag(argv, '--lesson')
  if (answer === undefined) {
    probePhase1(argv, question, sessionId)
    return // phase 1 ends the command — exitCode carries the verdict
  }
  // phase 2 — validate before touching the store, as cmdAdd does:
  // a malformed flag must report the flag, not a beads setup error
  const on = hookEvents(flagAll(argv, '--on'))
  const match = matchFlags(argv)
  const budget = budgetFlag(argv)
  const extra = evidence(flagAll(argv, '--evidence'))
  checkBeads()
  const res = recordProbeAnswer({
    question,
    lesson: answer,
    trigger: probePhase2Trigger(question, on, match, budget),
    evidence: extra,
    ...(sessionId !== undefined ? { sessionId } : {}),
  })
  if (res.merged) {
    console.error(`merged evidence into existing ${res.lesson.id}`)
  }
  console.log(res.lesson.id)
}

export function runLearnCommand(argv: string[]): void {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    usage(cmd === undefined ? 1 : 0)
  }
  // own-key lookup — an inherited key like `toString` is not a subcommand
  if (!Object.hasOwn(KNOWN_FLAGS, cmd)) {
    console.error(`error: unknown learn command "${cmd}"`)
    usage()
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    usage(0)
  }
  rejectUnknownFlags(cmd, rest)
  // each verb validates its input before checkBeads — a missing flag or
  // argument must report itself, not a beads setup error
  switch (cmd) {
    case 'add':
      if (learnPositionals(rest).length > 0) {
        fail(`unexpected argument "${learnPositionals(rest)[0]!}" — add takes flags only`)
      }
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
    case 'capture':
      cmdCapture(rest)
      return
    case 'probe':
      cmdProbe(rest)
      return
  }
}
