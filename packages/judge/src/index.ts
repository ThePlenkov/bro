/**
 * @broject/judge — the judge capability's connectors and chain
 * (spec: specs/sessions/bro-f4ot.2-judge.md): the `jev` connector
 * (native /v1/decide client), the `llm-judge` fallback (OpenAI-compat
 * chat → typed answers), and `judgeFacade()` — the primary→fallback
 * composition consumers call. Shadow-mode consumers (journal, act
 * annotation, stats) land in their own milestones.
 */
export { judgeSection, DEFAULT_JUDGE_CONFIG } from './config.ts'
export type { JudgeConfig, JudgeLlmConfig } from './config.ts'
export { jevConnector, jevJudge } from './jev.ts'
export type { JevJudgeOpts } from './jev.ts'
export { llmJudge, llmJudgeConnector } from './llm-judge.ts'
export type { LlmJudgeOpts } from './llm-judge.ts'
export { chainedJudge, judgeConfig, judgeFacade } from './chain.ts'
export type { DeadlineJudge, JudgeFacadeOpts } from './chain.ts'
