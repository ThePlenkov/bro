/**
 * The shared POST-JSON transport moved to @broject/providers with the
 * bindings that use it (spec: bro-ribc.1) — re-exported here so
 * in-package imports keep their `./http.ts` shape.
 */
export {
  clamp01,
  isNum,
  isProbs,
  mapUsage,
  objOr,
  postJson,
  remaining,
  stripTrailingSlashes,
} from '@broject/providers'
export type { FetchFn, HttpResult, RetryWhen } from '@broject/providers'
