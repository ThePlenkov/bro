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
import { gh, ghHost, ghJson, ghTry, resolveRepo } from '@broject/core';
import type { PublishResult, TaskRow, TaskStore, TaskStoreAsync } from '@broject/core';
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
  repoOf,
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
import type { IssueNode } from './tasks-queries.ts';

/** The projection marker — every bead-materialized issue carries it,
 *  so `gh issue list -l bro:bead` is the board's instant filter. */
const MIRROR_LABEL = 'bro:bead';

// --- projection (spec specs/backends/bro-z2z7f) ----------------------------------

/** 'https://<this host>/<this repo>/milestone/N' → N — the epic's
 *  external_ref round-trips through this exact shape; a milestone in
 *  another repo or on another host is a foreign ref, not a container
 *  here (its NUMBER would silently target this repo's milestones). */
function milestoneRefNumber(dir: string, ref: string): number | undefined {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/milestone\/(\d+)\/?$/.exec(ref.trim());
  if (
    m === null ||
    m[1]!.toLowerCase() !== ghHost().toLowerCase() ||
    `${m[2]}/${m[3]}`.toLowerCase() !== repoOf(dir).toLowerCase()
  ) {
    return undefined;
  }
  return Number(m[4]);
}

interface MilestoneRow {
  number: number;
  title: string;
  html_url?: string;
}

const milestoneUrl = (repo: string, m: MilestoneRow): string =>
  m.html_url ?? `https://${ghHost()}/${repo}/milestone/${m.number}`;

/** Epic → milestone — title-match is the lost-map fallback; the
 *  authoritative dedup is the epic row's external_ref, which the
 *  caller's write-back fills with this milestone's html_url. */
function ensureMilestone(dir: string, epic: TaskRow): { number: number; url: string } {
  const repo = repoOf(dir);
  const title = epic.title !== undefined && epic.title.trim() !== '' ? epic.title : epic.id;
  const all = ghJson<MilestoneRow[]>(
    ['api', '--paginate', `repos/${repo}/milestones?state=all&per_page=100`],
    dir
  );
  const hit = all.find(m => m.title === title);
  if (hit !== undefined) {
    return { number: hit.number, url: milestoneUrl(repo, hit) };
  }
  const made = ghJson<MilestoneRow>(
    [
      'api',
      '-X',
      'POST',
      `repos/${repo}/milestones`,
      '-f',
      `title=${title}`,
      '-f',
      `description=bead ${epic.id} — projected epic`,
    ],
    dir
  );
  return { number: made.number, url: milestoneUrl(repo, made) };
}

/** The epic's container: a known milestone ref joins it; an absent
 *  ref creates the milestone and lends the bead its URL. A foreign
 *  ref declines — the epic projects elsewhere, no join. */
function epicMilestone(dir: string, epic: TaskRow): { milestone?: number; epicRef?: string } {
  const eref = epic.external_ref?.trim() ?? '';
  if (eref !== '') {
    const known = milestoneRefNumber(dir, eref);
    return known === undefined ? {} : { milestone: known };
  }
  const ms = ensureMilestone(dir, epic);
  return { milestone: ms.number, epicRef: ms.url };
}

/** The bead→issue projection. Dedup: an external_ref naming one of
 *  this repo's issues returns it — the caller's write-back made the
 *  map; a foreign ref declines (the bead already projects elsewhere —
 *  one task, one outward identity). An epic parent materializes as a
 *  milestone the new issue joins. */
function publishSync(
  dir: string,
  task: TaskRow,
  opts?: { epic?: TaskRow }
): PublishResult | undefined {
  const ref = task.external_ref?.trim() ?? '';
  let replaceExternalRef: true | undefined;
  if (ref !== '') {
    try {
      const n = issueNumber(dir, ref);
      const cur = queryIssueSync(dir, n);
      if (cur !== undefined) {
        return { item: pub(toRow(cur)) };
      }
      // the mapped item is gone — fall through to re-publish, and flag
      // the stale map so the caller's write-back replaces it instead of
      // preserving it (the next pass would duplicate again)
      replaceExternalRef = true;
    } catch {
      return undefined;
    }
  }
  const epic = opts?.epic;
  const { milestone, epicRef } = epic === undefined ? {} : epicMilestone(dir, epic);
  // the source row's metadata bag is provenance, never identity — an
  // `external_ref` inside it (a stale or foreign map value) must not
  // reach the item's trailer: toRow reads trailer external_ref as the
  // item's own ref, so the caller's write-back would re-stamp the bogus
  // value and dedup stays broken. The item's own url is its canonical
  // ref here; a deliberate trailer ref rides TaskInput.externalRef,
  // which publish never sets.
  const { external_ref: _eref, ...restMeta } = task.metadata ?? {};
  const row = createSync(dir, {
    title: task.title !== undefined && task.title !== '' ? task.title : task.id,
    description: task.description,
    type: task.issue_type,
    priority: task.priority,
    labels: [MIRROR_LABEL, ...(task.labels ?? []).filter(l => l !== MIRROR_LABEL)],
    metadata: { ...restMeta, bead: task.id },
  });
  if (milestone !== undefined) {
    // best-effort: the issue already exists, so a failed join must not
    // throw — publishSync throwing skips the caller's external_ref
    // write-back, and the next run would create a duplicate
    const join = ghTry(
      [
        'api',
        '-X',
        'PATCH',
        `repos/{owner}/{repo}/issues/${row.id}`,
        '-F',
        `milestone=${milestone}`,
      ],
      dir
    );
    if (join.code !== 0) {
      console.error(`warning: milestone join on issue ${row.id} failed — ${join.err}`);
    }
  }
  return { item: pub(row), epicRef, replaceExternalRef };
}

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
