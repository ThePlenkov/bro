/**
 * The provider client dispatch (spec: specs/bro-ribc.1.md) — a named
 * `providers` entry resolves to the typed client its kind binds. A
 * consumer asks for the surface it needs (`call` for the judge,
 * `chat` for prose adapters, `spawn` for the fleet when it lands);
 * a kind without the requested surface simply leaves the member
 * absent, and an entry whose kind has no binding at all throws —
 * naming provider + kind, never silently falling through.
 */
import type {
  DecideResult,
  JudgeQuestion,
  ProviderEntry,
} from '@broject/core'
import { openaiCompatChat } from './openai.ts'
import { systemoneCall, type ProviderWireOpts } from './systemone.ts'

/** The typed call surface — one decide() over the caller's absolute
 *  deadline (epoch ms), DecideResult out. */
export type ProviderCall = (
  state: unknown,
  questions: Record<string, JudgeQuestion>,
  deadline: number
) => Promise<DecideResult>

/** One chat-completions round-trip: prompt in, content + resolved
 *  model + usage out. */
export interface ProviderChatResult {
  content: string
  /** The wire-reported model, or the one the request pinned. */
  model: string
  usage?: DecideResult['usage']
}

/** The raw prose surface — the consumer renders the prompt and parses
 *  the reply; the binding owns the wire only. */
export type ProviderChat = (
  prompt: string,
  deadline: number
) => Promise<ProviderChatResult>

/** What a bound entry can serve. Absent member = the kind doesn't
 *  have that surface here — check before use, don't assume. */
export interface ProviderClient {
  call?: ProviderCall
  chat?: ProviderChat
}

/** Load an entry → its typed client. `name` is the registry key —
 *  provenance stamps answers `provider:<name>` so stats score each
 *  service on its own record. Throws for a kind with no binding yet
 *  (acp lands with bro-ribc.9, cli with the fleet milestone) — a
 *  startup error naming provider + kind, not a runtime surprise. */
export function providerClient(
  name: string,
  entry: ProviderEntry,
  opts: ProviderWireOpts = {}
): ProviderClient {
  const keyField = opts.keyField ?? `providers.${name}.apiKeyEnv`
  switch (entry.type) {
    case 'systemone':
      return { call: systemoneCall(`provider:${name}`, entry, { ...opts, keyField }) }
    case 'openai-compat':
      return { chat: openaiCompatChat(entry, { ...opts, keyField }) }
    default:
      throw new Error(
        `providers.${name} (type '${entry.type}') has no client binding yet — ` +
          'the kind is registered but ships with a later milestone (spec bro-ribc.1)'
      )
  }
}
