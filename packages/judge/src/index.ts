/**
 * @broject/judge — the judge capability's connectors, chain, and shadow
 * plane (spec: specs/sessions/bro-f4ot.2-judge.md): the `jev` connector
 * (native /v1/systemone client), the `llm-judge` fallback (OpenAI-compat
 * chat → typed answers), `judgeFacade()` — the primary→fallback
 * composition consumers call — and shadow mode: the verdict journal
 * (`<git-common>/bro/judge/verdicts.jsonl`) plus act/drive annotation.
 * Stats and dogfood replay land in their own milestones.
 */
export { judgeSection, DEFAULT_JUDGE_CONFIG } from './config.ts'
export type { JudgeConfig, JudgeLlmConfig } from './config.ts'
export { jevConnector, jevJudge } from './jev.ts'
export type { JevJudgeOpts } from './jev.ts'
export { llmJudge, llmJudgeConnector } from './llm-judge.ts'
export type { LlmJudgeOpts } from './llm-judge.ts'
export { chainedJudge, judgeConfig, judgeFacade } from './chain.ts'
export type { JudgeFacadeOpts } from './chain.ts'
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
