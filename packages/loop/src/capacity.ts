import type { LoopConfig } from './types.ts'

/** Push admission — the WIP cap's resource leg (spec bro-2spp7).
 *  `maxOpen` counts open gate-stack slots but never asks whether the
 *  machine can pay for another one; the disk floor is priced in slot
 *  units so "free disk < N × worktree-cost" refuses the claim before
 *  the worktree add walks into ENOSPC. Pure decision — the statfs
 *  probes are the caller's IO. */

export const MB = 1024 * 1024

/** Free bytes one probe reported for a filesystem a claim writes to. */
export interface DiskProbe {
  path: string
  freeBytes: number
}

/** The floor in bytes — N slots priced at worktreeMb each. */
export function diskFloorBytes(
  cfg: Pick<LoopConfig, 'worktreeMb' | 'diskMinSlots'>
): number {
  return cfg.diskMinSlots * cfg.worktreeMb * MB
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
    return undefined
  }
  const floor = diskFloorBytes(cfg)
  return probes.find((p) => p.freeBytes < floor)
}
