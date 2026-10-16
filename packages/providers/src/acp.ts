/**
 * The `acp` provider binding — an agent process speaking ACP v1 over
 * stdio (spec: specs/bro-ribc.1.md §acp, milestone 4 — call surface;
 * the spawn surface lands with bro-5hx1.1). `command` is a CLI serving
 * ACP (`kilo --acp`, `devin -p --acp`) — operator-authored config
 * tokenized to argv and exec'd without a shell; `profile` lands as a
 * separate `--profile <value>` arg.
 *
 * One minimal session per decide(): initialize → session/new →
 * optional session/set_config_option for the entry's model (looked up
 * by category: "model", never a hardcoded configId) → session/prompt.
 * The caller's deadline bounds the whole round-trip; an expired budget
 * fails open and the peer process dies with the call.
 *
 * The call grade is 'auto' (PROVIDER_REGISTRY): a systemone-family
 * model (`typesafe/jev-*` or a bare `jev-*` pin) answers with the
 * typed contract natively — the provider is pure transport and the
 * binding serves `call`. Any other model serves `chat` — raw agent
 * text the judge prompt-and-parses and flags `:prose` in decidedBy,
 * so an uncalibrated answer never shares the provider's typed bucket.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientContext,
  ClientRequestHandler,
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SendRequestOptions,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ActiveSessionMessage,
} from '@agentclientprotocol/sdk'
import { isSystemoneFamily, JudgeUnavailable } from '@broject/core'
import { agentTurnPlane } from './acp-events.ts'
import { otelSpan } from './otel.ts'
import type { OtelCtx } from './otel.ts'
import type {
  DecideResult,
  JudgeQuestion,
  ProviderEntry,
} from '@broject/core'
import { AcpTerminals } from './acp-terminal.ts'
import { objOr, remaining, splitShellWords } from './http.ts'
import type {
  ProviderCall,
  ProviderChat,
  ProviderChatResult,
  ProviderClient,
} from './registry.ts'
import type { ProviderWireOpts } from './systemone.ts'
import { mapTypedAnswers } from './typed.ts'

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>

/** The caller's config bug (interactive auth required, no model
 *  option advertised, a refused model, a non-v1 peer) — thrown as-is,
 *  never wrapped into JudgeUnavailable: a misconfigured provider is a
 *  startup error, not a backend outage. */
class AcpConfigError extends Error {
  override name = 'AcpConfigError'
}

// the family test lives in core (the api kind's parse-time wire
// inference consumes it) — re-exported so acp importers keep working
export { isSystemoneFamily } from '@broject/core'

/** JSON-RPC request-cancelled — the code both ends use for an aborted
 *  request. A cancel is availability (deadline, transport), never the
 *  peer refusing a value. */
const REQUEST_CANCELLED = -32800

/** ACP categories that say "not the model picker" — 'model_config' is
 *  a model PARAMETER (its options are parameter values, not model
 *  ids), 'mode'/'thought_level' select session behavior. Absent or
 *  unknown categories stay ambiguous — the spec forbids requiring
 *  category for correctness, so they may still serve. */
const NON_MODEL_CATEGORIES = new Set(['mode', 'thought_level', 'model_config'])

type SelectOpt = Extract<SessionConfigOption, { type: 'select' }>

/** The session's model select: category 'model' wins outright; a
 *  select whose category is absent or unknown still serves — a known
 *  non-model kind never does (the spec forbids requiring category for
 *  correctness). acpModels advertises and resolveModelPin resolves
 *  against the same pick — a listed id must always be pinnable. */
function modelSelect(configOptions: SessionConfigOption[]): SelectOpt | undefined {
  const selects = configOptions.filter((o): o is SelectOpt => o.type === 'select')
  return (
    selects.find((o) => o.category === 'model') ??
    selects.find((o) => o.category == null || !NON_MODEL_CATEGORIES.has(o.category))
  )
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** Minimal shell-words split for an operator-authored command line —
 *  whitespace-separated argv honoring '…', "…" and \x escapes. NOT a
 *  shell: no $expansion, globs, `;` or `|` — the provider command execs
 *  directly, so config text can never re-parse into a different
 *  program. An unclosed quote is a config error, named as such.
 *  Exported for the suite — the split IS the trust boundary. */
export function shellWords(command: string): string[] {
  try {
    return splitShellWords(command)
  } catch (err) {
    throw new AcpConfigError(
      `acp command has an ${err instanceof Error ? err.message : 'unclosed quote'}`
    )
  }
}

/** The spawned agent's env — `BRO_HOOKS=0` marks the child tree a
 *  machine backend (spec bro-ddksm): `bro hooks` no-ops there, so a
 *  session/new serving a disposable conductor/judge turn never pays
 *  session-start rehydrate probes written for a human session. A
 *  default, not a lock — an explicit ambient `BRO_HOOKS` wins. */
export function acpChildEnv(): NodeJS.ProcessEnv {
  return { BRO_HOOKS: '0', ...process.env }
}

/** The last bytes of peer stderr — the diagnostic that survives the
 *  process dying mid-turn (rate-limit walls, crash text). */
function stderrTail(child: ChildProcess): () => string {
  let tail = ''
  child.stderr?.on('data', (d: Buffer) => {
    tail = (tail + d.toString()).slice(-2048)
  })
  return () => tail.trim()
}

/** A judge call has no user to ask — default-deny: take a reject
 *  option when the agent offers one, else cancel the request. */
const denyPermission: ClientRequestHandler<
  RequestPermissionRequest,
  RequestPermissionResponse
> = (ctx) => {
  const reject = ctx.params.options.find(
    (o) => o.kind === 'reject_once' || o.kind === 'reject_always'
  )
  return {
    outcome:
      reject === undefined
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: reject.optionId },
  }
}

/** The whole call under the caller's budget — a peer that outlives it
 *  is fail-open, and the process kill in the caller's finally is the
 *  backstop the cooperative cancellation may not reach. */
async function withDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  const left = remaining(deadline)
  if (left <= 0) {
    throw new JudgeUnavailable('judge backend timed out (budget spent)')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new JudgeUnavailable('acp provider timed out')),
          left
        )
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/** Model selection — `session/set_config_option` on the option
 *  categorized "model" (configIds are agent-defined). A requested
 *  model the agent can't apply fails the call — an unpinned model
 *  would be fidelity laundering. Returns the value the agent REPORTS
 *  as current — provenance says what ran, not what was asked. */
async function applyModel(
  ctx: ClientContext,
  sessionId: string,
  configOptions: SessionConfigOption[],
  by: string,
  model: string | undefined,
  req: () => SendRequestOptions
): Promise<string> {
  const modelOpt = modelSelect(configOptions)
  if (model === undefined) {
    const cur = modelOpt?.currentValue
    return typeof cur === 'string' ? cur : 'unknown'
  }
  if (modelOpt === undefined) {
    throw new AcpConfigError(
      `${by}: model '${model}' requested but the acp agent advertises no model config option — refusing to run an unpinned model`
    )
  }
  return applyOption(ctx, sessionId, modelOpt, model, by, req)
}

/** `session/set_config_option` on one advertised option + verify the
 *  agent's reported currentValue. A refused set is config, a cancelled
 *  or dropped transport is availability. For the model option a family
 *  swap is laundering — asked jev, served qwen must never parse; other
 *  categories must report exactly what was asked. */
async function applyOption(
  ctx: ClientContext,
  sessionId: string,
  opt: SessionConfigOption,
  value: string,
  by: string,
  req: () => SendRequestOptions
): Promise<string> {
  const res = await ctx
    .request(
      'session/set_config_option',
      { sessionId, configId: opt.id, value },
      req()
    )
    .catch((err: unknown) => {
      if (err instanceof RequestError && err.code !== REQUEST_CANCELLED) {
        throw new AcpConfigError(`${by}: agent refused ${opt.category} '${value}' — ${errMsg(err)}`)
      }
      throw err
    })
  const served = res.configOptions.find((o) => o.id === opt.id)?.currentValue
  const reported = typeof served === 'string' ? served : value
  if (opt.category === 'model') {
    if (isSystemoneFamily(reported) !== isSystemoneFamily(value)) {
      throw new AcpConfigError(
        `${by}: asked for '${value}' but the agent reports '${reported}' — refusing a model-family swap`
      )
    }
  } else if (reported !== value) {
    throw new AcpConfigError(
      `${by}: asked for ${opt.category} '${value}' but the agent reports '${reported}'`
    )
  }
  return reported
}

/** Model resolution for the CONVERSE surfaces (acpConverse,
 *  acpPooledTurn) — tool-less agents advertise no model option, so a
 *  configured pin cannot be applied or verified; it IS the provenance
 *  (the operator asserted the fixed model at config time — spec
 *  bro-wxfls). `model` is what gets applied when an option exists;
 *  `label` is served verbatim when none does (never the client's
 *  request id — provenance reports what ran, not what was asked).
 *  Unlike applyModel this never throws on a pin under a tool-less
 *  backend — the converse surface serves a chat turn, not a
 *  calibrated verdict, so an unverifiable label is honest. The judge
 *  path keeps applyModel's hard refusal. */
async function converseModel(
  ctx: ClientContext,
  sessionId: string,
  configOptions: SessionConfigOption[],
  by: string,
  model: string | undefined,
  label: string | undefined = model,
  req: () => SendRequestOptions
): Promise<string> {
  if (modelSelect(configOptions) === undefined) {
    return label ?? 'unknown'
  }
  return applyModel(ctx, sessionId, configOptions, by, model, req)
}

interface AcpReply {
  /** Concatenated agent_message_chunk text. */
  text: string
  /** The model the agent reports running — never the wish alone. */
  model: string
  usage?: DecideResult['usage']
}

/** The initialize handshake — once per connection, not per session.
 *  `req(d)` mints per-request cancel options against ANY deadline so a
 *  pooled caller's per-turn budget is what bounds its requests. */
async function acpInit(ctx: ClientContext, by: string, deadline: number) {
  const req = (d = deadline): SendRequestOptions => ({
    cancellationSignal: AbortSignal.timeout(Math.max(1, remaining(d))),
  })
  const init = await ctx.request(
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'bro', version: '1' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      },
    },
    req()
  )
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw new AcpConfigError(
      `${by}: agent negotiated protocol ${init.protocolVersion} — the binding speaks v${PROTOCOL_VERSION} only`
    )
  }
  // authMethods is an OFFER, not a requirement — an agent with stored
  // credentials (e.g. kilo's saved oauth) still advertises its login
  // methods and serves sessions fine. Only a session/prompt failure
  // that actually names auth is the operator's problem; keep the
  // advertised ids for the remediation line.
  const authMethods = init.authMethods ?? []
  // prompt capabilities gate rich content — image blocks only go on
  // the wire when the agent says it can consume them (bro-7izjx)
  const caps = { image: init.agentCapabilities?.promptCapabilities?.image === true }
  const authHint = (): string =>
    authMethods.length > 0 ? ` (${authMethods.map((m) => m.id).join(', ')})` : ''
  const asAuthError = (err: unknown): never => {
    // availability vocabulary beats auth vocabulary: an 'auth-gateway
    // timeout' is an outage (fallbackable), not a config bug — only a
    // message that reads as auth REQUIRED names an interactive login
    const avail =
      err instanceof Error &&
      /timeout|timed out|unavailable|network|econn|socket|502|503|504|deadline/i.test(err.message)
    const isAuth =
      (err instanceof RequestError && err.code === -32000) ||
      (!avail && err instanceof Error && /auth|login|credential/i.test(err.message))
    throw isAuth
      ? new AcpConfigError(
          `${by}: agent requires interactive auth${authHint()} — a judge call can't log in; authenticate the agent CLI itself`
        )
      : err
  }
  return { asAuthError, req, caps }
}

/** session/new on an ALREADY-initialized connection — the pooled path. */
async function acpSessionOpen(
  ctx: ClientContext,
  opts: ProviderWireOpts,
  asAuthError: (err: unknown) => never,
  req: () => SendRequestOptions
) {
  const session = await ctx
    .buildSession({ cwd: opts.acp?.cwd ?? process.cwd(), mcpServers: [] })
    .start(req())
    .catch(asAuthError)
  return session
}

async function acpSession(
  ctx: ClientContext,
  opts: ProviderWireOpts,
  by: string,
  deadline: number
) {
  const { asAuthError, req, caps } = await acpInit(ctx, by, deadline)
  const session = await acpSessionOpen(ctx, opts, asAuthError, req)
  return { session, asAuthError, req, caps }
}

/** initialize → session/new → model → prompt → collect chunks — the
 *  v1 flow over a connected context, shared by the typed and prose
 *  surfaces. */
async function acpOp(
  ctx: ClientContext,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  by: string,
  promptText: string,
  deadline: number
): Promise<AcpReply> {
  const { session, asAuthError, req } = await acpSession(ctx, opts, by, deadline)
  try {
    const model = await applyModel(
      ctx,
      session.sessionId,
      session.newSessionResponse.configOptions ?? [],
      by,
      opts.model ?? entry.model,
      req
    )
    // spec bro-d6mcd: drain session/update as it arrives — the
    // caller's onUpdate sink (streaming hosts) sees every chunk,
    // tool_call and plan update; absent sink = the same whole-turn
    // contract readText() gave before.
    const r = await pumpTurn(
      session,
      promptText,
      opts.acp?.onUpdate ?? (() => {}),
      asAuthError,
      req,
      undefined,
      by,
      undefined,
      opts.acp?.cwd
    )
    if (r.stopReason !== 'end_turn') {
      throw new JudgeUnavailable(`${by} (acp) turn stopped — ${r.stopReason}`)
    }
    const usage = r.response.usage
    return {
      text: r.text,
      model,
      usage:
        usage != null && Number.isSafeInteger(usage.inputTokens)
          ? { inputTokens: usage.inputTokens }
          : undefined,
    }
  } finally {
    session.dispose()
  }
}

/** One connected ACP operation — `opts.acp.peer` is the in-process
 *  test seam; production execs the tokenized `entry.command` argv
 *  (profile as a separate arg — no shell) and kills the child when
 *  the op settles. `op` gets the connected context. */
async function withAcp<T>(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  deadline: number,
  op: (ctx: ClientContext) => Promise<T>
): Promise<T> {
  const terminals = new AcpTerminals()
  const app = terminals.register(
    client({ name: 'bro' }).onRequest('session/request_permission', denyPermission)
  )
  const peer = opts.acp?.peer
  let child: ChildProcess | undefined
  let tail = (): string => ''
  let spawnError: string | undefined
  const run = (): Promise<T> => {
    if (peer !== undefined) {
      return app.connectWith(peer, op)
    }
    const argv = [
      ...shellWords(entry.command),
      ...(entry.profile === undefined ? [] : ['--profile', entry.profile]),
    ]
    const bin = argv[0]
    if (bin === undefined) {
      throw new AcpConfigError(`${by}: acp command is empty`)
    }
    const proc = spawn(bin, argv.slice(1), { stdio: 'pipe', env: acpChildEnv() })
    child = proc
    // a binary that can't exec is operator misconfig — name it as such
    proc.once('error', (e) => {
      spawnError = e.message
    })
    tail = stderrTail(proc)
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    )
    return app.connectWith(stream, op)
  }
  try {
    return await withDeadline(deadline, run)
  } catch (err) {
    // a timed-out peer dies now — not whenever its prompt settles
    child?.kill('SIGKILL')
    if (err instanceof JudgeUnavailable || err instanceof AcpConfigError) {
      throw err
    }
    if (spawnError !== undefined) {
      throw new AcpConfigError(`${by}: cannot exec acp command — ${spawnError}`)
    }
    const stderr = tail()
    const detail = stderr === '' ? '' : ` (${stderr})`
    throw new JudgeUnavailable(`acp ${by} unavailable — ${errMsg(err)}${detail}`)
  } finally {
    terminals.dispose()
    child?.kill('SIGKILL')
  }
}

/** One minimal ACP session for the prompt — the round-trip shape the
 *  call surfaces share. */
async function acpRoundTrip(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  promptText: string,
  deadline: number
): Promise<AcpReply> {
  return withAcp(by, entry, opts, deadline, (ctx) =>
    acpOp(ctx, entry, opts, by, promptText, deadline)
  )
}

/** The catalog surface — session/new's configOptions carries the
 *  agent's own model option; its `options` list IS the model picker
 *  `devin acp`/`kilo acp`/… would render. An agent advertising no
 *  model option returns an empty list (not an error — an agent may
 *  simply not expose model selection). */
export async function acpModels(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts = {},
  deadline = Date.now() + 30_000
): Promise<{ value: string; name?: string }[]> {
  return withAcp(by, entry, opts, deadline, async (ctx) => {
    const { session } = await acpSession(ctx, opts, by, deadline)
    try {
      const opt = modelSelect(session.newSessionResponse.configOptions ?? [])
      const options = opt?.options ?? []
      // options may be grouped — a group's leaf options carry the values
      return options
        .flatMap((o) => ('options' in o ? o.options : [o]))
        .map((o) => ({ value: String(o.value), name: o.name }))
    } finally {
      session.dispose()
    }
  })
}

/** One conversational turn — the conductor's primitive (bro-xeozo).
 *  initialize → session/new → apply model → prompt → pump nextUpdate()
 *  until `stop`. `onUpdate` gets every session/update AS IT ARRIVES —
 *  the caller re-emits anthropic SSE per chunk; the final
 *  PromptResponse comes back in the return. Session is disposed, the
 *  spawned child killed, on settle — same lifecycle as every acp op. */
export async function acpConverse(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  promptText: string,
  onUpdate: (update: SessionUpdate) => void,
  deadline = Date.now() + 120_000,
  signal?: AbortSignal
): Promise<{ stopReason: StopReason; text: string; model: string }> {
  const span = otelSpan('acp.turn', { 'acp.by': by, 'acp.requested_model': opts.model ?? '' })
  return withAcp(by, entry, opts, deadline, async (ctx) => {
    const sessSpan = otelSpan('acp.session', { 'acp.by': by }, { parent: span.ctx })
    const { session, asAuthError, req } = await acpSession(ctx, opts, by, deadline)
    try {
      const model = await converseModel(
        ctx,
        session.sessionId,
        session.newSessionResponse.configOptions ?? [],
        by,
        opts.model ?? entry.model,
        undefined,
        req
      )
      const r = await pumpTurn(
        session,
        promptText,
        onUpdate,
        asAuthError,
        req,
        signal,
        by,
        sessSpan.ctx,
        opts.acp?.cwd
      )
      sessSpan.end({ 'acp.session_id': session.sessionId })
      span.end({
        'acp.model': model,
        'acp.stop_reason': r.stopReason,
        'acp.reply_len': r.text.length,
      })
      return { ...r, model }
    } catch (err) {
      sessSpan.end({ error: errMsg(err) }, 'error')
      span.end({ error: errMsg(err) }, 'error')
      throw err
    } finally {
      session.dispose()
    }
  })
}

/** Wrap an update sink so every tool_call opens an `acp.tool` span and
 *  every subagent_update an `acp.subagent` span (a child session inside
 *  the turn — the "each subagent, new span" edge). Spans end on the
 *  update's terminal status; anything still open at turn end flushes
 *  with the turn's own verdict. */
function tracedUpdates(
  onUpdate: (u: SessionUpdate) => void,
  parent: OtelCtx | undefined
): { sink: (u: SessionUpdate) => void; flush: (status: 'ok' | 'error') => void } {
  const open = new Map<string, ReturnType<typeof otelSpan>>()
  const terminal = (s: unknown): 'ok' | 'error' | undefined =>
    s === 'completed' ? 'ok' : s === 'failed' ? 'error' : undefined
  return {
    sink: (u) => {
      if (u.sessionUpdate === 'tool_call') {
        const s = otelSpan(
          'acp.tool',
          {
            'tool.id': u.toolCallId,
            'tool.title': u.title ?? '',
            'tool.name': u.name ?? '',
            'tool.kind': u.kind ?? '',
          },
          { parent }
        )
        const done = terminal(u.status)
        if (done === undefined) open.set(u.toolCallId, s)
        else s.end({ 'tool.status': String(u.status) }, done)
      } else if (u.sessionUpdate === 'tool_call_update') {
        const done = terminal(u.status)
        const s = open.get(u.toolCallId)
        if (s !== undefined && done !== undefined) {
          s.end({ 'tool.status': String(u.status) }, done)
          open.delete(u.toolCallId)
        }
      } else if (u.sessionUpdate === 'subagent_update') {
        // a child session — its own span under this turn's ctx; ended
        // with the turn (subagent updates carry no terminal status)
        if (!open.has(`sub:${u.sessionId}`)) {
          open.set(
            `sub:${u.sessionId}`,
            otelSpan(
              'acp.subagent',
              {
                'sub.session_id': u.sessionId,
                'sub.title': u.title ?? '',
                'sub.role': u.description ?? '',
              },
              { parent }
            )
          )
        }
      }
      // a throwing sink is an observer bug, not a turn failure —
      // swallow it so the pump keeps draining updates to stop
      try {
        onUpdate(u)
      } catch {
        /* observer must not kill the turn pump */
      }
    },
    flush: (status) => {
      for (const [, s] of open) s.end({ 'tool.status': 'turn_end' }, status)
      open.clear()
    },
  }
}

/** The prompt→updates loop shared by one-shot and pooled turns — and
 *  the single chokepoint the 'agent' event plane hangs off (bro-0ppt0):
 *  every ACP turn (conductor pool, fleet worker, judge) funnels here,
 *  so the plane observer is attached once, not per transport. `cwd`
 *  anchors the bus socket + the per-agent .events.jsonl archive. */
export async function pumpTurn(
  session: ActiveSession,
  prompt: string | ContentBlock[],
  onUpdate: (update: SessionUpdate) => void,
  asAuthError: (err: unknown) => never,
  req: () => SendRequestOptions,
  signal: AbortSignal | undefined,
  by: string,
  parent?: OtelCtx,
  cwd?: string
): Promise<{ stopReason: StopReason; text: string; response: PromptResponse }> {
  const traced = tracedUpdates(onUpdate, parent)
  const plane = agentTurnPlane({ cwd, by, sessionId: session.sessionId })
  plane.start()
  // prompt() enqueues `stop` into the SAME updates stream in order —
  // updates drain first, `stop` arrives last, so trailing chunks can't
  // be lost by racing the response promise (bro-d6mcd). The turn's
  // own rejection lands on the queue as a reject — swallow it on the
  // direct promise so it can't fire unhandled; the pump reads and
  // classifies the same failure through nextUpdate.
  void session.prompt(prompt, req()).catch(() => {})
  // a gone caller cancels the turn: the caller's dispose ends the
  // session — no orphan work on the agent
  const aborted = new Promise<never>((_, reject) => {
    const drop = () => reject(new JudgeUnavailable(`${by}: caller aborted the turn`))
    if (signal?.aborted === true) drop()
    signal?.addEventListener('abort', drop, { once: true })
  })
  let text = ''
  try {
    for (;;) {
      const msg: ActiveSessionMessage = await Promise.race([
        // prompt failures surface on the queue itself — classify the
        // rejection through asAuthError the same as a direct throw
        session.nextUpdate().catch(asAuthError),
        aborted,
      ])
      if (msg.kind === 'stop') {
        traced.flush('ok')
        plane.stop(msg.stopReason, { replyLen: text.length })
        return { stopReason: msg.stopReason, text, response: msg.response }
      }
      plane.update(msg.update)
      traced.sink(msg.update)
      if (msg.update.sessionUpdate === 'agent_message_chunk') {
        const c = msg.update.content
        if (c.type === 'text') text += c.text
      }
    }
  } catch (err) {
    traced.flush('error')
    plane.stop(undefined, { error: errMsg(err) })
    throw err
  } finally {
    // the acp-worker driver exits right after the turn — settle the
    // queued publishes first or the turn's last events die with it
    await plane.drain()
  }
}

/** A long-lived acp connection — the conductor's warm pool leg (bro-xeozo).
 *  `connect` keeps the child alive across requests: spawn+initialize cost
 *  is paid once per listener, `session/new` per request is the cheap part.
 *  `closed`/`signal` report transport death so callers can respawn. */
export interface AcpPeer {
  ctx: ClientContext
  /** Aborts when the transport dies — pooled callers respawn on next use. */
  signal: AbortSignal
  close: () => void
  tail: () => string
  /** Per-request cancel options against any deadline (init one is default). */
  req: (deadline?: number) => SendRequestOptions
  asAuthError: (err: unknown) => never
  /** Prompt capabilities negotiated at initialize — `image` gates
   *  whether image content blocks may go on the wire (bro-7izjx).
   *  Optional: external peers built before the field existed are
   *  treated as image-incapable (codeant #558). */
  caps?: { image: boolean }
}

export async function acpOpen(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  deadline: number,
  parent?: OtelCtx
): Promise<AcpPeer> {
  const span = otelSpan('acp.open', { 'acp.by': by, 'acp.command': entry.command }, { parent })
  function fail(err: unknown): never {
    span.end({ error: errMsg(err) }, 'error')
    throw err
  }
  const terminals = new AcpTerminals()
  const app = terminals.register(
    client({ name: 'bro' }).onRequest('session/request_permission', denyPermission)
  )
  const peer = opts.acp?.peer
  let child: ChildProcess | undefined
  let tail = (): string => ''
  let spawnError: string | undefined
  let conn: Awaited<ReturnType<typeof app.connect>>
  if (peer !== undefined) {
    conn = app.connect(peer)
  } else {
    const argv = [
      ...shellWords(entry.command),
      ...(entry.profile === undefined ? [] : ['--profile', entry.profile]),
    ]
    const bin = argv[0]
    if (bin === undefined) {
      fail(new AcpConfigError(`${by}: acp command is empty`))
    }
    const proc = spawn(bin, argv.slice(1), { stdio: 'pipe', env: acpChildEnv() })
    child = proc
    proc.once('error', (e) => {
      spawnError = e.message
    })
    tail = stderrTail(proc)
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    )
    conn = app.connect(stream)
  }
  const close = (): void => {
    conn.close()
    terminals.dispose()
    child?.kill('SIGKILL')
  }
  // a dead transport is itself a close: pooled callers only drop their
  // peer refs on abort — without this, terminals the agent spawned (and
  // the child) outlive the dead connection they were created under
  conn.signal.addEventListener('abort', close, { once: true })
  try {
    const { asAuthError, req, caps } = await withDeadline(deadline, () =>
      acpInit(conn.agent, by, deadline)
    )
    span.end({ 'acp.pid': child?.pid ?? 0 })
    return { ctx: conn.agent, signal: conn.signal, close, tail, req, asAuthError, caps }
  } catch (err) {
    close()
    // spawn's 'error' event is async — a binary that can't exec is only
    // knowable here, once the handshake on the dead transport has failed
    if (err instanceof AcpConfigError) {
      fail(err)
    }
    if (spawnError !== undefined) {
      fail(new AcpConfigError(`${by}: cannot exec acp command — ${spawnError}`))
    }
    fail(err)
  }
}

/** Flatten a select config option's (possibly grouped) leaf entries. */
function selectLeaves(opt: SessionConfigOption): { name: string; value: string }[] {
  if (opt.type !== 'select') return []
  return opt.options.flatMap((o) => ('options' in o ? o.options : [o]))
}

/** Claude pins context-window variants as `model[1m]` — a client-side
 *  opt-in, not a different catalog model; the trailing `[<size>]`
 *  bracket strips before resolution or the catalog match misses
 *  (bro-0g2l3). Other brackets stay — `model[custom]` is a real id. */
function modelBase(model: string): string {
  const raw = model.trimEnd()
  const open = raw.lastIndexOf('[')
  const inner = open >= 0 && raw.endsWith(']') ? raw.slice(open + 1, -1) : undefined
  return inner !== undefined && /^\d+[km]?$/i.test(inner) ? raw.slice(0, open).trimEnd() : raw
}

/** Resolve a caller's model name against the agent's advertised select
 *  options: `<provider>/` prefixes strip, exact value/name wins, a unique
 *  `<id>-` prefix match resolves family shorthand — anything else is a
 *  loud config error naming the catalog, never a silent fallback. */
function resolveModelPin(
  want: string,
  configOptions: SessionConfigOption[],
  by: string
): string | undefined {
  const opt = modelSelect(configOptions)
  if (opt === undefined) {
    return undefined // no catalog to resolve against — the session check decides
  }
  const leaves = selectLeaves(opt)
  const bare = want.includes('/') ? want.slice(want.indexOf('/') + 1) : want
  const exact = leaves.find(
    (o) => o.value === bare || o.name.toLowerCase() === bare.toLowerCase()
  )
  if (exact !== undefined) return exact.value
  const prefixed = leaves.filter((o) => o.value.startsWith(`${bare}-`))
  if (prefixed.length === 1) return prefixed[0]!.value
  if (prefixed.length > 1) {
    throw new AcpConfigError(
      `${by}: model '${want}' is ambiguous — the agent offers ` +
        prefixed.map((o) => o.value).join(', ')
    )
  }
  return undefined
}

/** Resolve a wanted pin against a live session — exact value, unique
 *  family prefix, composite `<base>-<level>` (thought_level leaf), or a
 *  spawn-level pin the session already reports. Returns the provenance
 *  label (the asked id when it names the (model, level) pair exactly). */
async function resolveTurnModel(
  ctx: ClientContext,
  sessionId: string,
  configOptions: SessionConfigOption[],
  want: string | undefined,
  configuredLabel: string | undefined,
  by: string,
  req: () => SendRequestOptions
): Promise<string> {
  const asked = want === undefined ? undefined : modelBase(want)
  const resolved = asked === undefined ? undefined : resolveModelPin(asked, configOptions, by)
  if (
    asked === undefined ||
    resolved !== undefined ||
    modelSelect(configOptions) === undefined
  ) {
    // direct path — or a tool-less backend (no model option): the
    // reported label is the configured pin, never the ask
    return converseModel(ctx, sessionId, configOptions, by, resolved, configuredLabel, req)
  }
  // the agent advertises a catalog that doesn't contain the ask.
  // Two honest ways it can still be served:
  //  - composite variant: `<base>-<level>` where <level> is a leaf of
  //    the agent's thought_level option (devin's swe-2 family maps
  //    -medium/-high/-max onto the thinking dimension — 'swe-2-max'
  //    is model swe-2-high + level max, never its own catalog id)
  //  - spawn-level pin: the provider command's --model already set
  //    state the session reports back verbatim
  const bare = asked.includes('/') ? asked.slice(asked.indexOf('/') + 1) : asked
  const modelOpt = modelSelect(configOptions)
  const thought = configOptions.find((o) => o.category === 'thought_level')
  const dash = bare.lastIndexOf('-')
  const level = dash > 0 ? bare.slice(dash + 1) : ''
  const baseResolved =
    thought !== undefined && dash > 0 && selectLeaves(thought).some((o) => o.value === level)
      ? resolveModelPin(bare.slice(0, dash), configOptions, by)
      : undefined
  if (modelOpt !== undefined && thought !== undefined && baseResolved !== undefined) {
    if (modelOpt.currentValue !== baseResolved || thought.currentValue !== level) {
      await applyOption(ctx, sessionId, modelOpt, baseResolved, by, req)
      await applyOption(ctx, sessionId, thought, level, by, req)
    }
    return bare // the asked id names this exact (model, level) pair
  }
  const cur = modelOpt?.currentValue
  if (cur !== bare) {
    throw new AcpConfigError(
      `${by}: model '${want}' is not in the agent's catalog and the session serves ` +
        `'${typeof cur === 'string' ? cur : 'unknown'}' — pick a catalog id or pin ` +
        `the model in the provider command`
    )
  }
  return bare
}

export interface PooledTurnOpts {
  /** Session updates sink — default drops them (the conductor parses). */
  onUpdate?: (update: SessionUpdate) => void
  signal?: AbortSignal
  by?: string
  /** The API caller's `model` field — outranks the configured pin. */
  requestModel?: string
  /** Parent span context — nests `acp.turn` under the caller's trace. */
  parent?: OtelCtx
}

/** One conversational turn on an already-open acp link — session/new,
 *  model pin, prompt pump, session dispose. The link itself survives. */
export async function acpPooledTurn(
  peer: AcpPeer,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  prompt: string | ContentBlock[],
  deadline: number,
  turn: PooledTurnOpts = {}
): Promise<{ stopReason: StopReason; text: string; model: string }> {
  const ctx = peer.ctx
  const req = () => peer.req(deadline)
  const by = turn.by ?? 'conductor'
  const span = otelSpan(
    'acp.turn',
    { 'acp.by': by, 'acp.requested_model': turn.requestModel ?? '' },
    { parent: turn.parent }
  )
  let ended = false
  const end = (a: Record<string, string | number | boolean>, status?: 'ok' | 'error'): void => {
    if (ended) return
    ended = true
    span.end(a, status)
  }
  try {
    const sessSpan = otelSpan('acp.session', { 'acp.by': by }, { parent: span.ctx })
    const session = await acpSessionOpen(ctx, opts, peer.asAuthError, req)
    const endSession = (a: Record<string, string | number | boolean> = {}): void =>
      sessSpan.end({ 'acp.session_id': session.sessionId, ...a })
    try {
      const configOptions = session.newSessionResponse.configOptions ?? []
      const model = await resolveTurnModel(
        ctx,
        session.sessionId,
        configOptions,
        turn.requestModel ?? opts.model ?? entry.model,
        // a request pin cannot be honored under a tool-less backend —
        // the reported label is the configured pin, never the ask
        opts.model ?? entry.model,
        by,
        req
      )
      const r = await pumpTurn(
        session,
        prompt,
        turn.onUpdate ?? (() => {}),
        peer.asAuthError,
        req,
        turn.signal,
        by,
        sessSpan.ctx,
        opts.acp?.cwd
      )
      endSession()
      end({
        'acp.session_id': session.sessionId,
        'acp.model': model,
        'acp.stop_reason': r.stopReason,
        'acp.reply_len': r.text.length,
      })
      return { ...r, model }
    } catch (err) {
      endSession({ error: errMsg(err) })
      end(
        { 'acp.session_id': session.sessionId, error: errMsg(err) },
        'error'
      )
      throw err
    } finally {
      session.dispose()
    }
  } catch (err) {
    // the pooled link skips withAcp's error mapping — same contract here:
    // config problems stay config, everything else is availability
    if (err instanceof JudgeUnavailable || err instanceof AcpConfigError) {
      end({ error: errMsg(err) }, 'error')
      throw err
    }
    const tail = peer.tail()
    const detail = tail === '' ? '' : ` (${tail})`
    end({ error: errMsg(err) }, 'error')
    throw new JudgeUnavailable(`acp ${by} unavailable — ${errMsg(err)}${detail}`)
  }
}

/** A session kept alive across turns — the conductor's Messages-API
 *  reuse leg (bro-whn25). The caller owns `dispose()` — a failed turn,
 *  an eviction, or peer death all end the session's cacheability, and
 *  the caller drops it from any reuse map. */
export interface AcpRetainedSession {
  sessionId: string
  /** One more user turn on the live session — the pooled pump minus
   *  session/new+dispose. A differing requestModel re-pins on the
   *  live session's config options. */
  prompt(
    prompt: string | ContentBlock[],
    deadline: number,
    turn?: PooledTurnOpts
  ): Promise<{ stopReason: StopReason; text: string; model: string }>
  /** Re-resolve a request model on the live session without a turn —
   *  a resend that pins a different model still owns the session. */
  repin(requestModel: string, deadline: number): Promise<string>
  dispose(): void
}

/** session/new WITHOUT the per-request dispose — the model pin is
 *  resolved at open and re-resolvable per prompt. Error surface is
 *  acpPooledTurn's: config stays config, everything else is a
 *  JudgeUnavailable naming the backend. */
export async function acpSessionRetain(
  peer: AcpPeer,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  deadline: number,
  turn: PooledTurnOpts = {}
): Promise<AcpRetainedSession> {
  const ctx = peer.ctx
  const req = () => peer.req(deadline)
  const by = turn.by ?? 'conductor'
  const span = otelSpan(
    'acp.session.retain',
    { 'acp.by': by, 'acp.requested_model': turn.requestModel ?? '' },
    { parent: turn.parent }
  )
  try {
    const session = await acpSessionOpen(ctx, opts, peer.asAuthError, req)
    const configOptions = session.newSessionResponse.configOptions ?? []
    const base = opts.model ?? entry.model
    // the RAW requested id (possibly a composite like 'swe-2-max') —
    // prompt() compares raw-to-raw so a resubmitted request id doesn't
    // re-pin a model the open already resolved
    const requested = turn.requestModel ?? base
    let model: string
    try {
      model = await resolveTurnModel(
        ctx,
        session.sessionId,
        configOptions,
        requested,
        base,
        by,
        req
      )
    } catch (err) {
      // the session opened but can't run the pin — it is not
      // cacheable, and no caller ever sees the handle to dispose it
      try {
        session.dispose()
      } catch {
        // already gone — the drop is the point
      }
      throw err
    }
    // what the session currently RUNS — a mid-conversation re-pin moves
    // the cursor so the same new pin isn't applied twice
    let curReq = requested
    let curModel = model
    span.end({ 'acp.session_id': session.sessionId, 'acp.model': model })
    // dispose is idempotent — the prompt failure path already drops the
    // handle, and the cache caller drops it again on eviction; a second
    // cancel on a dead session is a no-op, not an error
    let disposed = false
    const dispose = () => {
      if (disposed) {
        return
      }
      disposed = true
      session.dispose()
    }
    /** The shared wire classification: config stays config (a refused
     *  pin names the caller's mistake); everything else is a
     *  JudgeUnavailable naming the backend and the last transport
     *  lines. */
    const classifyWire = (err: unknown): Error => {
      if (err instanceof JudgeUnavailable || err instanceof AcpConfigError) {
        return err
      }
      const tail = peer.tail()
      const detail = tail === '' ? '' : ` (${tail})`
      return new JudgeUnavailable(`acp ${by} unavailable — ${errMsg(err)}${detail}`)
    }
    /** Resolve a request pin on the live session and move the cursor —
     *  shared by prompt() and repin(); a refused pin surfaces config
     *  and keeps the session, a dead wire disposes + goes unavailable. */
    const applyPin = async (want: string | undefined, dl: number): Promise<string> => {
      try {
        const m = await resolveTurnModel(
          ctx,
          session.sessionId,
          configOptions,
          want,
          base,
          by,
          () => peer.req(dl)
        )
        curReq = want
        curModel = m
        return m
      } catch (err) {
        const classified = classifyWire(err)
        if (!(classified instanceof JudgeUnavailable)) {
          throw classified
        }
        try {
          dispose()
        } catch {
          // already gone — the drop is the point
        }
        throw classified
      }
    }
    return {
      sessionId: session.sessionId,
      prompt: async (prompt, dl, t = {}) => {
        try {
          const r2 = () => peer.req(dl)
          const want = t.requestModel ?? curReq
          const effective = want === curReq ? curModel : await applyPin(want, dl)
          const r = await pumpTurn(
            session,
            prompt,
            t.onUpdate ?? (() => {}),
            peer.asAuthError,
            r2,
            t.signal,
            by,
            t.parent
          )
          return { ...r, model: effective }
        } catch (err) {
          // a failed turn leaves the session's context in doubt — the
          // session is dead weight; the caller evicts its cache entry
          // but the acp-side handle is dropped here and now
          try {
            dispose()
          } catch {
            // already gone — the drop is the point
          }
          throw classifyWire(err)
        }
      },
      repin: (requestModel, dl) =>
        requestModel === curReq ? Promise.resolve(curModel) : applyPin(requestModel, dl),
      dispose,
    }
  } catch (err) {
    span.end({ error: errMsg(err) }, 'error')
    if (err instanceof JudgeUnavailable || err instanceof AcpConfigError) {
      throw err
    }
    const tail = peer.tail()
    const detail = tail === '' ? '' : ` (${tail})`
    throw new JudgeUnavailable(`acp ${by} unavailable — ${errMsg(err)}${detail}`)
  }
}

/** The typed reply contract — the agent's message text IS the
 *  `{answers: {…}}` payload (a jev-family model speaks it natively).
 *  Strict JSON: a fenced or prosaic reply is drift, fail-open. */
function typedReply(text: string, by: string): { answers: unknown; model?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new JudgeUnavailable(`${by} (acp) returned a non-JSON reply — not a typed answer`)
  }
  const body = objOr(parsed)
  if (typeof body.answers !== 'object' || body.answers === null) {
    throw new JudgeUnavailable(`${by} (acp) returned no answers map`)
  }
  return {
    answers: body.answers,
    model: typeof body.model === 'string' ? body.model : undefined,
  }
}

/** The typed contract as prompt preamble — an ACP session is a chat
 *  surface, so unlike the systemone HTTP endpoint the wire format isn't
 *  baked in; the body alone gets answered as an agent task (the model
 *  even ran tools in dogfooding). The preamble states the shapes
 *  mapAnswer validates — field names are the wire's, not aliases. */
const TYPED_PREAMBLE = [
  'You are a System One decision endpoint. The user message below is a JSON body {state, questions}.',
  'Reply with STRICT JSON only — no prose, no markdown fences:',
  '{"answers": {"<question-id>": <answer>, ...}}',
  'Answer shape per question type — copy the question\'s "type":',
  '- "noul":   {"type":"noul","noul":<0..1 probability the answer is yes>}',
  '- "choice": {"type":"choice","choice":"<one criteria key>","probabilities":{"<key>":<p>, ...}}',
  '- "score":  {"type":"score","score":<0..N-1 probability-weighted level>,"probabilities":{"<level index>":<p>, ...}}',
  'Add "confidence": <0..1> to every answer. Answer EVERY question id exactly once.',
  'BODY:',
].join('\n')

/** The typed call surface for an `acp` entry on a systemone-family
 *  model — `{state, questions}` in, typed judgments out. */
export function acpCall(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts = {}
): ProviderCall {
  return async (
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    deadline: number
  ): Promise<DecideResult> => {
    const started = Date.now()
    const reply = await acpRoundTrip(
      by,
      entry,
      opts,
      `${TYPED_PREAMBLE}\n${JSON.stringify({ state, questions })}`,
      deadline
    )
    const body = typedReply(reply.text, by)
    return {
      answers: mapTypedAnswers(body.answers, questions, by, `${by} (acp)`),
      model: body.model ?? reply.model,
      latencyMs: Date.now() - started,
      usage: reply.usage,
      // the chain owns thresholding — a raw backend reports none
      lowConfidence: [],
    }
  }
}

/** The raw prose surface for an `acp` entry on a general model — the
 *  rendered prompt in, the agent's message text out; parsing and the
 *  uncalibrated stamp are the consumer's (the judge's proseDecide). */
export function acpChat(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts = {}
): ProviderChat {
  return async (prompt, deadline): Promise<ProviderChatResult> => {
    const reply = await acpRoundTrip(by, entry, opts, prompt, deadline)
    return { content: reply.text, model: reply.model, usage: reply.usage }
  }
}

/** Shell-quote for the profile render — `command` is a trusted config
 *  string (sh -c'd inside the driver), and the profile lands on it as a
 *  separate `--profile <value>` (spec bro-5hx1.1: the field exists so
 *  operators don't hand-edit profile variants into `command`). */
const shQ = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`

/** The spawn surface — argv for `bro acp-worker` (spec bro-5hx1.1).
 *  Rendered fully at spawn time so the worker never re-reads config;
 *  `broBin` is the resolver's PATH-first `['bro']` or the
 *  `npx -y @broject/bro@0` fallback. `opts` carries the EFFECTIVE
 *  values — model/autoApprove already resolved through the spawn →
 *  profile → entry ladder (entry fields are the final fallback, so a
 *  bare call still lands the configured values). The backend appends
 *  the prepared prompt file as the LAST element — the SpawnWorker
 *  argv contract — and never string-concats this into `sh -c`: a
 *  model value carrying shell metachars must not escape its argv
 *  slot. */
export function acpWorkerArgv(
  broBin: string[],
  entry: AcpEntry,
  opts: { model?: string; autoApprove?: boolean; sessionRm?: string } = {}
): string[] {
  const command =
    entry.profile === undefined ? entry.command : `${entry.command} --profile ${shQ(entry.profile)}`
  const argv = [...broBin, 'acp-worker', '--command', command]
  const model = opts.model ?? entry.model
  if (model !== undefined) {
    argv.push('--model', model)
  }
  if (opts.autoApprove ?? entry.autoApprove) {
    argv.push('--auto-approve')
  }
  const sessionRm = opts.sessionRm ?? entry.sessionRm
  if (sessionRm !== undefined) {
    argv.push('--session-rm', sessionRm)
  }
  return argv
}

/** The 'auto' capability resolves on the served model: systemone-family
 *  → typed `call`; anything else (or no pin at all — an unpinned model
 *  can never be trusted typed) → prose `chat`. */
export function acpClient(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts = {}
): ProviderClient {
  return isSystemoneFamily(opts.model ?? entry.model)
    ? { call: acpCall(by, entry, opts) }
    : { chat: acpChat(by, entry, opts) }
}
