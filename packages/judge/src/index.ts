/**
 * @broject/judge — the judge capability's connectors, chain, and shadow
 * plane (spec: specs/sessions/bro-f4ot.2-judge.md): the `systemone` connector
 * (native /v1/systemone client), the `llm-judge` fallback (OpenAI-compat
 * chat → typed answers), `judgeFacade()` — the primary→fallback
 * composition consumers call — and shadow mode: the verdict journal
 * (`<git-common>/bro/judge/verdicts.jsonl`) plus act/drive annotation.
 * `computeStats`/`formatStats` back `bro judge stats`;
 * `replayMergedThreads` backs `bro judge replay` — the dogfood pass
 * over archived threads.
 */
export { judgeSection, DEFAULT_JUDGE_CONFIG } from './config.ts'
export type { JudgeConfig, JudgeLlmConfig } from './config.ts'
export { systemoneConnector, systemoneJudge } from './systemone.ts'
export type { SystemoneJudgeOpts } from './systemone.ts'
export { llmJudge, llmJudgeConnector } from './llm-judge.ts'
export type { LlmJudgeOpts } from './llm-judge.ts'
export { chainedJudge, judgeConfig, judgeFacade } from './chain.ts'
export type { JudgeFacadeOpts } from './chain.ts'
export type { DeadlineJudge } from './deadline.ts'
export {
  providerJudge,
  providerJudgeAuth,
  proseDecide,
  synthesizedProviders,
} from './provider-judge.ts'
export type { ProviderJudgeOpts } from './provider-judge.ts'
export {
  appendRow,
  commentKey,
  findVerdict,
  journalPath,
  readJournal,
  recordDisposition,
  threadSubject,
} from './journal.ts'
export {
  ACT_THREAD_QUESTIONS,
  annotateThreads,
  formatAnnotation,
  threadState,
} from './shadow.ts'
export type { AnnotateOpts, AnnotateResult } from './shadow.ts'
export { computeStats, formatStats } from './stats.ts'
export type { JudgeStats, StatsOpts } from './stats.ts'
export { inferOutcome, replayMergedThreads } from './replay.ts'
export type { InferenceCtx, ReplayOpts, ReplayResult } from './replay.ts'
