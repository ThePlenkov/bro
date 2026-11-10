/**
 * The router's health read-model — one verdict per served model: can it
 * serve right now, and if not, why and until when.
 *
 * The model is the shared contract between the router's store (which
 * RECORDS the facts: the wall it saw, the sessions it holds) and the
 * route table (which CONSUMES the verdicts: a walled model is skipped,
 * with the reason attached).
 *
 * The key is the honest id — `<provider>/<model>` — the same spelling the
 * catalog speaks. A lane without a model keys as the bare provider.
 */
export type HealthReason = 'rate-limited' | 'quota' | 'session-cap' | 'lane-busy';

/** One model's verdict. `available` is the answer; the rest explains it. */
export interface HealthVerdict {
  /** can this (provider, model) serve right now */
  available: boolean;
  /** why not — absent when it can */
  reason?: HealthReason;
  /** when the wall lifts (epoch ms) */
  until?: number;
  /** the situation in words — the CLI prints this, the model never reads it */
  detail?: string;
  /** the sessions the router holds open — a fact the caller weighs
   *  against its OWN cap; the ledger does not know the cap */
  openSessions?: number;
}

/** provider/model → verdict. The snapshot is a point-in-time read. */
export type HealthSnapshot = Record<string, HealthVerdict>;

/** The honest id the snapshot is keyed by — `<provider>/<model>`, or the
 *  bare provider for a lane that serves no model of its own. */
export function healthKey(provider: string, model?: string): string {
  return model === undefined || model === '' ? provider : `${provider}/${model}`;
}
