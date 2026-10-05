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
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  ClientContext,
  ClientRequestHandler,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SendRequestOptions,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import { JudgeUnavailable } from '@broject/core'
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

/** Minimal shell-words split for an operator-authored command line —
 *  whitespace-separated argv honoring '…', "…" and \x escapes. NOT a
 *  shell: no $expansion, globs, `;` or `|` — the provider command execs
 *  directly, so config text can never re-parse into a different
 *  program. An unclosed quote is a config error, named as such.
 *  Exported for the suite — the split IS the trust boundary. */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let cur = ''
  let open = false
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === undefined && (ch === "'" || ch === '"')) {
      quote = ch
      open = true
    } else if (ch === quote) {
      quote = undefined
    } else if (quote === undefined && ch === '\\' && i + 1 < command.length) {
      cur += command[++i]
      open = true
    } else if (quote === undefined && /\s/.test(ch)) {
      if (open) {
        words.push(cur)
        cur = ''
        open = false
      }
    } else {
      cur += ch
      open = true
    }
  }
  if (quote !== undefined) {
    throw new AcpConfigError(`acp command has an unclosed ${quote} quote`)
  }
  if (open) {
    words.push(cur)
  }
  return words
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
    .catch((err: unknown) => {
      // a transport drop or the caller's deadline is an outage, not a
      // refusal — fail open as JudgeUnavailable, never mislabel config
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new JudgeUnavailable(`${by} (acp) model pin aborted — ${errMsg(err)}`)
      }
      throw new AcpConfigError(`${by}: agent refused model '${model}' — ${errMsg(err)}`)
    })
  const served = res.configOptions.find((o) => o.id === modelOpt.id)?.currentValue
  const reported = typeof served === 'string' ? served : model
  // a family swap is laundering — asked jev, served qwen must never
  // parse as a typed answer. Same-family drift is canonicalization:
  // provenance carries the reported id.
  if (isSystemoneFamily(reported) !== isSystemoneFamily(model)) {
    throw new AcpConfigError(
      `${by}: asked for '${model}' but the agent reports '${reported}' — refusing a model-family swap`
    )
  }
  return reported
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
 *  in-process test seam; production execs the tokenized `entry.command`
 *  argv (profile as a separate arg — no shell) and kills the child when
 *  the call settles. */
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
  let spawnError: string | undefined
  const run = (): Promise<AcpReply> => {
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
    const proc = spawn(bin, argv.slice(1), { stdio: 'pipe' })
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
