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
import { type AgentRegistryEntry, type ProcEntry, scanProc } from '@broject/core';

/** The registry's recorded starttime for entry.pid — undefined when
 *  the entry predates identity recording or the read failed; pidAlive
 *  then skips the reuse check rather than guess. */
export const entryPidStart = (entry: AgentRegistryEntry): string | undefined =>
  typeof entry.pidStart === 'string' && entry.pidStart !== '' ? entry.pidStart : undefined;

/** The wrapper's process-TREE snapshot — every descendant pid plus its
 *  /proc starttime, walked over ppid links. A descendant that escaped
 *  the process GROUP (setsid, its own session) is invisible to
 *  groupMemberAlive but stays in this list: the tree link breaks when
 *  the wrapper dies and the survivor reparents to init, so the
 *  snapshot must be taken while the parentage is still intact, and
 *  pid+starttime identity is what keeps a recycled pid from faking
 *  death. Empty where /proc is absent (non-Linux). */
export function descendantsOf(root: number): Array<{ pid: number; start?: string }> {
  return unitSnapshot(root).members;
}

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
