/** The open-fleet ceiling and the orphan-PR reconcile — pure decisions
 *  (spec bro-jis0c). `maxOpen` bounds this run's gate stack; the
 *  ceiling bounds every open PR on a fleet head — parked members,
 *  dead runs' survivors, other sessions' pushes. The caller owns the
 *  listing, the bead store, and the side effects; this module maps
 *  one settled snapshot to a verdict so the table is unit-testable
 *  without IO. */
import { loopSlug } from './item.ts';

/** headRef prefixes that count against the ceiling and answer to the
 *  reconcile — bro's own PR namespace: loop work, work-enter trees,
 *  stack members, and fixer/manual `fix/bro-*` heads. */
export const FLEET_HEAD_PREFIXES = ['work/', 'loop/', 'stack/', 'fix/bro-'];

export function isFleetHead(headRef: string): boolean {
  return FLEET_HEAD_PREFIXES.some(p => headRef.startsWith(p));
}

/** One open PR the host listed — the ceiling count and the reconcile
 *  input share the row. */
export interface FleetPrRow {
  pr: number;
  headRef: string;
}

/** The hold verdict — a count at or above the ceiling refuses claims;
 *  0 disables the bound entirely (operator escape). */
export function ceilingHeld(open: number, maxOpenTotal: number): boolean {
  return maxOpenTotal > 0 && open >= maxOpenTotal;
}

/** The bead slug a fleet head names, when its namespace is bead-
 *  deterministic: `loop/<slug>` carries the slug verbatim and
 *  `stack/<name>/<n>-<slug>` carries it after the member number. A
 *  missing bead on either is provably obsolete — a purged or renamed
 *  work item. `work/`/`fix/` heads yield no deterministic slug: their
 *  tail is an arbitrary label that only prefix-matching can try. */
export function deterministicHeadSlug(headRef: string): string | undefined {
  if (headRef.startsWith('loop/')) {
    return headRef.slice('loop/'.length);
  }
  if (headRef.startsWith('stack/')) {
    // stack/<name>/<n>-<slug> — two slashes, then the n- member prefix
    const tail = headRef.slice('stack/'.length);
    const member = tail.split('/', 2)[1];
    const m = /^(\d+)-(.+)$/.exec(member ?? '');
    return m === null ? undefined : m[2];
  }
  return undefined;
}

/** The minimal bead row a reconcile verdict reads. */
export interface ReconcileBead {
  id: string;
  status?: string;
}

function tryDeterministicBead(
  headRef: string,
  beadsBySlug: ReadonlyMap<string, ReconcileBead>
): { det?: string; bead?: ReconcileBead } {
  const det = deterministicHeadSlug(headRef);
  if (det === undefined) {
    return {};
  }
  return { det, bead: beadsBySlug.get(det) };
}

function findLongestPrefixMatch(
  headRef: string,
  beadsBySlug: ReadonlyMap<string, ReconcileBead>
): ReconcileBead | undefined {
  const slash = headRef.indexOf('/');
  const tail = headRef.slice(slash + 1);
  let best: ReconcileBead | undefined;
  let bestLen = -1;
  const owners = new Set<string>();

  for (const [slug, bead] of beadsBySlug) {
    if (tail !== slug && !tail.startsWith(`${slug}-`)) {
      continue;
    }
    owners.add(bead.id);
    const len = loopSlug(bead.id).length;
    if (best === undefined || len > bestLen) {
      best = bead;
      bestLen = len;
    }
  }

  // A `work/`/`fix/` tail is a human label, not a bead contract — when
  // two DIFFERENT beads both prefix it (`work/bro-a-retry` matches a
  // live `bro-a` and a closed `bro-a-retry`) the longest-prefix pick is
  // a guess that can name the closed bead and bury the live owner's
  // branch. Ambiguous ownership answers nothing: the head keeps.
  if (owners.size > 1) {
    return undefined;
  }
  return best;
}

/** Find the bead a fleet head names. Exact slug hit first (`loop/`,
 *  `stack/` members, tidy `work/` names); then the longest bead slug
 *  that is a '-'-bounded prefix of the head's tail — `work/<bead>-desc`
 *  and `fix/<bead>-desc` carry human suffixes past the id. The key set
 *  is the caller's loopSlug(id) map, so sanitized ids resolve exactly
 *  like their branches do. */
export function beadForHead(
  row: FleetPrRow,
  beadsBySlug: ReadonlyMap<string, ReconcileBead>
): ReconcileBead | undefined {
  const { det, bead } = tryDeterministicBead(row.headRef, beadsBySlug);
  if (det !== undefined) {
    if (bead !== undefined) {
      return bead;
    }
    return undefined;
  }
  return findLongestPrefixMatch(row.headRef, beadsBySlug);
}

/** What the reconcile pass does with an open fleet PR not on this
 *  run's stack. 'close' is the burial: the work item behind the head
 *  is dead (closed bead — or no bead at all under a deterministic
 *  namespace), so the PR is pure review/merge-budget spend. */
export type OrphanVerdict = { kind: 'close'; bead?: string; why: string } | { kind: 'keep' };

/** The statuses that keep a PR open — `open`/`in_progress` are live
 *  work; `deferred` is the park's snooze (spec bro-hl22w): the woken
 *  claim re-uses the kept worktree and its open PR, so burying it
 *  deletes unlanded work. Anything else (closed, or a backend's
 *  terminal state) is non-live; an unreadable/absent status keeps —
 *  an unknown bead is never a burial order. */
function isLiveStatus(status: string | undefined): boolean {
  return status === 'open' || status === 'in_progress' || status === 'deferred';
}

function isNonLiveStatus(status: string | undefined): boolean {
  if (typeof status !== 'string') {
    return false;
  }
  return !isLiveStatus(status);
}

/** Bead closed → close; deterministic head with no bead row → close
 *  (obsolete); live or unverifiable → keep. A kept live PR is drive's
 *  territory — it owns the fixer and the merge.
 *
 *  `members` is the batch's full bead set (the `bead` provenance
 *  trailer stamps every clump id on the PR body — `loop/<lead>` heads
 *  share the branch across members). Any LIVE member keeps the PR:
 *  the lead's closure says nothing about an `open`/`in_progress`/
 *  `deferred` sibling's unlanded commits. A member missing from the
 *  listing is as dead as a closed one — the same provably-obsolete
 *  rule the deterministic head namespace already applies. */
export function orphanVerdict(
  row: FleetPrRow,
  bead: ReconcileBead | undefined,
  members?: readonly ReconcileBead[]
): OrphanVerdict {
  if (members !== undefined && members.some(m => isLiveStatus(m.status))) {
    return { kind: 'keep' };
  }

  if (bead === undefined) {
    if (deterministicHeadSlug(row.headRef) === undefined) {
      return { kind: 'keep' };
    }
    return { kind: 'close', why: 'no bead — obsolete' };
  }

  if (bead.status === 'closed') {
    return { kind: 'close', bead: bead.id, why: `bead ${bead.id} closed` };
  }

  if (isNonLiveStatus(bead.status)) {
    return { kind: 'close', bead: bead.id, why: `bead ${bead.id} ${bead.status}` };
  }

  return { kind: 'keep' };
}
