/**
 * Litter keep-plane — the claim-liveness legs plus the PR-evidence
 * lookup (spec bro-ho09d). `claimOwner` unions every plane that can
 * prove an in_progress bead's claim is still held — loop run records,
 * the agent registry, session markers and ledger claims, act-wait
 * markers, agent-shaped processes rooted in the tree — and every leg
 * fails CLOSED: a live or unverifiable plane answers "owned", only a
 * unanimous dead read lets `releaseDeadClaim` note+reopen the bead.
 *
 * Leaf module — imports externals plus the sweep's shared types; the
 * caller narrows nothing (every leg reads the same LitterCtx).
 */
import { basename, resolve } from 'node:path';
import type { ListedWatch } from '@broject/act';
import {
  type AgentRegistryEntry,
  acquireAgentRegistryLock,
  type ClaimRow,
  pidAlive,
  readAgentRegistry,
  type TaskRow,
} from '@broject/core';
import { beadForHead, loopSlug } from '@broject/loop';
import { agentProcessesIn, detailMatches, registryEntryHoldsClaim } from '@broject/rig';
import type { LoopRunView } from './loop-state.ts';
import type { LitterCandidate, LitterCtx, WorktreeInfo } from './work.ts';

/** Candidate → bead row. Deterministic namespaces (loop/, stack/)
 *  read the exact slug map — a miss means no bead, full stop. Label
 *  namespaces (work//feat//fix//devin/ and detached dir/claim slugs)
 *  carry a human label, not a bead contract: beadForHead — the
 *  fleet-head reconcile's own matcher — is the ONLY rung, because its
 *  '-'-bounded prefix match already covers the tidy `work/<bead-id>`
 *  exact tail AND refuses ambiguity (two bead owners → undefined =
 *  keep). A raw exact-map shortcut would bypass that check: `work/
 *  <slug>` naming bead B while a shorter bead also prefix-matches
 *  would attribute the tree to B and reap a live owner's work. The
 *  second rung is the same matcher on the '<prefix>-<slug>' short
 *  form (`work/imvu3` → `bro-imvu3`), skipped when the slug already
 *  carries the prefix (that shape matched at rung one or names a
 *  doubled-prefix bead the prefix rung can't reach anyway). */
export function litterBead(ctx: LitterCtx, c: LitterCandidate): TaskRow | undefined {
  if (c.label !== true) {
    return ctx.bySlug.get(c.slug);
  }
  const headRef = c.branch === '' ? `x/${c.slug}` : c.branch;
  const direct = beadForHead({ pr: 0, headRef }, ctx.bySlug);
  if (direct !== undefined) {
    return direct;
  }
  return prefixRungBead(ctx, c);
}

/** The '<prefix>-<slug>' label rung — the store may not name a prefix
 *  at all, and a slug already carrying it matched at rung one (or
 *  names a doubled-prefix bead this rung can't reach anyway). */
function prefixRungBead(ctx: LitterCtx, c: LitterCandidate): TaskRow | undefined {
  const p = ctx.prefix;
  if (p === undefined || p === '') {
    return undefined;
  }
  if (c.slug.startsWith(`${p}-`)) {
    return undefined;
  }
  return beadForHead({ pr: 0, headRef: `x/${p}-${c.slug}` }, ctx.bySlug);
}

/** Live registry occupants pinning a tree — an agent (a respawned drive
 *  fixer, say) working a closed bead's tree still owns it. Undefined
 *  when the registry is unreadable: readAgentRegistry deliberately
 *  re-throws on corruption (a silent {} lets a reaper orphan live
 *  agents' trees — bro-f6zp), so an unknowable occupancy plane is a
 *  keep verdict, not an empty map. */
export function litterOccupants(root: string): Map<string, string> | undefined {
  const occupied = new Map<string, string>();
  try {
    for (const [molStep, e] of Object.entries(readAgentRegistry(root))) {
      const path = occupantPath(e);
      if (path !== undefined) {
        occupied.set(path, e.agentId || molStep);
      }
    }
    return occupied;
  } catch {
    return undefined;
  }
}

/** One registry entry's resolved worktree path when its pid reads live
 *  — a dead or worktree-less entry occupies nothing. */
function occupantPath(e: AgentRegistryEntry): string | undefined {
  if (typeof e.worktree !== 'string') {
    return undefined;
  }
  // registry rows ride untyped — the pidStart narrow keeps malformed
  // legacy entries from misreading the pid comparison
  const live =
    typeof e.pid === 'number' &&
    pidAlive(e.pid, typeof e.pidStart === 'string' ? e.pidStart : undefined);
  return live ? resolve(e.worktree) : undefined;
}

/** A fresh agents.json read inside the registry lock — an unreadable
 *  plane is undefined, which fails CLOSED (registryOwner answers
 *  'unreadable' = live) rather than trusting a stale snapshot. */
function registrySnapshot(root: string): Record<string, AgentRegistryEntry> | undefined {
  try {
    return readAgentRegistry(root);
  } catch {
    return undefined;
  }
}

/** The claim's live owner, or undefined when every plane is dead —
 *  every plane fails closed, first live (or unverifiable) owner wins. */
function claimOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  const planes: Array<() => string | undefined> = [
    () => runRecordOwner(ctx, c, bead),
    () => registryOwner(ctx, c, bead),
    () => sessionOwner(ctx, c),
    () => watchOwner(ctx, c, bead),
    () => treeProcessOwner(c),
  ];
  for (const probe of planes) {
    const owner = probe();
    if (owner !== undefined) {
      return owner;
    }
  }
  return undefined;
}

/** loop run records — collectLoopRuns already judged pid+pidStart;
 *  beadIds covers the whole claimed clump, not just the lead */
function runRecordOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  for (const v of ctx.claims.runs) {
    if (v.state !== 'running') {
      continue;
    }
    if (runRecordOn(v, c, bead)) {
      return `loop worker pid ${v.pid} live`;
    }
  }
  return undefined;
}

/** One run record's bead binding — the record's own id list (clump
 *  members, not just the lead) plus its slug. */
function runRecordOn(v: LoopRunView, c: LitterCandidate, bead: TaskRow): boolean {
  const onBead = [v.beadId, ...(v.beadIds ?? [])].includes(bead.id);
  return onBead || v.slug === c.slug;
}

/** A plane record's worktree field pins this candidate's tree — an
 *  absent candidate tree or a non-string field pins nothing. Shared
 *  by the registry and watch legs (both carry a `worktree`-shaped
 *  record resolved the same way). */
function worktreePinned(recorded: unknown, w: WorktreeInfo | undefined): boolean {
  if (w === undefined || typeof recorded !== 'string') {
    return false;
  }
  return resolve(recorded) === resolve(w.path);
}

/** agent registry — an unreadable plane is not a dead worker */
function registryOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  const { claims } = ctx;
  if (claims.registry === undefined) {
    return 'agent registry unreadable';
  }
  for (const [molStep, e] of Object.entries(claims.registry)) {
    const hitsBead = molStep === bead.id;
    if (!hitsBead && !worktreePinned(e.worktree, c.w)) {
      continue;
    }
    if (registryEntryHoldsClaim(claims.agentsHome, e)) {
      return `agent ${e.agentId || molStep} live`;
    }
  }
  return undefined;
}

/** A live ledger claim naming this candidate — the marker/arm-detail
 *  legs' machine-wide twin (bro-izpyk.10). `worktree:` binds by path
 *  first, then by its recorded detail like a marker line; `branch:`
 *  binds by name/detail the same way. `ids` lets a `.task`-style claim
 *  carry the full bead id (same widening sessionOwner's marker leg
 *  gets). */
export function sessionClaimOn(
  rows: ClaimRow[],
  c: LitterCandidate,
  ids: string[] = []
): ClaimRow | undefined {
  return rows.find(row => claimRowOn(row, c, ids));
}

/** One ledger claim's match — `worktree:` binds by path first, then by
 *  its recorded detail like a marker line; `branch:` binds by
 *  name/detail the same way. */
function claimRowOn(row: ClaimRow, c: LitterCandidate, ids: string[]): boolean {
  const r = row.resource;
  if (r.startsWith('worktree:')) {
    return worktreeClaimRowOn(row, r, c, ids);
  }
  if (r.startsWith('branch:')) {
    return detailMatches(row.detail || r.slice('branch:'.length), {
      branch: c.branch,
      slug: c.slug,
      worktree: c.w?.path,
    });
  }
  return false;
}

/** The `worktree:` leg — the claimed path itself first (a lease
 *  naming the tree pins it regardless of the recorded detail), then
 *  the detail/ids match like a marker line. */
function worktreeClaimRowOn(row: ClaimRow, r: string, c: LitterCandidate, ids: string[]): boolean {
  const path = r.slice('worktree:'.length);
  if (c.w !== undefined && resolve(path) === resolve(c.w.path)) {
    return true;
  }
  const probe = row.detail || basename(path);
  return (
    detailMatches(probe, { branch: c.branch, slug: c.slug, worktree: c.w?.path }) ||
    ids.includes(probe)
  );
}

/** session markers — `bd --claim` arms .task, `bro work enter` arms .work */
function sessionOwner(ctx: LitterCtx, c: LitterCandidate): string | undefined {
  // a .task marker carries the full bead id (`bd update <bead> --claim`)
  // — branch/slug/worktree matching alone misses it for short label
  // slugs (`work/imvu3` → `bro-imvu3`), so the resolved row's ids join
  // the match set
  const bead = litterBead(ctx, c);
  const ids = bead === undefined ? [] : [bead.id, loopSlug(bead.id)];
  const detail = ctx.claims.sessionDetails.find(d => armedDetailOn(d, c, ids));
  if (detail !== undefined) {
    return `session armed ${detail}`;
  }
  // ledger claims — the marker leg's cross-session twin (bro-izpyk.10):
  // a live `worktree:`/`branch:` lease naming this candidate is the
  // same keep-reason, machine-wide
  const claim = sessionClaimOn(ctx.claims.sessionClaims, c, ids);
  return claim === undefined
    ? undefined
    : `session ${claim.sid.slice(0, 8)} claims ${claim.resource}`;
}

/** One armed marker detail's match — the branch/slug/worktree triple
 *  or a clump id verbatim. */
function armedDetailOn(d: string, c: LitterCandidate, ids: string[]): boolean {
  return (
    detailMatches(d, { branch: c.branch, slug: c.slug, worktree: c.w?.path }) || ids.includes(d)
  );
}

/** live watch markers — a landed member's claim rides its act wait
 *  (bro-q6ppv): the loop services the gate stack past the worker's exit */
function watchOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  for (const l of ctx.claims.watches) {
    if (l.alive && watchHits(l, c, bead)) {
      return `watch on ${l.watch.link} live`;
    }
  }
  return undefined;
}

/** One watch marker's binding — a clump's whole id list rides the
 *  marker comma-joined (bro-q6ppv); the workdir pins the tree the same
 *  way the registry's worktree field does. */
function watchHits(l: ListedWatch, c: LitterCandidate, bead: TaskRow): boolean {
  const hitsBead = l.watch.bead?.split(',').includes(bead.id) === true;
  return hitsBead || worktreePinned(l.watch.workdir, c.w);
}

/** a live agent-shaped process inside the tree — covers a worker that
 *  never registered (spawn crashed after fork, record write lost) */
function treeProcessOwner(c: LitterCandidate): string | undefined {
  if (c.w === undefined) {
    return undefined;
  }
  const hit = agentProcessesIn(c.w.path)[0];
  return hit === undefined ? undefined : `process ${hit.pid} live in tree`;
}

/** Release an orphaned claim — every plane dead. Runs the final
 *  liveness re-check and the note+reopen inside the shared registry
 *  lock: a respawn's claim→register writes under the same lock, so a
 *  worker landing during our wait either shows up in the re-read or
 *  claims after we've released (the reopened bead is then its target —
 *  correct). Returns the keep reason when the claim survives,
 *  undefined when it was released (or would be, under dry-run). */
export function releaseDeadClaim(
  ctx: LitterCtx,
  c: LitterCandidate,
  bead: TaskRow
): string | undefined {
  const { opts, rep } = ctx;
  const pre = claimOwner(ctx, c, bead);
  if (pre !== undefined) {
    return pre;
  }
  let release: () => void;
  try {
    release = acquireAgentRegistryLock(ctx.main.path);
  } catch {
    return 'occupancy lock contended';
  }
  try {
    // re-read under the lock — the snapshot predates the wait, and a
    // respawn's registry write lands inside this same section
    const registry = registrySnapshot(opts.root);
    const owner = claimOwner({ ...ctx, claims: { ...ctx.claims, registry } }, c, bead);
    if (owner !== undefined) {
      return owner;
    }
    if (opts.dryRun !== true) {
      const failed = noteReopenClaim(ctx, bead);
      if (failed !== undefined) {
        return failed;
      }
    }
    // the snapshot row drives the rest of the sweep's verdicts
    bead.status = 'open';
    rep.released.push(`${bead.id} (no live worker)`);
    return undefined;
  } finally {
    release();
  }
}

/** The note+reopen half of a claim release — a store write that loses
 *  (dead store, racing claim) reports the failure and keeps the bead:
 *  the sweep must not mark a claim released that never landed. */
function noteReopenClaim(ctx: LitterCtx, bead: TaskRow): string | undefined {
  try {
    ctx.opts.tasks.note(
      bead.id,
      'bro work prune --loop: released orphaned claim — every worker-liveness plane is dead (bro-ho09d)'
    );
    ctx.opts.tasks.reopen(bead.id);
  } catch (err) {
    ctx.rep.errors.push(
      `claim release for ${bead.id} failed — ${err instanceof Error ? err.message : err}`
    );
    return 'claim release failed';
  }
  return undefined;
}
