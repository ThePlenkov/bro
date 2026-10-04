/**
 * Capture — distills finished artifacts into trigger-shaped lessons
 * (spec: specs/sessions/bro-f4ot.1-learn.md §Capture). Sources:
 *
 *   drill  closed drill frames' up-memos (## Result + ## Prevention in
 *          `notes`) and closed `prevention` beads carrying a `sink:`
 *          route — those auto-capture: routed means the item already
 *          went through its gate. The memo becomes the lesson, the
 *          frame's scope (paths, commands) the trigger match, the bead
 *          id the evidence.
 *   retro  closed `retro` beads written by `bro retrospect record` —
 *          root cause (## Why, or a legacy PREVENT: line) becomes the
 *          lesson; the retro and its originating `wtf` bead are the
 *          evidence.
 *   act    closed `debt` beads — findings recurring across PRs (same
 *          fingerprint, or times_seen > 1) become lessons triggered on
 *          the paths that attracted them.
 *   mol    `--mol <id>` harvests a closed molecule's steps: a
 *          `--result` line flagged `learn:`/`learning:` is distilled
 *          (the flag is the contract — an unflagged result is a
 *          handoff, not a lesson). Drill/retro artifacts a run produced
 *          land through their own sources; dedup unions the evidence.
 *
 * Dedup is by normalized lesson text (the `learn-<slug>` id): re-
 * capturing a source merges the new evidence refs and recomputes
 * confidence instead of writing a second lesson. `dryRun` renders the
 * would-be plan — capture is a proposal surface.
 */
import { bdJson, taskStore } from '@broject/core'
import type { TaskRow } from '@broject/core'
import {
  deriveConfidence,
  lessonId,
  type Confidence,
  type Evidence,
  type Lesson,
  type LessonSource,
  type LessonTrigger,
  type TriggerMatch,
} from './lesson.ts'
import {
  getLesson,
  LessonStoreError,
  listLessons,
  putLesson,
  withStoreLock,
} from './store.ts'

export const CAPTURE_SOURCES = ['drill', 'retro', 'act', 'mol'] as const
export type CaptureSource = (typeof CAPTURE_SOURCES)[number]

const CLOSED = new Set(['closed', 'done'])
const isClosed = (r: TaskRow): boolean => r.status !== undefined && CLOSED.has(r.status)
const hasLabel = (r: TaskRow, label: string): boolean => r.labels?.includes(label) ?? false

/** The lesson is quotable as one line — collapse a memo/section the
 *  same way `add` normalizes --lesson. */
const oneLine = (s: string): string => s.trim().replace(/\s+/g, ' ')

const beadEvidence = (id: string): Evidence => ({ kind: 'bead', ref: id })

// --- trigger scope -------------------------------------------------------------
// A lesson that can't name when it fires is trigger rot. Structured keys
// (paths/commands) ride the post-tool trace; when a source has neither,
// title terms ride session-start/prompt-submit instead; nothing at all
// skips the artifact.

/** CLIs a trigger prefix makes sense for — `bro act merge` is a useful
 *  prefix, `the fix` is not. 2–3 leading words, no flags. */
const COMMAND_RE =
  /\b(?:bro|bd|gh|glab|npm|npx|pnpm|yarn|bun|node|tsx|git|docker|cargo|curl)\s+[a-z][\w-]*(?:\s+[a-z][\w-]*)?/g

/** Repo-ish paths: anything containing a '/' (`specs/sessions`,
 *  `packages/learn/**`) and bare filenames with a real extension
 *  (`bro.config.json`, `SKILL.md`, `AGENTS.md`). */
const SLASH_PATH_RE = /[\w@.*+-]+(?:\/[\w@.*+-]+)+\/?/g
const FILE_RE =
  /\b[\w.-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|md|json|jsonc|toml|ya?ml|sh|py|rs|go|sql|lock|env|ini|cfg|txt)\b/g

export const TERM_RE = /[a-z][a-z0-9-]{3,}/g

/** Words too common to discriminate a prompt/context — a term that
 *  matches every session is a fire-on-everything trigger. */
export const TERM_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'when', 'then', 'than', 'have', 'been',
  'were', 'will', 'would', 'should', 'could', 'about', 'into', 'over',
  'after', 'before', 'because', 'through', 'their', 'there', 'where',
  'what', 'which', 'while', 'also', 'just', 'only', 'more', 'some',
  'such', 'other', 'each', 'very', 'most', 'make', 'made', 'keep',
  'work', 'working', 'thing', 'things', 'need', 'needs', 'like', 'them',
  'they', 'does', 'done', 'doing', 'being', 'same', 'must', 'still',
])

function collect(re: RegExp, text: string, cap: number): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(re)) {
    const v = m[0].replace(/[),.;:'"`\]]+$/, '')
    if (v !== '' && !v.includes('://')) {
      out.add(v)
    }
    if (out.size >= cap) break
  }
  return [...out]
}

/** Structured trigger keys from a scope text — capped so a lesson
 *  doesn't carry a whole file tree in its trigger. */
function scopeMatch(text: string): TriggerMatch {
  const match: TriggerMatch = {}
  // URLs are not trigger paths — strip them so `example.com/foo` can't
  // ride SLASH_PATH_RE into a post-tool trigger on a non-local "path"
  const t = text.replace(/\bhttps?:\/\/\S+/g, ' ')
  const paths = [
    ...collect(SLASH_PATH_RE, t, 5),
    ...collect(FILE_RE, t, 4),
  ]
  const commands = collect(COMMAND_RE, t, 5)
  if (paths.length > 0) match.paths = [...new Set(paths)].slice(0, 6)
  if (commands.length > 0) match.commands = commands
  return match
}

/** Fallback trigger material — significant title words for the
 *  prompt/context haystack. */
function scopeTerms(title: string): string[] {
  const terms: string[] = []
  for (const m of title.toLowerCase().matchAll(TERM_RE)) {
    if (TERM_STOPWORDS.has(m[0]) || terms.includes(m[0])) continue
    terms.push(m[0])
    if (terms.length >= 4) break
  }
  return terms
}

/**
 * The trigger for a captured artifact: post-tool when the scope names
 * paths/commands (the trace is its evidence plane), else
 * session-start/prompt-submit on title terms, else undefined — the
 * caller skips (a trigger that can't name its condition is rot, not a
 * lesson).
 */
function buildTrigger(title: string, scopeText: string): LessonTrigger | undefined {
  const match = scopeMatch(`${title}\n${scopeText}`)
  if (match.paths !== undefined || match.commands !== undefined) {
    return { on: ['post-tool'], match }
  }
  const terms = scopeTerms(title)
  if (terms.length > 0) {
    return { on: ['session-start', 'prompt-submit'], match: { terms } }
  }
  return undefined
}

// --- shared row plumbing ---------------------------------------------------------

export interface CaptureCandidate {
  lesson: string
  trigger: LessonTrigger
  evidence: Evidence[]
  source: LessonSource
  /** bead/mol id the candidate was distilled from — the report names it */
  origin: string
  /** a closed+routed artifact already held under its gate (spec
   *  confidence ladder: one gated evidence is 'established') */
  heldUnderGate?: boolean
  /** pins a fresh write's confidence instead of deriving it — for
   *  sources whose whole evidence set is one investigation citing
   *  itself. Merges always derive from the union. */
  confidence?: Confidence
  /** union this trigger into the existing lesson's on merge — a repeat
   *  of the new context must still index the rule it joined */
  mergeTrigger?: boolean
}

export interface CaptureSkip {
  origin: string
  reason: string
}

interface Harvest {
  candidates: CaptureCandidate[]
  skipped: CaptureSkip[]
}

/** `bd dep list` neighbors — hydrated rows both directions; rows without
 *  an id aren't issues (edge objects from a drifted bd) and drop out. */
function depRows(id: string, dir?: string): TaskRow[] {
  const rows = taskStore(dir).deps<TaskRow>([id], { type: 'discovered-from' })
  return rows.filter((r) => typeof r?.id === 'string')
}

/** Evidence beads for a harvested row: itself plus discovered-from
 *  neighbors wearing one of `labels` (wtf/drill/retro/prevention). */
function beadPlusDeps(row: TaskRow, labels: string[]): Evidence[] {
  const ev: Evidence[] = [beadEvidence(row.id)]
  try {
    for (const dep of depRows(row.id)) {
      if (labels.some((l) => hasLabel(dep, l)) && dep.id !== row.id) {
        ev.push(beadEvidence(dep.id))
      }
    }
  } catch {
    // a dep-list failure keeps the artifact's own id — evidence degrades,
    // never blocks the harvest
  }
  return ev
}

function listLabeled(label: string, dir?: string): TaskRow[] {
  // the -l filter is bd's; the client-side recheck keeps a backend that
  // ignores it from feeding every row to every harvester
  return taskStore(dir)
    .list<TaskRow>({ labels: [label], all: true, limit: 0 })
    .filter((r) => hasLabel(r, label))
}

// --- drill ----------------------------------------------------------------------

/** The up-memo `drillUp` wrote: `## Result\n\nX\n\n## Prevention\n\n- a`. */
function drillMemo(notes: string | undefined): { result: string; prevents: string[] } | null {
  if (!notes?.includes('## Result')) {
    return null
  }
  const result = /##\s*Result\s*\n+([\s\S]*?)(?=\n##|\s*$)/.exec(notes)?.[1]?.trim() ?? ''
  const prevents = [
    ...(/##\s*Prevention\s*\n+([\s\S]*)$/.exec(notes)?.[1] ?? '').matchAll(/^\s*-\s+(.+)$/gm),
  ]
    .map((m) => m[1]!.trim())
    .filter((p) => p !== '')
  if (result === '' && prevents.length === 0) {
    return null
  }
  return { result, prevents }
}

function harvestDrill(dir?: string): Harvest {
  const out: Harvest = { candidates: [], skipped: [] }
  for (const frame of listLabeled('drill', dir).filter(isClosed)) {
    // bd list omits notes — the memo needs a show per closed frame
    const row = taskStore(dir).get<TaskRow>(frame.id) ?? frame
    const memo = drillMemo(row.notes)
    if (memo === null) {
      out.skipped.push({ origin: frame.id, reason: 'closed drill frame has no result memo' })
      continue
    }
    const lesson =
      memo.prevents.length > 0
        ? oneLine(`${memo.result} — prevent: ${memo.prevents.join('; ')}`)
        : oneLine(memo.result)
    const trigger = buildTrigger(
      row.title ?? '',
      `${row.description ?? ''}\n${row.notes ?? ''}`
    )
    if (trigger === undefined) {
      out.skipped.push({ origin: frame.id, reason: 'no trigger scope (paths/commands/terms)' })
      continue
    }
    out.candidates.push({
      lesson,
      trigger,
      // the frame's own prevention beads corroborate the memo
      evidence: beadPlusDeps(row, ['prevention']),
      source: 'capture:drill',
      origin: frame.id,
    })
  }
  // a closed prevention bead with a `sink:` route is captured without a
  // flag — routed means it already went through its gate
  for (const row of listLabeled('prevention', dir).filter(isClosed)) {
    if (!row.labels?.some((l) => l.startsWith('sink:'))) {
      continue
    }
    const lesson = oneLine((row.title ?? '').replace(/^(?:prevention|retro):\s*/i, ''))
    if (lesson === '') {
      out.skipped.push({ origin: row.id, reason: 'prevention bead has no lesson text' })
      continue
    }
    const trigger = buildTrigger(row.title ?? '', row.description ?? '')
    if (trigger === undefined) {
      out.skipped.push({ origin: row.id, reason: 'no trigger scope (paths/commands/terms)' })
      continue
    }
    out.candidates.push({
      lesson,
      trigger,
      // the frame/retro it was discovered-from corroborates the item
      evidence: beadPlusDeps(row, ['drill', 'retro']),
      source: 'capture:drill',
      origin: row.id,
      heldUnderGate: true,
    })
  }
  return out
}

// --- retro -----------------------------------------------------------------------

/** `## What`/`## Why`/`scope:` (recordRetro's memo) or the legacy
 *  `WHAT:`/`WHY:`/`PREVENT:` inline form. The prevention text wins —
 *  it is already imperative; else the root cause is the durable bit. */
function retroLesson(description: string): string {
  const prevent = /PREVENT:\s*([\s\S]+?)(?=\n(?:##|[A-Z]+:)|$)/.exec(description)?.[1]
  if (prevent !== undefined && prevent.trim() !== '') {
    return oneLine(prevent)
  }
  const why = /##\s*Why\s*\n+([\s\S]*?)(?=\n##|\nscope:|$)/.exec(description)?.[1]
  if (why !== undefined && why.trim() !== '') {
    return oneLine(why)
  }
  const whyInline = /WHY:\s*([\s\S]+?)(?=\n(?:##|[A-Z]+:)|$)/.exec(description)?.[1]
  if (whyInline !== undefined && whyInline.trim() !== '') {
    return oneLine(whyInline)
  }
  const what = /##\s*What\s*\n+([\s\S]*?)(?=\n##|\nscope:|$)/.exec(description)?.[1]
  return oneLine(what ?? description)
}

function harvestRetro(dir?: string): Harvest {
  const out: Harvest = { candidates: [], skipped: [] }
  for (const row of listLabeled('retro', dir).filter(isClosed)) {
    // prevention beads can also wear `retro` — the drill pass owns them
    if (hasLabel(row, 'prevention')) {
      continue
    }
    const lesson = retroLesson(row.description ?? row.title ?? '')
    if (lesson === '') {
      out.skipped.push({ origin: row.id, reason: 'retro bead has no lesson text' })
      continue
    }
    const trigger = buildTrigger(row.title ?? '', row.description ?? '')
    if (trigger === undefined) {
      out.skipped.push({ origin: row.id, reason: 'no trigger scope (paths/commands/terms)' })
      continue
    }
    out.candidates.push({
      lesson,
      trigger,
      // the originating wtf is the second evidence the spec names
      evidence: beadPlusDeps(row, ['wtf']),
      source: 'capture:retro',
      origin: row.id,
    })
  }
  return out
}

// --- act ---------------------------------------------------------------------------

/** `PR #123` / `https://…/pull/123` refs out of a debt row — the second
 *  evidence kind a recurring finding earns. */
function prEvidence(row: TaskRow): Evidence[] {
  const out: Evidence[] = []
  for (const m of (row.description ?? '').matchAll(/\bpr:\s*(https?:\/\/\S+)/gi)) {
    out.push({ kind: 'pr', ref: m[1]! })
  }
  for (const m of (row.description ?? '').matchAll(/#(\d{1,7})\b/g)) {
    out.push({ kind: 'pr', ref: `#${m[1]}` })
  }
  return [...new Map(out.map((e) => [e.ref, e])).values()].slice(0, 4)
}

const numMeta = (row: TaskRow, key: string): number =>
  typeof row.metadata?.[key] === 'number' ? (row.metadata[key] as number) : 0

function harvestAct(dir?: string): Harvest {
  const out: Harvest = { candidates: [], skipped: [] }
  // fingerprint IS the normalized finding; a row without one groups on
  // its normalized title so bd drift doesn't silently exclude rows
  const groups = new Map<string, TaskRow[]>()
  for (const row of listLabeled('debt', dir).filter(isClosed)) {
    const fp =
      typeof row.metadata?.fingerprint === 'string' && row.metadata.fingerprint !== ''
        ? `fp:${row.metadata.fingerprint}`
        : `title:${oneLine(row.title ?? '').toLowerCase()}`
    groups.set(fp, [...(groups.get(fp) ?? []), row])
  }
  for (const group of groups.values()) {
    const prs = new Set(group.map((r) => numMeta(r, 'source_pr')).filter((p) => p > 0))
    const recurring = prs.size >= 2 || group.some((r) => numMeta(r, 'times_seen') >= 2)
    const origin = group.map((r) => r.id).sort((a, b) => a.localeCompare(b))[0]!
    if (!recurring) {
      out.skipped.push({ origin, reason: 'finding seen once — not a recurrence' })
      continue
    }
    const title = group[0]!.title ?? ''
    // bead titles are `<area>: <preview>` — the preview is the finding
    const body = title.includes(': ') ? title.slice(title.indexOf(': ') + 2) : title
    const lesson = oneLine(body)
    if (lesson === '') {
      out.skipped.push({ origin, reason: 'debt finding has no lesson text' })
      continue
    }
    // paths the findings hit are the trigger; area/body text carries
    // the rest of the scope
    const paths = [
      ...new Set(
        group
          .map((r) => row_meta_path(r))
          .filter((p): p is string => p !== undefined)
      ),
    ]
    const findingText = group.map((r) => `${r.title ?? ''}\n${r.description ?? ''}`).join('\n')
    const scopeText = `${paths.join(' ')}\n${findingText}`
    const trigger = buildTrigger(title, scopeText)
    if (trigger === undefined) {
      out.skipped.push({ origin, reason: 'no trigger scope (paths/commands/terms)' })
      continue
    }
    const evidence = [...group.map((r) => beadEvidence(r.id)), ...group.flatMap(prEvidence)]
    out.candidates.push({
      lesson,
      trigger,
      evidence: [...new Map(evidence.map((e) => [`${e.kind}:${e.ref}`, e])).values()],
      source: 'capture:act',
      origin,
      // the findings held under a merged-PR review gate
      heldUnderGate: true,
    })
  }
  return out
}

const row_meta_path = (row: TaskRow): string | undefined => {
  const p = row.metadata?.path
  return typeof p === 'string' && p !== '' ? p : undefined
}

// --- mol ----------------------------------------------------------------------------

/** A `--result` line teaches only when flagged — `learn:` is the flag. */
const LEARN_FLAG = /^learn(?:ing)?:\s+(.+)$/i

interface MolShow {
  root: { id: string; status: string }
  issues: { id: string; title?: string; status: string }[]
}

function harvestMol(molId: string, dir?: string): Harvest {
  const out: Harvest = { candidates: [], skipped: [] }
  const mol = bdJson<MolShow>(['mol', 'show', molId], dir)
  if (typeof mol?.root?.status !== 'string' || !Array.isArray(mol.issues)) {
    throw new Error(`mol show ${molId} returned an unexpected shape — a drifted bd payload is not a molecule`)
  }
  if (!CLOSED.has(mol.root.status)) {
    throw new Error(`molecule ${molId} is ${mol.root.status} — capture harvests closed molecules`)
  }
  for (const step of mol.issues.filter((i) => i.id !== mol.root.id && CLOSED.has(i.status))) {
    const reason = taskStore(dir).get<TaskRow>(step.id)?.close_reason ?? ''
    const flagged = reason
      .split('\n')
      .map((l) => LEARN_FLAG.exec(l.trim())?.[1]?.trim())
      .filter((l): l is string => l !== undefined && l !== '')
    if (flagged.length === 0) {
      continue // an unflagged result is a handoff, not a lesson
    }
    for (const text of flagged) {
      const lesson = oneLine(text)
      const trigger = buildTrigger(step.title ?? '', `${lesson}\n${step.title ?? ''}`)
      if (trigger === undefined) {
        out.skipped.push({ origin: step.id, reason: 'no trigger scope (paths/commands/terms)' })
        continue
      }
      out.candidates.push({
        lesson,
        trigger,
        evidence: [beadEvidence(step.id), beadEvidence(mol.root.id)],
        source: 'capture:mol',
        origin: step.id,
        // the step result survived a merge/verify gate inside the run
        heldUnderGate: true,
      })
    }
  }
  return out
}

// --- dedup + apply ----------------------------------------------------------------------

export interface CaptureWrite {
  lesson: Lesson
  origin: string
}

export interface CaptureMerge {
  lesson: Lesson
  /** evidence refs the merge added */
  added: Evidence[]
  origin: string
}

export interface CapturePlan {
  write: CaptureWrite[]
  merge: CaptureMerge[]
  skipped: CaptureSkip[]
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  tentative: 0,
  established: 1,
  proven: 2,
}

/** Union evidence by kind:ref — the re-capture merge the spec describes. */
function unionEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  return [...new Map([...a, ...b].map((e) => [`${e.kind}:${e.ref}`, e])).values()]
}

/** Union two triggers for a merge — `on` and each match list deduped,
 *  errors OR'd; budget keeps the existing lesson's value (a firing
 *  policy, not index material). */
function unionTrigger(a: LessonTrigger, b: LessonTrigger): LessonTrigger {
  const list = (x?: string[], y?: string[]): string[] | undefined =>
    x === undefined && y === undefined ? undefined : [...new Set([...(x ?? []), ...(y ?? [])])]
  const match: TriggerMatch = {}
  const terms = list(a.match?.terms, b.match?.terms)
  if (terms !== undefined) match.terms = terms
  const commands = list(a.match?.commands, b.match?.commands)
  if (commands !== undefined) match.commands = commands
  const paths = list(a.match?.paths, b.match?.paths)
  if (paths !== undefined) match.paths = paths
  const tools = list(a.match?.tools, b.match?.tools)
  if (tools !== undefined) match.tools = tools
  if (a.match?.errors === true || b.match?.errors === true) match.errors = true
  return {
    on: [...new Set([...a.on, ...b.on])],
    ...(Object.keys(match).length > 0 ? { match } : {}),
    ...(a.budget !== undefined ? { budget: a.budget } : {}),
  }
}

interface PlanCtx {
  /** corrupt keys squatting lesson ids — never merge into unreadable data */
  corrupt: Set<string>
  byId: Map<string, Lesson>
  /** ids queued in plan.write this run — a repeat candidate folds into
   *  the pending write in place, not a write+merge pair for one lesson */
  pending: Map<string, CaptureWrite>
  plan: CapturePlan
}

function foldNew(ctx: PlanCtx, id: string, c: CaptureCandidate): void {
  const lesson: Lesson = {
    id,
    trigger: c.trigger,
    lesson: c.lesson,
    evidence: c.evidence,
    confidence:
      c.confidence ?? deriveConfidence(c.evidence, { heldUnderGate: c.heldUnderGate === true }),
    source: c.source,
    createdAt: new Date().toISOString(),
  }
  const w: CaptureWrite = { lesson, origin: c.origin }
  ctx.plan.write.push(w)
  ctx.pending.set(id, w)
  ctx.byId.set(id, lesson)
}

function foldMerge(ctx: PlanCtx, id: string, existing: Lesson, c: CaptureCandidate): void {
  const merged = unionEvidence(existing.evidence, c.evidence)
  const added = merged.filter(
    (e) => !existing.evidence.some((x) => x.kind === e.kind && x.ref === e.ref)
  )
  const derived = deriveConfidence(merged, { heldUnderGate: c.heldUnderGate === true })
  const upgraded = CONFIDENCE_RANK[derived] > CONFIDENCE_RANK[existing.confidence]
  const trigger =
    c.mergeTrigger === true ? unionTrigger(existing.trigger, c.trigger) : existing.trigger
  const widened = JSON.stringify(trigger) !== JSON.stringify(existing.trigger)
  if (added.length === 0 && !upgraded && !widened) {
    return // already captured — nothing new to teach the store
  }
  const lesson: Lesson = {
    ...existing,
    trigger,
    evidence: merged,
    confidence: upgraded ? derived : existing.confidence,
    updatedAt: new Date().toISOString(),
  }
  const w = ctx.pending.get(id)
  if (w !== undefined) {
    w.lesson = lesson // fold into the pending write
  } else {
    ctx.plan.merge.push({ lesson, added, origin: c.origin })
  }
  ctx.byId.set(id, lesson)
}

/** Fold candidates against the store: same normalized lesson text merges
 *  evidence and recomputes confidence; a corrupt key squatting the id
 *  skips (never overwrites a lesson it can't read). */
export function planCapture(candidates: CaptureCandidate[], dir?: string): CapturePlan {
  const { lessons, skipped: storeSkipped } = listLessons(dir)
  const ctx: PlanCtx = {
    corrupt: new Set(storeSkipped.map((s) => s.key)),
    byId: new Map(lessons.map((l) => [l.id, l])),
    pending: new Map(),
    plan: { write: [], merge: [], skipped: [] },
  }
  for (const c of candidates) {
    const id = lessonId(c.lesson)
    if (ctx.corrupt.has(`learn/${id}`)) {
      ctx.plan.skipped.push({ origin: c.origin, reason: `${id} exists but fails schema` })
      continue
    }
    const existing = ctx.byId.get(id)
    // a 40-char slug can collide — different lesson text on the same id
    // is not the same rule: never fold its evidence into the other lesson
    if (existing !== undefined && oneLine(existing.lesson) !== oneLine(c.lesson)) {
      ctx.plan.skipped.push({ origin: c.origin, reason: `${id} collides with a different lesson` })
      continue
    }
    if (existing === undefined) {
      foldNew(ctx, id, c)
    } else {
      foldMerge(ctx, id, existing, c)
    }
  }
  return ctx.plan
}

/** The plan is the contract — writes happen here or nowhere. */
export function applyCapture(plan: CapturePlan, dir?: string): void {
  for (const w of plan.write) {
    putLesson(w.lesson, dir)
  }
  for (const m of plan.merge) {
    try {
      // re-read at write time and re-union — a concurrent capture may
      // have added evidence since plan() ran (bd kv has no CAS; this
      // narrows the lost-update window to one store round-trip)
      const fresh = getLesson(m.lesson.id, dir)
      const lesson =
        fresh === null
          ? m.lesson
          : {
              ...m.lesson,
              evidence: unionEvidence(fresh.evidence, m.lesson.evidence),
              confidence:
                CONFIDENCE_RANK[m.lesson.confidence] > CONFIDENCE_RANK[fresh.confidence]
                  ? m.lesson.confidence
                  : fresh.confidence,
            }
      putLesson(lesson, dir)
    } catch (err) {
      throw new LessonStoreError(
        `merge of ${m.lesson.id} failed — ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      )
    }
  }
}

export interface CaptureOptions {
  /** default: everything but mol (mol needs an explicit --mol) */
  sources?: CaptureSource[]
  mol?: string
  dryRun?: boolean
  dir?: string
}

export interface CaptureReport {
  plan: CapturePlan
  dryRun: boolean
}

/** Harvest → dedup plan → optional apply. `dryRun` stops after the
 *  plan — capture is a proposal surface; nothing it can't show. */
export function captureLessons(opts: CaptureOptions = {}): CaptureReport {
  // --mol alone scopes to the molecule; an explicit --source is the
  // allowlist — it wins, and --mol only names the molecule it harvests
  const sources = new Set(
    opts.sources ??
      (opts.mol !== undefined ? ['mol' as const] : CAPTURE_SOURCES.filter((s) => s !== 'mol'))
  )
  if (opts.mol !== undefined && opts.sources !== undefined && !sources.has('mol')) {
    throw new Error('--mol given but mol is not in --source — the molecule would never run')
  }
  const harvests: Harvest[] = []
  if (sources.has('drill')) harvests.push(harvestDrill(opts.dir))
  if (sources.has('retro')) harvests.push(harvestRetro(opts.dir))
  if (sources.has('act')) harvests.push(harvestAct(opts.dir))
  if (sources.has('mol')) {
    if (opts.mol === undefined) {
      throw new Error('mol capture requires --mol <id> — name the molecule to harvest')
    }
    harvests.push(harvestMol(opts.mol, opts.dir))
  }
  const candidates = harvests.flatMap((h) => h.candidates)
  const skipped = harvests.flatMap((h) => h.skipped)
  // non-dryRun plan→apply runs under the store lock — a concurrent
  // learn writer must not read the same store state and overwrite the
  // merged evidence this section produces (bd kv has no CAS)
  const plan =
    opts.dryRun === true
      ? planCapture(candidates, opts.dir)
      : withStoreLock(opts.dir, () => {
          const p = planCapture(candidates, opts.dir)
          applyCapture(p, opts.dir)
          return p
        })
  plan.skipped.push(...skipped)
  return { plan, dryRun: opts.dryRun === true }
}
