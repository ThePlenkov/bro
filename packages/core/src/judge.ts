/**
 * JudgeFacade — calibrated decisions for agent loops (spec:
 * specs/sessions/bro-f4ot.2-judge.md). A connector's optional `judge`
 * member answers typed questions over a caller-supplied state:
 * choice/score/noul in, typed answers + confidence out. Named by domain
 * semantics — decide, choice, score, noul — never vendor API names.
 *
 * v1 is shadow-only: verdicts annotate and journal, they never act. The
 * exit gate stays deterministic by design.
 */

/** Instructions and criteria values — the wire shape accepts a plain
 *  string or structured JSON (object/array) on both; the model reads
 *  the structure (e.g. named data fields referenced from `question`). */
export type JudgeText = string | Record<string, unknown> | unknown[]

/** One typed question — the three kinds the contract speaks.
 *  `choice` picks among labelled options; `score` rates on an ordered
 *  2–10 level scale; `noul` is a calibrated yes/no probability. */
export type JudgeQuestion =
  | {
      type: 'choice'
      instructions: JudgeText
      /** Option label → rubric description; null = needs no detail. */
      criteria: Record<string, JudgeText | null>
    }
  | {
      type: 'score'
      instructions: JudgeText
      /** Ordered level descriptions, low to high — 2–10 entries. */
      criteria: JudgeText[]
    }
  | {
      type: 'noul'
      instructions: JudgeText
      /** Optional: what a yes/no each means. */
      criteria?: { true?: JudgeText; false?: JudgeText }
    }

/** The answer's shape is fixed by its question's type — callers branch
 *  on `type` in plain code, no parsing. `decidedBy` names the connector
 *  that produced this answer (an escalated answer says 'llm-judge'). */
export type JudgeAnswer =
  | {
      type: 'choice'
      choice: string
      probabilities: Record<string, number>
      confidence: number
      decidedBy: string
    }
  | {
      type: 'score'
      score: number
      probabilities: Record<string, number>
      confidence: number
      decidedBy: string
    }
  | { type: 'noul'; noul: number; confidence: number; decidedBy: string }

export interface DecideResult {
  /** Keyed to the questions asked. */
  answers: Record<string, JudgeAnswer>
  /** Resolved model version. */
  model: string
  latencyMs: number
  usage?: { inputTokens?: number; costUsd?: number }
  /** Answer keys below the configured confidence threshold AND not
   *  escalated to a confident answer (no fallback, or fallback also
   *  unsure) — advisory consumers render these dimmed; nobody
   *  auto-trusts them. */
  lowConfidence: string[]
}

export interface JudgeFacade {
  /** One call, many questions — consumers batch a subject's questions
   *  into one decide(); backends evaluate them in parallel. */
  decide(
    state: unknown,
    questions: Record<string, JudgeQuestion>
  ): Promise<DecideResult>
}

/** Thrown by every judge backend on unreachability — network, auth,
 *  credits, 5xx-after-retries, timeout. Consumers treat "no verdict" as
 *  "no annotation", never as a gate input: a judge that can stall the
 *  act loop is a judge that gets turned off. Validation failures (the
 *  caller's bug) throw ordinary errors instead. */
export class JudgeUnavailable extends Error {
  override name = 'JudgeUnavailable'
}

/** One recorded decide() — the shadow-mode journal row. Written by the
 *  journal plane (`<git-common-dir>/bro/judge/verdicts.jsonl`); the type
 *  lives with the contract so producers and stats share it. */
export interface Verdict {
  /** ISO timestamp. */
  ts: string
  /** Consumer surface — 'act-thread' v1; 'act-disposition' records the
   *  observed outcome where it happens. */
  kind: string
  /** Subject identity — the call-site dedup key. */
  subject: { pr?: number; threadId?: string; headSha?: string; commentSha?: string }
  questions: Record<string, JudgeQuestion>
  answers: Record<string, JudgeAnswer>
  model: string
  latencyMs: number
  costUsd?: number
  /** Filled once observed: 'fixed' | 'replied' | 'deferred' | 'rejected'. */
  outcome?: string
  /** Dogfood verdicts — kept out of live stats. */
  replay?: boolean
}
