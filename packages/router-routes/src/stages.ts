/**
 * The classification cascade's stage trace (spec bro-0ykhg.2) — the
 * record every stage leaves: what it saw, what it kept, what it cost.
 *
 * The trace is data, not behavior: the brouter decision path writes it,
 * the journal stores it, `--explain=route` reads it. Pure types live
 * here so the decision contract can carry them without importing the
 * brouter package.
 */

/** The cascade's four rungs, cheapest first. */
export type CascadeStageName = 'T0' | 'T1' | 'T2' | 'T3';

/** Who settled the route — the explanation's `decided by:` line. */
export type CascadeDecider = 'rules' | 'recall' | 'judge' | 'escalate';

/** One stage's record — the contenders it saw, the contenders it left,
 *  and what it decided (a route name, when it did). */
export interface CascadeStage {
  stage: CascadeStageName;
  /** contender route names entering the stage, in order */
  before: string[];
  /** contender route names leaving the stage, in order */
  after: string[];
  /** wall-clock the stage cost, milliseconds */
  latencyMs: number;
  /** the route the stage decided, when it decided one */
  decided?: string;
  /** why the stage passed, or what it removed — operator-facing */
  note?: string;
}

/** The whole cascade's record — stages in order, and who decided. */
export interface CascadeTrace {
  stages: CascadeStage[];
  decidedBy?: CascadeDecider;
}
