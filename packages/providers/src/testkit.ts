/** Test seam — a scripted FetchFn for the wire clients, shared by the
 *  providers and judge suites. Each queued `{status, body}` is served
 *  in order (the last repeats); `calls` records url + init so tests
 *  assert on the request that went out. */
import { agent, RequestError } from '@agentclientprotocol/sdk'
import type {
  AgentApp,
  AuthMethod,
  ContentBlock,
  PermissionOption,
  SessionConfigOption,
  SessionUpdate,
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
  /** Raw content blocks per prompt — image-passthrough assertions
   *  (bro-7izjx). */
  blocks: ContentBlock[][]
  /** session/set_config_option calls the client made. */
  configSets: Array<{ configId: string; value: unknown }>
  /** session/new requests (cwd recorded). */
  sessions: Array<{ cwd: string }>
  /** The client's answer to a scripted session/request_permission. */
  permissionOutcome?: unknown
  /** What the agent got back from a scripted terminal/* round-trip. */
  terminalResult?: { output: string; exitCode: number | null | undefined }
  /** The client's advertised capabilities from initialize. */
  clientCapabilities?: unknown
}

/** A scripted in-process ACP agent — the real protocol round-trip
 *  (initialize → session/new → set_config_option → prompt →
 *  session/update chunks) without spawning a process. Wire it through
 *  the `acp.peer` seam on ProviderWireOpts. */
export function fakeAcpAgent(
  opts: {
    replyText?: string
    /** Full update sequence to emit before the stop — supersedes the
     *  single replyText chunk (streaming-surface tests, spec bro-d6mcd). */
    updates?: SessionUpdate[]
    stopReason?: StopReason
    authMethods?: AuthMethod[]
    protocolVersion?: number
    configOptions?: SessionConfigOption[]
    /** set_config_option reports this value instead of the pin — an
     *  agent that "applied" the request but kept running another model. */
    reportedModel?: string
    /** set_config_option fails: 'refuse' answers a peer error,
     *  'cancel' answers -32800 like an aborted request. */
    failConfig?: 'refuse' | 'cancel'
    /** Ask session/request_permission mid-prompt with these options —
     *  the outcome lands in `permissionOutcome`. */
    askPermission?: PermissionOption[]
    /** session/prompt fails: 'auth' answers the wire's auth_required
     *  error (code −32000), 'generic' a plain handler error that
     *  arrives as "Internal error" like any backend flake would,
     *  'auth-gateway-504' an auth-worded outage message that must
     *  classify as availability, never config. */
    failPrompt?: 'auth' | 'generic' | 'auth-gateway-504'
    /** session/new fails: 'auth' refuses with auth_required — the
     *  real gate for an agent whose advertised authMethods are not
     *  covered by stored credentials. */
    failNew?: 'auth'
    /** advertise promptCapabilities.image — the conductor only sends
     *  image blocks when the agent says it can consume them (bro-7izjx). */
    imageCapable?: boolean
    /** Exercise the client's terminal plane mid-prompt: create →
     *  wait_for_exit → output → release on `sh -c <value>`. */
    askTerminal?: string
  } = {}
): FakeAcpAgent {
  const seen: FakeAcpAgent = {
    app: undefined as never,
    prompts: [],
    blocks: [],
    configSets: [],
    sessions: [],
  }
  const app = agent({ name: 'fake-acp' })
    .onRequest('initialize', (ctx) => {
      seen.clientCapabilities = ctx.params.clientCapabilities
      return {
        protocolVersion: opts.protocolVersion ?? ctx.params.protocolVersion,
        authMethods: opts.authMethods ?? [],
        agentInfo: { name: 'fake-acp', version: '0' },
        agentCapabilities: {
          promptCapabilities: { image: opts.imageCapable === true },
        },
      }
    })
    .onRequest('session/new', (ctx) => {
      if (opts.failNew === 'auth') {
        throw RequestError.authRequired()
      }
      seen.sessions.push({ cwd: ctx.params.cwd })
      return { sessionId: 'sess-1', configOptions: opts.configOptions ?? [] }
    })
    .onRequest('session/set_config_option', (ctx) => {
      seen.configSets.push({ configId: ctx.params.configId, value: ctx.params.value })
      if (opts.failConfig === 'cancel') {
        throw RequestError.requestCancelled({ configId: ctx.params.configId })
      }
      if (opts.failConfig === 'refuse') {
        throw new Error('model not supported')
      }
      const currentValue = opts.reportedModel ?? String(ctx.params.value)
      return {
        configOptions: (opts.configOptions ?? []).map((o) =>
          o.id === ctx.params.configId && o.type === 'select'
            ? { ...o, currentValue }
            : o
        ),
      }
    })
    .onRequest('session/prompt', async (ctx) => {
      seen.blocks.push(ctx.params.prompt)
      seen.prompts.push(
        ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
      )
      if (opts.failPrompt === 'auth') {
        throw RequestError.authRequired()
      }
      if (opts.failPrompt === 'generic') {
        throw new Error('upstream connection reset')
      }
      if (opts.failPrompt === 'auth-gateway-504') {
        throw new RequestError(-32603, 'auth gateway returned HTTP 504')
      }
      if (opts.askPermission !== undefined) {
        const res = await ctx.client.request('session/request_permission', {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'tc-1', title: 'run tests' },
          options: opts.askPermission,
        })
        seen.permissionOutcome = res.outcome
      }
      if (opts.askTerminal !== undefined) {
        const created = await ctx.client.request('terminal/create', {
          sessionId: ctx.params.sessionId,
          command: 'sh',
          args: ['-c', opts.askTerminal],
        })
        const status = await ctx.client.request('terminal/wait_for_exit', {
          sessionId: ctx.params.sessionId,
          terminalId: created.terminalId,
        })
        const out = await ctx.client.request('terminal/output', {
          sessionId: ctx.params.sessionId,
          terminalId: created.terminalId,
        })
        await ctx.client.request('terminal/release', {
          sessionId: ctx.params.sessionId,
          terminalId: created.terminalId,
        })
        seen.terminalResult = { output: out.output, exitCode: status.exitCode }
      }
      const updates: SessionUpdate[] = opts.updates ?? [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: opts.replyText ?? '{}' },
        },
      ]
      for (const update of updates) {
        await ctx.client.notify('session/update', {
          sessionId: ctx.params.sessionId,
          update,
        })
      }
      return { stopReason: opts.stopReason ?? 'end_turn' }
    })
  seen.app = app
  return seen
}
