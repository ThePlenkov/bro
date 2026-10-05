/**
 * Learn store — lessons persist in the repo's beads Dolt store as
 * `bd kv` entries: key `learn/<id>`, value the Lesson JSON. Enumeration
 * is `bd kv list` filtered on the `learn/` prefix; reads are exact
 * `bd kv get`; deletes are `bd kv clear`. Dolt sync makes lessons
 * cross-session and cross-machine for free, and the store inherits the
 * stealth property of beads — nothing lands in git.
 *
 * `bro learn` writes through `bd` — the CLI never opens Dolt itself.
 * Enumeration fails open: a kv entry that fails the lesson schema is
 * reported in `skipped`, never thrown — lessons written by a newer bro
 * must not wedge an older one. Exact reads (`getLesson`) are the
 * exception: a corrupt entry throws so `show` can say "exists but
 * broken" rather than lying "no such lesson".
 */
import { bd, bdTry, bdTryAsync, gitTry, withFileLock } from '@broject/core'
import { join } from 'node:path'
import { lessonProblems, type Lesson } from './lesson.ts'

export const KV_PREFIX = 'learn/'

/** `learn/<id>` — the kv namespace prefix plus the lesson's own
 *  `learn-<slug>` id (spec: key `learn/<id>`). */
const keyOf = (id: string): string => `${KV_PREFIX}${id}`

/** Thrown on store-level failures — dead bd, malformed kv payloads,
 *  writes that didn't land. Schema violations of single entries are
 *  NOT errors: they surface via `skipped` on reads instead. */
export class LessonStoreError extends Error {
  override name = 'LessonStoreError'
}

export interface SkippedEntry {
  key: string
  problems: string[]
}

export interface LessonListing {
  lessons: Lesson[]
  /** entries under learn/ that failed the schema — caller warns */
  skipped: SkippedEntry[]
}

/** Explicit discriminant — a forward-compatible Lesson may itself gain
 *  a `key`/`problems` field, so field-sniffing is not a safe tag. */
type ParsedEntry = { ok: true; lesson: Lesson } | { ok: false; skipped: SkippedEntry }

function parseEntry(key: string, raw: string): ParsedEntry {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      skipped: {
        key,
        problems: [`malformed JSON — ${err instanceof Error ? err.message : String(err)}`],
      },
    }
  }
  const problems = lessonProblems(parsed)
  if (problems.length > 0) {
    return { ok: false, skipped: { key, problems } }
  }
  const lesson = parsed as Lesson
  const id = key.slice(KV_PREFIX.length)
  if (lesson.id !== id) {
    // store.ts only ever writes key = learn/<id>; divergence is corruption
    return { ok: false, skipped: { key, problems: [`id "${lesson.id}" does not match key "${key}"`] } }
  }
  return { ok: true, lesson }
}

/** Every lesson in the store — schema violations land in `skipped`. */
export function listLessons(cwd?: string): LessonListing {
  const res = bdTry(['kv', 'list', '--json'], 15_000, cwd)
  if (res.code !== 0) {
    throw new LessonStoreError(`bd kv list failed — ${res.err || `exit ${res.code}`}`)
  }
  let map: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(res.out)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    map = parsed as Record<string, unknown>
  } catch (err) {
    throw new LessonStoreError(
      `bd kv list returned malformed JSON — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const lessons: Lesson[] = []
  const skipped: SkippedEntry[] = []
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith(KV_PREFIX)) {
      continue
    }
    if (typeof value !== 'string') {
      skipped.push({ key, problems: ['kv value is not a string'] })
      continue
    }
    const entry = parseEntry(key, value)
    if (entry.ok) {
      lessons.push(entry.lesson)
    } else {
      skipped.push(entry.skipped)
    }
  }
  return { lessons, skipped }
}

/** Async listLessons — the probe path; a sync bdTry would freeze the
 *  connector sweep's timeout timers for the full dolt startup. */
export async function listLessonsAsync(cwd?: string): Promise<LessonListing> {
  const res = await bdTryAsync(['kv', 'list', '--json'], 15_000, cwd)
  if (res.code !== 0) {
    throw new LessonStoreError(`bd kv list failed — ${res.err || `exit ${res.code}`}`)
  }
  let map: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(res.out)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    map = parsed as Record<string, unknown>
  } catch (err) {
    throw new LessonStoreError(
      `bd kv list returned malformed JSON — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const lessons: Lesson[] = []
  const skipped: SkippedEntry[] = []
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith(KV_PREFIX)) {
      continue
    }
    if (typeof value !== 'string') {
      skipped.push({ key, problems: ['kv value is not a string'] })
      continue
    }
    const entry = parseEntry(key, value)
    if (entry.ok) {
      lessons.push(entry.lesson)
    } else {
      skipped.push(entry.skipped)
    }
  }
  return { lessons, skipped }
}

/** bd's exact kv miss signal — `<key> (not set)` on stderr, exit 1.
 *  Deliberately narrow: a dead store, a missing db, or bd usage drift
 *  must throw, not masquerade as an absent key. */
const KV_MISS = /\(not set\)/

/** Exact read — null when absent. Corrupt entries throw: `show` must
 *  be able to say "this key exists but is broken". */
export function getLesson(id: string, cwd?: string): Lesson | null {
  const res = bdTry(['kv', 'get', keyOf(id)], 15_000, cwd)
  if (res.code !== 0) {
    if (KV_MISS.test(`${res.err}\n${res.out}`)) {
      return null
    }
    throw new LessonStoreError(`bd kv get ${keyOf(id)} failed — ${res.err || `exit ${res.code}`}`)
  }
  const entry = parseEntry(keyOf(id), res.out.trim())
  if (!entry.ok) {
    throw new LessonStoreError(`lesson ${id} fails schema: ${entry.skipped.problems.join('; ')}`)
  }
  return entry.lesson
}

/** Write — fails closed: an invalid lesson never reaches the store. */
export function putLesson(lesson: Lesson, cwd?: string): void {
  const problems = lessonProblems(lesson)
  if (problems.length > 0) {
    throw new LessonStoreError(`refusing to store invalid lesson: ${problems.join('; ')}`)
  }
  try {
    bd(['kv', 'set', keyOf(lesson.id), JSON.stringify(lesson)], cwd)
  } catch (err) {
    throw new LessonStoreError(
      `bd kv set ${keyOf(lesson.id)} failed — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }
}

/** `bd kv clear` — void: bd reports success even on absent keys, so
 *  existence checks are the caller's (`getLesson` first). */
export function deleteLesson(id: string, cwd?: string): void {
  const res = bdTry(['kv', 'clear', keyOf(id)], 15_000, cwd)
  if (res.code !== 0) {
    throw new LessonStoreError(`bd kv clear ${keyOf(id)} failed — ${res.err || `exit ${res.code}`}`)
  }
}

/** `<git-common>/bro/learn-store.lock` serializes a read-modify-write
 *  across every learn writer in this repo — bd kv has no CAS, so two
 *  concurrent plan→apply sections can overwrite each other's merged
 *  evidence. Outside a git repo there is no shared store to race on:
 *  run unlocked. */
export function withStoreLock<T>(cwd: string | undefined, fn: () => T): T {
  const r = gitTry(
    ['-C', cwd ?? process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
  )
  if (r.code !== 0 || r.out.trim() === '') {
    return fn()
  }
  return withFileLock(join(r.out.trim(), 'bro', 'learn-store.lock'), fn, {
    label: 'learn store lock',
  })
}

/** Every stored lesson id — the dedup surface for `add`. */
export function lessonIds(cwd?: string): Set<string> {
  const { lessons, skipped } = listLessons(cwd)
  return new Set([
    ...lessons.map((l) => l.id),
    ...skipped.map((s) => s.key.slice(KV_PREFIX.length)),
  ])
}
