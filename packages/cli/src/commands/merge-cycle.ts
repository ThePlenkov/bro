import type { TaskRow } from '@broject/core';
import type { RetroAction } from '@broject/retro';

const CLASSIFY_TITLE = /^classify merge-cycle findings for \[#(\d+)\]\(/;

/** An open classify action is keyed by PR number, not by its generated bead
 * id or the current retro run. */
export function isOpenClassifyBeadForPr(row: TaskRow, pr: number): boolean {
  if (row.status === 'closed' || row.status === 'done') return false;
  return CLASSIFY_TITLE.exec(row.title ?? '')?.[1] === String(pr);
}

/** Keep the store read at the command seam so the action builder remains
 * deterministic and easy to exercise without a beads database. */
export function hasOpenClassifyBeadForPr(rows: TaskRow[], pr: number): boolean {
  return rows.some(row => isOpenClassifyBeadForPr(row, pr));
}

/** The backlog action is useful only when the cycle surfaced findings to
 * classify. Clean merges should still record the retro, but must not add
 * bookkeeping noise to the ready queue. */
export function mergeCycleActions(
  link: string,
  threadCount: number,
  fixRounds: number,
  classifyAlreadyFiled = false
): RetroAction[] {
  if ((threadCount === 0 && fixRounds === 0) || classifyAlreadyFiled) return [];
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
