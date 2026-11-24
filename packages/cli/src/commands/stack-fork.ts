/**
 * `bro stack` fork/base truth — where a member's own work begins and
 * whether its branch still carries the base's head. Everything reads
 * the git truth (reflogs, merge-base, rev-parse) so the sync plan and
 * the rebase replay agree on the same commits; a question git cannot
 * answer is `undefined`/no-fork, never a guess.
 */
import { countMergesInRange, gitTry } from '@broject/core';
import type { SyncMemberInput } from '@broject/stack';
import type { MemberView } from './stack-refs.ts';
import { baseRef } from './stack-refs.ts';

/** The branch a member stands on — its recorded edge (the fork truth
 *  the plan reads), else its PR's declared base, else the chain's
 *  previous member. The order matches `planSync`'s own resolution: one
 *  answer, or the head check and the planner read different bases and
 *  disagree about whether the member is current. */
function baseOf(m: MemberView, prev: string): string {
  return m.edgeBase ?? m.prBase ?? prev;
}

/**
 * Does the branch still carry the head of the base it stands on? The
 * chain's base==prev-head invariant, read from the git truth. A fix that
 * landed BELOW the member moves that head while the base's NAME stays
 * the same — the name alone reads as "in sync", the head says otherwise,
 * and without this the operator rebases the chain by hand.
 *
 * `undefined` when a head cannot be read: an UNKNOWN truth is not
 * "carries" — the chain is not attested, and the caller skips the member
 * rather than claiming a success it cannot prove.
 */
export function carriesBaseHead(branch: string, base: string, root: string): boolean | undefined {
  const baseHead = baseTip(root, base);
  return carriesCommit(branch, baseHead ?? '', root);
}

/** Does the branch still carry this COMMIT? The chain's base==prev-head
 *  invariant, read from the git truth — and the same question the fork
 *  asks: the fork is only the member's own work when the base's commit
 *  is inside the member's history. */
function carriesCommit(branch: string, baseHead: string, root: string): boolean | undefined {
  const memberHead = gitTry([
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]).out.trim();
  if (baseHead === '' || memberHead === '') {
    return undefined;
  }
  return gitTry(['-C', root, 'merge-base', '--is-ancestor', baseHead, memberHead]).code === 0;
}

/** The base's tip, read as a SHA. The ref's TIP — the commit the
 *  member's own work starts after — and a SHA does not move: the
 *  cascade rewrites the base's ref, and a name read after that points
 *  somewhere else.
 *
 *  ONE read, ONE answer: the containment check and the fork use the
 *  same commit, so the base cannot slip between the two reads. */
function baseTip(root: string, base: string): string | undefined {
  const ref = baseRef(root, base);
  if (ref === undefined) {
    return undefined;
  }
  const sha = gitTry([
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]).out.trim();
  return sha === '' ? undefined : sha;
}

/** The heads the plan reads — one flag per member. A merged member
 *  leaves the chain: the member above it stands on the one below the
 *  merged one, exactly as `planSync`'s own live tip walks.
 *
 *  The plan's FORK rides along: the base's tip as a SHA, read HERE —
 *  in the plan phase, before the cascade moves any ref. The rebase
 *  starts the member's replay from that commit, so the replay carries
 *  the member's own work and never the base's old commits. */
export function markBaseHeads(members: MemberView[], root: string, defaultBase: string): void {
  let prev = defaultBase;
  for (const m of members) {
    if (m.prState !== 'MERGED') {
      const base = baseOf(m, prev);
      const tip = baseTip(root, base);
      m.forkSha = tip;
      // the containment check reads the SAME commit the fork will use —
      // one answer, so the base cannot slip between the two reads
      m.containsBaseHead = tip === undefined ? undefined : carriesCommit(m.branch, tip, root);
      prev = m.branch;
    }
  }
}

/**
 * The chain's ROOT base — the branch its first member stands on. A chain
 * that roots on something other than the default branch (the router's arc
 * roots on its own PR) must not be planned onto the default: the root is
 * the chain's own, and the plan follows it.
 *
 * A member that MERGED left the chain: its base is the branch it landed
 * on, and that branch is gone with it. The chain then stands on the
 * default branch — the same answer `planSync` gives the member that
 * follows ("its successor's base becomes the nearest lower member still
 * open, or the default branch").
 *
 * A DEAD ref is never a base. The recorded edge names a branch that may
 * itself have merged and been deleted (the arc's base merges before the
 * layer above it does) — planning onto it is what made the sync refuse
 * to move the members that were still in the chain. So the candidate
 * must be a branch that still EXISTS; otherwise the chain falls back to
 * the default branch, which is where the dead branch's work landed.
 *
 * `alive` answers "does this branch still exist" — the caller reads it
 * from the git truth, so this stays a pure function of its inputs. It is
 * REQUIRED, with no default: a caller that forgot to check would fail
 * OPEN (every dead branch reads as alive), which is the failure this
 * whole guard exists to prevent.
 *
 * `undefined` when NO branch is alive — not even the default branch.
 * There is nothing to stand on, and the caller must say so rather than
 * plan onto a dead ref.
 */
export function chainRootBase(
  members: SyncMemberInput[],
  defaultBase: string,
  alive: (branch: string) => boolean
): string | undefined {
  const first = members[0];
  if (first !== undefined && first.prState !== 'MERGED') {
    for (const candidate of [first.edgeBase, first.prBase]) {
      if (candidate !== undefined && alive(candidate)) return candidate;
    }
  }
  return alive(defaultBase) ? defaultBase : undefined;
}

/** Where the member's own work began — the commit its branch was
 *  created at, read from its OWN reflog ("branch: Created from <base>"
 *  names the base's tip of that moment). The base's ref may be GONE —
 *  the platform deletes a merged member's branch — and the member's
 *  history still remembers.
 *
 *  The CREATION entry, not merely the oldest one: a reflog that was
 *  truncated or expired has no creation entry left, and its oldest
 *  survivor is a later commit — a fork that would drop the member's own
 *  commits. No creation entry means no answer, and the caller falls
 *  through to the base's reflog. */
function forkFromReflog(branch: string, wt: string): string | undefined {
  const out = gitTry(['-C', wt, 'reflog', 'show', '--format=%H %gs', branch]).out;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [sha, ...rest] = trimmed.split(' ');
    if (!rest.join(' ').startsWith('branch: Created')) continue;
    return gitTry(['-C', wt, 'merge-base', '--is-ancestor', sha, 'HEAD']).code === 0
      ? sha
      : undefined;
  }
  return undefined;
}

/**
 * Where the child's own work starts — the fork point for a rebase onto a
 * base whose history moved. The plain merge-base is right when the child
 * was built on the base's CURRENT tip. When the base was REWRITTEN under
 * the child (a fix landed below and the parent was rebased), the
 * merge-base is the parent's old root and the replay would carry the
 * parent's old commits — and their conflicts — along.
 *
 * Three answers, in order of how well they know the truth:
 *
 * 1. the base's tip, already inside the child — the merge-base IS the
 *    fork: the child's work starts right after it.
 * 2. git's OWN fork point — the base's reflog remembers the tip the
 *    child was built on, so this is exact even when the rewrite changed
 *    the parent's CONTENT (an amend that adds a file is not patch-
 *    equivalent, and only the reflog still knows where the child began).
 * 3. the child's last commit the new base already holds BY PATCH — the
 *    rewritten parent looks patch-equivalent to git.
 *
 * And when none of the three answers — NO FORK. The bare merge-base is a
 * GUESS: it sits BEFORE the base's old commits, so a replay from there
 * carries them (and their conflicts) along. When no reflog and no
 * patch-equivalence can place the fork, the rebase does not happen and
 * the owner resolves it — a member that is skipped is visible, a member
 * that replays the base's commits is not.
 */
export function forkPoint(base: string, wt: string): string {
  // the base is read through the resolver (bro-yi9sz): a base that lives
  // only as a remote-tracking ref is a base, not a dead ref. An
  // unresolvable base keeps the old behaviour — the git calls below fail
  // and the caller sees no fork.
  const ref = baseRef(wt, base) ?? base;
  const mergeBase = gitTry(['-C', wt, 'merge-base', ref, 'HEAD']).out.trim();
  if (mergeBase === '') {
    return mergeBase;
  }
  // the base's tip is already inside the child — the merge-base IS the fork
  if (gitTry(['-C', wt, 'merge-base', '--is-ancestor', ref, 'HEAD']).code === 0) {
    return mergeBase;
  }
  // git's own answer — the base's reflog, not a guess
  const forked = gitTry(['-C', wt, 'merge-base', '--fork-point', ref, 'HEAD']).out.trim();
  if (forked !== '') {
    return forked;
  }
  const cherry = gitTry(['-C', wt, 'cherry', ref, 'HEAD']).out.trim();
  if (cherry === '') {
    // every commit the member carries is in the base by patch — there is
    // no work of its own to replay, and the fork is its own tip
    return gitTry(['-C', wt, 'rev-parse', 'HEAD']).out.trim();
  }
  let fork = '';
  for (const line of cherry.split('\n')) {
    // The cherry list runs OLDEST first: the equivalent commits the
    // child carries come before the child's own work. The fork is the
    // LAST equivalent before that work starts — a later equivalent
    // would push the fork past the child's own commits and drop them
    // from the replay.
    if (line.startsWith('+ ')) break;
    if (line.startsWith('- ')) {
      fork = line.slice(2).trim();
    }
  }
  return fork;
}

/** Where the member's replay must start — the fork, in the order of how
 *  well each answer knows the truth.
 *
 *  1. THE PLAN'S SHA — the base's tip as the plan saw it — but only
 *     while the member's CURRENT history still carries it: the member
 *     may have been rewritten since the plan (the platform's follow),
 *     and a commit the member does not carry is not a fork.
 *  2. THE BASE THE MEMBER FORKED FROM (`oldBase`) — the branch the
 *     member's line actually left, so `forkPoint` asks the right
 *     question: where was that base when the member branched off it.
 *     The BASE's reflog is the base's own history — the member's own
 *     branch moves cannot rewrite it, so a member that was deleted and
 *     recreated (a new creation entry, a later point) cannot fool it.
 *  3. THE MEMBER'S OWN CREATION POINT — the base's ref may be GONE (the
 *     platform deleted it after the merge), and the member's history
 *     still remembers where its work began.
 *  4. NOTHING — and that is an answer too. The desired base's reflog
 *     answers a DIFFERENT question (where the desired base forked from
 *     the member's line), and its answer is OLDER than the truth: it is
 *     where the chain left the trunk, so a replay from there carries
 *     the base's old commits. No fork, no rebase: the owner resolves
 *     it. */
export function forkFor(
  branch: string,
  forkSha: string | undefined,
  oldBase: string,
  wt: string
): string {
  if (forkSha !== undefined && carriesCommit(branch, forkSha, wt) === true) {
    return forkSha;
  }
  const fromBase = forkPoint(oldBase, wt);
  if (fromBase !== '') {
    return fromBase;
  }
  const own = forkFromReflog(branch, wt);
  if (own !== undefined) {
    return own;
  }
  return '';
}

/** The merge commits in the range a rebase would replay — the refusal
 *  line, or undefined when the range is clean.
 *
 *  A plain rebase LINEARIZES: the merge commits in the range are
 *  dropped, and with them the conflict resolutions they carry (the
 *  corruption class `stack merge --rebase` refuses, PR #872). An
 *  unreadable count is a refusal too: an unknown truth is not "no
 *  merges". */
export function mergeCommitRefusal(
  path: string,
  range: string,
  branch: string
): string | undefined {
  const count = countMergesInRange(path, range);
  if (count === undefined) {
    return `  ${branch} skipped — the merge commits in its range cannot be counted; owner resolves on enter`;
  }
  if (count > 0) {
    return `  ${branch} contains merge commits — a rebase cannot preserve merge resolutions; use merge or squash`;
  }
  return undefined;
}
