/** Test seam — a scripted FetchFn for the wire clients, shared by the
 *  providers and judge suites. Each queued `{status, body}` is served
 *  in order (the last repeats); `calls` records url + init so tests
 *  assert on the request that went out. */
import { agent, RequestError } from '@agentclientprotocol/sdk';
import type {
  AgentApp,
  AgentCapabilities,
  AgentContext,
  AuthMethod,
  ContentBlock,
  NewSessionRequest,
  PermissionOption,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { FetchFn } from './http.ts';

export interface Call {
  url: string;
  init: { headers?: Record<string, string>; body?: string };
}

export function fakeFetch(...queue: Array<{ status: number; body: unknown }>): {
  fetch: FetchFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Call['init'] });
    const next = queue[Math.min(calls.length - 1, queue.length - 1)]!;
    return {
      status: next.status,
      text: async () => JSON.stringify(next.body),
    } as Response;
  }) as FetchFn;
  return { fetch, calls };
}

export interface FakeAcpAgent {
  app: AgentApp;
  /** Prompt texts the agent received. */
  prompts: string[];
  /** Raw content blocks per prompt — image-passthrough assertions
   *  (bro-7izjx). */
  blocks: ContentBlock[][];
  /** session/set_config_option calls the client made. */
  configSets: Array<{ configId: string; value: unknown }>;
  /** session/new requests (cwd recorded). */
  sessions: Array<{ cwd: string }>;
  /** The raw session/new params — brokered-transport passthrough
   *  assertions (bro-ymbq1). */
  sessionRequests: NewSessionRequest[];
  /** session/cancel notifications the agent received (session ids). */
  cancels: string[];
  /** session/close requests the agent received (session ids). */
  closes: string[];
  /** session/fork requests the agent received (source session ids). */
  forks: string[];
  /** session/load requests the agent received (session ids). */
  loads: string[];
  /** session/resume requests the agent received (session ids). */
  resumes: string[];
  /** What the client advertised at initialize — the brokered link's
   *  capability union shows up here (bro-ymbq1). */
  clientCapabilities?: unknown;
  /** The client's answer to a scripted session/request_permission. */
  permissionOutcome?: unknown;
  /** What the agent got back from a scripted terminal/* round-trip. */
  terminalResult?: { output: string; exitCode: number | null | undefined };
  /** The client's answer to a scripted probeClient call (bro-ymbq1). */
  probeResult?: unknown;
}

/** The mid-prompt client-bound scripts a test can arm — a scripted
 *  permission ask, a terminal/* round-trip, a free-form probe. Each
 *  result lands on `seen` for the test to assert against. */
async function runClientProbes(
  client: AgentContext,
  sessionId: string,
  opts: {
    askPermission?: PermissionOption[];
    askTerminal?: string;
    probeClient?: (client: AgentContext, sessionId: string) => Promise<unknown>;
  },
  seen: FakeAcpAgent
): Promise<void> {
  if (opts.askPermission !== undefined) {
    const res = await client.request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'tc-1', title: 'run tests' },
      options: opts.askPermission,
    });
    seen.permissionOutcome = res.outcome;
  }
  if (opts.askTerminal !== undefined) {
    const created = await client.request('terminal/create', {
      sessionId,
      command: 'sh',
      args: ['-c', opts.askTerminal],
    });
    const status = await client.request('terminal/wait_for_exit', {
      sessionId,
      terminalId: created.terminalId,
    });
    const out = await client.request('terminal/output', {
      sessionId,
      terminalId: created.terminalId,
    });
    await client.request('terminal/release', { sessionId, terminalId: created.terminalId });
    seen.terminalResult = { output: out.output, exitCode: status.exitCode };
  }
  if (opts.probeClient !== undefined) {
    seen.probeResult = await opts.probeClient(client, sessionId);
  }
}

/** A scripted in-process ACP agent — the real protocol round-trip
 *  (initialize → session/new → set_config_option → prompt →
 *  session/update chunks) without spawning a process. Wire it through
 *  the `acp.peer` seam on ProviderWireOpts. */
export function fakeAcpAgent(
  opts: {
    replyText?: string;
    /** Full update sequence to emit before the stop — supersedes the
     *  single replyText chunk (streaming-surface tests, spec bro-d6mcd). */
    updates?: SessionUpdate[];
    stopReason?: StopReason;
    authMethods?: AuthMethod[];
    protocolVersion?: number;
    configOptions?: SessionConfigOption[];
    /** set_config_option reports this value instead of the pin — an
     *  agent that "applied" the request but kept running another model. */
    reportedModel?: string;
    /** set_config_option fails: 'refuse' answers a peer error,
     *  'cancel' answers -32800 like an aborted request. */
    failConfig?: 'refuse' | 'cancel';
    /** Ask session/request_permission mid-prompt with these options —
     *  the outcome lands in `permissionOutcome`. */
    askPermission?: PermissionOption[];
    /** A client-bound call made mid-prompt — e.g.
     *  `(client, sid) => client.request('fs/read_text_file',
     *  {sessionId: sid, path: '/x'})`; its result lands in
     *  `probeResult` (bro-ymbq1's brokered bridge). */
    probeClient?: (client: AgentContext, sessionId: string) => Promise<unknown>;
    /** The prompt turn holds until this resolves — lets a test observe
     *  live mid-turn traffic (session/update fan-out, cancel) before
     *  the stop flows (bro-ymbq1). */
    holdPromptUntil?: Promise<void>;
    /** Extra agentCapabilities merged over the default — e.g.
     *  loadSession:true to watch the broker strip it (bro-ymbq1). */
    agentCapabilities?: AgentCapabilities;
    /** session/prompt fails: 'auth' answers the wire's auth_required
     *  error (code −32000), 'generic' a plain handler error that
     *  arrives as "Internal error" like any backend flake would,
     *  'auth-gateway-504' an auth-worded outage message that must
     *  classify as availability, never config. */
    failPrompt?: 'auth' | 'generic' | 'auth-gateway-504' | 'rate-limit';
    /** Awaited after every update is notified, before session/prompt
     *  returns — a test gate holding the turn open so a consumer must
     *  prove it saw deltas before end_turn. */
    holdEnd?: () => Promise<void>;
    /** session/new fails: 'auth' refuses with auth_required — the
     *  real gate for an agent whose advertised authMethods are not
     *  covered by stored credentials. */
    failNew?: 'auth';
    /** Mint a distinct `sess-N` per session/new instead of always
     *  'sess-1' — multi-session tests need real distinct ids. */
    uniqueSessions?: boolean;
    /** advertise promptCapabilities.image — the conductor only sends
     *  image blocks when the agent says it can consume them (bro-7izjx). */
    imageCapable?: boolean;
    /** Exercise the client's terminal plane mid-prompt: create →
     *  wait_for_exit → output → release on `sh -c <value>`. */
    askTerminal?: string;
    /** Advertise `loadSession` and serve session/load — the resume
     *  ladder's top rung (spec bro-5qsnr). */
    loadCapable?: boolean;
    /** Advertise `sessionCapabilities.resume` and serve session/resume —
     *  the ladder's second rung. */
    resumeCapable?: boolean;
    /** session/load|resume throws (the session is gone — old PR, dead
     *  store); the worker must fall back to session/new. */
    failLoad?: boolean;
  } = {}
): FakeAcpAgent {
  const seen: FakeAcpAgent = {
    app: undefined as never,
    prompts: [],
    blocks: [],
    configSets: [],
    sessions: [],
    sessionRequests: [],
    cancels: [],
    closes: [],
    forks: [],
    loads: [],
    resumes: [],
  };
  const app = agent({ name: 'fake-acp' })
    .onRequest('initialize', ctx => {
      seen.clientCapabilities = ctx.params.clientCapabilities;
      return {
        protocolVersion: opts.protocolVersion ?? ctx.params.protocolVersion,
        authMethods: opts.authMethods ?? [],
        agentInfo: { name: 'fake-acp', version: '0' },
        agentCapabilities: {
          promptCapabilities: { image: opts.imageCapable === true },
          ...(opts.loadCapable === true ? { loadSession: true } : {}),
          ...(opts.resumeCapable === true ? { sessionCapabilities: { resume: {} } } : {}),
          ...opts.agentCapabilities,
        },
      };
    })
    .onRequest('session/new', ctx => {
      if (opts.failNew === 'auth') {
        throw RequestError.authRequired();
      }
      seen.sessions.push({ cwd: ctx.params.cwd });
      seen.sessionRequests.push(ctx.params);
      return {
        sessionId: `sess-${opts.uniqueSessions === true ? seen.sessions.length : 1}`,
        configOptions: opts.configOptions ?? [],
      };
    })
    .onRequest('session/fork', ctx => {
      seen.forks.push(ctx.params.sessionId);
      return { sessionId: `sess-fork-${seen.forks.length}` };
    })
    .onRequest('session/load', ctx => {
      seen.loads.push(ctx.params.sessionId);
      if (opts.failLoad === true) {
        throw new Error(`session ${ctx.params.sessionId} not found`);
      }
      return { configOptions: opts.configOptions ?? [] };
    })
    .onRequest('session/resume', ctx => {
      seen.resumes.push(ctx.params.sessionId);
      if (opts.failLoad === true) {
        throw new Error(`session ${ctx.params.sessionId} not found`);
      }
      return { configOptions: opts.configOptions ?? [] };
    })
    .onNotification('session/cancel', ctx => {
      seen.cancels.push(ctx.params.sessionId);
    })
    .onRequest('session/close', ctx => {
      seen.closes.push(ctx.params.sessionId);
      return {};
    })
    .onRequest('session/set_config_option', ctx => {
      seen.configSets.push({ configId: ctx.params.configId, value: ctx.params.value });
      if (opts.failConfig === 'cancel') {
        throw RequestError.requestCancelled({ configId: ctx.params.configId });
      }
      if (opts.failConfig === 'refuse') {
        throw new Error('model not supported');
      }
      const currentValue = opts.reportedModel ?? String(ctx.params.value);
      return {
        configOptions: (opts.configOptions ?? []).map(o =>
          o.id === ctx.params.configId && o.type === 'select' ? { ...o, currentValue } : o
        ),
      };
    })
    .onNotification('session/cancel', ctx => {
      seen.cancels.push(ctx.params.sessionId);
    })
    .onRequest('session/prompt', async ctx => {
      seen.blocks.push(ctx.params.prompt);
      seen.prompts.push(ctx.params.prompt.map(b => (b.type === 'text' ? b.text : '')).join(''));
      if (opts.failPrompt === 'auth') {
        throw RequestError.authRequired();
      }
      if (opts.failPrompt === 'generic') {
        throw new Error('upstream connection reset');
      }
      if (opts.failPrompt === 'auth-gateway-504') {
        throw new RequestError(-32603, 'auth gateway returned HTTP 504');
      }
      if (opts.failPrompt === 'rate-limit') {
        throw new RequestError(-32603, 'rate limit exceeded — retry later');
      }
      await runClientProbes(ctx.client, ctx.params.sessionId, opts, seen);
      const updates: SessionUpdate[] = opts.updates ?? [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: opts.replyText ?? '{}' },
        },
      ];
      for (const update of updates) {
        await ctx.client.notify('session/update', {
          sessionId: ctx.params.sessionId,
          update,
        });
      }
      await opts.holdEnd?.();
      await opts.holdPromptUntil;
      return { stopReason: opts.stopReason ?? 'end_turn' };
    });
  seen.app = app;
  return seen;
}
