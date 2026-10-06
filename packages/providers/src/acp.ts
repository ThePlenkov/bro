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
  ClientContext,
  ClientRequestHandler,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SendRequestOptions,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import { isSystemoneFamily, JudgeUnavailable } from '@broject/core'
import type {
  DecideResult,
  JudgeQuestion,
  ProviderEntry,
} from '@broject/core'
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
      // only the peer's own error reply is a refusal — a cancel or a
      // dropped transport is availability, not config: it rides up to
      // the JudgeUnavailable mapping in acpRoundTrip
      if (err instanceof RequestError && err.code !== REQUEST_CANCELLED) {
        throw new AcpConfigError(`${by}: agent refused model '${model}' — ${errMsg(err)}`)
      }
      throw err
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
  // authMethods is an OFFER, not a requirement — an agent with stored
  // credentials (e.g. kilo's saved oauth) still advertises its login
  // methods and serves sessions fine. Only a session/prompt failure
  // that actually names auth is the operator's problem; keep the
  // advertised ids for the remediation line.
  const authMethods = init.authMethods ?? []
  const authHint = (): string =>
    authMethods.length > 0 ? ` (${authMethods.map((m) => m.id).join(', ')})` : ''
  const asAuthError = (err: unknown): never => {
    // availability vocabulary beats auth vocabulary: an 'auth-gateway
    // timeout' is an outage (fallbackable), not a config bug — only a
    // message that reads as auth REQUIRED names an interactive login
    const avail =
      err instanceof Error &&
      /timeout|timed out|unavailable|network|econn|socket|502|503|deadline/i.test(err.message)
    const isAuth =
      (err instanceof RequestError && err.code === -32000) ||
      (!avail && err instanceof Error && /auth|login|credential/i.test(err.message))
    throw isAuth
      ? new AcpConfigError(
          `${by}: agent requires interactive auth${authHint()} — a judge call can't log in; authenticate the agent CLI itself`
        )
      : err
  }
  const session = await ctx
    .buildSession({ cwd: opts.acp?.cwd ?? process.cwd(), mcpServers: [] })
    .start(req())
    .catch(asAuthError)
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
      session.prompt(promptText, req()).catch(asAuthError),
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
  opts: { model?: string; autoApprove?: boolean } = {}
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
