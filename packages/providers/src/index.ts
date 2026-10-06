/**
 * @broject/providers — the typed provider registry's bindings (spec:
 * specs/bro-ribc.1.md). Core holds the `providers` section and the
 * ProviderEntry union; this package holds the per-kind wire clients —
 * systemone typed calls, openai-compat chat — so a repo without
 * providers configured never pays for them. Consumers pick an entry
 * by name and ask for a surface (`call`, `chat`, `spawn`); they never
 * name a vendor.
 */
export { acpCall, acpChat, acpClient, acpWorkerArgv, isSystemoneFamily } from './acp.ts'
export { AcpWorkerError, renderAcpUpdate, runAcpWorker } from './acp-worker.ts'
export type { AcpWorkerSpec } from './acp-worker.ts'
export { cliChat, expandPromptFile } from './cli.ts'
export { openaiCompatChat } from './openai.ts'
export { providerClient } from './registry.ts'
export type {
  AcpSeam,
  ProviderCall,
  ProviderChat,
  ProviderChatResult,
  ProviderClient,
} from './registry.ts'
export { systemoneCall } from './systemone.ts'
export type { ApiTarget, ProviderWireOpts } from './systemone.ts'
// typed-contract keyspace guards — the prose path validates its
// probabilities map against the asked criteria with the same rule
export { isLevelKey, isProbsOn } from './typed.ts'
// the shared transport — the judge package's http helpers moved here
// with the bindings that use them; consumers re-export, not reimplement
export {
  clamp01,
  isNum,
  isProbs,
  mapUsage,
  objOr,
  postJson,
  remaining,
  stripTrailingSlashes,
} from './http.ts'
export type { FetchFn, HttpResult, RetryWhen } from './http.ts'
// test seam — one scripted transport shared by the providers and
// judge suites (was four identical copies; sonar flagged the blocks)
export { fakeAcpAgent, fakeFetch } from './testkit.ts'
export type { Call, FakeAcpAgent } from './testkit.ts'
