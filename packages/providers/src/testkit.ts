/** Test seam — a scripted FetchFn for the wire clients, shared by the
 *  providers and judge suites. Each queued `{status, body}` is served
 *  in order (the last repeats); `calls` records url + init so tests
 *  assert on the request that went out. */
import { agent } from '@agentclientprotocol/sdk'
import type {
  AgentApp,
  AuthMethod,
  SessionConfigOption,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { FetchFn } from './http.ts'

export interface Call {
  url: string
  init: { headers?: Record<string, string>; body?: string }
}

export function fakeFetch(
  ...queue: Array<{ status: number; body: unknown }>
): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Call['init'] })
    const next = queue[Math.min(calls.length - 1, queue.length - 1)]!
    return {
      status: next.status,
      text: async () => JSON.stringify(next.body),
    } as Response
  }) as FetchFn
  return { fetch, calls }
}

export interface FakeAcpAgent {
  app: AgentApp
  /** Prompt texts the agent received. */
  prompts: string[]
  /** session/set_config_option calls the client made. */
  configSets: Array<{ configId: string; value: unknown }>
  /** session/new requests (cwd recorded). */
  sessions: Array<{ cwd: string }>
}

/** A scripted in-process ACP agent — the real protocol round-trip
 *  (initialize → session/new → set_config_option → prompt →
 *  session/update chunks) without spawning a process. Wire it through
 *  the `acp.peer` seam on ProviderWireOpts. */
export function fakeAcpAgent(
  opts: {
    replyText?: string
    stopReason?: StopReason
    authMethods?: AuthMethod[]
    protocolVersion?: number
    configOptions?: SessionConfigOption[]
  } = {}
): FakeAcpAgent {
  const seen: FakeAcpAgent = {
    app: undefined as never,
    prompts: [],
    configSets: [],
    sessions: [],
  }
  const app = agent({ name: 'fake-acp' })
    .onRequest('initialize', (ctx) => ({
      protocolVersion: opts.protocolVersion ?? ctx.params.protocolVersion,
      authMethods: opts.authMethods ?? [],
      agentInfo: { name: 'fake-acp', version: '0' },
    }))
    .onRequest('session/new', (ctx) => {
      seen.sessions.push({ cwd: ctx.params.cwd })
      return { sessionId: 'sess-1', configOptions: opts.configOptions ?? [] }
    })
    .onRequest('session/set_config_option', (ctx) => {
      seen.configSets.push({ configId: ctx.params.configId, value: ctx.params.value })
      return {
        configOptions: (opts.configOptions ?? []).map((o) =>
          o.id === ctx.params.configId && o.type === 'select'
            ? { ...o, currentValue: String(ctx.params.value) }
            : o
        ),
      }
    })
    .onRequest('session/prompt', async (ctx) => {
      seen.prompts.push(
        ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
      )
      await ctx.client.notify('session/update', {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: opts.replyText ?? '{}' },
        },
      })
      return { stopReason: opts.stopReason ?? 'end_turn' }
    })
  seen.app = app
  return seen
}
