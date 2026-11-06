import type { SessionUpdateLike } from '../wire/index.ts';

/** One archive row — the shapes `agentTurnPlane` and the worker's
 *  permission seam write into the append-only `<agentId>.events.jsonl`
 *  journal (spec bro-l8wqu). Unknown kinds parse through harmlessly —
 *  forward-compatible tail. */
export interface ArchiveRow {
  kind?: string;
  /** The journal stamp — every row `agentTurnPlane` writes carries
   *  it; the pane's time gutter and judge-turn detection ride on
   *  these two fields. */
  ts?: string;
  by?: string;
  phase?: string;
  update?: SessionUpdateLike;
  stopReason?: string;
  error?: string;
  title?: string;
  verdict?: string;
  /** `kind: 'prompt'` — journaled by `AgentTurnPlane.start` (the turn's
   *  flattened request text); older archives without one may carry an
   *  injected sibling `.prompt.md` row instead — same shape, `text`. */
  text?: string;
}
