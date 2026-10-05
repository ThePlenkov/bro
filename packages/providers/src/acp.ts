/**
 * The `acp` provider binding — an agent process speaking ACP v1 over
 * stdio (spec: specs/bro-ribc.1.md §acp, milestone 4 — call surface;
 * the spawn surface lands with bro-5hx1.1). `command` is a CLI serving
 * ACP (`kilo --acp`, `devin -p --acp`) — operator-authored config, the
 * same trusted-string contract loop.agent carries; it runs under
 * `sh -c` with `profile` appended as `--profile <value>`.
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
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  ClientContext,
  ClientRequestHandler,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SendRequestOptions,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import { isEnvName, JudgeUnavailable } from '@broject/core'
import type {
  DecideResult,
  JudgeQuestion,
  ProviderEntry,
} from '@broject/core'
import { objOr, remaining } from './http.ts'
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

/** A systemone-family model id — `typesafe/jev-*` on a router, or a
 *  bare `jev-*` pin. Only these get the typed contract; every other
 *  served model is prose-grade. */
export const isSystemoneFamily = (model: string | undefined): boolean =>
  model !== undefined && /^(?:typesafe\/)?jev-/.test(model)

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

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
  const modelOpt = configOptions.find((o) => o.category === 'model')
  if (model === undefined) {
    const cur = modelOpt?.currentValue
    return typeof cur === 'string' ? cur : 'unknown'
  }
  if (modelOpt === undefined) {
    throw new AcpConfigError(
      `${by}: model '${model}' requested but the acp agent advertises no model config option — refusing to run an unpinned model`
    )
  }
  const res = await ctx
    .request(
      'session/set_config_option',
      { sessionId, configId: modelOpt.id, value: model },
      req()
    )
    .catch((err) => {
      throw new AcpConfigError(`${by}: agent refused model '${model}' — ${errMsg(err)}`)
    })
  const cur = res.configOptions.find((o) => o.id === modelOpt.id)?.currentValue
  return typeof cur === 'string' ? cur : model
}

interface AcpReply {
  /** Concatenated agent_message_chunk text. */
  text: string
  /** The model the agent reports running — never the wish alone. */
  model: string
  usage?: DecideResult['usage']
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
  const req = (): SendRequestOptions => ({
    cancellationSignal: AbortSignal.timeout(Math.max(1, remaining(deadline))),
  })
  const init = await ctx.request(
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'bro', version: '1' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
    req()
  )
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw new AcpConfigError(
      `${by}: agent negotiated protocol ${init.protocolVersion} — the binding speaks v${PROTOCOL_VERSION} only`
    )
  }
  const authMethods = init.authMethods ?? []
  if (authMethods.length > 0) {
    throw new AcpConfigError(
      `${by}: agent requires interactive auth (${authMethods
        .map((m) => m.id)
        .join(', ')}) — a judge call can't log in; authenticate the agent CLI itself`
    )
  }
  const session = await ctx
    .buildSession({ cwd: opts.acp?.cwd ?? process.cwd(), mcpServers: [] })
    .start(req())
  try {
    const model = await applyModel(
      ctx,
      session.sessionId,
      session.newSessionResponse.configOptions ?? [],
      by,
      opts.model ?? entry.model,
      req
    )
    const [resp, text] = await Promise.all([
      session.prompt(promptText, req()),
      session.readText(),
    ])
    if (resp.stopReason !== 'end_turn') {
      throw new JudgeUnavailable(`${by} (acp) turn stopped — ${resp.stopReason}`)
    }
    const usage = resp.usage
    return {
      text,
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

/** One minimal ACP session for the prompt — `opts.acp.peer` is the
 *  in-process test seam; production spawns `entry.command` (+ the
 *  entry's profile flag) under `sh -c` and kills it when the call
 *  settles. */
async function acpRoundTrip(
  by: string,
  entry: AcpEntry,
  opts: ProviderWireOpts,
  promptText: string,
  deadline: number
): Promise<AcpReply> {
  const app = client({ name: 'bro' }).onRequest(
    'session/request_permission',
    denyPermission
  )
  const op = (ctx: ClientContext): Promise<AcpReply> =>
    acpOp(ctx, entry, opts, by, promptText, deadline)
  const peer = opts.acp?.peer
  let child: ChildProcess | undefined
  let tail = (): string => ''
  const run = (): Promise<AcpReply> => {
    if (peer !== undefined) {
      return app.connectWith(peer, op)
    }
    const command =
      entry.profile === undefined
        ? entry.command
        : `${entry.command} --profile ${entry.profile}`
    const proc = spawn('sh', ['-c', command], { stdio: 'pipe' })
    child = proc
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
    const stderr = tail()
    throw new JudgeUnavailable(
      `acp ${by} unavailable — ${errMsg(err)}${stderr === '' ? '' : ` (${stderr})`}`
    )
  } finally {
    child?.kill('SIGKILL')
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
      JSON.stringify({ state, questions }),
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
