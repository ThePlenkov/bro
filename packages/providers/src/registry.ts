/**
 * The provider client dispatch (spec: specs/bro-ribc.1.md) — a named
 * `providers` entry resolves to the typed client its kind binds. A
 * consumer asks for the surface it needs (`call` for the judge,
 * `chat` for prose adapters, `spawn` for the fleet when it lands);
 * a kind without the requested surface simply leaves the member
 * absent, and an entry whose kind has no binding at all throws —
 * naming provider + kind, never silently falling through.
 */
import { resolveApiModel } from '@broject/core'
import type {
  DecideResult,
  JudgeQuestion,
  ProviderEntry,
} from '@broject/core'
import { acpClient } from './acp.ts'
import { cliChat } from './cli.ts'
import { stripTrailingSlashes } from './http.ts'
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

/** The acp kind's session seam — `peer` replaces the spawned `command`
 *  with an in-process agent (the SDK's AgentApp; tests wire a scripted
 *  one), `cwd` is the session's working directory. */
export interface AcpSeam {
  peer?: import('@agentclientprotocol/sdk').AgentApp
  cwd?: string
}

/** Load an entry → its typed client. `name` is the registry key —
 *  provenance stamps answers `provider:<name>` so stats score each
 *  service on its own record. Throws for a kind with no binding yet
 *  (cli lands with the fleet milestone) — a startup error naming
 *  provider + kind, not a runtime surprise. */
export function providerClient(
  name: string,
  entry: ProviderEntry,
  opts: ProviderWireOpts = {}
): ProviderClient {
  const keyField = opts.keyField ?? `providers.${name}.apiKeyEnv`
  switch (entry.type) {
    case 'api': {
      // one host, per-model wire — resolve the served model first;
      // an undeclared id is a config error (the allowlist is the point)
      const { model, wire } = resolveApiModel(entry, opts.model)
      const target = { ...entry, model }
      return wire === 'systemone'
        ? { call: systemoneCall(`provider:${name}`, target, { ...opts, model, keyField }) }
        : {
            chat: openaiCompatChat(
              {
                ...target,
                // the api entry's baseUrl is the host root; the openai
                // wire mounts at /v1 (same convention systemone applies
                // to its own endpoint internally) — unless the author
                // already pointed baseUrl at the versioned path
                baseUrl: stripTrailingSlashes(entry.baseUrl).endsWith('/v1')
                  ? stripTrailingSlashes(entry.baseUrl)
                  : `${stripTrailingSlashes(entry.baseUrl)}/v1`,
              },
              { ...opts, model, keyField }
            ),
          }
    }
    case 'acp':
      // 'auto' grade — the binding picks call vs chat on the resolved
      // model (systemone-family → typed, else prose)
      return acpClient(`provider:${name}`, entry, { ...opts, keyField })
    case 'cli':
      return { chat: cliChat(`provider:${name}`, entry, opts) }
    default: {
      // entry is `never` here — the union is fully bound; a raw entry
      // reaching this branch bypassed validation, so read the kind
      // defensively for the message
      const bad = (entry as { type?: string }).type ?? 'unknown'
      throw new Error(
        `providers.${name} (type '${bad}') has no client binding — ` +
          'a registered kind with no binding is a registry defect (spec bro-ribc.1)'
      )
    }
  }
}
