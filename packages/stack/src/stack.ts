/**
 * Stack domain logic — pure functions over the `stack/<name>/<n>-<slug>`
 * branch namespace. A named stack is a VIEW over live branches plus the
 * `.git/bro/stack/` edge files `bro work enter` already writes — there is
 * no parallel registry, so every answer here derives from git state the
 * caller passes in.
 */

/** stack/<name>/<n>-<slug> — name and slug are bead-ish (`[\w.-]+`), n is
 *  the 1-based position. The slug cannot start with another `<digits>-`
 *  without ambiguity, so bead slugs (which never do) are the contract.
 *  Slug stays inside one ref component — no `/`, no `..`, no `.lock`. */
const STACK_BRANCH_RE = /^stack\/([\w.-]+)\/(\d+)-([\w.-]+)$/

export interface StackBranch {
  /** stack name */
  name: string
  /** 1-based position in the chain */
  n: number
  /** bead id / worktree slug */
  slug: string
  /** full branch shortname */
  branch: string
}

/** A git-ref-safe slug component — no `.`-leading component, no `..`,
 *  no `.lock` tail, no leading `-`. Shared by name validation and
 *  parseStackBranch's slug guard so a malformed `stack/…` ref never
 *  enters member ordering. */
function isRefComponent(s: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/.test(s) &&
    !s.endsWith('.lock')
  )
}

export function isStackName(name: string): boolean {
  return isRefComponent(name)
}

export function parseStackBranch(branch: string): StackBranch | undefined {
  const m = STACK_BRANCH_RE.exec(branch)
  const n = m === null ? NaN : Number(m[2])
  if (
    m === null ||
    !isStackName(m[1]!) ||
    !isRefComponent(m[3]!) ||
    !Number.isSafeInteger(n) ||
    n < 1
  ) {
    return undefined
  }
  return { name: m[1]!, n, slug: m[3]!, branch }
}

export function formatStackBranch(name: string, n: number, slug: string): string {
  return `stack/${name}/${n}-${slug}`
}

/** Members of one stack, ordered bottom-up. Duplicate n values (two
 *  pushes raced) sort by branch name — deterministic, and the caller can
 *  surface it as an anomaly. */
export function stackMembers(branches: string[], name: string): StackBranch[] {
  return branches
    .map(parseStackBranch)
    .filter((b): b is StackBranch => b?.name === name)
    .sort((a, b) => a.n - b.n || a.branch.localeCompare(b.branch))
}

/** Distinct stack names present in a branch list. */
export function stackNames(branches: string[]): string[] {
  const names = new Set<string>()
  for (const b of branches) {
    const p = parseStackBranch(b)
    if (p) {
      names.add(p.name)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** Next position — always tip+1, never a gap fill: a missing middle
 *  member's slot must not be silently reused by a later push. */
export function nextIndex(members: StackBranch[]): number {
  return (members.at(-1)?.n ?? 0) + 1
}

// --- sync planning -------------------------------------------------------------

/** One member's observed state at sync time — all inputs, no IO. */
export interface SyncMemberInput extends StackBranch {
  /** Recorded `.git/bro/stack/` edge — absent means "based on the
   *  default branch" (enter records no edge for a main base). */
  edgeBase?: string
  /** Open PR's declared base — ground truth when the edge is missing. */
  prBase?: string
  /** Normalized PR state; undefined = no PR (or host unreachable —
   *  callers must not pass undefined on lookup failure: an unknown
   *  merge state must keep the member alive, never mark it merged). */
  prState?: string
  /** Local rewrite is allowed — worktree present, clean, unlocked. */
  rebaseable: boolean
  /** Why rebaseable is false, for the skip report. */
  blocked?: string
}

export interface SyncPlanItem<T extends SyncMemberInput = SyncMemberInput> {
  member: T
  /** What the member's base should be after sync. */
  desiredBase: string
  /** The base the branch actually forked from — edge, else the PR's
   *  declared base, else desiredBase (nothing to undo). */
  oldBase: string
  rebase: boolean
  retarget: boolean
  /** Set when the member needs a rebase but may not be touched — the
   *  PR is left untargeted too: retargeting onto the default branch
   *  while the branch still carries unmerged parent commits would
   *  inflate its diff. */
  skip?: string
}

/** Bottom-up retarget/rebase plan. A member whose PR merged drops out
 *  of the chain: its successor's base becomes the nearest lower member
 *  still open, or the default branch. `defaultBase` is the branch NAME
 *  PRs target (e.g. `main`), not a remote ref. */
export function planSync<T extends SyncMemberInput>(
  members: T[],
  defaultBase: string
): SyncPlanItem<T>[] {
  const plan: SyncPlanItem<T>[] = []
  let liveTip = defaultBase
  for (const m of members) {
    const desiredBase = liveTip
    const oldBase = m.edgeBase ?? m.prBase ?? desiredBase
    const merged = m.prState === 'MERGED'
    const rebase = !merged && oldBase !== desiredBase
    const item: SyncPlanItem<T> = {
      member: m,
      desiredBase,
      oldBase,
      rebase,
      retarget: !merged && m.prState === 'OPEN' && m.prBase !== desiredBase,
      skip: rebase && !m.rebaseable ? (m.blocked ?? 'not rebaseable') : undefined,
    }
    // a skipped rebase vetoes the retarget — same diff-inflation rule
    if (item.skip) {
      item.retarget = false
    }
    plan.push(item)
    // merged members leave the chain; everyone else — skipped or synced —
    // is still the branch children base on
    if (!merged) {
      liveTip = m.branch
    }
  }
  return plan
}

/** The live member's tip — the highest-n member not in `dead` (merged
 *  members keep their branch until the worktree goes away, but a merged
 *  branch is a dead end as a base). Position numbering still counts
 *  every member — a merged member's slot is never reused. */
export function stackTop(
  members: StackBranch[],
  dead?: ReadonlySet<string>
): StackBranch | undefined {
  return members.findLast((m) => dead?.has(m.branch) !== true)
}

/** Effective base for display: the PR's declared base is ground truth
 *  when a PR exists, else the recorded edge, else the default branch —
 *  a missing edge after sync means the member sits on the default. */
export function displayBase(
  member: { prBase?: string; edgeBase?: string },
  defaultBase: string
): string {
  return member.prBase ?? member.edgeBase ?? defaultBase
}
