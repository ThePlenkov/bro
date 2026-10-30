import { js, type ConfigSection } from '@broject/core';
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from './types.ts';

/** `loop` config section — strings normalized, numbers must be finite
 *  non-negatives, everything else falls back to the default. */
export const loopSection: ConfigSection<LoopConfig> = raw => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (k: keyof LoopConfig) =>
    typeof obj[k] === 'string' && (obj[k] as string).trim() !== ''
      ? (obj[k] as string).trim()
      : DEFAULT_LOOP_CONFIG[k];
  const num = (
    k:
      | 'stallMin'
      | 'crashExitMs'
      | 'mergeTimeoutMin'
      | 'fixRounds'
      | 'maxItems'
      | 'maxOpen'
      | 'maxOpenTotal'
      | 'worktreeWarn'
      | 'worktreeMb'
      | 'diskMinSlots'
      | 'batch'
      | 'batchMinPriority'
      | 'parkedKeep'
      | 'parkedTtlDays'
      | 'parkedWakeMin',
    min = 0
  ) =>
    typeof obj[k] === 'number' && Number.isFinite(obj[k]) && (obj[k] as number) >= min
      ? (obj[k] as number)
      : DEFAULT_LOOP_CONFIG[k];
  return {
    agent: str('agent') as string,
    provider: str('provider') as string,
    profile: str('profile') as string,
    model: str('model') as string,
    bootstrap: str('bootstrap') as string,
    stallMin: num('stallMin', 1),
    crashExitMs: num('crashExitMs'),
    mergeTimeoutMin: num('mergeTimeoutMin', 1),
    fixRounds: num('fixRounds'),
    maxItems: num('maxItems'),
    maxOpen: num('maxOpen', 1),
    maxOpenTotal: num('maxOpenTotal'),
    worktreeWarn: num('worktreeWarn'),
    // a 0 price would silence the floor entirely — the honest
    // "disable" is diskMinSlots: 0, not worktreeMb: 0
    worktreeMb: num('worktreeMb', 1),
    diskMinSlots: num('diskMinSlots'),
    batch: num('batch', 1),
    batchMinPriority: num('batchMinPriority'),
    parkedKeep: num('parkedKeep'),
    parkedTtlDays: num('parkedTtlDays'),
    parkedWakeMin: num('parkedWakeMin'),
  };
};

loopSection.jsonSchema = js.obj({
  agent: js.str,
  provider: js.str,
  profile: js.str,
  model: js.str,
  bootstrap: js.str,
  stallMin: js.num(1),
  crashExitMs: js.num(0),
  mergeTimeoutMin: js.num(1),
  fixRounds: js.num(0),
  maxItems: js.num(0),
  maxOpen: js.num(1),
  maxOpenTotal: js.num(0),
  worktreeWarn: js.num(0),
  worktreeMb: js.num(1),
  diskMinSlots: js.num(0),
  batch: js.num(1),
  batchMinPriority: js.num(0),
  parkedKeep: js.num(0),
  parkedTtlDays: js.num(0),
  parkedWakeMin: js.num(0),
});
