import type { RetroAction } from '@broject/retro';

/** The backlog action is useful only when the cycle surfaced findings to
 * classify. Clean merges should still record the retro, but must not add
 * bookkeeping noise to the ready queue. */
export function mergeCycleActions(
  link: string,
  threadCount: number,
  fixRounds: number
): RetroAction[] {
  if (threadCount === 0 && fixRounds === 0) return [];
  return [
    {
      title: `classify merge-cycle findings for ${link} into prevention actions`,
      sink: 'backlog',
      detail:
        `The bro merge cycle recorded ${threadCount} thread(s) and ` +
        `${fixRounds} fix round(s). Review the retro's evidence and turn ` +
        'recurring finding classes into AGENTS.md / skill / spec preventions.',
    },
  ];
}
