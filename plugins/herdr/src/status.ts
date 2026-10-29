/**
 * Workspace status tokens — the label is the status surface (spec
 * bro-8dbyb): report-metadata tokens are display-only metadata the UI
 * never renders, so the compact `[worker·pr]` prefix rides the label.
 * Everything here is a pure read over planes + the act-state file cache
 * — a summary of what real pollers observed, never the gate itself.
 */

import { type PrActCacheEntry, type StatusAgent, silentBucketMin } from './lib.ts';
import type { Planes } from './planes.ts';

export interface WorkspaceStatus {
  /** `working` | `silent<N>` | `dead` — absent when nothing runs here. */
  worker?: string;
  /** PR number when one resolves (bead link or act-state headRef). */
  pr?: number;
  /** merged | closed | draft | conflict | blocked | pending | ok — the
   *  last-observed summary from the act-state cache; absent = unknown. */
  gate?: string;
}

/** The worktree path a fleet agent runs on: the registry's absolute
 *  path when it still resolves, else the status plane's name match —
 *  same join `agentArms` uses. */
export function agentTreePath(a: StatusAgent, p: Planes): string | undefined {
  const reg = p.registry[a.id];
  const byAbs =
    reg?.worktree !== undefined ? p.status.worktrees.find(t => t.path === reg.worktree) : undefined;
  return (byAbs ?? p.status.worktrees.find(t => t.name === a.worktree))?.path;
}

function silentToken(bucketMin: number): string {
  return bucketMin >= 60 ? `silent${Math.floor(bucketMin / 60)}h` : `silent${bucketMin}m`;
}

/** A live run's worker token — quiet past the stall bar renders the
 *  silence bucket, under it the run is just working. `stallMin <= 0`
 *  means no stall semantics, so every live run is working. */
function liveRunToken(silentMs: number | null | undefined, stallMin: number): string {
  const b = silentBucketMin(silentMs);
  if (b === null || stallMin <= 0) return 'working';
  const silentMin = Math.floor((silentMs ?? 0) / 60_000);
  return silentMin >= stallMin ? silentToken(b) : 'working';
}

/** A running fleet agent's worker token — the registry-resolved
 *  worktree path is the join, same as `agentArms`. */
function agentWorkerToken(path: string, p: Planes): 'working' | undefined {
  const agent = p.status.fleet.agents.find(
    a => a.state === 'running' && agentTreePath(a, p) === path
  );
  return agent !== undefined ? 'working' : undefined;
}

/** Live runs before dead ones — and a live agent before a dead record
 *  (a respawn beside a retained dead run is a worker, not a corpse).
 *  Order: a live run, a running agent, a dead run — a marker-armed
 *  session with no worker gets none. */
function workerToken(path: string, p: Planes): string | undefined {
  const runs = p.status.loop.runs.filter(r => r.worktree === path);
  const live = runs.find(r => r.state === 'running');
  if (live !== undefined) return liveRunToken(live.silentMs, p.status.loop.stallMin);
  const agent = agentWorkerToken(path, p);
  if (agent !== undefined) return agent;
  return runs.some(r => r.state === 'dead') ? 'dead' : undefined;
}

/** Pull a PR number off the bead's link (`…/pull/N`) — drive fixer
 *  beads carry `drive:pr:<N>` which status surfaces as `link`. */
function prFromLink(link: string | undefined): number | undefined {
  const m = link !== undefined ? /\/pull\/(\d+)/.exec(link) : null;
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

function isBlocked(s: PrActCacheEntry['state']): boolean {
  return (s.openThreads ?? 0) > 0 || (s.ciFailing ?? 0) > 0 || (s.sastPending ?? 0) > 0;
}

function isPending(s: PrActCacheEntry['state']): boolean {
  return (s.ciPending ?? 0) > 0 || (s.reviewersPending ?? 0) > 0;
}

/** Last-observed gate summary — not `evaluateExitGate`, never the
 *  verdict: "is it moving", not "may it merge". */
export function gateToken(s: PrActCacheEntry['state']): string {
  const st = (s.state ?? '').toUpperCase();
  if (st === 'MERGED' || st === 'CLOSED') return st.toLowerCase();
  if (s.isDraft === true) return 'draft';
  if ((s.mergeable ?? '').toUpperCase() === 'CONFLICTING') return 'conflict';
  if (isBlocked(s)) return 'blocked';
  if (isPending(s)) return 'pending';
  return 'ok';
}

/** Entries past this age are treated as absent — a dead poller's last
 *  write must not paint a stale verdict on the label forever. The
 *  state-cache sweeps at 6h; labels go quiet well before that. */
const ACT_LABEL_STALE_MS = 30 * 60_000;

function fresh(e: PrActCacheEntry, now: number): boolean {
  return now - e.fetchedAt <= ACT_LABEL_STALE_MS;
}

/** The act entry whose `headRef` is this worktree's branch — the
 *  strongest join: the branch is what the PR actually tracks. */
function entryForRef(
  p: Planes,
  path: string,
  act: PrActCacheEntry[],
  now: number
): PrActCacheEntry | undefined {
  const branch = p.status.worktrees.find(t => t.path === path)?.branch;
  if (branch === undefined || branch === '') return undefined;
  return act.find(e => e.state.headRef === branch && fresh(e, now));
}

function entryForPr(
  pr: number | undefined,
  act: PrActCacheEntry[],
  now: number
): PrActCacheEntry | undefined {
  if (pr === undefined) return undefined;
  return act.find(e => e.state.pr === pr && fresh(e, now));
}

function linkPr(p: Planes, slug: string | undefined): number | undefined {
  if (slug === undefined) return undefined;
  return prFromLink(p.status.beads.inProgress.find(b => b.id === slug)?.link);
}

/** PR + gate for a worktree: the tree's bead `link` first, else the
 *  act-state entry whose `headRef` is the tree's branch. */
function prFor(
  path: string,
  slug: string | undefined,
  p: Planes,
  act: PrActCacheEntry[]
): { pr?: number; gate?: string } {
  const now = Date.now();
  const link = linkPr(p, slug);
  const entry = entryForRef(p, path, act, now) ?? entryForPr(link, act, now);
  const pr = link ?? entry?.state.pr;
  if (pr === undefined) return {};
  return { pr, ...(entry !== undefined ? { gate: gateToken(entry.state) } : {}) };
}

/** `[silent16h·#765 blocked] ` — or the empty string when the tree
 *  carries no tokens (v1 label shape, unchanged). */
export function statusPrefix(s: WorkspaceStatus): string {
  const toks: string[] = [];
  if (s.worker !== undefined) toks.push(s.worker);
  if (s.pr !== undefined) {
    toks.push(s.gate !== undefined && s.gate !== '' ? `#${s.pr} ${s.gate}` : `#${s.pr}`);
  }
  return toks.length === 0 ? '' : `[${toks.join('·')}] `;
}

/** The whole status view for one armed tree — worker silence, the PR,
 *  the last-observed gate. */
export function statusFor(
  path: string,
  slug: string | undefined,
  p: Planes,
  act: PrActCacheEntry[]
): WorkspaceStatus {
  const worker = workerToken(path, p);
  return { ...(worker !== undefined ? { worker } : {}), ...prFor(path, slug, p, act) };
}
