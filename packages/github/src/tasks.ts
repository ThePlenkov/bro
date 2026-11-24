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
import {
  bodyMeta,
  gh,
  ghHost,
  ghJson,
  ghTry,
  nativeTaskRel,
  resolveRepo,
  withMeta,
} from '@broject/core';
import type {
  ClaimCapability,
  PublishResult,
  TaskInput,
  TaskRow,
  TaskStore,
  TaskStoreAsync,
} from '@broject/core';
import {
  ensureLabel,
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
import {
  applyFilter,
  assigneesOf,
  BLOCKED_LABEL,
  CLAIMED_LABEL,
  fetchCap,
  labelsOf,
  pub,
  QUERY_CAP,
  readyOf,
  statesFor,
  toRow,
} from './tasks-rows.ts';
import { depsAsync, depsSync, neighborsAsync, neighborsSync } from './tasks-deps.ts';
import type { IssueNode } from './tasks-queries.ts';

/** The projection marker — every bead-materialized issue carries it,
 *  so `gh issue list -l bro:bead` is the board's instant filter. */
const MIRROR_LABEL = 'bro:bead';

// --- sync mutations -----------------------------------------------------------------

/** link(from, to, 'blocked') — "from is blocked by to". 'parent'
 *  makes `from` a sub-issue of `to`. Generic rels map to GitHub's
 *  dependency/sub-issue primitives; other rels have no GitHub analogue
 *  — thrown, never faked as comments. */
function linkSync(dir: string, from: string, to: string, rel: string): void {
  const type = nativeTaskRel(rel);
  if (type === 'blocks') {
    const blocker = queryIssueSync(dir, issueNumber(dir, to));
    if (blocker?.databaseId === undefined) {
      throw new Error(`github tasks: cannot resolve ${to} to an issue id`);
    }
    gh(
      [
        'api',
        '-X',
        'POST',
        `repos/{owner}/{repo}/issues/${issueNumber(dir, from)}/dependencies/blocked_by`,
        '-f',
        `issue_id=${blocker.databaseId}`,
      ],
      dir
    );
    return;
  }
  if (type === 'parent-child') {
    const child = queryIssueSync(dir, issueNumber(dir, from));
    if (child?.databaseId === undefined) {
      throw new Error(`github tasks: cannot resolve ${from} to an issue id`);
    }
    gh(
      [
        'api',
        '-X',
        'POST',
        `repos/{owner}/{repo}/issues/${issueNumber(dir, to)}/sub_issues`,
        '-f',
        `sub_issue_id=${child.databaseId}`,
      ],
      dir
    );
    return;
  }
  throw new Error(`github tasks: link rel '${rel}' has no GitHub analogue (blocked | parent)`);
}

/** The remote claim's honest capability (spec specs/bro-l8c4f.12):
 *  assign→verify-reread is a marker, never a lease — a residual
 *  interleaving window can seat two winners, and every worker behind
 *  the viewer credential claims as the same identity. */
const CLAIM_CAPABILITY = {
  strength: 'best-effort',
  identity: 'viewer',
  authority: 'service',
} as const satisfies ClaimCapability;

/** claim = addAssignees(me) → verify → bro:claimed label. The label is
 *  the commit flag: it lands only after the assignee verified. A
 *  contested assignee set resolves to the lowest login — the loser
 *  unassigns and throws. That settles a race the verify OBSERVED —
 *  it cannot promise a single winner: a loser's re-read can still
 *  snapshot the pre-write state and pass, so the capability stays
 *  best-effort, never a lease. */
function claimSync(dir: string, id: string): void {
  const n = queryIssueSync(dir, issueNumber(dir, id));
  if (n === undefined) {
    throw new Error(`github tasks: issue ${id} not found`);
  }
  if (n.state !== 'OPEN') {
    throw new Error(
      `github tasks: ${id} is ${n.state.toLowerCase()} — only open issues are claimable`
    );
  }
  const labels = labelsOf(n);
  const assignees = assigneesOf(n);
  if (labels.includes(CLAIMED_LABEL) || assignees.length > 0) {
    const holders = assignees.length > 0 ? ` by ${assignees.join(', ')}` : '';
    throw new Error(`github tasks: ${id} already claimed${holders}`);
  }
  const me = ghActor(dir);
  if (me === '') {
    throw new Error('github tasks: claim needs a gh identity — `gh api user` returned no login');
  }
  ensureLabel(dir, CLAIMED_LABEL);
  gh(['issue', 'edit', String(n.number), '--add-assignee', me], dir);
  const check = assigneesOf(queryIssueSync(dir, n.number) ?? n);
  const others = check.filter(a => a !== me);
  if (others.length === 0) {
    gh(['issue', 'edit', String(n.number), '--add-label', CLAIMED_LABEL], dir);
    return;
  }
  // codepoint order — every racer must pick the same winner regardless
  // of host locale (localeCompare ordering varies between machines)
  const winner = [...others, me].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!;
  if (winner !== me) {
    ghTry(['issue', 'edit', String(n.number), '--remove-assignee', me], dir);
    throw new Error(`github tasks: ${id} claim contested — ${winner} holds it`);
  }
  // winner path: the loser removes itself asynchronously; label now.
  gh(['issue', 'edit', String(n.number), '--add-label', CLAIMED_LABEL], dir);
}

function reopenSync(dir: string, id: string): void {
  const n = issueNumber(dir, id);
  // `gh issue reopen` errors on an already-open issue — and most
  // reopens ARE already open (an un-claim on a claimed issue). Only a
  // closed state needs the verb; the marker release runs either way.
  const cur = queryIssueSync(dir, n);
  if (cur?.state !== 'OPEN') {
    gh(['issue', 'reopen', String(n)], dir);
  }
  // release every claim marker — the pre-read names all assignees, not
  // just ours: a claim held by a crashed worker or a rival would
  // otherwise keep the issue in_progress forever, never re-queuing.
  // The blocked marker goes too — reopen means "back to the queue", and
  // real blockers (open deps/sub-issues) still hold via isBlocked.
  // Best-effort: the reopen already landed, a stale marker is cosmetic.
  for (const a of cur === undefined ? [] : assigneesOf(cur)) {
    ghTry(['issue', 'edit', String(n), '--remove-assignee', a], dir);
  }
  ghTry(['issue', 'edit', String(n), '--remove-label', CLAIMED_LABEL], dir);
  ghTry(['issue', 'edit', String(n), '--remove-label', BLOCKED_LABEL], dir);
}

/** The metadata trailer fields — every trailer-carried input must trip
 *  the guard, or a lone `priority`/`externalRef` writes no body and
 *  reads back a default. */
function createMeta(i: TaskInput): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...i.metadata };
  if (i.type !== undefined) {
    meta.type = i.type;
  }
  if (i.priority !== undefined) {
    meta.priority = i.priority;
  }
  if (i.externalRef !== undefined) {
    meta.external_ref = i.externalRef;
  }
  return meta;
}

/** 'kind:ref' — refs may be issue URLs carrying their own colons, so
 *  split on the FIRST colon only. */
function depRef(d: string): { kind: string; ref: string } {
  const colon = d.indexOf(':');
  return { kind: d.slice(0, colon), ref: d.slice(colon + 1) };
}

/** Wire parent + deps after the issue exists — pre-validated by
 *  createSync so an unsupported kind can't leave a half-created issue. */
function applyDeps(dir: string, id: string, i: TaskInput): void {
  if (i.parent !== undefined) {
    linkSync(dir, id, i.parent, 'parent');
  }
  for (const d of i.deps ?? []) {
    const { kind, ref } = depRef(d);
    linkSync(dir, id, ref, kind);
  }
}

function createSync(dir: string, i: TaskInput): TaskRow {
  // pre-validate deps before the issue exists — an unsupported dep rel
  // must not leave a half-created issue
  for (const d of i.deps ?? []) {
    const { kind } = depRef(d);
    if (!/^(blocks|blocked|blocked-by|parent|parent-child)$/.test(kind)) {
      throw new Error(`github tasks: dep rel '${kind}' unsupported (blocked | parent)`);
    }
  }
  const args = ['issue', 'create', '--title', i.title];
  if (
    i.description ||
    i.metadata ||
    i.type !== undefined ||
    i.priority !== undefined ||
    i.externalRef !== undefined
  ) {
    args.push('--body', withMeta(i.description, createMeta(i)));
  }
  for (const l of i.labels ?? []) {
    ensureLabel(dir, l);
    args.push('--label', l);
  }
  const url = gh(args, dir).trim();
  const num = /(\d+)$/.exec(url)?.[1];
  if (num === undefined) {
    throw new Error(`github tasks: gh issue create returned no issue URL — got: ${url}`);
  }
  const id = String(Number(num));
  applyDeps(dir, id, i);
  const row = queryIssueSync(dir, Number(id));
  if (row === undefined) {
    // the issue exists (the URL proved it) — a read miss is the
    // backend's problem, not a reason to fake a row
    throw new Error(`github tasks: created issue ${id} but could not read it back`);
  }
  return toRow(row);
}

function updateStatus(dir: string, n: number, id: string, val: string): void {
  if (val === 'open') {
    reopenSync(dir, id);
  } else if (val === 'closed') {
    gh(['issue', 'close', String(n)], dir);
  } else if (val === 'in_progress') {
    claimSync(dir, id);
  } else if (val === 'blocked') {
    ensureLabel(dir, BLOCKED_LABEL);
    gh(['issue', 'edit', String(n), '--add-label', BLOCKED_LABEL], dir);
  } else {
    throw new Error(`github tasks: unknown status '${val}'`);
  }
}

function updateMetaField(dir: string, n: number, k: string, val: string): void {
  const cur = queryIssueSync(dir, n);
  const meta = bodyMeta(cur?.body);
  const META_KEYS: Record<string, string> = { issue_type: 'type', externalRef: 'external_ref' };
  meta[META_KEYS[k] ?? k] = k === 'priority' ? Number(val) : val;
  gh(['issue', 'edit', String(n), '--body', withMeta(cur?.body, meta)], dir);
}

function addLabels(dir: string, n: number, val: string): void {
  for (const l of val
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')) {
    ensureLabel(dir, l);
    gh(['issue', 'edit', String(n), '--add-label', l], dir);
  }
}

function updateSync(dir: string, id: string, patch: Record<string, string | number>): void {
  const n = issueNumber(dir, id);
  for (const [k, v] of Object.entries(patch)) {
    const val = String(v);
    if (k === 'title') {
      gh(['issue', 'edit', String(n), '--title', val], dir);
    } else if (k === 'body' || k === 'description') {
      const cur = queryIssueSync(dir, n);
      gh(['issue', 'edit', String(n), '--body', withMeta(val, bodyMeta(cur?.body))], dir);
    } else if (k === 'status') {
      updateStatus(dir, n, id, val);
    } else if (k === 'claim') {
      if (v === 'true' || val === 'true') {
        claimSync(dir, id);
      }
    } else if (k === 'labels' || k === 'label') {
      addLabels(dir, n, val);
    } else if (k === 'assignee') {
      gh(['issue', 'edit', String(n), '--add-assignee', val], dir);
    } else if (k === 'notes' || k === 'note') {
      gh(['issue', 'comment', String(n), '--body', val], dir);
    } else if (['type', 'issue_type', 'priority', 'external_ref', 'externalRef'].includes(k)) {
      updateMetaField(dir, n, k, val);
    } else {
      throw new Error(`github tasks: unsupported update key '${k}'`);
    }
  }
}

function removeSync(dir: string, id: string): void {
  const n = queryIssueSync(dir, issueNumber(dir, id));
  if (n === undefined) {
    throw new Error(`github tasks: issue ${id} not found`);
  }
  ghJson(
    [
      'api',
      'graphql',
      '-f',
      'query=mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}',
      '-f',
      `id=${n.id}`,
    ],
    dir
  );
}

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
