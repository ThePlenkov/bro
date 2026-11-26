import type { PaneLed } from './led.ts';

export type RetentionBlocker = 'dirty' | 'unpushed' | 'pr' | 'active';

export interface RetentionLegs {
  gitClean: boolean;
  unpushed: boolean;
  prOpen: boolean;
  sessionActive: boolean;
  /** The archive LED is useful to callers displaying the verdict. */
  led?: PaneLed;
}

export interface RetentionVerdict {
  archivable: boolean;
  blockedBy: RetentionBlocker[];
  led: PaneLed;
}

/** Combine independently verified legs. Missing/false legs fail closed. */
export function retentionVerdict(legs: RetentionLegs): RetentionVerdict {
  const blockedBy: RetentionBlocker[] = [];
  if (!legs.gitClean) blockedBy.push('dirty');
  if (legs.unpushed) blockedBy.push('unpushed');
  if (legs.prOpen) blockedBy.push('pr');
  if (legs.sessionActive) blockedBy.push('active');
  return {
    archivable: blockedBy.length === 0,
    blockedBy,
    led: legs.led ?? { state: blockedBy.length === 0 ? 'idle' : 'working' },
  };
}
