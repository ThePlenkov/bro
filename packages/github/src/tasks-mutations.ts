/**
 * The issue verbs — link, claim, reopen, create, update, remove (moved
 * from tasks.ts). `gh issue` verbs are the transport; every verb that
 * re-reads goes through the GraphQL read path in tasks-queries.ts.
 *
 * GitHub has no transaction to claim through: the protocol is
 * read → addAssignees → re-read. A contested assignee set resolves to
 * the lowest login; the loser unassigns and throws. The residual
 * micro-window (a loser's verify landing before the winner's write)
 * stays visible — the issue shows both assignees — never faked.
 */

import type { ClaimCapability, TaskInput, TaskRow } from '@broject/core';
import { bodyMeta, gh, ghJson, ghTry, nativeTaskRel, withMeta } from '@broject/core';
import { ensureLabel, ghActor, issueNumber, queryIssueSync } from './tasks-queries.ts';
import { assigneesOf, BLOCKED_LABEL, CLAIMED_LABEL, labelsOf, toRow } from './tasks-rows.ts';

/** The dependency write both rels share — resolve one side's REST
 *  databaseId, then POST the endpoint naming the other side's NUMBER.
 *  'blocks' resolves `to` and posts onto `from`'s dependencies;
 *  'parent-child' resolves `from` and posts onto `to`'s sub_issues.
 *  The resolve runs first — a missing issue errors before the other
 *  side's ref is even parsed. */
function linkRel(dir: string, from: string, to: string, type: string): void {
  const resolve = type === 'blocks' ? to : from;
  const node = queryIssueSync(dir, issueNumber(dir, resolve));
  if (node?.databaseId === undefined) {
    throw new Error(`github tasks: cannot resolve ${resolve} to an issue id`);
  }
  const endpoint =
    type === 'blocks'
      ? `repos/{owner}/{repo}/issues/${issueNumber(dir, from)}/dependencies/blocked_by`
      : `repos/{owner}/{repo}/issues/${issueNumber(dir, to)}/sub_issues`;
  const field = type === 'blocks' ? 'issue_id' : 'sub_issue_id';
  gh(['api', '-X', 'POST', endpoint, '-f', `${field}=${node.databaseId}`], dir);
}

/** link(from, to, 'blocked') — "from is blocked by to". 'parent'
 *  makes `from` a sub-issue of `to`. Generic rels map to GitHub's
 *  dependency/sub-issue primitives; other rels have no GitHub analogue
 *  — thrown, never faked as comments. */
export function linkSync(dir: string, from: string, to: string, rel: string): void {
  const type = nativeTaskRel(rel);
  if (type === 'blocks' || type === 'parent-child') {
    linkRel(dir, from, to, type);
    return;
  }
  throw new Error(`github tasks: link rel '${rel}' has no GitHub analogue (blocked | parent)`);
}

/** The remote claim's honest capability (spec specs/bro-l8c4f.12):
 *  assign→verify-reread is a marker, never a lease — a residual
 *  interleaving window can seat two winners, and every worker behind
 *  the viewer credential claims as the same identity. */
export const CLAIM_CAPABILITY = {
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
export function claimSync(dir: string, id: string): void {
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

export function reopenSync(dir: string, id: string): void {
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

/** The issue body — only composed when the input carries body-worthy
 *  content: a lone title/labels create must not write an empty trailer. */
const createBody = (i: TaskInput): string | undefined =>
  i.description ||
  i.metadata ||
  i.type !== undefined ||
  i.priority !== undefined ||
  i.externalRef !== undefined
    ? withMeta(i.description, createMeta(i))
    : undefined;

/** 'kind:ref' — refs may be issue URLs carrying their own colons, so
 *  split on the FIRST colon only. A missing colon is a malformed dep:
 *  slicing at -1 would fake the kind ('parents' → 'parent') and pass
 *  the rel regex with a bogus ref — throw before either caller slices. */
function depRef(d: string): { kind: string; ref: string } {
  const colon = d.indexOf(':');
  if (colon === -1) {
    throw new Error(`github tasks: dep '${d}' is not 'kind:ref' (blocked | parent)`);
  }
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

export function createSync(dir: string, i: TaskInput): TaskRow {
  // pre-validate deps before the issue exists — an unsupported dep rel
  // must not leave a half-created issue
  for (const d of i.deps ?? []) {
    const { kind } = depRef(d);
    if (!/^(blocks|blocked|blocked-by|parent|parent-child)$/.test(kind)) {
      throw new Error(`github tasks: dep rel '${kind}' unsupported (blocked | parent)`);
    }
  }
  const args = ['issue', 'create', '--title', i.title];
  const body = createBody(i);
  if (body !== undefined) {
    args.push('--body', body);
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

/** The issue a patch lands on — `n` for the gh argv, `id` for the verbs
 *  that re-resolve (claim/reopen read the ref, not the number). */
interface PatchTarget {
  dir: string;
  n: number;
  id: string;
}

/** One patch entry — the raw value and its string form travel together
 *  (`claim` reads the raw, every verb wants the string). */
interface PatchField {
  key: string;
  raw: string | number;
  val: string;
}

/** One patch key → its verb. Keys the store doesn't carry are a usage
 *  error — a silent drop would claim an update that never landed. */
function applyPatchField(t: PatchTarget, f: PatchField): void {
  const { dir, n, id } = t;
  if (f.key === 'title') {
    gh(['issue', 'edit', String(n), '--title', f.val], dir);
  } else if (f.key === 'body' || f.key === 'description') {
    const cur = queryIssueSync(dir, n);
    gh(['issue', 'edit', String(n), '--body', withMeta(f.val, bodyMeta(cur?.body))], dir);
  } else if (f.key === 'status') {
    updateStatus(dir, n, id, f.val);
  } else if (f.key === 'claim') {
    if (f.raw === 'true' || f.val === 'true') {
      claimSync(dir, id);
    }
  } else if (f.key === 'labels' || f.key === 'label') {
    addLabels(dir, n, f.val);
  } else if (f.key === 'assignee') {
    gh(['issue', 'edit', String(n), '--add-assignee', f.val], dir);
  } else if (f.key === 'notes' || f.key === 'note') {
    gh(['issue', 'comment', String(n), '--body', f.val], dir);
  } else if (['type', 'issue_type', 'priority', 'external_ref', 'externalRef'].includes(f.key)) {
    updateMetaField(dir, n, f.key, f.val);
  } else {
    throw new Error(`github tasks: unsupported update key '${f.key}'`);
  }
}

export function updateSync(dir: string, id: string, patch: Record<string, string | number>): void {
  const target: PatchTarget = { dir, n: issueNumber(dir, id), id };
  for (const [key, raw] of Object.entries(patch)) {
    applyPatchField(target, { key, raw, val: String(raw) });
  }
}

export function removeSync(dir: string, id: string): void {
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
