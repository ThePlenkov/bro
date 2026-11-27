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
  /** `kind: 'permission'` — the ask's tool call id, so the answer can
   *  close the very record the ask opened. */
  toolCallId?: string;
  /** `kind: 'permission'` — the AGENT's own options for the ask. The
   *  headless driver records none (it answers without a human); an
   *  interactive client records them so a reader can see what was
   *  on the table. */
  options?: { optionId: string; name: string; kind: string }[];
  /** `kind: 'permission'` — the answer's optionId, the agent's own id. */
  optionId?: string;
  /** `kind: 'permission'` — the answer's option kind (allow_once,
   *  reject_once, …) — the label the card prints. */
  optionKind?: string;
  /** `kind: 'usage'` — provider-reported accounting attached to the
   *  per-agent event journal. Missing values mean the provider was silent,
   *  never an estimate. */
  provider?: string;
  model?: string;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  usage?: unknown;
}
