/**
 * The github connector's `tasks` facade — the TaskStore contract over
 * Issues (spec specs/bro-huy5o.1.md). `gh` is the transport: GraphQL
 * for reads, `gh issue` verbs for mutations.
 *
 * Mapping:
 *   id        — the bare issue number ('42'); '#42' and URLs accepted
 *   status    — closed | in_progress (bro:claimed label or assignee) |
 *               blocked (open blocker) | open
 *   blocked   — open `blockedBy` dependency, open sub-issue (decomposed
 *               work is not itself ready), or a manual 'blocked' label
 *   claim     — assignee + `bro:claimed` label (label lands last, after
 *               the assignee verifies — it is the commit flag)
 *   type/prio — native issueType wins, then type:/kind:/epic labels,
 *               then the `<!-- bro: {...} -->` body trailer; p<N> and
 *               priority:<N> labels, then the trailer, default 2
 *
 * GitHub has no transaction to claim through: the protocol is
 * read → addAssignees → re-read. A contested assignee set resolves to
 * the lowest login; the loser unassigns and throws. The residual
 * micro-window (a loser's verify landing before the winner's write)
 * stays visible — the issue shows both assignees — never faked.
 *
 * GHES fallback: `blockedBy`/`subIssues`/`parent`/`issueType` are
 * github.com schema additions. A schema error on them retries without
 * relation fields — relationships degrade to "none known", declared
 * absent rather than faked.
 */
import { gh, resolveRepo } from '@broject/core';
import type { TaskRow, TaskStore, TaskStoreAsync } from '@broject/core';
import {
  ghActor,
  ghActorAsync,
  issueNumber,
  queryIssueAsync,
  queryIssuesAsync,
  queryIssuesSync,
  queryIssueSync,
  querySubIssuesAsync,
  querySubIssuesSync,
} from './tasks-queries.ts';
import { applyFilter, fetchCap, pub, QUERY_CAP, readyOf, statesFor, toRow } from './tasks-rows.ts';
import { depsAsync, depsSync, neighborsAsync, neighborsSync } from './tasks-deps.ts';
import {
  CLAIM_CAPABILITY,
  claimSync,
  createSync,
  linkSync,
  removeSync,
  reopenSync,
  updateSync,
} from './tasks-mutations.ts';
import { publishSync } from './tasks-publish.ts';
import type { IssueNode } from './tasks-queries.ts';

// --- the stores -------------------------------------------------------------------

function rowOrUndef(n: IssueNode | undefined): TaskRow | undefined {
  return n === undefined ? undefined : pub(toRow(n));
}

export function githubTasks(dir: string): TaskStore {
  return {
    list: (f = {}) =>
      applyFilter(queryIssuesSync(dir, statesFor(f), fetchCap(f)).map(toRow).map(pub), f) as never,
    // applyFilter must not slice here — the limit lands AFTER the
    // priority sort in readyOf, or high-priority issues late in the
    // creation-ordered page get truncated away
    ready: (f = {}) =>
      readyOf(
        applyFilter(queryIssuesSync(dir, ['OPEN'], QUERY_CAP).map(toRow).map(pub), {
          ...f,
          status: 'open',
          limit: undefined,
        }),
        f
      ) as never,
    get: id => rowOrUndef(queryIssueSync(dir, issueNumber(dir, id))) as never,
    create: i => pub(createSync(dir, i)) as never,
    update: (id, patch) => updateSync(dir, id, patch),
    claim: id => claimSync(dir, id),
    claimCapability: () => CLAIM_CAPABILITY,
    actor: () => ghActor(dir),
    reopen: id => reopenSync(dir, id),
    close: (id, reason) => {
      gh(
        ['issue', 'close', String(issueNumber(dir, id)), ...(reason ? ['--comment', reason] : [])],
        dir
      );
    },
    remove: id => removeSync(dir, id),
    note: (id, text) => {
      gh(['issue', 'comment', String(issueNumber(dir, id)), '--body', text], dir);
    },
    children: id => querySubIssuesSync(dir, issueNumber(dir, id)).map(toRow).map(pub) as never,
    deps: (ids, opts = {}) => depsSync(dir, ids, opts) as never,
    neighbors: (id, opts = {}) => neighborsSync(dir, id, opts) as never,
    link: (from, to, rel = 'related') => linkSync(dir, from, to, rel),
    prefix: () => {
      // the repo IS the scope — no prefix. The probe still runs: an
      // unresolvable remote fails closed, same contract as beads.
      resolveRepo([], dir);
      return undefined;
    },
    publish: (task, opts) => publishSync(dir, task, opts),
  };
}

export function githubTasksAsync(dir: string): TaskStoreAsync {
  return {
    list: async (f = {}) =>
      applyFilter((await queryIssuesAsync(dir, statesFor(f), fetchCap(f))).map(toRow).map(pub), f),
    ready: async (f = {}) =>
      readyOf(
        applyFilter((await queryIssuesAsync(dir, ['OPEN'], QUERY_CAP)).map(toRow).map(pub), {
          ...f,
          status: 'open',
          limit: undefined,
        }),
        f
      ),
    get: async id => rowOrUndef(await queryIssueAsync(dir, issueNumber(dir, id))) as never,
    children: async id =>
      (await querySubIssuesAsync(dir, issueNumber(dir, id))).map(toRow).map(pub) as never,
    deps: async (ids, opts = {}) => (await depsAsync(dir, ids, opts)) as never,
    neighbors: async (id, opts = {}) => (await neighborsAsync(dir, id, opts)) as never,
    actor: () => ghActorAsync(dir),
  };
}
