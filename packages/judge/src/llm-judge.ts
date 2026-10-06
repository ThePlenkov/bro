/**
 * The `llm-judge` connector — a compatibility alias for the
 * `openai-compat` provider kind (spec: specs/bro-ribc.1.md).
 * `connectors.judge: 'llm-judge'` resolves to the anonymous entry
 * `judge.llm` synthesizes; `decidedBy` stays 'llm-judge' so stats keep
 * scoring prompt-and-parsed answers on their own record. The chat
 * binding lives in @broject/providers; the prompt-and-parse machinery
 * moved to provider-judge.ts — llm-judge is what an openai-compat
 * provider IS when a judge consumes it.
 */
import { JudgeUnavailable } from '@broject/core'
import type { Connector } from '@broject/core'
import { openaiCompatChat } from '@broject/providers'
import { isEnvName, type JudgeConfig } from './config.ts'
import { deadlineJudge, judgeConfig, type DeadlineJudge } from './chain.ts'
import type { FetchFn } from './http.ts'
import { proseDecide } from './provider-judge.ts'

const LLM_NAME = 'llm-judge'

export interface LlmJudgeOpts {
  fetch?: FetchFn
}

function unconfigured(): never {
  throw new JudgeUnavailable(
    'judge.llm is not configured — set judge.llm { baseUrl, model, apiKeyEnv? } in bro.config.json'
  )
}

export function llmJudge(cfg: JudgeConfig, opts: LlmJudgeOpts = {}): DeadlineJudge {
  const llm = cfg.llm
  const chat =
    llm === undefined
      ? undefined
      : openaiCompatChat(
          {
            baseUrl: llm.baseUrl,
            apiKeyEnv: llm.apiKeyEnv,
            model: llm.model,
          },
          { fetch: opts.fetch, keyField: 'judge.llm.apiKeyEnv' }
        )
  // async — the unconfigured path must REJECT, not throw synchronously
  // out of decide() (a sync throw escapes assert-style callers)
  return deadlineJudge(cfg.timeoutMs, async (state, questions, deadline) => {
    if (chat === undefined) {
      unconfigured()
    }
    return proseDecide(LLM_NAME, chat, state, questions, deadline)
  })
}

export const llmJudgeConnector: Connector = {
  name: LLM_NAME,
  auth(ctx) {
    const { judge } = judgeConfig(ctx.dir)
    if (judge.llm === undefined) {
      return 'judge.llm is not configured — set judge.llm { baseUrl, model } in bro.config.json'
    }
    const { apiKeyEnv } = judge.llm
    if (apiKeyEnv !== undefined && !isEnvName(apiKeyEnv)) {
      // a pasted key value must never echo back in an auth message
      return 'judge.llm.apiKeyEnv is not a valid environment variable name'
    }
    return apiKeyEnv !== undefined && !process.env[apiKeyEnv]
      ? 'the env var named by judge.llm.apiKeyEnv is not set — export it for llm-judge'
      : null
  },
  judge: (ctx) => llmJudge(judgeConfig(ctx.dir).judge),
}
