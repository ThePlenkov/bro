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
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  ActiveSession,
  AgentApp,
  AgentCapabilities,
  AuthMethod,
  ClientContext,
  ClientRequestHandler,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import { pumpTurn } from './acp.ts';
import { agentEventRecord } from './acp-events.ts';
import { otelHeader, otelSpan } from './otel.ts';

/** What the resolver computed for one spawn — self-contained, so the
 *  worker never re-reads bro.config.json mid-run. */
export interface AcpWorkerSpec {
  /** The rendered agent command (`entry.command` + `--profile`) —
   *  trusted config, exec'd via `sh -c` as the stdio peer. */
  command: string;
  /** The effective model — pinned via `session/set_config_option`
   *  looked up by category. Absent = the agent's own currentValue
   *  stands and provenance records it when reported. */
  model?: string;
  /** Permission policy: answer `session/request_permission` with the
   *  allow option. Default false — deny, and log the denial. */
  autoApprove?: boolean;
  /** The prepared prompt artifact — its text rides session/prompt. */
  promptFile: string;
  /** The session cwd — spec.repoRoot (the step's worktree). */
  cwd: string;
  /** Child env — default process.env, which already carries the
   *  caller's spec.env plus the connector's identity pins (the backend
   *  injected them on the driver, and the peer inherits them). */
  env?: Record<string, string | undefined>;
  /** The configured provider name — error text and the registry patch
   *  read it (the BRO_AGENT_PROVIDER pin, when spawned managed). */
  provider?: string;
  /** Registry provenance callback — the driver reports the real
   *  sessionId after session open and the agent-REPORTED model after
   *  set_config_option: provenance says what ran, not what was asked. */
  record?: (patch: { acpSessionId?: string; model?: string }) => void;
  /** Resume target — the agent-CLI session a previous worker recorded
   *  on this worktree (spec bro-5qsnr). The driver re-opens it via
   *  session/load (or session/resume where that's what the agent
   *  advertises) in the SAME cwd — sessions are cwd-keyed — and the
   *  prompt lands as a follow-up turn on the coder's own context.
   *  Every failure mode (no capability, gone session) falls back to
   *  session/new: a cold fixer is the floor, never a spawn failure. */
  resumeSessionId?: string;
  /** MCP servers to pass to session/new (opt-in per provider). */
  mcpServers?: unknown[];
  /** The in-process test seam — a fakeAcpAgent() app from
   *  `@broject/providers/testkit`, skipping the process spawn
   *  entirely. */
  peer?: AgentApp;
  /** Log sink — one rendered line per update plus driver's own lines.
   *  Default stdout, which the backend redirects into the .log. */
  log?: (line: string) => void;
  /** The agent's stderr — mirrored raw so provider walls (rate-limit/
   *  quota text) reach the .log for classifyExitCause. Default stderr
   *  (same fd as the log in every backend). */
  err?: (text: string) => void;
  /** Wire SIGTERM/SIGINT → session/cancel + grace-kill. Default true;
   *  tests running in-process pass false. */
  signals?: boolean;
  /** session/cancel → SIGKILL grace. Default 1500ms. */
  cancelGraceMs?: number;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Startup/config failures — bad handshake, interactive auth, a model
 *  the agent can't apply. Same honest-error class as acp.ts's
 *  AcpConfigError: name the refusal, never run unpinned. */
export class AcpWorkerError extends Error {
  override name = 'AcpWorkerError';
}

/** One rendered log line per session/update (spec step 6 — the .log
 *  stays the observability plane AND the exit-cause classifier's
 *  input). Text chunks render as bare text — the drain loop coalesces
 *  a same-kind run into one line; every other kind renders its
 *  discriminator plus a compact detail payload. */
export function renderAcpUpdate(u: SessionUpdate): string {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const c = (u as { content?: { type?: string; text?: string } }).content;
      return c?.type === 'text' ? (c.text ?? '') : `[${u.sessionUpdate}: ${c?.type ?? '?'}]`;
    }
    case 'tool_call': {
      const t = u as { title?: string; status?: string };
      return `tool_call ${t.title ?? '?'} (${t.status ?? '?'})`;
    }
    case 'tool_call_update': {
      const t = u as { toolCallId?: string; status?: string | null };
      return `tool_call_update ${t.toolCallId ?? '?'} (${t.status ?? '?'})`;
    }
    case 'config_option_update': {
      const t = u as { configOptions?: { id: string; currentValue?: unknown }[] };
      const names = (t.configOptions ?? [])
        .map(o => `${o.id}=${String(o.currentValue ?? '?')}`)
        .join(' ');
      return `config_option_update ${names}`;
    }
    case 'usage_update': {
      const t = u as { used?: unknown; size?: unknown };
      return `usage_update used=${String(t.used ?? '?')} size=${String(t.size ?? '?')}`;
    }
    default: {
      const { sessionUpdate: kind, ...rest } = u as Record<string, unknown>;
      const detail = JSON.stringify(rest);
      return detail === '{}' || detail === undefined
        ? String(kind)
        : `${String(kind)} ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`;
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate opt-in MCP descriptors before session/new. Start with stdio;
 *  HTTP/SSE/remote transports need negotiated capability the headless
 *  worker does not wire. Diagnostics must not echo env/header values. */
function validatedMcpServers(raw: unknown[] | undefined, by: string): unknown[] {
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  const out: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!isPlainObject(v)) {
      throw new AcpWorkerError(`${by}: mcpServers[${i}] must be an object descriptor`);
    }
    const t = typeof v.type === 'string' ? v.type : 'stdio';
    if (t !== 'stdio') {
      throw mcpTransportErr(t, i, by);
    }
    const dErr = stdioDescriptorErr(v, i, by);
    if (dErr !== undefined) {
      throw dErr;
    }
    out.push(v);
  }
  return out;
}

/** The non-stdio transports all fail here — HTTP-family ones carry the
 *  negotiated-capability remediation, unknown names the accepted shape. */
function mcpTransportErr(t: string, i: number, by: string): AcpWorkerError {
  if (t === 'http' || t === 'sse' || t === 'streamable-http') {
    return new AcpWorkerError(
      `${by}: mcpServers[${i}] uses transport '${t}' — HTTP/SSE MCP is only supported when the ACP session negotiates it; use a stdio descriptor for headless workers`
    );
  }
  return new AcpWorkerError(
    `${by}: mcpServers[${i}] has unsupported MCP transport '${t}' — use a stdio descriptor`
  );
}

/** A stdio descriptor is `{command, args, env?}` — session/new validates
 *  the same wire shape, but a missing or mistyped field dies there as an
 *  opaque session-start failure instead of naming the bad key. Values
 *  are never echoed into messages. */
function stdioDescriptorErr(
  v: Record<string, unknown>,
  i: number,
  by: string
): AcpWorkerError | undefined {
  if (typeof v.command !== 'string' || v.command === '') {
    return new AcpWorkerError(`${by}: mcpServers[${i}].command must be a non-empty string`);
  }
  if (!Array.isArray(v.args) || v.args.some(a => typeof a !== 'string')) {
    return new AcpWorkerError(`${by}: mcpServers[${i}].args must be an array of strings`);
  }
  return stdioEnvShapeErr(v, i, by);
}

/** A stdio descriptor's `env`, when present, is `[{name, value}]`
 *  string pairs — a numeric/bare value would fail obscurely inside
 *  session/new, so it is refused here with an index. Values are never
 *  echoed into the message. */
function stdioEnvShapeErr(
  v: Record<string, unknown>,
  i: number,
  by: string
): AcpWorkerError | undefined {
  if (v.env === undefined) {
    return undefined;
  }
  if (!Array.isArray(v.env)) {
    return new AcpWorkerError(
      `${by}: mcpServers[${i}].env must be an array of {name, value} pairs`
    );
  }
  for (let j = 0; j < v.env.length; j++) {
    const e = v.env[j];
    if (
      !isPlainObject(e) ||
      typeof e.name !== 'string' ||
      e.name === '' ||
      typeof e.value !== 'string'
    ) {
      return new AcpWorkerError(
        `${by}: mcpServers[${i}].env[${j}] must be a {name, value} string pair`
      );
    }
  }
  return undefined;
}

/** `session/request_permission` policy — the headless default-deny:
 *  reject when the agent offers one, cancel otherwise, and LOG the
 *  denial either way (a permissions-asking agent stalls visibly, not
 *  silently). `autoApprove` answers with the allow option; an agent
 *  offering no allow option still gets denied, not invented approval. */
function permissionHandler(
  autoApprove: boolean,
  provider: string | undefined,
  log: (line: string) => void,
  record?: (row: { sessionId: string; title: string; verdict: string }) => void
): ClientRequestHandler<RequestPermissionRequest, RequestPermissionResponse> {
  return ctx => {
    const opts = ctx.params.options ?? [];
    const what =
      ctx.params.toolCall?.title ?? ctx.params.toolCall?.toolCallId ?? 'permission request';
    const note = (verdict: string): void => {
      record?.({ sessionId: ctx.params.sessionId, title: String(what), verdict });
    };
    if (autoApprove) {
      const allow = opts.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
      if (allow !== undefined) {
        log(`permission ${what} — approved (autoApprove)`);
        note('approved');
        return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      }
      log(`permission ${what} — no allow option offered; denying`);
    } else {
      log(
        `permission ${what} — denied (headless default; opt in via providers.${
          provider ?? '<name>'
        }.autoApprove, --auto-approve, or the agent CLI's own flag)`
      );
    }
    const reject = opts.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');
    if (reject === undefined) note('cancelled');
    else note('denied');
    return {
      outcome:
        reject === undefined
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId: reject.optionId },
    };
  };
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
] as const;

/** The SDK's attach is runtime-public but type-private — the only way
 *  a loaded/resumed session gets the same update router + prompt pump
 *  a session/new answer builds. */
const attachSession = (ctx: ClientContext, response: NewSessionResponse): ActiveSession =>
  (ctx as unknown as { attachSession(r: NewSessionResponse): ActiveSession }).attachSession(
    response
  );

/** Session open (spec bro-5qsnr): a resume target becomes session/load
 *  — or session/resume where that's what the agent advertises — in the
 *  SAME cwd (sessions are cwd-keyed), and the prompt lands as a
 *  follow-up turn on the coder's own context. The load response omits
 *  `sessionId` (it IS the request's), so the attached
 *  `NewSessionResponse` is fabricated around it. Every failure mode —
 *  no advertised capability, a session the store no longer holds, an
 *  old PR's id — ends in the session/new a non-resumed worker always
 *  ran: a cold fixer is the floor, never a spawn failure. */
async function openSession(
  ctx: ClientContext,
  spec: AcpWorkerSpec,
  caps: AgentCapabilities | undefined,
  authMethods: AuthMethod[],
  mcpServers: unknown[],
  log: (line: string) => void,
  by: string
): Promise<ActiveSession> {
  const resumeId = spec.resumeSessionId;
  if (resumeId !== undefined) {
    const canLoad = caps?.loadSession === true;
    const canResume = caps?.sessionCapabilities?.resume != null;
    if (canLoad || canResume) {
      try {
        const res = canLoad
          ? await ctx.request('session/load', {
              sessionId: resumeId,
              cwd: spec.cwd,
              mcpServers: mcpServers as never,
            })
          : await ctx.request('session/resume', {
              sessionId: resumeId,
              cwd: spec.cwd,
              mcpServers: mcpServers as never,
            });
        log(`resumes session ${resumeId}`);
        return attachSession(ctx, {
          sessionId: resumeId,
          modes: res.modes,
          configOptions: res.configOptions,
        });
      } catch (err) {
        log(
          `session ${resumeId} resume failed — ${errMsg(err)}; starting a fresh session (mcpServers forwarded)`
        );
      }
    } else {
      log(
        `session ${resumeId} not resumable — no load/resume capability; starting a fresh session (mcpServers forwarded)`
      );
    }
  }
  return ctx
    .buildSession({ cwd: spec.cwd, mcpServers: mcpServers as never })
    .start()
    .catch((err: unknown) => {
      const hint = authMethods.length > 0 ? ` (${authMethods.map(m => m.id).join(', ')})` : '';
      throw new AcpWorkerError(`${by}: agent refused session${hint} — ${errMsg(err)}`);
    });
}

/** Run one ACP worker to turn end. Returns the driver's exit code —
 *  0 on `end_turn`, non-zero on everything else. Never throws: the
 *  caller maps the code to the `.exit` file, and every failure mode
 *  logs its own line first (the log IS the diagnosis surface). */
export async function runAcpWorker(spec: AcpWorkerSpec): Promise<number> {
  // Pin env-derived knobs at startup: BRO_WORKER_DRAIN_MS is read once,
  // not per turn. Invalid/unset values parse to undefined so drain() owns
  // the default and clamp; the worker's CI-sensitive longer bound (10s)
  // applies at this call site.
  const parsedDrainMs = Number(process.env.BRO_WORKER_DRAIN_MS);
  const envDrainMs =
    Number.isFinite(parsedDrainMs) && parsedDrainMs > 0 ? parsedDrainMs : undefined;
  const drainTimeoutMs = envDrainMs ?? 10_000;
  const log = spec.log ?? ((line: string) => console.log(line));
  const errOut = spec.err ?? ((text: string) => void process.stderr.write(text));
  const by = spec.provider === undefined ? 'acp' : `acp provider '${spec.provider}'`;

  // acp.open/acp.turn/acp.session spans (spec bro-xgejl.1) — the fleet
  // worker's trace leg: bro.cmd acp-worker → acp.open → acp.turn →
  // acp.session → acp.tool*, all under the agent.spawn parent the
  // spawn's TRACEPARENT env carried in. Ends are once-guarded — every
  // failure path lands exactly one terminal status.
  const openSpan = otelSpan('acp.open', { 'acp.by': by, 'acp.command': spec.command });
  let openEnded = false;
  const endOpen = (
    more: Record<string, string | number | boolean> = {},
    status: 'ok' | 'error' = 'ok'
  ): void => {
    if (openEnded) return;
    openEnded = true;
    openSpan.end(more, status);
  };

  const app = client({ name: 'bro' }).onRequest(
    'session/request_permission',
    permissionHandler(spec.autoApprove === true, spec.provider, log, r =>
      // the ask never reaches a session/update consumer — the archive
      // row is the pane's blocked signal (spec bro-l8wqu)
      agentEventRecord(spec.cwd, r.sessionId, by, {
        kind: 'permission',
        title: r.title,
        verdict: r.verdict,
      })
    )
  );
  for (const m of UNADVERTISED_METHODS) {
    app.onRequest<unknown, never>(
      m,
      p => p,
      (): never => {
        log(`unadvertised agent→client call ${m} — method-not-found`);
        throw RequestError.methodNotFound(m);
      }
    );
  }

  let child: ChildProcess | undefined;
  // signal scope: filled by the op once the session exists — a signal
  // before session/new has nothing to cancel and just kills the child
  let cx: ClientContext | undefined;
  let sessionId: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = spec.cancelGraceMs ?? 1500;
  const onSignal = (sig: 'SIGTERM' | 'SIGINT'): void => {
    log(`${sig} — sending session/cancel (${grace}ms grace)`);
    if (cx !== undefined && sessionId !== undefined) {
      void cx.notify('session/cancel', { sessionId }).catch(() => {});
    }
    if (killTimer === undefined) {
      killTimer = setTimeout(() => {
        // `child` is read at fire time — a signal that lands in the
        // spawn window still stops the process it was meant for once
        // grace elapses; nothing spawned (the peer seam) means the
        // signal's only remaining stop is the driver itself
        if (child !== undefined) {
          child.kill('SIGKILL');
        } else {
          process.exit(1);
        }
      }, grace);
      killTimer.unref();
    }
  };
  const wireSignals = spec.signals !== false;
  if (wireSignals) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  const op = async (ctx: ClientContext): Promise<number> => {
    cx = ctx;
    const init = await ctx
      .request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'bro', version: '1' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })
      .catch((err: unknown) => {
        endOpen({ error: errMsg(err) }, 'error');
        throw err;
      });
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      endOpen({ error: `protocol ${init.protocolVersion}` }, 'error');
      throw new AcpWorkerError(
        `${by}: agent negotiated protocol ${init.protocolVersion} — the driver speaks v${PROTOCOL_VERSION} only`
      );
    }
    // authMethods is an OFFER, not a requirement (same policy as the
    // acp judge call): an agent with stored credentials still advertises
    // its login methods — only an actual refusal at session/new names
    // auth as required
    const authMethods = init.authMethods ?? [];
    // open is established — its children (the agent child's hook
    // descendants) parent under it via the TRACEPARENT pinned into the
    // spawn env below. acp.session/acp.turn nest one level under open;
    // session id lands on both once session/new answers (spec
    // bro-xgejl.1)
    endOpen({ 'acp.pid': child?.pid ?? 0 });
    const turnSpan = otelSpan(
      'acp.turn',
      { 'acp.by': by, 'acp.requested_model': spec.model ?? '' },
      { parent: openSpan.ctx }
    );
    const sessSpan = otelSpan('acp.session', { 'acp.by': by }, { parent: turnSpan.ctx });
    let sessEnded = false;
    let turnEnded = false;
    const endSess = (
      more: Record<string, string | number | boolean> = {},
      status: 'ok' | 'error' = 'ok'
    ): void => {
      if (sessEnded) return;
      sessEnded = true;
      sessSpan.end(more, status);
    };
    const endTurn = (
      more: Record<string, string | number | boolean> = {},
      status: 'ok' | 'error' = 'ok'
    ): void => {
      if (turnEnded) return;
      turnEnded = true;
      turnSpan.end(more, status);
    };
    let reportedModel: string | undefined;
    let mcpServers: unknown[];
    try {
      mcpServers = validatedMcpServers(
        Array.isArray(spec.mcpServers) ? spec.mcpServers : undefined,
        by
      );
    } catch (err) {
      endSess({ error: errMsg(err) }, 'error');
      endTurn({ error: errMsg(err) }, 'error');
      throw err;
    }
    // openSession owns the resume-or-new decision (bro-5qsnr); a throw
    // here means no session ever attached — the spans end error
    const session = await openSession(
      ctx,
      spec,
      init.agentCapabilities,
      authMethods,
      mcpServers,
      log,
      by
    ).catch((err: unknown) => {
      endSess({ error: errMsg(err) }, 'error');
      endTurn({ error: errMsg(err) }, 'error');
      throw err;
    });
    sessionId = session.sessionId;
    spec.record?.({ acpSessionId: session.sessionId });
    log(`session ${session.sessionId} (cwd ${spec.cwd})`);
    try {
      // model — by category, never a hardcoded configId; a requested
      // model the agent can't apply fails the spawn, and provenance
      // records the REPORTED value either way
      const modelOpt = (session.newSessionResponse.configOptions ?? []).find(
        o => o.category === 'model'
      );
      if (spec.model !== undefined) {
        if (modelOpt === undefined) {
          throw new AcpWorkerError(
            `${by}: model '${spec.model}' requested but the acp agent advertises no model config option — refusing to run an unpinned model`
          );
        }
        const res = await ctx
          .request('session/set_config_option', {
            sessionId: session.sessionId,
            configId: modelOpt.id,
            value: spec.model,
          })
          .catch((err: unknown) => {
            throw new AcpWorkerError(`${by}: agent refused model '${spec.model}' — ${errMsg(err)}`);
          });
        const served = res.configOptions?.find(o => o.id === modelOpt.id)?.currentValue;
        const reported = typeof served === 'string' ? served : spec.model;
        reportedModel = reported;
        spec.record?.({ model: reported });
        log(`model ${reported}`);
      } else {
        const cur = modelOpt?.currentValue;
        if (typeof cur === 'string') {
          reportedModel = cur;
          spec.record?.({ model: cur });
          log(`model ${cur} (agent default)`);
        }
      }
      const promptText = readFileSync(spec.promptFile, 'utf8');
      // the shared pump IS the turn (bro-0ppt0): draining to `stop`
      // keeps every notification on the .log in arrival order, and
      // the same updates publish onto the 'agent' bus topic + the
      // .events.jsonl archive at the pumpTurn chokepoint — one seam,
      // no worker-local wire shapes. The worker's error mapping lives
      // in the outer catch; the pump's own failures classify plainly.
      // chunk updates stream token-level — the log sink accumulates a
      // same-kind run and flushes it as one line before the next update
      // kind renders, so the .log carries a sentence, not a line per
      // delta (bro-dojl5's buffering, kept on the sink side of pumpTurn)
      let buf: { kind: string; text: string } | undefined;
      const flush = (): void => {
        if (buf !== undefined && buf.text !== '') {
          log(buf.text);
        }
        buf = undefined;
      };
      const onUpdate = (u: SessionUpdate): void => {
        const kind = u.sessionUpdate;
        const isChunk = kind === 'agent_message_chunk' || kind === 'agent_thought_chunk';
        if (isChunk && buf?.kind === kind) {
          buf.text += renderAcpUpdate(u);
          return;
        }
        flush();
        if (isChunk) {
          buf = { kind, text: renderAcpUpdate(u) };
        } else {
          log(renderAcpUpdate(u));
        }
      };
      const r = await pumpTurn(
        session,
        promptText,
        onUpdate,
        (err: unknown): never => {
          throw err;
        },
        () => ({}),
        undefined,
        by,
        sessSpan.ctx,
        spec.cwd,
        drainTimeoutMs
      ).finally(flush);
      log(`turn stopped — ${r.stopReason}`);
      endSess({ 'acp.session_id': session.sessionId });
      endTurn({
        'acp.session_id': session.sessionId,
        ...(reportedModel === undefined ? {} : { 'acp.model': reportedModel }),
        'acp.stop_reason': r.stopReason,
        'acp.reply_len': r.text.length,
      });
      return r.stopReason === 'end_turn' ? 0 : 1;
    } catch (err) {
      endSess({ 'acp.session_id': session.sessionId, error: errMsg(err) }, 'error');
      endTurn(
        {
          'acp.session_id': session.sessionId,
          ...(reportedModel === undefined ? {} : { 'acp.model': reportedModel }),
          error: errMsg(err),
        },
        'error'
      );
      throw err;
    } finally {
      session.dispose();
    }
  };

  try {
    if (spec.peer !== undefined) {
      return await app.connectWith(spec.peer, op);
    }
    const proc = spawn(
      'sh', // NOSONAR — PATH lookup is the contract (same as git/bd everywhere)
      ['-c', spec.command],
      {
        // NOSONAR — operator-authored config string; the trust contract
        // loop.agent/agents.*.command already carry. Only DATA is
        // forbidden from the shell — everything else rides argv/params.
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...spec.env,
          // the agent child's own hook descendants parent under
          // acp.open — same injection the fleet spawn sites perform
          // (spec bro-xgejl.1)
          TRACEPARENT: otelHeader(openSpan.ctx),
        },
        // stdin is the request channel — 'ignore' would leave
        // proc.stdin null and the driver dead before initialize
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    child = proc;
    // provider walls print on the agent's stderr — mirror them so the
    // .log tail still classifies rate_limit/quota, not 'crash'
    let errBuf = '';
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      errBuf = (errBuf + text).slice(-4096);
      errOut(text);
    });
    const stderr = (): string => errBuf.trim();
    try {
      return await app.connectWith(
        ndJsonStream(
          Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
          Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>
        ),
        op
      );
    } catch (err) {
      const tail = stderr();
      throw new AcpWorkerError(
        `${by} unavailable — ${errMsg(err)}${tail === '' ? '' : ` (${tail})`}`
      );
    }
  } catch (err) {
    // covers connectWith/transport failures op never reached —
    // initialize/protocol/refusal paths already ended their spans
    endOpen({ error: errMsg(err) }, 'error');
    log(`acp-worker failed — ${errMsg(err)}`);
    return 1;
  } finally {
    if (wireSignals) {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    }
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    await retireAgentChild(child);
  }
}

/** Graceful reap — SIGKILL orphans the agent's forked children and
 *  leaves its session 'open' in the CLI's session store, so a TERM
 *  grace window precedes the kill. */
async function retireAgentChild(child: ChildProcess | undefined): Promise<void> {
  child?.kill('SIGTERM');
  if (child === undefined) {
    return;
  }
  const exited = await new Promise<boolean>(res => {
    child.once('exit', () => res(true));
    setTimeout(() => res(false), 3000);
  });
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise<void>(res => {
      child.once('exit', res);
      setTimeout(res, 2000);
    });
  }
}

export type { StopReason };
