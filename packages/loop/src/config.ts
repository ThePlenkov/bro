import { js, type ConfigSection } from '@broject/core';
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from './types.ts';

/** The supervised cadence ceiling — the spawned `--every` lands in a
 *  `setTimeout`, so the 32-bit-ms bound applies; the CLI's argv
 *  validation enforces the same number. */
const SUPERVISED_MAX_SEC = 0x7fffffff / 1000;

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
      | 'everySec'
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
    min = 0,
    max = Number.POSITIVE_INFINITY,
    int = false
  ) =>
    typeof obj[k] === 'number' &&
    // counts and budgets must be whole; durations and cadences may be
    // fractional (a 0.5s stallMin or a 2.5s everySec is valid)
    (int ? Number.isInteger(obj[k]) : Number.isFinite(obj[k])) &&
    (obj[k] as number) >= min &&
    (obj[k] as number) <= max
      ? (obj[k] as number)
      : DEFAULT_LOOP_CONFIG[k];
  return {
    agent: str('agent') as string,
    provider: str('provider') as string,
    profile: str('profile') as string,
    model: str('model') as string,
    bootstrap: str('bootstrap') as string,
    // a sub-second re-scan cadence is a busy loop, not a supervisor —
    // the same floor the shared want-marker bounds carry; the ceiling
    // is the spawned supervisor's own --every bound (its sleep rides a
    // setTimeout) — an oversized value would arm a marker the child
    // refuses, so it falls back here instead
    everySec: num('everySec', 1, SUPERVISED_MAX_SEC),
    stallMin: num('stallMin', 1),
    crashExitMs: num('crashExitMs'),
    mergeTimeoutMin: num('mergeTimeoutMin', 1),
    fixRounds: num('fixRounds', 0, Number.POSITIVE_INFINITY, true),
    autoMerge: obj.autoMerge === true,
    maxItems: num('maxItems', 0, Number.POSITIVE_INFINITY, true),
    maxOpen: num('maxOpen', 1, Number.POSITIVE_INFINITY, true),
    maxOpenTotal: num('maxOpenTotal', 0, Number.POSITIVE_INFINITY, true),
    worktreeWarn: num('worktreeWarn', 0, Number.POSITIVE_INFINITY, true),
    // a 0 price would silence the floor entirely — the honest
    // "disable" is diskMinSlots: 0, not worktreeMb: 0
    worktreeMb: num('worktreeMb', 1),
    diskMinSlots: num('diskMinSlots', 0, Number.POSITIVE_INFINITY, true),
    batch: num('batch', 1, Number.POSITIVE_INFINITY, true),
    batchMinPriority: num('batchMinPriority', 0, Number.POSITIVE_INFINITY, true),
    parkedKeep: num('parkedKeep', 0, Number.POSITIVE_INFINITY, true),
    parkedTtlDays: num('parkedTtlDays', 0, Number.POSITIVE_INFINITY, true),
    parkedWakeMin: num('parkedWakeMin'),
  };
};

loopSection.jsonSchema = js.obj({
  agent: js.str,
  provider: js.str,
  profile: js.str,
  model: js.str,
  bootstrap: js.str,
  everySec: { type: 'number', minimum: 1, maximum: SUPERVISED_MAX_SEC },
  stallMin: js.num(1),
  crashExitMs: js.num(0),
  mergeTimeoutMin: js.num(1),
  fixRounds: js.num(0),
  autoMerge: js.bool,
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
