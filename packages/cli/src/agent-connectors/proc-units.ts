/**
 * Process-unit probes for the native backend's stop path — /proc tree
 * walks and process-group ownership checks. The wrapper's death is not
 * its unit's death: a TERM-resistant descendant survives the group
 * signal, so a stop may only record `stopped` when the WHOLE execution
 * unit is gone, not the sh-wrapper alone (bro-l8c4f.3). The probes live
 * in @broject/core — pidAlive for the wrapper, groupMemberAlive (over
 * one shared scanProc) for the group. Off /proc the group probe cannot
 * tell the wrapper's zombie from a live member — there the caller's pid
 * check is the probe, and a descendant that outlives its wrapper is a
 * documented blind spot (failing open would spin the whole kill-wait on
 * EVERY stop and the `stopped` marker would never land).
 *
 * Leaf module — imports externals only.
 */
import {
  type AgentRegistryEntry,
  groupMemberAlive,
  type ProcEntry,
  pidAlive,
  scanProc,
} from '@broject/core';
import { pollUntilGone } from './stop-entry.ts';

/** The registry's recorded starttime for entry.pid — undefined when
 *  the entry predates identity recording or the read failed; pidAlive
 *  then skips the reuse check rather than guess. */
export const entryPidStart = (entry: AgentRegistryEntry): string | undefined =>
  typeof entry.pidStart === 'string' && entry.pidStart !== '' ? entry.pidStart : undefined;

/** The pre-signal unit snapshot — the wrapper's process tree plus
 *  every process GROUP the tree spans, off one /proc scan. A payload
 *  that leads its own session or process group escapes
 *  kill(-wrapperPgid): a fork-style `systemd-run --scope` gives the
 *  scoped child its own pid (spec bro-ybo8z — exec-style systemd-run
 *  keeps the wrapper's pid and needs nothing extra), and a setsid'd
 *  descendant was already unreachable. `down` signals each distinct
 *  pgid a live member belongs to — `{root group} ∪ {member groups}` —
 *  which for the common single-group tree is the group it always was.
 *  Members keep the same {pid,start} shape descendantsOf reports;
 *  zombies claim no group. */
export function unitSnapshot(root: number): {
  members: Array<{ pid: number; start?: string }>;
  groups: Set<number>;
} {
  const scan = scanProc();
  const members: Array<{ pid: number; start?: string }> = [];
  const groups = new Set<number>();
  if (scan === null) {
    return { members, groups };
  }
  const { byPid, children } = procTreeIndex(scan.entries);
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c)) {
        continue;
      }
      seen.add(c);
      queue.push(c);
      const e = byPid.get(c);
      members.push({ pid: c, start: e?.start === '' ? undefined : e?.start });
      if (e !== undefined && e.state !== 'Z' && e.pgrp > 0) {
        groups.add(e.pgrp);
      }
    }
  }
  return { members, groups };
}

/** ppid → children index plus pid → row, built over one /proc scan —
 *  the tree walk's lookup tables. */
export function procTreeIndex(entries: ProcEntry[]): {
  byPid: Map<number, ProcEntry>;
  children: Map<number, number[]>;
} {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  for (const e of entries) {
    byPid.set(e.pid, e);
    // push into the existing list — copying the array per entry makes
    // the /proc scan O(N²) on busy hosts (status/stop call it per probe)
    const list = children.get(e.ppid);
    if (list === undefined) {
      children.set(e.ppid, [e.pid]);
    } else {
      list.push(e.pid);
    }
  }
  return { byPid, children };
}

/** Pre-signal group ownership re-check — a pgid captured by the unit
 *  snapshot may have been emptied and recycled between scan and kill,
 *  and kill(-g) would then land SIGTERM on an unrelated process group.
 *  A group is still ours while a live member recorded in the snapshot
 *  sits in it carrying its recorded starttime (the pid+start identity
 *  pin the liveness probes use); members recorded without a starttime
 *  stay fail-open the way pidAlive does. */
export function unitOwnsGroup(
  scan: { entries: ProcEntry[] },
  g: number,
  recorded: ReadonlyMap<number, string | undefined>
): boolean {
  return scan.entries.some(
    e =>
      e.pgrp === g &&
      e.state !== 'Z' &&
      recorded.has(e.pid) &&
      (recorded.get(e.pid) === undefined || e.start === recorded.get(e.pid))
  );
}

/** SIGCONT+SIGTERM every process group the unit snapshot recorded —
 *  re-verifying each is still ours before signaling: between snapshot
 *  and kill the group could have emptied and its pgid been recycled,
 *  and kill(-g) would then land SIGTERM on an unrelated process group.
 *  The wrapper's own group gets the weaker groupMemberAlive re-check
 *  when no recorded member answers: a descendant that already outlived
 *  the wrapper is absent from the pre-death snapshot yet still holds
 *  the group, and skipping it would leak the unit's last writer. Off
 *  /proc (scan null) no re-check is possible — the legacy signal
 *  stands, same as before. */
function signalGroups(
  pid: number,
  start: string | undefined,
  members: Array<{ pid: number; start?: string }>,
  groups: ReadonlySet<number>
): void {
  // pid → recorded starttime for every pid the snapshot owns —
  // the identity table the per-group re-check signals against (a
  // recycled pgid holds none of these pids)
  const recorded = new Map<number, string | undefined>([[pid, start]]);
  for (const m of members) {
    recorded.set(m.pid, m.start);
  }
  for (const g of new Set<number>([pid, ...groups])) {
    const fresh = scanProc();
    const stale =
      fresh !== null &&
      !unitOwnsGroup(fresh, g, recorded) &&
      !(g === pid && groupMemberAlive(pid, start));
    if (stale) {
      continue;
    }
    try {
      // a lane-paused group (spec bro-y3jvd) pends every signal —
      // SIGCONT first or the TERM below waits on a stopped process
      process.kill(-g, 'SIGCONT');
    } catch {
      // not stopped, or already gone — the TERM below decides
    }
    try {
      process.kill(-g, 'SIGTERM'); // detached → own process group
    } catch {
      // No fallback to kill(pid): a native child is always its own
      // group leader, so a failed group signal means the group was
      // emptied or recycled — signaling a bare pid could hit an
      // unrelated process.
    }
  }
}

/** Signal every process group the unit spans, then wait for the unit
 *  to die — returns the liveness closure the stop path's registry-lock
 *  re-check needs (the unit, not the wrapper, is the wait: a
 *  TERM-resistant descendant outlives the sh-wrapper it was spawned
 *  under, and `stopped` over it would free a respawn onto a live
 *  writer — bro-l8c4f.3).
 *
 *  The tree snapshot rides BEFORE the signal: a descendant that
 *  escaped the group (setsid — or a scope payload a fork-style
 *  systemd-run gave its own pid to, bro-ybo8z) is invisible to
 *  groupMemberAlive, and once the wrapper dies it reparents to init —
 *  the pre-signal pid+starttime pin is the only handle left on it. The
 *  signal goes to every group the tree spans: a scoped payload's own
 *  pgid gets SIGTERM too.
 *
 *  A pid already dead (or absent) skips the signal entirely — the
 *  returned probe still answers honestly, so a repeated `down` finds
 *  the unit-check side effect (a descendant holding the group) even
 *  when no signal was sent. */
export async function signalUnitGroups(
  pid: number | undefined,
  start: string | undefined
): Promise<() => boolean> {
  let unit: Array<{ pid: number; start?: string }> = [];
  const unitAlive = () =>
    pid !== undefined &&
    (pidAlive(pid, start) ||
      groupMemberAlive(pid, start) ||
      unit.some(d => pidAlive(d.pid, d.start)));
  const live = pid !== undefined && (pidAlive(pid, start) || groupMemberAlive(pid, start));
  if (!live) {
    return unitAlive;
  }
  const snap = unitSnapshot(pid);
  unit = snap.members;
  signalGroups(pid, start, unit, snap.groups);
  // let the signal land before recording the stop — `stopped` on a
  // still-living pid would let a respawn run alongside the dying
  // agent (nativeState reports live pids as running regardless).
  await pollUntilGone(unitAlive);
  return unitAlive;
}
