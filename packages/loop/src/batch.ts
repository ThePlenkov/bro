/** Batch claims (spec bro-nspj7) — the pure grouping + coverage halves
 *  of "push next CLUMP". Affinity keys are creation-time signals read
 *  off the bead (labels, parent, spec ref, path-title), never
 *  claim-time guesswork; coverage is parsed out of the member branch's
 *  own commit log so a merged PR closes exactly the beads its commits
 *  name. No IO — the caller owns claims, git, and side effects. */

/** The bead fields clumping reads — `bd ready` rows carry all of them. */
export interface BatchableBead {
  id: string
  title: string
  description?: string
  priority: number
  issue_type: string
  labels?: string[]
  /** bd reuses `parent` for molecule steps and epic children — callers
   *  must only pass claimable beads, where a set parent is always an
   *  epic (the queue's own classify step enforces it). */
  parent?: string
}

/** A bead opted out of clumping by label — the operator escape hatch. */
export const SOLO_LABEL = 'solo'

const SPEC_REF = /\bspec:\s*([A-Za-z0-9._/-]+)/i

/** A title prefix counts as a path only when it looks like one — a '/'
 *  separator or a file extension. 'loop: batch claims' is prose;
 *  'specs/sessions:' and 'work.ts:' are places. */
const PATH_PREFIX = /^([^\s:]{1,200})\s*:/
const PATHISH = /\/|\.[a-z0-9]{1,8}$/i

/** A spec mention → its canonical id: `spec: specs/sessions/bro-x.md`
 *  and `spec: bro-x` are the same affinity. */
function specKey(text: string | undefined): string | undefined {
  const m = text === undefined ? undefined : SPEC_REF.exec(text)
  if (!m) {
    return undefined
  }
  const ref = m[1]!.replace(/^\.?\/+/, '').replace(/^specs\//, '').replace(/\.mdx?$/i, '')
  return ref === '' ? undefined : `spec:${ref}`
}

/** The bead's affinity keys in precedence order — spec binding (the
 *  tightest: one feature spec), then epic family, then `area:*`
 *  labels, then a path-looking title prefix. */
export function affinityKeys(b: BatchableBead): string[] {
  const keys: string[] = []
  const spec = specKey(b.description) ?? specKey(b.title)
  if (spec !== undefined) {
    keys.push(spec)
  }
  if (b.parent !== undefined && b.parent !== '') {
    keys.push(`epic:${b.parent}`)
  }
  for (const l of b.labels ?? []) {
    if (l.startsWith('area:')) {
      keys.push(l)
    }
  }
  const m = PATH_PREFIX.exec(b.title)
  if (m && PATHISH.test(m[1]!)) {
    keys.push(`path:${m[1]}`)
  }
  return keys
}

/** The single key a lead binds its clump on — highest precedence wins. */
export function leadKey(b: BatchableBead): string | undefined {
  return affinityKeys(b)[0]
}

/** May this bead ride in a clump at all — as lead or member? The floor
 *  keeps urgent work solo (`priority >= minPriority` means P3 nits and
 *  P4 noise batch, P1/P2 never do); a `solo` label is the per-bead
 *  opt-out. */
export function batchable(b: BatchableBead, minPriority: number): boolean {
  return b.priority >= minPriority && !(b.labels ?? []).includes(SOLO_LABEL)
}

/** The members a lead may pull into its clump — ordered candidates
 *  carrying the lead's key, eligible by the same bar, capped so the
 *  whole clump (lead included) stays within `size`. A lead with no key
 *  or a below-floor priority clumps with nobody. */
export function clumpMembers<T extends BatchableBead>(
  lead: T,
  candidates: T[],
  opts: { size: number; minPriority: number }
): T[] {
  const key = batchable(lead, opts.minPriority) ? leadKey(lead) : undefined
  if (key === undefined || opts.size < 2) {
    return []
  }
  return candidates
    .filter((b) => batchable(b, opts.minPriority) && affinityKeys(b).includes(key))
    .slice(0, opts.size - 1)
}

const escRe = (s: string): string => s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Which of `ids` the commit log actually names — bead coverage is
 *  evidence (a commit message carrying the id), not a self-reported PR
 *  body. The boundary lookarounds exclude '.', so a commit naming the
 *  child `bro-x1.2` does not cover a clump member `bro-x1`. */
export function coveredBeadIds(commitLog: string, ids: Iterable<string>): Set<string> {
  const covered = new Set<string>()
  for (const id of ids) {
    if (id !== '' && new RegExp(`(?<![\\w.])${escRe(id)}(?![\\w.])`).test(commitLog)) {
      covered.add(id)
    }
  }
  return covered
}
