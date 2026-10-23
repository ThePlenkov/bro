/**
 * `bro acp proxy -- <agent cmd>` — the cascading ACP edge (specs
 * bro-rs8sp.md §decision, bro-bhyo1.md). bro is the ACP agent to the
 * client on its own stdin/stdout and the ACP client to the spawned
 * downstream — verbatim forwarding by default, with the hook seam
 * injected into the session's first `session/prompt`.
 *
 * The transport is a message pump over the SDK's `Stream`/`ndJsonStream`
 * — deliberately NOT the typed `agent()`/`client()` apps: those parse
 * params against generated schemas and silently narrow the wire. The
 * pump moves the parsed `{jsonrpc, id, method, params}` objects across
 * untouched, so `_`-methods, future v1 additions, `_meta`, and error
 * envelopes cross without a handler list that can rot. Request ids
 * forward verbatim too — each direction's outbound id space is
 * single-sourced (client-originated on the downstream leg,
 * agent-originated on the upstream leg), so nothing translates.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type {
  AnyMessage,
  ContentBlock,
  JsonRpcId,
  SessionUpdate,
  Stream,
} from '@agentclientprotocol/sdk'
import { acpChildEnv } from './acp.ts'
import { agentTurnPlane, type AgentTurnPlane } from './acp-events.ts'
import { otelSpan, type OtelSpan } from './otel.ts'

/** The hook seam, injected by the CLI (collectSessionContext /
 *  collectPromptContext from commands/hooks.ts). Both return the
 *  context text or undefined — the proxy never learns what a connector
 *  is; it only knows a seam call may yield a text block. */
export interface AcpProxySeam {
  /** Session-start context — runs once per session on the first
   *  session/prompt whose collection SETTLES. `settled:false` means
   *  the probes timed out or errored: the partial text still rides
   *  that prompt (the hook emits partial output the same way), but
   *  the slot stays open and the next prompt retries; a settled run
   *  that crosses closes it. `cwd` is the session/new-supplied
   *  repo. */
  sessionContext?(
    cwd: string,
    sessionId: string
  ): Promise<{ text?: string; settled?: boolean } | undefined>
  /** Prompt-submit context — runs per prompt on the flattened text. */
  promptContext?(
    cwd: string,
    sessionId: string,
    prompt: string
  ): Promise<string | undefined>
}

export interface AcpProxyOptions {
  seam?: AcpProxySeam
  /** Diagnostics — stdout is the wire, so the proxy only ever logs to
   *  stderr. Defaults to console.error. */
  log?: (line: string) => void
}

/** One proxied ACP session — stamped when a session/new|load|fork
 *  response crosses with a session id. `cwd` is the client-supplied
 *  repo root every seam call and the turn plane resolve inside —
 *  undefined when the params carried none (load/resume/fork have no
 *  cwd field): the seam skips that session rather than probe the
 *  proxy's own cwd, which is never a substitute (spec bro-bhyo1). */
interface ProxySession {
  cwd: string | undefined
  /** A prompt has actually crossed downstream — set at write time
   *  inside the serialized writeQ, so "first prompt" means first to
   *  cross: a cancelled held prompt never claims the slot, and two
   *  queued prompts can't both take it. */
  seenPrompt: boolean
  /** Session-start context collection settled — true while no
   *  sessionContext seam exists, on a cwd-less session's first check,
   *  and after a settled collection (even an empty one). An UNSETTLED
   *  collection leaves it false so the next prompt retries — partial
   *  probe output is never presented as the session's start context. */
  sessionCtxDone: boolean
  /** session/prompt ids held in the writeQ — seam collection queued or
   *  in flight. A session/cancel answers exactly these upstream
   *  `stopReason:'cancelled'` and they never cross; a prompt already
   *  crossed keeps its pending entry so the agent's own answer still
   *  lands — answering a crossed prompt here would fork two responses
   *  for one wire id. */
  held: Set<JsonRpcId>
  /** Session-scoped c2a writes queue behind a pending injection so a
   *  following set_mode/cancel can't overtake the held prompt on the
   *  downstream wire. */
  writeQ: Promise<void>
  /** undefined when the session has no cwd — the plane resolves inside
   *  the session repo or doesn't exist. */
  plane: AgentTurnPlane | undefined
  span: OtelSpan | undefined
}

/** A request forwarded downstream that has not answered yet — on a
 *  dead agent the pending entries fail visibly, never vanish. */
interface PendingRequest {
  method: string
  /** session/prompt bookkeeping — the turn span and its session.
   *  `first` stamps at cross time (first prompt to actually write
   *  downstream) for the span's first_prompt attr. */
  prompt?: { sessionId: string; span: OtelSpan; first?: boolean }
  /** session/new|load|fork bookkeeping — the cwd/sessionId to stamp
   *  onto the response's session id. `cwd` stays undefined when the
   *  params carried none — never the proxy's own cwd. */
  bind?: { cwd: string | undefined; sessionId?: string }
  /** session/close bookkeeping — the session id to release on a
   *  successful close response. */
  close?: string
}

/** Latch — resolves once; the winner decides the proxy's verdict. */
function latch(): { promise: Promise<void>; fire: () => void; fired: boolean } {
  let resolve!: () => void
  const l = {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    fire: () => {
      if (!l.fired) {
        l.fired = true
        resolve()
      }
    },
    fired: false,
  }
  return l
}

/** The pump's view of a message — the wire object's own keys, no
 *  schema narrowing. `AnyMessage` is a typed union that doesn't index
 *  cleanly; the pump reads it as the record it actually is. */
interface Wire {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

const wire = (m: AnyMessage): Wire => m as Wire

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isRequest = (m: AnyMessage): boolean =>
  typeof wire(m).method === 'string' && wire(m).id !== undefined

const isNotification = (m: AnyMessage): boolean =>
  typeof wire(m).method === 'string' && wire(m).id === undefined

const isResponse = (m: AnyMessage): boolean =>
  wire(m).method === undefined && wire(m).id !== undefined

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const paramsOf = (m: AnyMessage): Record<string, unknown> | undefined => {
  const p = wire(m).params
  return isRecord(p) ? p : undefined
}

const sessionIdOf = (m: AnyMessage): string | undefined => str(paramsOf(m)?.['sessionId'])

/** Flatten a prompt's text blocks for the prompt-submit probes — the
 *  same join the fake agent does (`text` blocks concat, non-text
 *  contributes nothing — the probes read prompt text, not images). */
const promptText = (params: Record<string, unknown>): string =>
  (Array.isArray(params['prompt']) ? params['prompt'] : [])
    .map((b) => (isRecord(b) && b['type'] === 'text' ? str(b['text']) ?? '' : ''))
    .join('')

/**
 * The message pump — runs until either leg closes. Returns the process
 * exit code: 0 when the client ended the wire (clean), 1 when the
 * downstream agent died first (a dead agent is not a clean session).
 */
export async function acpProxy(
  upstream: Stream,
  downstream: Stream,
  opts: AcpProxyOptions = {}
): Promise<number> {
  const log = opts.log ?? ((line: string) => console.error(line))
  const sessions = new Map<string, ProxySession>()
  const pending = new Map<JsonRpcId, PendingRequest>()
  const downDead = latch()
  const upDead = latch()
  const downWriter = downstream.writable.getWriter()
  const upWriter = upstream.writable.getWriter()

  const writeDown = (m: AnyMessage): void => {
    downWriter.write(m).then(undefined, () => downDead.fire())
  }
  const writeUp = (m: AnyMessage): void => {
    upWriter.write(m).then(undefined, () => upDead.fire())
  }

  /** Answer an upstream request ourselves — only the held-prompt
   *  cancel path uses this; the proxy never synthesizes success. */
  const answerUpstream = (id: JsonRpcId, result: unknown): void => {
    writeUp({ jsonrpc: '2.0', id, result } as AnyMessage)
  }

  /** Session-scoped downstream writes queue through the session's
   *  writeQ so nothing overtakes a first prompt still collecting its
   *  injection. Non-session methods write immediately — a session id
   *  is the only ordering key the wire gives us. */
  const writeDownFor = (sessionId: string | undefined, m: AnyMessage): void => {
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (ses === undefined) {
      writeDown(m)
      return
    }
    ses.writeQ = ses.writeQ.then(() => {
      if (!downDead.fired) {
        writeDown(m)
      }
    })
  }

  /** One seam call — both seam legs are optional and fail-open: a
   *  throwing collector is an unsettled probe, never a dead prompt. A
   *  session without a cwd skips the seam entirely — the proxy's own
   *  cwd is not a fallback, it is a different repo. */
  const seamCall = async (
    fn:
      | ((cwd: string, sessionId: string, prompt: string) => Promise<string | undefined>)
      | undefined,
    session: ProxySession,
    sessionId: string,
    prompt: string
  ): Promise<string | undefined> => {
    if (fn === undefined || session.cwd === undefined) return undefined
    try {
      return (await fn(session.cwd, sessionId, prompt)) ?? undefined
    } catch {
      return undefined
    }
  }

  /** The sessionContext leg — same fail-open rule, but a throw is an
   *  UNSETTLED collection (retry next prompt) while a cwd-less session
   *  or absent seam settles immediately: nothing can ever collect. */
  const seamSessionCall = async (
    fn: AcpProxySeam['sessionContext'],
    session: ProxySession,
    sessionId: string
  ): Promise<{ text?: string; settled: boolean }> => {
    if (fn === undefined || session.cwd === undefined) return { settled: true }
    try {
      const r = await fn(session.cwd, sessionId)
      return { text: r?.text ?? undefined, settled: r?.settled ?? true }
    } catch {
      return { settled: false }
    }
  }

  /** The one rewrite the wire ever sees: while the session's start
   *  context is still owed, the session seam runs — an unsettled
   *  collection (timeout/error) contributes what it has, but the slot
   *  stays open so the next prompt retries; the slot closes only when
   *  a settled collection actually CROSSES downstream — the caller
   *  marks it at write time, so a prompt cancelled mid-collection
   *  doesn't lose the session's start context. An empty join injects
   *  nothing — byte-identical forwarding is the default. */
  const injectPrompt = async (
    m: AnyMessage,
    params: Record<string, unknown>,
    sessionId: string,
    ses: ProxySession
  ): Promise<{ m: AnyMessage; sessionCtxSettled: boolean }> => {
    const text = promptText(params)
    const [sessionCtx, promptCtx] = await Promise.all([
      ses.sessionCtxDone
        ? Promise.resolve<{ text?: string; settled: boolean }>({ settled: true })
        : seamSessionCall(opts.seam?.sessionContext, ses, sessionId),
      seamCall(opts.seam?.promptContext, ses, sessionId, text),
    ])
    // an unsettled collection still contributes what it has — the hook
    // emits partial output the same way — but the slot stays open so
    // the next prompt retries a full collection (the session's start
    // context closes only when a settled run crosses downstream)
    const combined = [sessionCtx.text, promptCtx]
      .filter((s) => s !== undefined && s !== '')
      .join('\n')
    if (combined === '') return { m, sessionCtxSettled: sessionCtx.settled }
    const blocks = Array.isArray(params['prompt']) ? params['prompt'] : []
    const block: ContentBlock = { type: 'text', text: combined }
    return {
      m: { ...m, params: { ...params, prompt: [block, ...blocks] } },
      sessionCtxSettled: sessionCtx.settled,
    }
  }

  /** c2a request — verbatim forward plus the session/prompt seam. */
  const onClientRequest = async (m: AnyMessage): Promise<void> => {
    const method = wire(m).method as string
    const id = wire(m).id as JsonRpcId
    const params = paramsOf(m)
    const sessionId = sessionIdOf(m)
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId)

    if (method === 'session/prompt' && sessionId !== undefined && ses !== undefined && params !== undefined) {
      const turn = otelSpan('acp.proxy.turn', {
        'acp.session': sessionId,
      }, { parent: ses.span?.ctx })
      pending.set(id, { method, prompt: { sessionId, span: turn } })
      // The injection is a held write — it must not stall the read
      // loop (session/cancel lands during collection), but it must not
      // be overtaken by later session writes either. `held` marks it
      // from enqueue until the write attempt — a per-prompt flag would
      // lose every prompt queued behind the first (the cancel path
      // aborts held prompts by deleting their pending entry).
      ses.held.add(id)
      ses.writeQ = ses.writeQ.then(async () => {
        try {
          // pending discharged → the cancel path already answered this
          // prompt upstream; it must not cross now. Checked twice —
          // the seam collection between them is the abortable window.
          if (!pending.has(id) || downDead.fired) {
            return
          }
          // "first prompt" = first to actually CROSS, decided here
          // under the serialized writeQ: a cancelled held prompt never
          // claims the slot, and two queued prompts can't both take it
          const first = !ses.seenPrompt
          const injected = await injectPrompt(m, params, sessionId, ses)
          if (!pending.has(id) || downDead.fired) {
            return
          }
          const p = pending.get(id)
          if (p?.prompt !== undefined) p.prompt.first = first
          ses.seenPrompt = true
          // a settled collection that crosses closes the slot; an
          // unsettled one stays owed — the next prompt retries
          ses.sessionCtxDone = ses.sessionCtxDone || injected.sessionCtxSettled
          ses.plane?.start()
          writeDown(injected.m)
        } finally {
          ses.held.delete(id)
        }
      })
      return
    }

    if (method === 'session/prompt') {
      // no stamped session — the client skipped session/new; forward
      // untouched, no seam (there is no cwd to probe inside)
      pending.set(id, { method })
      writeDown(m)
      return
    }

    const bind =
      method === 'session/new' ||
      method === 'session/load' ||
      method === 'session/fork' ||
      method === 'session/resume'
        ? { cwd: str(params?.['cwd']), sessionId: str(params?.['sessionId']) }
        : undefined
    const close = method === 'session/close' ? sessionId : undefined
    pending.set(id, {
      method,
      ...(bind !== undefined ? { bind } : {}),
      ...(close !== undefined ? { close } : {}),
    })
    writeDownFor(sessionId, m)
  }

  /** Answer every held prompt of the session upstream with
   *  `stopReason:'cancelled'` — held prompts never cross, so the wire
   *  never shows a prompt after its cancel/close. No plane events here:
   *  a held prompt never started a downstream turn (the plane's
   *  start/stop bookends only crossed work). Returns the abort count. */
  const abortHeld = (ses: ProxySession, sessionId: string): number => {
    let aborted = 0
    for (const [id, p] of pending) {
      const pr = p.prompt
      if (pr !== undefined && pr.sessionId === sessionId && ses.held.has(id)) {
        pending.delete(id)
        aborted++
        pr.span.end({ 'acp.stop_reason': 'cancelled' })
        answerUpstream(id, { stopReason: 'cancelled' })
      }
    }
    return aborted
  }

  /** Release a session — held prompts answered, state dropped, span
   *  ended, plane drained. Runs on a successful session/close response
   *  (a failed close leaves the session live — the close never took). */
  const releaseSession = (sessionId: string, ses: ProxySession): void => {
    abortHeld(ses, sessionId)
    sessions.delete(sessionId)
    ses.span?.end({ 'acp.proxy.close': true })
    void ses.plane?.drain().then(undefined, () => {})
  }

  /** c2a notification — verbatim; session/cancel first answers every
   *  held prompt of the session upstream `stopReason:'cancelled'`
   *  (held prompts never cross — the wire never shows a prompt after
   *  its cancel). The cancel itself crosses only while crossed work
   *  still runs downstream — it is session-scoped, so in-flight prompts
   *  are its real targets; a cancel whose whole target set was held
   *  prompts is fully handled by the proxy, and forwarding it would
   *  show a cancel without its prompt. */
  const onClientNotification = (m: AnyMessage): void => {
    if (wire(m).method === 'session/cancel') {
      const sessionId = sessionIdOf(m)
      const ses = sessionId === undefined ? undefined : sessions.get(sessionId)
      if (ses !== undefined && sessionId !== undefined) {
        const heldAborted = abortHeld(ses, sessionId)
        const inFlight = [...pending.values()].some(
          (p) => p.prompt?.sessionId === sessionId
        )
        if (heldAborted > 0 && !inFlight) {
          return
        }
      }
    }
    writeDownFor(sessionIdOf(m), m)
  }

  /** a2c notification — verbatim; session/update feeds the turn plane
   *  (hook probes never fire here — the seam maps to prompts only). */
  const onAgentNotification = (m: AnyMessage): void => {
    if (wire(m).method === 'session/update') {
      const sessionId = sessionIdOf(m)
      const update = paramsOf(m)?.['update']
      const ses = sessionId === undefined ? undefined : sessions.get(sessionId)
      if (ses !== undefined && update !== undefined) {
        try {
          ses.plane?.update(update as SessionUpdate)
        } catch {
          // telemetry is advisory — a malformed update must not cost the wire
        }
      }
    }
    writeUp(m)
  }

  /** a2c response — route verbatim; the bookkeeping it lands (session
   *  bind, turn span) rides on the pending entry it discharges. */
  const onAgentResponse = (m: AnyMessage): void => {
    const id = wire(m).id as JsonRpcId
    const req = pending.get(id)
    pending.delete(id)
    if (req?.bind !== undefined && wire(m).error === undefined) {
      const result = wire(m).result
      // the RESPONSE's sessionId wins — session/fork's params carry
      // the SOURCE id, the fork's own id only exists in the result.
      // load/resume responses may omit it → the request param is the
      // fallback. An error response stamps nothing — a failed open
      // must not register a session the next attempt would collide with.
      const sid =
        (isRecord(result) ? str(result['sessionId']) : undefined) ?? req.bind.sessionId
      if (sid !== undefined && !sessions.has(sid)) {
        const cwd = req.bind.cwd
        sessions.set(sid, {
          cwd,
          seenPrompt: false,
          sessionCtxDone: opts.seam?.sessionContext === undefined,
          held: new Set(),
          writeQ: Promise.resolve(),
          plane:
            cwd === undefined
              ? undefined
              : agentTurnPlane({
                  cwd,
                  by: 'acp proxy',
                  sessionId: sid,
                  plane: 'proxy',
                }),
          span: otelSpan('acp.proxy.session', { 'acp.session': sid }),
        })
      }
    }
    if (req?.close !== undefined && wire(m).error === undefined) {
      const ses = sessions.get(req.close)
      if (ses !== undefined) {
        releaseSession(req.close, ses)
      }
    }
    if (req?.prompt !== undefined) {
      const ses = sessions.get(req.prompt.sessionId)
      const result = wire(m).result
      const stopReason = isRecord(result) ? str(result['stopReason']) : undefined
      const failed = wire(m).error !== undefined
      req.prompt.span.end(
        {
          ...(req.prompt.first !== undefined
            ? { 'acp.proxy.first_prompt': req.prompt.first }
            : {}),
          ...(stopReason !== undefined ? { 'acp.stop_reason': stopReason } : {}),
          ...(failed ? { 'acp.error': true } : {}),
        },
        failed ? 'error' : 'ok'
      )
      ses?.plane?.stop(stopReason, failed ? { error: 'session/prompt error' } : {})
    }
    writeUp(m)
  }

  /** The client→agent leg — requests hold pending entries until the
   *  answer crosses; notifications pass through the cancel check. */
  const pumpC2A = async (): Promise<void> => {
    const reader = upstream.readable.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      const m = value
      try {
        if (isRequest(m)) {
          await onClientRequest(m)
        } else if (isNotification(m)) {
          onClientNotification(m)
        } else if (isResponse(m)) {
          writeDownFor(undefined, m)
        }
        // a malformed message is dropped, never answered — the proxy
        // is not a peer, it is the wire
      } catch (e) {
        log(`acp proxy: dropped c→a ${wire(m).method ?? 'message'}: ${(e as Error).message}`)
      }
    }
  }

  /** The agent→client leg — everything crosses untouched; only the
   *  bookkeeping that rides a response needs the pending table. */
  const pumpA2C = async (): Promise<void> => {
    const reader = downstream.readable.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      const m = value
      try {
        if (isNotification(m)) {
          onAgentNotification(m)
        } else if (isResponse(m)) {
          onAgentResponse(m)
        } else if (isRequest(m)) {
          writeUp(m)
        }
      } catch (e) {
        log(`acp proxy: dropped a→c ${wire(m).method ?? 'message'}: ${(e as Error).message}`)
      }
    }
  }

  const verdict = await Promise.race([
    pumpC2A().then(
      () => 'up' as const, // client closed its side of the wire
      () => 'up' as const
    ),
    pumpA2C().then(
      () => 'down' as const, // agent closed its side of the wire
      () => 'down' as const
    ),
    downDead.promise.then(() => 'down' as const),
    upDead.promise.then(() => 'up' as const),
  ])

  // downstream dead → every request still in flight fails visibly on
  // the upstream wire; a dead agent never silently eats a prompt
  if (verdict === 'down') {
    for (const [id, req] of pending) {
      pending.delete(id)
      req.prompt?.span.endDetached({ 'acp.error': 'downstream closed' }, 'error')
      writeUp({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'acp proxy: downstream agent closed' },
      } as AnyMessage)
    }
  }

  for (const ses of sessions.values()) {
    // endDetached — the process exits right after this return, an
    // in-flight fetch here never lands (spec bro-huy5o.11 §endDetached)
    ses.span?.endDetached({ 'acp.proxy.verdict': verdict })
    await ses.plane?.drain()
  }
  // both legs close — the writer locks release and the streams settle
  for (const w of [upWriter, downWriter]) {
    try {
      await w.close()
    } catch {
      /* already closed / broken pipe — teardown is best-effort */
    }
  }
  return verdict === 'up' ? 0 : 1
}

/**
 * The CLI entry — spawn `<cmd>`, wire the proxy's own stdio as the
 * upstream transport and the child's stdio as downstream, run the pump,
 * then reap. `command` is already tokenized (everything after `--`),
 * exec'd directly — never through a shell.
 */
export async function runAcpProxy(
  command: string[],
  opts: AcpProxyOptions = {}
): Promise<number> {
  const log = opts.log ?? ((line: string) => console.error(line))
  const bin = command[0]
  if (bin === undefined) {
    log('acp proxy: empty downstream command')
    return 2
  }
  const child: ChildProcess = spawn(bin, command.slice(1), {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: acpChildEnv(),
  })
  // a failed exec answers 'error' ASYNC — the stream wrap below must
  // not synchronously unwrap null stdio first, and the proxy must not
  // wait for the client's EOF to report a spawn that never happened:
  // the exit race ends the run with the downstream-dead verdict.
  const execFailed = new Promise<number>((resolve) => {
    child.once('error', (e) => {
      log(`acp proxy: cannot exec '${bin}' — ${e.message}`)
      resolve(1)
    })
  })
  if (child.stdin === null || child.stdout === null) {
    log(`acp proxy: cannot exec '${bin}' — no stdio pipes`)
    child.kill()
    return 1
  }
  const downstream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  )
  const upstream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  )
  const code = await Promise.race([acpProxy(upstream, downstream, opts), execFailed])
  // upstream end → close the agent; a wedged child still dies on the
  // process exit that follows
  try {
    child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  return code
}
