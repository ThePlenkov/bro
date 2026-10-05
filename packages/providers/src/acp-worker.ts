/**
 * The `acp` provider's spawn surface — the fleet worker driver (spec
 * bro-5hx1.1 §driver). `bro acp-worker --command '<entry.command>'
 * [--model <m>] [--auto-approve] <promptFile>` runs ONE ACP v1 session
 * over the agent CLI's stdio:
 *
 *   spawn(sh -c command) → initialize(v1, fs/terminal unadvertised)
 *   → session/new → session/set_config_option(category:'model') →
 *   session/prompt → session/update notifications → the .log.
 *
 * The driver IS the registered worker — one liveness story: the
 * backend detaches the driver, `agents down` group-signals it, and the
 * agent process dies in the driver's group. SIGTERM/SIGINT on the
 * driver become `session/cancel` plus a short grace, then the child
 * dies — cancellation is the courtesy, the process group is the
 * backstop. Turn end maps `stopReason` to the exit code: `end_turn`
 * is 0, everything else (max_tokens, refused, cancelled, transport
 * death, handshake failure) is non-zero — the wrapper writes `.exit`,
 * the log tail feeds classifyExitCause.
 *
 * Trust boundary (spec-pinned): `command` is operator-authored config
 * — the same trusted-code contract `loop.agent` carries — so it meets
 * `sh -c` verbatim. What never meets the shell is DATA: the model, the
 * prompt text, and every runtime value ride argv slots / protocol
 * params, never string-concatenation.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import type {
  AgentApp,
  ClientContext,
  ClientRequestHandler,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk'

/** What the resolver computed for one spawn — self-contained, so the
 *  worker never re-reads bro.config.json mid-run. */
export interface AcpWorkerSpec {
  /** The rendered agent command (`entry.command` + `--profile`) —
   *  trusted config, exec'd via `sh -c` as the stdio peer. */
  command: string
  /** The effective model — pinned via `session/set_config_option`
   *  looked up by category. Absent = the agent's own currentValue
   *  stands and provenance records it when reported. */
  model?: string
  /** Permission policy: answer `session/request_permission` with the
   *  allow option. Default false — deny, and log the denial. */
  autoApprove?: boolean
  /** The prepared prompt artifact — its text rides session/prompt. */
  promptFile: string
  /** The session cwd — spec.repoRoot (the step's worktree). */
  cwd: string
  /** Child env — default process.env, which already carries the
   *  caller's spec.env plus the connector's identity pins (the backend
   *  injected them on the driver, and the peer inherits them). */
  env?: Record<string, string | undefined>
  /** The configured provider name — error text and the registry patch
   *  read it (the BRO_AGENT_PROVIDER pin, when spawned managed). */
  provider?: string
  /** Registry provenance callback — the driver reports the real
   *  sessionId after session/new and the agent-REPORTED model after
   *  set_config_option: provenance says what ran, not what was asked. */
  record?: (patch: { acpSessionId?: string; model?: string }) => void
  /** The in-process test seam — a fakeAcpAgent() app, skipping the
   *  process spawn entirely. */
  peer?: AgentApp
  /** Log sink — one rendered line per update plus driver's own lines.
   *  Default stdout, which the backend redirects into the .log. */
  log?: (line: string) => void
  /** The agent's stderr — mirrored raw so provider walls (rate-limit/
   *  quota text) reach the .log for classifyExitCause. Default stderr
   *  (same fd as the log in every backend). */
  err?: (text: string) => void
  /** Wire SIGTERM/SIGINT → session/cancel + grace-kill. Default true;
   *  tests running in-process pass false. */
  signals?: boolean
  /** session/cancel → SIGKILL grace. Default 1500ms. */
  cancelGraceMs?: number
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** Startup/config failures — bad handshake, interactive auth, a model
 *  the agent can't apply. Same honest-error class as acp.ts's
 *  AcpConfigError: name the refusal, never run unpinned. */
export class AcpWorkerError extends Error {
  override name = 'AcpWorkerError'
}

/** One rendered log line per session/update (spec step 6 — the .log
 *  stays the observability plane AND the exit-cause classifier's
 *  input). Text chunks render as text; every other kind renders its
 *  discriminator plus a compact detail payload. */
export function renderAcpUpdate(u: SessionUpdate): string {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const c = (u as { content?: { type?: string; text?: string } }).content
      return c?.type === 'text'
        ? c.text ?? ''
        : `[${u.sessionUpdate}: ${c?.type ?? '?'}]`
    }
    case 'tool_call': {
      const t = u as { title?: string; status?: string }
      return `tool_call ${t.title ?? '?'} (${t.status ?? '?'})`
    }
    case 'tool_call_update': {
      const t = u as { toolCallId?: string; status?: string | null }
      return `tool_call_update ${t.toolCallId ?? '?'} (${t.status ?? '?'})`
    }
    case 'config_option_update': {
      const t = u as { configOptions?: { id: string; currentValue?: unknown }[] }
      const names = (t.configOptions ?? [])
        .map((o) => `${o.id}=${String(o.currentValue ?? '?')}`)
        .join(' ')
      return `config_option_update ${names}`
    }
    case 'usage_update': {
      const t = u as { used?: unknown; size?: unknown }
      return `usage_update used=${String(t.used ?? '?')} size=${String(t.size ?? '?')}`
    }
    default: {
      const { sessionUpdate: kind, ...rest } = u as Record<string, unknown>
      const detail = JSON.stringify(rest)
      return detail === '{}' || detail === undefined
        ? String(kind)
        : `${String(kind)} ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`
    }
  }
}

/** `session/request_permission` policy — the headless default-deny:
 *  reject when the agent offers one, cancel otherwise, and LOG the
 *  denial either way (a permissions-asking agent stalls visibly, not
 *  silently). `autoApprove` answers with the allow option; an agent
 *  offering no allow option still gets denied, not invented approval. */
function permissionHandler(
  autoApprove: boolean,
  provider: string | undefined,
  log: (line: string) => void
): ClientRequestHandler<RequestPermissionRequest, RequestPermissionResponse> {
  return (ctx) => {
    const opts = ctx.params.options ?? []
    const what =
      ctx.params.toolCall?.title ?? ctx.params.toolCall?.toolCallId ?? 'permission request'
    if (autoApprove) {
      const allow = opts.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
      if (allow !== undefined) {
        log(`permission ${what} — approved (autoApprove)`)
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
      log(`permission ${what} — no allow option offered; denying`)
    } else {
      log(
        `permission ${what} — denied (headless default; opt in via providers.${
          provider ?? '<name>'
        }.autoApprove, --auto-approve, or the agent CLI's own flag)`
      )
    }
    const reject = opts.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')
    return {
      outcome:
        reject === undefined
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId: reject.optionId },
    }
  }
}

/** Agent→client service methods v1 does not advertise (fs, terminal,
 *  elicitation, MCP relay) — spec step 8: registered handlers LOG the
 *  attempt and answer method-not-found; capability honesty beats
 *  partial emulation. */
const UNADVERTISED_METHODS = [
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/release',
  'terminal/wait_for_exit',
  'terminal/kill',
  'elicitation/create',
  'mcp/message',
] as const

/** Run one ACP worker to turn end. Returns the driver's exit code —
 *  0 on `end_turn`, non-zero on everything else. Never throws: the
 *  caller maps the code to the `.exit` file, and every failure mode
 *  logs its own line first (the log IS the diagnosis surface). */
export async function runAcpWorker(spec: AcpWorkerSpec): Promise<number> {
  const log = spec.log ?? ((line: string) => console.log(line))
  const errOut = spec.err ?? ((text: string) => void process.stderr.write(text))
  const by = spec.provider === undefined ? 'acp' : `acp provider '${spec.provider}'`

  const app = client({ name: 'bro' }).onRequest(
    'session/request_permission',
    permissionHandler(spec.autoApprove === true, spec.provider, log)
  )
  for (const m of UNADVERTISED_METHODS) {
    app.onRequest<unknown, never>(
      m,
      (p) => p,
      (): never => {
        log(`unadvertised agent→client call ${m} — method-not-found`)
        throw RequestError.methodNotFound(m)
      }
    )
  }

  let child: ChildProcess | undefined
  // signal scope: filled by the op once the session exists — a signal
  // before session/new has nothing to cancel and just kills the child
  let cx: ClientContext | undefined
  let sessionId: string | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const grace = spec.cancelGraceMs ?? 1500
  const onSignal = (sig: 'SIGTERM' | 'SIGINT'): void => {
    log(`${sig} — sending session/cancel (${grace}ms grace)`)
    if (cx !== undefined && sessionId !== undefined) {
      void cx.notify('session/cancel', { sessionId }).catch(() => {})
    }
    if (killTimer === undefined) {
      killTimer = setTimeout(() => {
        // `child` is read at fire time — a signal that lands in the
        // spawn window still stops the process it was meant for once
        // grace elapses; nothing spawned (the peer seam) means the
        // signal's only remaining stop is the driver itself
        if (child !== undefined) {
          child.kill('SIGKILL')
        } else {
          process.exit(1)
        }
      }, grace)
      killTimer.unref()
    }
  }
  const wireSignals = spec.signals !== false
  if (wireSignals) {
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  }

  const op = async (ctx: ClientContext): Promise<number> => {
    cx = ctx
    const init = await ctx.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'bro', version: '1' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpWorkerError(
        `${by}: agent negotiated protocol ${init.protocolVersion} — the driver speaks v${PROTOCOL_VERSION} only`
      )
    }
    const authMethods = init.authMethods ?? []
    if (authMethods.length > 0) {
      throw new AcpWorkerError(
        `${by}: agent requires interactive auth (${authMethods
          .map((m) => m.id)
          .join(', ')}) — a detached worker cannot log in; authenticate the agent CLI itself`
      )
    }
    const session = await ctx
      .buildSession({ cwd: spec.cwd, mcpServers: [] })
      .start()
    sessionId = session.sessionId
    spec.record?.({ acpSessionId: session.sessionId })
    log(`session ${session.sessionId} (cwd ${spec.cwd})`)
    try {
      // model — by category, never a hardcoded configId; a requested
      // model the agent can't apply fails the spawn, and provenance
      // records the REPORTED value either way
      const modelOpt = (session.newSessionResponse.configOptions ?? []).find(
        (o) => o.category === 'model'
      )
      if (spec.model !== undefined) {
        if (modelOpt === undefined) {
          throw new AcpWorkerError(
            `${by}: model '${spec.model}' requested but the acp agent advertises no model config option — refusing to run an unpinned model`
          )
        }
        const res = await ctx
          .request('session/set_config_option', {
            sessionId: session.sessionId,
            configId: modelOpt.id,
            value: spec.model,
          })
          .catch((err: unknown) => {
            throw new AcpWorkerError(
              `${by}: agent refused model '${spec.model}' — ${errMsg(err)}`
            )
          })
        const served = res.configOptions?.find((o) => o.id === modelOpt.id)?.currentValue
        const reported = typeof served === 'string' ? served : spec.model
        spec.record?.({ model: reported })
        log(`model ${reported}`)
      } else {
        const cur = modelOpt?.currentValue
        if (typeof cur === 'string') {
          spec.record?.({ model: cur })
          log(`model ${cur} (agent default)`)
        }
      }
      const promptText = readFileSync(spec.promptFile, 'utf8')
      // the stop lands in the update queue with the same response —
      // draining to `stop` IS awaiting the turn, and keeps every
      // notification on the log in arrival order
      const drain = async (): Promise<PromptResponse> => {
        for (;;) {
          const m = await session.nextUpdate()
          if (m.kind === 'stop') {
            return m.response
          }
          log(renderAcpUpdate(m.update))
        }
      }
      const [resp] = await Promise.all([session.prompt(promptText), drain()])
      log(`turn stopped — ${resp.stopReason}`)
      return resp.stopReason === 'end_turn' ? 0 : 1
    } finally {
      session.dispose()
    }
  }

  try {
    if (spec.peer !== undefined) {
      return await app.connectWith(spec.peer, op)
    }
    const proc = spawn(
      'sh', // NOSONAR — PATH lookup is the contract (same as git/bd everywhere)
      ['-c', spec.command],
      {
        // NOSONAR — operator-authored config string; the trust contract
        // loop.agent/agents.*.command already carry. Only DATA is
        // forbidden from the shell — everything else rides argv/params.
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    child = proc
    // provider walls print on the agent's stderr — mirror them so the
    // .log tail still classifies rate_limit/quota, not 'crash'
    let errBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString()
      errBuf = (errBuf + text).slice(-4096)
      errOut(text)
    })
    const stderr = (): string => errBuf.trim()
    try {
      return await app.connectWith(
        ndJsonStream(
          Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
          Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>
        ),
        op
      )
    } catch (err) {
      const tail = stderr()
      throw new AcpWorkerError(
        `${by} unavailable — ${errMsg(err)}${tail === '' ? '' : ` (${tail})`}`
      )
    }
  } catch (err) {
    log(`acp-worker failed — ${errMsg(err)}`)
    return 1
  } finally {
    if (wireSignals) {
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGINT', onSignal)
    }
    if (killTimer !== undefined) {
      clearTimeout(killTimer)
    }
    child?.kill('SIGKILL')
  }
}

export type { StopReason }
