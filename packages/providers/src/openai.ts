/**
 * The `openai-compat` provider binding — any OpenAI-compatible chat
 * endpoint (POST {baseUrl}/chat/completions) as a raw prose call
 * (spec: specs/bro-ribc.1.md). The wire answer is free text; turning
 * it into typed judgments is the consumer's prompt-and-parse problem
 * (the judge's prose adapter lives in @broject/judge) — this binding
 * owns protocol knowledge only: endpoint, auth env, model, retry
 * contract.
 */
import { isEnvName, JudgeUnavailable } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import {
  mapUsage,
  objOr,
  postJson,
  stripTrailingSlashes,
  type HttpResult,
} from './http.ts'
import type { ProviderChat, ProviderChatResult } from './registry.ts'
import type { ProviderWireOpts } from './systemone.ts'

type OpenAiCompatEntry = Extract<ProviderEntry, { type: 'openai-compat' }>

/** Auth headers from the configured env var — a non-NAME apiKeyEnv is
 *  a config bug (throws, never echoed); a missing var is fail-open,
 *  and its message names the config FIELD, never the value — an
 *  all-caps pasted key passes isEnvName and would echo the secret
 *  verbatim. */
function authHeaders(entry: OpenAiCompatEntry, keyField: string): Record<string, string> {
  if (entry.apiKeyEnv === undefined) {
    return {}
  }
  if (!isEnvName(entry.apiKeyEnv)) {
    throw new Error(`${keyField} is not a valid environment variable name`)
  }
  const key = process.env[entry.apiKeyEnv]
  if (key === undefined || key === '') {
    throw new JudgeUnavailable(`the env var named by ${keyField} is not set — export it for the provider`)
  }
  return { authorization: `Bearer ${key}` }
}

/** chat-completions error contract → throw. 400/404 are caller bugs;
 *  everything else (incl. 401/403 — an unprovisioned endpoint is
 *  "unavailable", not a gate input) is JudgeUnavailable. */
function throwForStatus(res: HttpResult): never {
  const err = objOr(res.body).error
  const errObj = objOr(err)
  const msg =
    typeof errObj.message === 'string' ? errObj.message : `HTTP ${res.status}`
  if (res.status === 400 || res.status === 404) {
    throw new Error(`openai-compat provider rejected the request — ${msg}`)
  }
  throw new JudgeUnavailable(`openai-compat provider unavailable — ${msg}`)
}

/** choices[0].message.content — a missing/typed-wrong reply is "no
 *  verdict", not a gate input. */
function replyContent(body: unknown): string {
  const choices = objOr(body).choices
  const content =
    Array.isArray(choices) && choices.length > 0
      ? (choices[0] as { message?: { content?: unknown } }).message?.content
      : undefined
  if (typeof content !== 'string') {
    throw new JudgeUnavailable('openai-compat provider returned no message content')
  }
  return content
}

/** The raw prose call surface for an `openai-compat` entry — prompt
 *  in, content+model+usage out, over the shared deadline. */
export function openaiCompatChat(
  entry: OpenAiCompatEntry,
  opts: ProviderWireOpts = {}
): ProviderChat {
  const keyField = opts.keyField ?? 'apiKeyEnv'
  const model = opts.model ?? entry.model
  const endpoint = `${stripTrailingSlashes(entry.baseUrl)}/chat/completions`
  return async (prompt, deadline): Promise<ProviderChatResult> => {
    const res = await postJson(
      endpoint,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
      },
      authHeaders(entry, keyField),
      deadline,
      (s) => s === 429 || s >= 500,
      opts.fetch
    )
    if (res.status !== 200) {
      throwForStatus(res)
    }
    const body = objOr(res.body)
    return {
      content: replyContent(body),
      model: typeof body.model === 'string' ? body.model : model,
      usage: mapUsage(body, 'prompt_tokens'),
    }
  }
}
