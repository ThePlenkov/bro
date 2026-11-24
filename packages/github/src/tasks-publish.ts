/**
 * The bead→issue projection (spec specs/backends/bro-z2z7f), moved from
 * tasks.ts. Dedup: an external_ref naming one of this repo's issues
 * returns it — the caller's write-back made the map; a foreign ref
 * declines (the bead already projects elsewhere — one task, one
 * outward identity). An epic parent materializes as a milestone the
 * new issue joins.
 */
import { ghHost, ghJson, ghTry } from '@broject/core';
import type { PublishResult, TaskRow } from '@broject/core';
import { createSync } from './tasks-mutations.ts';
import { issueNumber, queryIssueSync, repoOf } from './tasks-queries.ts';
import { pub, toRow } from './tasks-rows.ts';

/** The projection marker — every bead-materialized issue carries it,
 *  so `gh issue list -l bro:bead` is the board's instant filter. */
const MIRROR_LABEL = 'bro:bead';

/** 'https://<this host>/<this repo>/milestone/N' → N — the epic's
 *  external_ref round-trips through this exact shape; a milestone in
 *  another repo or on another host is a foreign ref, not a container
 *  here (its NUMBER would silently target this repo's milestones). */
function milestoneRefNumber(dir: string, ref: string): number | undefined {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/milestone\/(\d+)\/?$/.exec(ref.trim());
  if (m === null) {
    return undefined;
  }
  const [, host, owner, name, num] = m;
  if (host.toLowerCase() !== ghHost().toLowerCase()) {
    return undefined;
  }
  return `${owner}/${name}`.toLowerCase() === repoOf(dir).toLowerCase() ? Number(num) : undefined;
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

/** What the row's external_ref maps to on this repo: a live issue
 *  (publish returns it), a stale map (re-publish and flag the
 *  replacement), or a foreign/unparseable ref (decline). */
type MappedRef = { kind: 'live'; row: TaskRow } | { kind: 'stale' } | { kind: 'foreign' };

function mappedRef(dir: string, ref: string): MappedRef {
  try {
    const cur = queryIssueSync(dir, issueNumber(dir, ref));
    return cur === undefined ? { kind: 'stale' } : { kind: 'live', row: pub(toRow(cur)) };
  } catch {
    return { kind: 'foreign' };
  }
}

/** Join the new issue to the epic's milestone — best-effort: the issue
 *  already exists, so a failed join must not throw (a publishSync throw
 *  skips the caller's external_ref write-back, and the next run would
 *  create a duplicate). */
function joinMilestone(dir: string, issueId: string, milestone: number | undefined): void {
  if (milestone === undefined) {
    return;
  }
  const join = ghTry(
    [
      'api',
      '-X',
      'PATCH',
      `repos/{owner}/{repo}/issues/${issueId}`,
      '-F',
      `milestone=${milestone}`,
    ],
    dir
  );
  if (join.code !== 0) {
    console.error(`warning: milestone join on issue ${issueId} failed — ${join.err}`);
  }
}

/** The bead→issue projection. Dedup: an external_ref naming one of
 *  this repo's issues returns it — the caller's write-back made the
 *  map; a foreign ref declines (the bead already projects elsewhere —
 *  one task, one outward identity). An epic parent materializes as a
 *  milestone the new issue joins. */
export function publishSync(
  dir: string,
  task: TaskRow,
  opts?: { epic?: TaskRow }
): PublishResult | undefined {
  const ref = task.external_ref?.trim() ?? '';
  let replaceExternalRef: true | undefined;
  if (ref !== '') {
    const mapped = mappedRef(dir, ref);
    if (mapped.kind === 'live') {
      return { item: mapped.row };
    }
    if (mapped.kind === 'foreign') {
      return undefined;
    }
    // the mapped item is gone — fall through to re-publish, and flag
    // the stale map so the caller's write-back replaces it instead of
    // preserving it (the next pass would duplicate again)
    replaceExternalRef = true;
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
  joinMilestone(dir, row.id, milestone);
  return { item: pub(row), epicRef, replaceExternalRef };
}
