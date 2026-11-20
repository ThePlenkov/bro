import type { LoopConfig } from './types.ts';

/** Push admission — the WIP cap's resource leg (spec bro-2spp7).
 *  `maxOpen` counts open gate-stack slots but never asks whether the
 *  machine can pay for another one; the disk floor is priced in slot
 *  units so "free disk < N × worktree-cost" refuses the claim before
 *  the worktree add walks into ENOSPC. Pure decision — the statfs
 *  probes are the caller's IO. */

export const MB = 1024 * 1024;

/** Free bytes one probe reported for a filesystem a claim writes to. */
export interface DiskProbe {
  path: string;
  freeBytes: number;
  /** Filesystem capacity — the small-fs leg prices its floor off this.
   *  Absent on probes a caller built without a statfs total: they keep
   *  the slot-priced floor exactly as before. */
  totalBytes?: number;
}

/** The floor in bytes — N slots priced at worktreeMb each, saturated:
 *  config numbers are only finite-bounded, so an absurd product must
 *  not slide past MAX_SAFE_INTEGER into garbage math — a floor at the
 *  cap still reads "everything below it breaches", the honest
 *  direction for an absurd config. */
export function diskFloorBytes(cfg: Pick<LoopConfig, 'worktreeMb' | 'diskMinSlots'>): number {
  return Math.min(cfg.diskMinSlots * cfg.worktreeMb * MB, Number.MAX_SAFE_INTEGER);
}

/** A filesystem holding this many slots or fewer is 'small' — its
 *  floor scales with capacity instead (see diskFloorFor). 16 slots of
 *  headroom is where the absolute price stops being a meaningful
 *  early warning: a 5.9G tmpfs priced at 2×400M holds only at 86%
 *  used — one leak burst from ENOSPC (spec bro-v96mp). */
const SMALL_FS_SLOTS = 16;

/** The effective floor for one probe. The slot price answers "can the
 *  fs still buy N worktrees" — right on a disk with real headroom, but
 *  a filesystem the whole queue could never grow into (total ≤
 *  SMALL_FS_SLOTS × the slot price — a tmpfs, a small ramdisk) trips
 *  it only at the ENOSPC edge. Small filesystems demand proportional
 *  headroom instead: half stays free, so a leak-held run idles at 50%
 *  used rather than 86% (spec bro-v96mp). */
export function diskFloorFor(
  cfg: Pick<LoopConfig, 'worktreeMb' | 'diskMinSlots'>,
  probe: DiskProbe
): number {
  const floor = diskFloorBytes(cfg);
  const total = probe.totalBytes;
  // total/SMALL_FS_SLOTS > floor, not total > SMALL_FS_SLOTS*floor: the
  // product overflows MAX_SAFE_INTEGER's precision the moment the slot
  // price saturates (an absurd config floors at the cap), where the
  // bound stops meaning anything; the divide is a power-of-two exponent
  // shift — exact at every magnitude a statfs can report.
  if (total === undefined || total <= 0 || total / SMALL_FS_SLOTS > floor) {
    return floor;
  }
  return Math.max(floor, Math.floor(total / 2));
}

/** The first probe below the floor — the push must hold. Undefined
 *  admits: every probed filesystem still covers the floor, or the
 *  watermark is off (`diskMinSlots`/`worktreeMb` 0), or no probe could
 *  read at all — a watermark that cannot see is reported by the
 *  caller, never a hold verdict. */
export function diskFloorBreach(
  probes: DiskProbe[],
  cfg: Pick<LoopConfig, 'worktreeMb' | 'diskMinSlots'>
): DiskProbe | undefined {
  if (cfg.diskMinSlots <= 0 || cfg.worktreeMb <= 0 || probes.length === 0) {
    return undefined;
  }
  return probes.find(p => p.freeBytes < diskFloorFor(cfg, p));
}
