/**
 * The `systemone` connector — a compatibility alias for the systemone
 * provider kind (spec: specs/bro-ribc.1.md). `connectors.judge:
 * 'systemone'` resolves to the anonymous entry that legacy
 * `judge.{baseUrl,model,apiKeyEnv}` synthesizes; `decidedBy` stays
 * 'systemone' so existing journals keep scoring the same backend.
 * The wire binding lives in @broject/providers.
 */
import type { Connector } from '@broject/core'
import { systemoneCall } from '@broject/providers'
import { isEnvName, type JudgeConfig } from './config.ts'
import { deadlineJudge, judgeConfig, type DeadlineJudge } from './chain.ts'
import type { FetchFn } from './http.ts'

const SYSTEMONE_NAME = 'systemone'

export interface SystemoneJudgeOpts {
  /** Test seam — injects a scripted transport. */
  fetch?: FetchFn
}

export function systemoneJudge(cfg: JudgeConfig, opts: SystemoneJudgeOpts = {}): DeadlineJudge {
  return deadlineJudge(
    cfg.timeoutMs,
    systemoneCall(
      SYSTEMONE_NAME,
      {
        baseUrl: cfg.baseUrl,
        apiKeyEnv: cfg.apiKeyEnv,
        model: cfg.model,
      },
      { fetch: opts.fetch, keyField: 'judge.apiKeyEnv' }
    )
  )
}

export const systemoneConnector: Connector = {
  name: SYSTEMONE_NAME,
  auth(ctx) {
    const { apiKeyEnv } = judgeConfig(ctx.dir).judge
    if (!isEnvName(apiKeyEnv)) {
      return 'judge.apiKeyEnv is not a valid environment variable name'
    }
    return process.env[apiKeyEnv]
      ? null
      : 'the env var named by judge.apiKeyEnv is not set — export a TypeSafe API key (https://docs.typesafe.ai)'
  },
  judge: (ctx) => systemoneJudge(judgeConfig(ctx.dir).judge),
}
