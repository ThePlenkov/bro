/**
 * Trigger matcher — the declarative half of a lesson (spec:
 * specs/sessions/bro-f4ot.1-learn.md). A trigger names hook events
 * (`on`) plus context conditions (`match`): conjunctive across keys,
 * disjunctive within a list — every present key must hit, any list
 * entry satisfies its key. A trigger with no `match` fires on the event
 * alone.
 *
 * The evidence plane is the session trace the hooks layer journals —
 * one JSONL line per post-tool event: `{ts, tool, command?, paths?,
 * ok?}`. Terms are a fuzzy haystack match (prompt text, session-context
 * lines, raw trace lines); commands/paths/tools/errors evaluate against
 * the parsed entries.
 */
import type { LessonTrigger, TriggerMatch } from './lesson.ts'

/** One journaled post-tool event. Fields absent from the hook payload
 *  stay absent — a `paths`/`tools` key on a tool family that never
 *  reports them simply can't match. */
export interface TraceEntry {
  ts?: number
  tool?: string
  command?: string
  paths?: string[]
  ok?: boolean
}

/** What a trigger evaluates against — `text` is the `terms` haystack
 *  (prompt, session context, raw trace tail), `trace` the parsed
 *  entries the structured keys see. */
export interface MatchContext {
  text: string
  trace: TraceEntry[]
}

/** Parse one journal line — a malformed or non-object line is skipped,
 *  never fatal (the journal is append-only; a torn last line must not
 *  blind the matcher). */
export function parseTraceLine(line: string): TraceEntry | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null
  }
  const e = v as Record<string, unknown>
  const out: TraceEntry = {}
  if (typeof e.ts === 'number') out.ts = e.ts
  if (typeof e.tool === 'string') out.tool = e.tool
  if (typeof e.command === 'string') out.command = e.command
  if (Array.isArray(e.paths)) {
    const paths = e.paths.filter((p): p is string => typeof p === 'string')
    if (paths.length > 0) out.paths = paths
  }
  if (typeof e.ok === 'boolean') out.ok = e.ok
  return out
}

// --- path globs ---------------------------------------------------------------
// Same convention as act's docsPaths: a pattern without a slash matches
// the basename ('bro.config.json' hits any dir), '**/' is zero-or-more
// directories, '*' stays inside a segment, '**' crosses '/', a trailing
// '/' means the dir at any depth.

const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|[^*?]+/g

function globToRe(glob: string): RegExp {
  const re = glob.replace(GLOB_TOKEN, (tok) => {
    switch (tok) {
      case '**/':
        return '(?:.*/)?'
      case '**':
        return '.*'
      case '*':
        return '[^/]*'
      case '?':
        return '[^/]'
      default:
        return tok.replace(/[^a-zA-Z0-9]/g, (c) => `\\${c}`)
    }
  })
  return new RegExp(`^${re}$`)
}

export function matchPath(path: string, pattern: string): boolean {
  const glob = pattern.endsWith('/') ? `**/${pattern}**` : pattern
  const target = glob.includes('/')
    ? path
    : path.slice(path.lastIndexOf('/') + 1)
  return globToRe(glob).test(target)
}

/** `commands` match prefixes against each command position in the
 *  traced shell line — `cd x && gh pr merge` still hits `gh pr merge`,
 *  while quoted text never reaches a command position: separators
 *  inside arguments are skipped by the scan (`echo "x; gh pr merge"`
 *  is one echo, not two commands — the same read the hooks arming
 *  classifier makes). Char-scan, not regex: a quoted-span alternation
 *  on uncontrolled trace data is a polynomial-regex finding. */
function commandHits(command: string, prefixes: string[]): boolean {
  const hits = (seg: string): boolean =>
    prefixes.some((p) => seg.trimStart().startsWith(p))
  let seg = ''
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== '') {
      if (c === '\\') {
        i++ // an escaped char can't close the quote
      } else if (c === quote) {
        quote = ''
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === ';' || c === '&' || c === '|') {
      if (hits(seg)) {
        return true
      }
      seg = ''
      continue
    }
    seg += c
  }
  return hits(seg)
}

/** Per-key verdicts for one `match` block — every present key gets a
 *  row; any list entry satisfies its key. `bro guard test` renders
 *  these; `triggerMatches` is their conjunction. */
export function matchKeys(
  m: TriggerMatch,
  ctx: MatchContext
): { key: string; ok: boolean }[] {
  const out: { key: string; ok: boolean }[] = []
  const text = ctx.text.toLowerCase()
  if (m.terms !== undefined) {
    out.push({
      key: 'terms',
      ok: m.terms.some((t) => text.includes(t.toLowerCase())),
    })
  }
  if (m.commands !== undefined) {
    out.push({
      key: 'commands',
      ok: ctx.trace.some(
        (e) => e.command !== undefined && commandHits(e.command, m.commands!)
      ),
    })
  }
  if (m.paths !== undefined) {
    out.push({
      key: 'paths',
      ok: ctx.trace.some((e) =>
        (e.paths ?? []).some((p) => m.paths!.some((g) => matchPath(p, g)))
      ),
    })
  }
  if (m.tools !== undefined) {
    out.push({
      key: 'tools',
      ok: ctx.trace.some((e) => e.tool !== undefined && m.tools!.includes(e.tool)),
    })
  }
  // errors is a boolean condition — `true` needs a failed landing in the
  // trace, `false` needs their absence
  if (m.errors !== undefined) {
    out.push({ key: 'errors', ok: m.errors === ctx.trace.some((e) => e.ok === false) })
  }
  return out
}

/**
 * Does the trigger's `match` block hold against this context? Every
 * present key must hit; any entry in a key's list satisfies it. Absent
 * `match` (or an empty one) means event-only — always true.
 */
export function triggerMatches(trigger: LessonTrigger, ctx: MatchContext): boolean {
  const m = trigger.match
  if (m === undefined) {
    return true
  }
  return matchKeys(m, ctx).every((k) => k.ok)
}
