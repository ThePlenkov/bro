/**
 * `bro acp proxy -- <agent cmd>` — the cascading ACP edge (specs
 * bro-rs8sp.md §decision, bro-bhyo1.md, bro-u2eps.md, bro-9qopj.md).
 * bro is the ACP agent to the client on its own stdin/stdout and the
 * ACP client to the spawned downstream — verbatim forwarding by
 * default, with the hook seam injected into the session's first
 * `session/prompt`, the tool-call arming/guard pass on
 * `session/update`, the stop gate holding a `session/prompt` response
 * at turn end, and the permission policy deciding
 * `session/request_permission` at the one seam every client shares.
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

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  AnyMessage,
  ContentBlock,
  JsonRpcId,
  SessionUpdate,
  Stream,
} from '@agentclientprotocol/sdk';
import { acpChildEnv } from './acp.ts';
import { agentTurnPlane, type AgentTurnPlane } from './acp-events.ts';
import { otelSpan, type OtelSpan } from './otel.ts';

/** One observed tool call, as the session/update stream reports it —
 *  `phase:'start'` is the `tool_call` announce, `phase:'end'` the
 *  terminal `tool_call_update` (status completed|failed). `input` is
 *  the call's `rawInput` verbatim — the seam's classifier pulls
 *  `command`/`file_path`/`files` out of it, exactly like a hook's
 *  `tool_input`. */
export interface AcpProxyToolCall {
  phase: 'start' | 'end';
  toolCallId: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
}

/** One agent→client `session/request_permission`, normalized like
 *  AcpProxyToolCall — the proxy hands the wire's `toolCall` fields over
 *  verbatim and the seam reads the hook-shaped parts out (`input` is
 *  `rawInput`, the `tool_input` analog the classifier pulls `command`/
 *  `file_path`/`files` out of — spec bro-9qopj). */
export interface AcpProxyPermissionCall {
  toolCallId: string;
  name?: string;
  title?: string;
  kind?: string;
  input?: unknown;
}

/** The seam's verdict on a permission ask — the PermissionRequest
 *  hook's three outcomes mapped onto the wire (spec bro-rs8sp's
 *  permission row): `allow`/`deny` answer downstream without the
 *  client ever seeing the ask; `ask` (or an absent/throwing leg)
 *  forwards it verbatim. `reason` journals the why — a deny's
 *  block/cap-refusal text — and `hints` buffer onto the next crossed
 *  prompt like toolCall's say lines (guard `warn` verdicts ride
 *  there). */
export interface AcpProxyPermissionVerdict {
  verdict: 'allow' | 'deny' | 'ask';
  reason?: string;
  hints?: string[];
}

/** The hook seam, injected by the CLI (collectSessionContext /
 *  collectPromptContext / collectToolCallGuards / collectStopGate from
 *  commands/hooks.ts). Both return the context text or undefined — the
 *  proxy never learns what a connector is; it only knows a seam call
 *  may yield a text block. */
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
  ): Promise<{ text?: string; settled?: boolean } | undefined>;
  /** Prompt-submit context — runs per prompt on the flattened text. */
  promptContext?(cwd: string, sessionId: string, prompt: string): Promise<string | undefined>;
  /** Per-tool-call hook channel — the in-process equivalent of the
   *  PostToolUse event (session-marker arming + guard defs, spec
   *  bro-u2eps). Returned lines are advisory text the proxy buffers
   *  onto the next crossed prompt — the seam that already carries
   *  advisory text, never a fabricated wire message. */
  toolCall?(cwd: string, sessionId: string, call: AcpProxyToolCall): Promise<string[] | undefined>;
  /** Turn-end stop gate — evaluated when a session/prompt response
   *  lands, before it crosses upstream. `block` holds the response and
   *  sends exactly one gate re-prompt (the held response never crosses;
   *  the gate turn's own response answers the client — the client's
   *  request resolves once, with the final turn's verdict). `hints`
   *  ride the next crossed prompt as advisory text. A throw is
   *  fail-open: the held response forwards verbatim. */
  stopGate?(
    cwd: string,
    sessionId: string
  ): Promise<{ block?: string; hints?: string[] } | undefined>;
  /** Permission policy — the in-process equivalent of the
   *  PermissionRequest hook (spec bro-9qopj): evaluate once per
   *  `session/request_permission`, return the verdict the proxy maps
   *  onto the wire. Fail-open like every seam leg: absent, throwing,
   *  or 'ask' forwards the ask to the client verbatim. */
  permission?(
    cwd: string,
    sessionId: string,
    call: AcpProxyPermissionCall
  ): Promise<AcpProxyPermissionVerdict | undefined>;
}

export interface AcpProxyOptions {
  seam?: AcpProxySeam;
  /** Diagnostics — stdout is the wire, so the proxy only ever logs to
   *  stderr. Defaults to console.error. */
  log?: (line: string) => void;
}

/** One proxied ACP session — stamped when a session/new|load|fork
 *  response crosses with a session id. `cwd` is the client-supplied
 *  repo root every seam call and the turn plane resolve inside —
 *  undefined when the params carried none (load/resume/fork have no
 *  cwd field): the seam skips that session rather than probe the
 *  proxy's own cwd, which is never a substitute (spec bro-bhyo1). */
interface ProxySession {
  cwd: string | undefined;
  /** A prompt has actually crossed downstream — set at write time
   *  inside the serialized writeQ, so "first prompt" means first to
   *  cross: a cancelled held prompt never claims the slot, and two
   *  queued prompts can't both take it. */
  seenPrompt: boolean;
  /** Session-start context collection settled — true while no
   *  sessionContext seam exists, on a cwd-less session's first check,
   *  and after a settled collection (even an empty one). An UNSETTLED
   *  collection leaves it false so the next prompt retries — partial
   *  probe output is never presented as the session's start context. */
  sessionCtxDone: boolean;
  /** session/prompt ids held in the writeQ — seam collection queued or
   *  in flight. A session/cancel answers exactly these upstream
   *  `stopReason:'cancelled'` and they never cross; a prompt already
   *  crossed keeps its pending entry so the agent's own answer still
   *  lands — answering a crossed prompt here would fork two responses
   *  for one wire id. */
  held: Set<JsonRpcId>;
  /** Session-scoped c2a writes queue behind a pending injection so a
   *  following set_mode/cancel can't overtake the held prompt on the
   *  downstream wire. Tool-call evals and stop-gate evals chain here
   *  too — they are session-scoped work whose writes (the gate
   *  re-prompt) must keep wire order with the client's own prompts. */
  writeQ: Promise<void>;
  /** Advisory lines owed to the agent — guard `say` output and
   *  stop-gate hints. Drained into the next crossed prompt (a client
   *  prompt or the gate re-prompt) as prepended text blocks: the one
   *  seam the wire already has for advisory text. */
  advisory: string[];
  /** undefined when the session has no cwd — the plane resolves inside
   *  the session repo or doesn't exist. */
  plane: AgentTurnPlane | undefined;
  span: OtelSpan | undefined;
}

/** A request forwarded downstream that has not answered yet — on a
 *  dead agent the pending entries fail visibly, never vanish. */
interface PendingRequest {
  method: string;
  /** session/prompt bookkeeping — the turn span and its session.
   *  `first` stamps at cross time (first prompt to actually write
   *  downstream) for the span's first_prompt attr. */
  prompt?: { sessionId: string; span: OtelSpan; first?: boolean };
  /** session/new|load|fork bookkeeping — the cwd/sessionId to stamp
   *  onto the response's session id. `cwd` stays undefined when the
   *  params carried none — never the proxy's own cwd. */
  bind?: { cwd: string | undefined; sessionId?: string };
  /** session/close bookkeeping — the session id to release on a
   *  successful close response. */
  close?: string;
  /** Stop-gate bookkeeping — set on the client prompt whose response
   *  the gate held back: the response body owed upstream when the gate
   *  passes (or 'cancelled' when a session/cancel lands first). */
  heldResponse?: AnyMessage;
  /** Stop-gate bookkeeping — set on the PROXY-originated gate
   *  re-prompt: the client request id its response answers for. The
   *  gate turn's own response crosses under that id; the held original
   *  never does (the client's request resolves once, with the final
   *  turn's verdict). */
  gateFor?: JsonRpcId;
  /** Fires when the gate turn discharges — the session's writeQ chains
   *  behind it so the client's next prompt never crosses downstream
   *  mid-gate-turn (a concurrent session/prompt is legal JSON-RPC but
   *  an agent that cannot interleave turns would drop or wedge it). */
  gateDone?: () => void;
}

/** An agent→client request in flight — forwarded upstream verbatim or
 *  held for the permission-policy eval (spec bro-9qopj). The table
 *  buys three things the verbatim pass couldn't do: the client's
 *  response relays back down WITH its bookkeeping (a forwarded ask's
 *  answer journals); a session cancel/close settles a still-held ask
 *  locally (the wire never shows an ask after its cancel — the
 *  held-prompt rule one level up); and a dead client answers every
 *  outstanding ask downstream instead of leaving the agent stalled
 *  on a question that can never resolve. */
interface PendingA2C {
  method: string;
  sessionId?: string;
  /** Permission-ask bookkeeping — present only on
   *  `session/request_permission` entries. */
  permission?: {
    /** The tool call's journal label (title, else toolCallId). */
    title?: string;
    toolCallId?: string;
    /** true while the policy eval holds the ask — a cancel/close
     *  settles it locally; false once the ask crossed upstream and
     *  the client's own answer is owed the relay. */
    held: boolean;
    /** The offered option set — a forwarded ask's selected optionId
     *  maps back to its kind for the journal verdict. */
    options: { optionId: string; kind?: string }[];
  };
}

/** Latch — resolves once; the winner decides the proxy's verdict. */
function latch(): { promise: Promise<void>; fire: () => void; fired: boolean } {
  let resolve!: () => void;
  const l = {
    promise: new Promise<void>(r => {
      resolve = r;
    }),
    fire: () => {
      if (!l.fired) {
        l.fired = true;
        resolve();
      }
    },
    fired: false,
  };
  return l;
}

/** The pump's view of a message — the wire object's own keys, no
 *  schema narrowing. `AnyMessage` is a typed union that doesn't index
 *  cleanly; the pump reads it as the record it actually is. */
interface Wire {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const wire = (m: AnyMessage): Wire => m as Wire;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isRequest = (m: AnyMessage): boolean =>
  typeof wire(m).method === 'string' && wire(m).id !== undefined;

const isNotification = (m: AnyMessage): boolean =>
  typeof wire(m).method === 'string' && wire(m).id === undefined;

const isResponse = (m: AnyMessage): boolean =>
  wire(m).method === undefined && wire(m).id !== undefined;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const paramsOf = (m: AnyMessage): Record<string, unknown> | undefined => {
  const p = wire(m).params;
  return isRecord(p) ? p : undefined;
};

const sessionIdOf = (m: AnyMessage): string | undefined => str(paramsOf(m)?.['sessionId']);

/** Flatten a prompt's text blocks for the prompt-submit probes — the
 *  same join the fake agent does (`text` blocks concat, non-text
 *  contributes nothing — the probes read prompt text, not images). */
const promptText = (params: Record<string, unknown>): string =>
  (Array.isArray(params['prompt']) ? params['prompt'] : [])
    .map(b => (isRecord(b) && b['type'] === 'text' ? (str(b['text']) ?? '') : ''))
    .join('');

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
  const log = opts.log ?? ((line: string) => console.error(line));
  const sessions = new Map<string, ProxySession>();
  const pending = new Map<JsonRpcId, PendingRequest>();
  /** a2c requests in flight — the second pending table (spec
   *  bro-9qopj). Every agent→client request registers before it
   *  crosses upstream; a permission ask registers BEFORE its eval so
   *  a cancel/close/teardown racing the eval settles it. */
  const pendingA2C = new Map<JsonRpcId, PendingA2C>();
  const downDead = latch();
  const upDead = latch();
  const downWriter = downstream.writable.getWriter();
  const upWriter = upstream.writable.getWriter();
  /** BRO_HOOKS=0 → the proxy is a pure transport: no tool-call
   *  arming/guards and no turn-end gate (machine-backend trees spawn
   *  their agents with it so the child's hooks and the proxy's in-process
   *  pass never double up — spec bro-u2eps §3). */
  const hooksOff = process.env.BRO_HOOKS === '0';
  /** Proxy-originated gate re-prompt ids — namespaced strings so they
   *  can never collide with a client's numeric id space. */
  let gateSeq = 0;

  const writeDown = (m: AnyMessage): void => {
    downWriter.write(m).then(undefined, () => downDead.fire());
  };
  const writeUp = (m: AnyMessage): void => {
    upWriter.write(m).then(undefined, () => upDead.fire());
  };

  /** Answer an upstream request ourselves — only the held-prompt
   *  cancel path uses this; the proxy never synthesizes success. */
  const answerUpstream = (id: JsonRpcId, result: unknown): void => {
    writeUp({ jsonrpc: '2.0', id, result } as AnyMessage);
  };

  /** Session-scoped downstream writes queue through the session's
   *  writeQ so nothing overtakes a first prompt still collecting its
   *  injection. Non-session methods write immediately — a session id
   *  is the only ordering key the wire gives us. */
  const writeDownFor = (sessionId: string | undefined, m: AnyMessage): void => {
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (ses === undefined) {
      writeDown(m);
      return;
    }
    ses.writeQ = ses.writeQ.then(() => {
      if (!downDead.fired) {
        writeDown(m);
      }
    });
  };

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
    if (fn === undefined || session.cwd === undefined) return undefined;
    try {
      return (await fn(session.cwd, sessionId, prompt)) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** The sessionContext leg — same fail-open rule, but a throw is an
   *  UNSETTLED collection (retry next prompt) while a cwd-less session
   *  or absent seam settles immediately: nothing can ever collect. */
  const seamSessionCall = async (
    fn: AcpProxySeam['sessionContext'],
    session: ProxySession,
    sessionId: string
  ): Promise<{ text?: string; settled: boolean }> => {
    if (fn === undefined || session.cwd === undefined) return { settled: true };
    try {
      const r = await fn(session.cwd, sessionId);
      return { text: r?.text ?? undefined, settled: r?.settled ?? true };
    } catch {
      return { settled: false };
    }
  };

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
    const text = promptText(params);
    const [sessionCtx, promptCtx] = await Promise.all([
      ses.sessionCtxDone
        ? Promise.resolve<{ text?: string; settled: boolean }>({ settled: true })
        : seamSessionCall(opts.seam?.sessionContext, ses, sessionId),
      seamCall(opts.seam?.promptContext, ses, sessionId, text),
    ]);
    // an unsettled collection still contributes what it has — the hook
    // emits partial output the same way — but the slot stays open so
    // the next prompt retries a full collection (the session's start
    // context closes only when a settled run crosses downstream). The
    // advisory buffer drains here too — guard `say` lines and gate
    // hints ride the crossed prompt as the same advisory text block.
    const advisory = ses.advisory.splice(0);
    const combined = [sessionCtx.text, promptCtx, ...advisory]
      .filter(s => s !== undefined && s !== '')
      .join('\n');
    if (combined === '') return { m, sessionCtxSettled: sessionCtx.settled };
    const blocks = Array.isArray(params['prompt']) ? params['prompt'] : [];
    const block: ContentBlock = { type: 'text', text: combined };
    return {
      m: { ...m, params: { ...params, prompt: [block, ...blocks] } },
      sessionCtxSettled: sessionCtx.settled,
    };
  };

  /** Session-open methods — a successful response stamps session state
   *  (the response's sessionId wins — session/fork's params carry the
   *  source id). */
  const OPEN_METHODS = new Set(['session/new', 'session/load', 'session/fork', 'session/resume']);

  /** c2a request — verbatim forward plus the session/prompt seam. */
  const onClientRequest = (m: AnyMessage): void => {
    const method = wire(m).method as string;
    const id = wire(m).id as JsonRpcId;
    if (method === 'session/prompt') {
      onPromptRequest(m, id);
      return;
    }
    const params = paramsOf(m);
    const sessionId = sessionIdOf(m);
    pending.set(id, {
      method,
      ...(OPEN_METHODS.has(method)
        ? { bind: { cwd: str(params?.['cwd']), sessionId: str(params?.['sessionId']) } }
        : {}),
      ...(method === 'session/close' && sessionId !== undefined ? { close: sessionId } : {}),
    });
    writeDownFor(sessionId, m);
  };

  /** The stamped session a prompt rides — undefined when the client
   *  skipped session/new, named an unknown session, or sent no params:
   *  an unstamped prompt forwards untouched (there is no cwd to probe
   *  inside). */
  const promptSession = (
    m: AnyMessage
  ): { params: Record<string, unknown>; sessionId: string; ses: ProxySession } | undefined => {
    const params = paramsOf(m);
    const sessionId = sessionIdOf(m);
    if (params === undefined || sessionId === undefined) {
      return undefined;
    }
    const ses = sessions.get(sessionId);
    return ses === undefined ? undefined : { params, sessionId, ses };
  };

  /** c2a session/prompt — on a stamped session the prompt is a HELD
   *  write: queued behind the session's serialized writeQ so the seam
   *  collection can't stall the read loop (session/cancel lands during
   *  collection) and nothing overtakes it on the downstream wire.
   *  `held` marks it from enqueue until the write attempt — a
   *  per-prompt flag would lose every prompt queued behind the first
   *  (the cancel path aborts held prompts by deleting their pending
   *  entry). */
  const onPromptRequest = (m: AnyMessage, id: JsonRpcId): void => {
    const target = promptSession(m);
    if (target === undefined) {
      pending.set(id, { method: 'session/prompt' });
      writeDown(m);
      return;
    }
    const turn = otelSpan(
      'acp.proxy.turn',
      {
        'acp.session': target.sessionId,
      },
      { parent: target.ses.span?.ctx }
    );
    pending.set(id, {
      method: 'session/prompt',
      prompt: { sessionId: target.sessionId, span: turn },
    });
    target.ses.held.add(id);
    target.ses.writeQ = target.ses.writeQ.then(() => crossPrompt({ m, id, ...target }));
  };

  /** Still writable? pending discharged → the cancel path already
   *  answered this prompt upstream; downstream dead → nothing crosses
   *  anyway. The two check points bracket the seam collection — the
   *  abortable window. */
  const crossable = (id: JsonRpcId): boolean => pending.has(id) && !downDead.fired;

  /** The held write, run inside the session's writeQ: "first prompt" =
   *  first to actually CROSS, decided here under the serialized queue —
   *  a cancelled held prompt never claims the slot, and two queued
   *  prompts can't both take it. */
  const crossPrompt = async (held: {
    m: AnyMessage;
    id: JsonRpcId;
    params: Record<string, unknown>;
    sessionId: string;
    ses: ProxySession;
  }): Promise<void> => {
    const { m, id, params, sessionId, ses } = held;
    try {
      if (!crossable(id)) {
        return;
      }
      const first = !ses.seenPrompt;
      const injected = await injectPrompt(m, params, sessionId, ses);
      if (!crossable(id)) {
        return;
      }
      const p = pending.get(id);
      if (p?.prompt !== undefined) p.prompt.first = first;
      ses.seenPrompt = true;
      // a settled collection that crosses closes the slot; an
      // unsettled one stays owed — the next prompt retries
      ses.sessionCtxDone = ses.sessionCtxDone || injected.sessionCtxSettled;
      ses.plane?.start();
      writeDown(injected.m);
    } finally {
      ses.held.delete(id);
    }
  };

  /** Answer every held prompt of the session upstream with
   *  `stopReason:'cancelled'` — held prompts never cross, so the wire
   *  never shows a prompt after its cancel/close. No plane events here:
   *  a held prompt never started a downstream turn (the plane's
   *  start/stop bookends only crossed work). Returns the abort count. */
  const abortHeld = (ses: ProxySession, sessionId: string): number => {
    let aborted = 0;
    // held is the session's own prompt-id set — iterating it touches
    // only this session's held writes, never a sibling session's
    for (const id of ses.held) {
      const pr = pending.get(id)?.prompt;
      if (pr === undefined || pr.sessionId !== sessionId) {
        continue;
      }
      pending.delete(id);
      aborted++;
      pr.span.end({ 'acp.stop_reason': 'cancelled' });
      answerUpstream(id, { stopReason: 'cancelled' });
    }
    return aborted;
  };

  /** Answer every GATE-HELD prompt of the session upstream with
   *  `stopReason:'cancelled'` — the held response never crosses and
   *  the pending entry drops, so a mid-eval gate verdict lands on an
   *  empty slot and an in-flight gate turn's response finds no client
   *  id to answer for. Returns the abort count. */
  const abortGateHeld = (sessionId: string): number => {
    let aborted = 0;
    for (const [pid, p] of pending) {
      if (p.prompt?.sessionId === sessionId && p.heldResponse !== undefined) {
        pending.delete(pid);
        aborted++;
        answerUpstream(pid, { stopReason: 'cancelled' });
      }
    }
    return aborted;
  };

  /** Release a session — held prompts answered, state dropped, span
   *  ended, plane drained. Runs on a successful session/close response
   *  (a failed close leaves the session live — the close never took). */
  const releaseSession = (sessionId: string, ses: ProxySession): void => {
    abortHeld(ses, sessionId);
    abortGateHeld(sessionId);
    abortHeldAsks(sessionId);
    sessions.delete(sessionId);
    ses.span?.end({ 'acp.proxy.close': true });
    void ses.plane?.drain().then(undefined, () => {});
  };

  /** Should this session/cancel cross? It first answers every held
   *  prompt of the session upstream `stopReason:'cancelled'` (held
   *  prompts never cross — the wire never shows a prompt after its
   *  cancel). The cancel itself crosses only while crossed work still
   *  runs downstream — it is session-scoped, so in-flight prompts are
   *  its real targets; a cancel whose whole target set was held
   *  prompts is fully handled by the proxy, and forwarding it would
   *  show a cancel without its prompt. */
  const cancelCrosses = (m: AnyMessage): boolean => {
    const sessionId = sessionIdOf(m);
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (ses === undefined || sessionId === undefined) {
      return true;
    }
    // gate-held prompts answer upstream the same way held ones do —
    // a cancel settles the client's request 'cancelled' and the gate
    // eval (or the gate turn's late response) lands on an empty slot.
    // Held permission asks settle downstream the same way — the wire
    // never shows an ask after its cancel either
    const aborted = abortHeld(ses, sessionId) + abortGateHeld(sessionId) + abortHeldAsks(sessionId);
    if (aborted === 0) {
      return true;
    }
    return [...pending.values()].some(p => p.prompt?.sessionId === sessionId);
  };

  /** c2a notification — verbatim modulo the cancel check. */
  const onClientNotification = (m: AnyMessage): void => {
    if (wire(m).method !== 'session/cancel' || cancelCrosses(m)) {
      const sid = sessionIdOf(m);
      // a gate turn in flight is the cancel's real target — queueing
      // behind its discharge would make the abort unreachable exactly
      // when it matters (a stalled turn never receives its cancel).
      // The gate prompt already crossed, so writing immediately keeps
      // the cancel-after-prompt order the writeQ exists to enforce.
      const gateInFlight =
        wire(m).method === 'session/cancel' &&
        [...pending.values()].some(p => p.gateFor !== undefined && p.prompt?.sessionId === sid);
      if (gateInFlight) {
        writeDown(m);
      } else {
        writeDownFor(sid, m);
      }
    }
  };

  /** Feed one session/update to the session's turn plane — telemetry
   *  is advisory: a malformed update must not cost the wire. */
  const feedPlane = (m: AnyMessage): void => {
    const sessionId = sessionIdOf(m);
    const update = paramsOf(m)?.['update'];
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (ses === undefined || update === undefined) {
      return;
    }
    try {
      ses.plane?.update(update as SessionUpdate);
    } catch {
      /* telemetry is advisory */
    }
  };

  /** Tool-call statuses that end a call — a `tool_call_update` only
   *  fires the hook seam's `end` phase once the call actually finished
   *  (in-progress deltas carry no outcome to arm or match against). */
  const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed']);

  /** Route one tool_call-ish session/update into the seam's in-process
   *  hook pass (spec bro-u2eps §1): `tool_call` announces the call —
   *  'start' journals and arms it; a TERMINAL `tool_call_update` (or an
   *  announce that already carries a terminal status) is 'end' — the
   *  post-tool analog whose journal entry carries the outcome and whose
   *  guard sweep sees the post-call repo state. The eval chains onto
   *  the session's writeQ: it is session-scoped work that must not race
   *  the prompts whose injection drains the lines it produces. Any
   *  throw is a log line — a crashed eval never touches the wire. */
  const feedToolCall = (
    update: Record<string, unknown>,
    ses: ProxySession,
    sessionId: string
  ): void => {
    const toolCall = opts.seam?.toolCall;
    const cwd = ses.cwd;
    if (hooksOff || toolCall === undefined || cwd === undefined) {
      return;
    }
    const kind = update['sessionUpdate'];
    const status = str(update['status']);
    const phase: 'start' | 'end' | undefined =
      kind === 'tool_call'
        ? status !== undefined && TERMINAL_TOOL_STATUS.has(status)
          ? 'end'
          : 'start'
        : kind === 'tool_call_update' && status !== undefined && TERMINAL_TOOL_STATUS.has(status)
          ? 'end'
          : undefined;
    if (phase === undefined) {
      return;
    }
    const toolCallId = str(update['toolCallId']);
    if (toolCallId === undefined) {
      return;
    }
    const call: AcpProxyToolCall = {
      phase,
      toolCallId,
      name: str(update['name']),
      title: str(update['title']),
      kind: str(update['kind']),
      status,
      input: update['rawInput'],
      output: update['rawOutput'],
    };
    ses.writeQ = ses.writeQ.then(async () => {
      try {
        const lines = await toolCall(cwd, sessionId, call);
        if (lines !== undefined && lines.length > 0) {
          ses.advisory.push(...lines);
        }
      } catch (e) {
        log(
          `acp proxy: tool_call hook eval failed (session ${sessionId}) — ${(e as Error).message}`
        );
      }
    });
  };

  // --- permission policy at the protocol seam (spec bro-9qopj) -----------

  const PERMISSION_METHOD = 'session/request_permission';

  /** The offered option set, reduced to the two fields the seam needs
   *  — optionId to answer, kind to pick and journal. */
  const permissionOptionsOf = (params: Record<string, unknown> | undefined) => {
    const raw = Array.isArray(params?.['options']) ? params['options'] : [];
    const out: { optionId: string; kind?: string }[] = [];
    for (const o of raw) {
      if (isRecord(o)) {
        const optionId = str(o['optionId']);
        if (optionId !== undefined) {
          out.push({ optionId, kind: str(o['kind']) });
        }
      }
    }
    return out;
  };

  /** The wire pick for a verdict's polarity (spec bro-rs8sp's selection
   *  rule): the `*_once` variant wins whenever offered; `*_always`
   *  only when it is the polarity's sole offered variant — refusing a
   *  sole offered option fails an answerable request. */
  const pickPermissionOption = (
    options: { optionId: string; kind?: string }[],
    polarity: 'allow' | 'reject'
  ): string | undefined => {
    const once = options.find(o => o.kind === `${polarity}_once`);
    if (once !== undefined) {
      return once.optionId;
    }
    const always = options.find(o => o.kind === `${polarity}_always`);
    return always?.optionId;
  };

  /** The proxy's own answer to a permission ask — a normal
   *  `selected`/`cancelled` outcome, indistinguishable from the
   *  client's own answer. That is the point: every client gets the
   *  policy, no client needs a hook dialect for it. */
  const answerPermission = (id: JsonRpcId, outcome: unknown): void => {
    writeDown({ jsonrpc: '2.0', id, result: { outcome } } as AnyMessage);
  };

  /** One journal row per ask — through the session's plane so an
   *  unbadged proxy run still archives under `bro/proxy/` (a session
   *  without a cwd has no plane and journals nothing — same posture
   *  as the rest of the archive). */
  const notePermission = (
    ses: ProxySession | undefined,
    row: {
      title: string;
      toolCallId?: string;
      decidedBy: 'proxy' | 'client';
      verdict: string;
      optionId?: string;
      reason?: string;
    }
  ): void => {
    try {
      ses?.plane?.note({ kind: 'permission', ...row });
    } catch {
      /* telemetry is advisory — a journaling crash never touches the wire */
    }
  };

  /** Settle a held ask with the seam's verdict — the bro-rs8sp
   *  permission row: allow → allow_once; deny → reject_once
   *  (`cancelled` when no reject is offered); ask → forward verbatim.
   *  The pending entry is re-read: a cancel/close/teardown racing the
   *  eval already settled the ask, and the verdict lands on an empty
   *  slot. */
  const settlePermission = (
    m: AnyMessage,
    id: JsonRpcId,
    ses: ProxySession,
    sessionId: string,
    outcome: AcpProxyPermissionVerdict | undefined
  ): void => {
    const req = pendingA2C.get(id);
    if (req?.permission === undefined) {
      return; // a cancel/close/teardown already answered it
    }
    if (outcome?.hints !== undefined) {
      ses.advisory.push(...outcome.hints);
    }
    const verdict = outcome?.verdict ?? 'ask';
    if (verdict === 'ask' || upDead.fired) {
      // forward the ask verbatim — the client's own answer relays back
      // through the pending entry (held flips: the ask crossed)
      req.permission.held = false;
      writeUp(m);
      return;
    }
    pendingA2C.delete(id);
    const perm = req.permission;
    const title = perm.title ?? perm.toolCallId ?? 'permission request';
    const allow = verdict === 'allow' ? pickPermissionOption(perm.options, 'allow') : undefined;
    if (allow !== undefined) {
      notePermission(ses, {
        title,
        toolCallId: perm.toolCallId,
        decidedBy: 'proxy',
        verdict: 'approved',
        optionId: allow,
        ...(outcome?.reason !== undefined ? { reason: outcome.reason } : {}),
      });
      answerPermission(id, { outcome: 'selected', optionId: allow });
      return;
    }
    // deny — or an allow verdict the option set cannot honor: the
    // acp-worker autoApprove rule says an agent offering no allow
    // option still gets denied, never an invented approval
    const reason =
      outcome?.reason ??
      (verdict === 'allow' ? 'policy allowed but no allow option was offered' : undefined);
    const reject = pickPermissionOption(perm.options, 'reject');
    if (reject !== undefined) {
      notePermission(ses, {
        title,
        toolCallId: perm.toolCallId,
        decidedBy: 'proxy',
        verdict: 'denied',
        optionId: reject,
        ...(reason !== undefined ? { reason } : {}),
      });
      answerPermission(id, { outcome: 'selected', optionId: reject });
    } else {
      // no reject option offered — the denyPermission shape: the ask
      // ends cancelled, never an invented reject
      notePermission(ses, {
        title,
        toolCallId: perm.toolCallId,
        decidedBy: 'proxy',
        verdict: 'cancelled',
        ...(reason !== undefined ? { reason } : {}),
      });
      answerPermission(id, { outcome: 'cancelled' });
    }
  };

  /** a2c session/request_permission — register held, then evaluate the
   *  seam free-standing. The eval must NEVER queue on the session's
   *  writeQ: an ask inside a gate turn would deadlock behind the
   *  discharge it exists to unblock (the gate turn holds the writeQ
   *  slot until its response lands; the response can't land until the
   *  ask is answered). The entry registers synchronously so a
   *  cancel/close/teardown racing the eval settles it — the
   *  `crossable` discipline the held prompt uses, one level up. */
  const onPermissionRequest = (m: AnyMessage, id: JsonRpcId): void => {
    const params = paramsOf(m);
    const sessionId = sessionIdOf(m);
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId);
    const toolCall = isRecord(params?.['toolCall']) ? params['toolCall'] : undefined;
    const perm = {
      title: str(toolCall?.['title']) ?? str(toolCall?.['toolCallId']),
      toolCallId: str(toolCall?.['toolCallId']),
      held: true,
      options: permissionOptionsOf(params),
    };
    pendingA2C.set(id, { method: PERMISSION_METHOD, sessionId, permission: perm });
    const fn = opts.seam?.permission;
    const cwd = ses?.cwd;
    if (
      hooksOff ||
      fn === undefined ||
      ses === undefined ||
      cwd === undefined ||
      sessionId === undefined
    ) {
      // no policy — the ask crosses verbatim; the pending entry still
      // relays the client's answer into the journal
      perm.held = false;
      writeUp(m);
      return;
    }
    const call: AcpProxyPermissionCall = {
      toolCallId: perm.toolCallId ?? '',
      name: str(toolCall?.['name']),
      title: str(toolCall?.['title']),
      kind: str(toolCall?.['kind']),
      input: toolCall?.['rawInput'],
    };
    void (async () => {
      let outcome: AcpProxyPermissionVerdict | undefined;
      try {
        outcome = await fn(cwd, sessionId, call);
      } catch (e) {
        log(`acp proxy: permission eval failed (session ${sessionId}) — ${(e as Error).message}`);
      }
      settlePermission(m, id, ses, sessionId, outcome);
    })();
  };

  /** Answer every held permission ask of the session downstream
   *  `cancelled` — a cancel/close settles the ask where it stands:
   *  held asks never crossed, so the wire never shows an ask after
   *  its cancel. Forwarded asks keep their pending entry — the
   *  client's own answer is owed the relay. Returns the count. */
  const abortHeldAsks = (sessionId: string): number => {
    let aborted = 0;
    for (const [id, req] of pendingA2C) {
      if (req.sessionId !== sessionId || req.permission?.held !== true) {
        continue;
      }
      pendingA2C.delete(id);
      aborted++;
      notePermission(sessions.get(sessionId), {
        title: req.permission.title ?? req.permission.toolCallId ?? 'permission request',
        toolCallId: req.permission.toolCallId,
        decidedBy: 'proxy',
        verdict: 'cancelled',
        reason: 'session cancelled while the policy evaluated',
      });
      answerPermission(id, { outcome: 'cancelled' });
    }
    return aborted;
  };

  /** a2c request — verbatim forward plus the permission seam. Every
   *  request registers: the response relay, the cancel settle, and
   *  the dead-client sweep all read the table. */
  const onAgentRequest = (m: AnyMessage): void => {
    const method = wire(m).method as string;
    const id = wire(m).id as JsonRpcId;
    if (method === PERMISSION_METHOD) {
      onPermissionRequest(m, id);
      return;
    }
    pendingA2C.set(id, { method, sessionId: sessionIdOf(m) });
    writeUp(m);
  };

  /** c2a response — discharge the a2c entry and relay verbatim. A
   *  forwarded ask's answer lands its journal row here: the human's
   *  verdict mapped back through the offered option kinds. */
  const onClientResponse = (m: AnyMessage): void => {
    const id = wire(m).id;
    const req = id === undefined ? undefined : pendingA2C.get(id);
    if (req === undefined || id === undefined) {
      writeDownFor(undefined, m);
      return;
    }
    pendingA2C.delete(id);
    if (req.permission !== undefined) {
      const ses = req.sessionId === undefined ? undefined : sessions.get(req.sessionId);
      const result = wire(m).result;
      const outcome = isRecord(result) ? result['outcome'] : undefined;
      const perm = req.permission;
      const title = perm.title ?? perm.toolCallId ?? 'permission request';
      let verdict = 'cancelled';
      let optionId: string | undefined;
      if (wire(m).error !== undefined) {
        verdict = 'error';
      } else if (isRecord(outcome) && outcome['outcome'] === 'selected') {
        optionId = str(outcome['optionId']);
        const kind = perm.options.find(o => o.optionId === optionId)?.kind;
        if (kind !== undefined && kind.startsWith('allow')) {
          verdict = 'approved';
        } else if (kind !== undefined && kind.startsWith('reject')) {
          verdict = 'denied';
        } else {
          verdict = 'selected';
        }
      }
      notePermission(ses, {
        title,
        toolCallId: perm.toolCallId,
        decidedBy: 'client',
        verdict,
        ...(optionId !== undefined ? { optionId } : {}),
      });
    }
    writeDownFor(undefined, m);
  };

  /** a2c notification — verbatim; session/update feeds the turn plane
   *  and the tool-call hook seam (in-process arming + guard eval —
   *  never a subprocess). */
  const onAgentNotification = (m: AnyMessage): void => {
    if (wire(m).method === 'session/update') {
      feedPlane(m);
      const sessionId = sessionIdOf(m);
      const update = paramsOf(m)?.['update'];
      const ses = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (ses !== undefined && sessionId !== undefined && isRecord(update)) {
        feedToolCall(update, ses, sessionId);
      }
    }
    writeUp(m);
  };

  /** Stamp session state on a successful session-open response — the
   *  RESPONSE's sessionId wins: session/fork's params carry the SOURCE
   *  id, the fork's own id only exists in the result. load/resume
   *  responses may omit it → the request param is the fallback. */
  const stampSession = (bind: PendingRequest['bind'], result: unknown): void => {
    if (bind === undefined) {
      return;
    }
    const sid = (isRecord(result) ? str(result['sessionId']) : undefined) ?? bind.sessionId;
    if (sid === undefined || sessions.has(sid)) {
      return;
    }
    const cwd = bind.cwd;
    sessions.set(sid, {
      cwd,
      seenPrompt: false,
      sessionCtxDone: opts.seam?.sessionContext === undefined,
      held: new Set(),
      writeQ: Promise.resolve(),
      advisory: [],
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
    });
  };

  /** Release the session a successful session/close named — a failed
   *  close never ran, so the session stays live. */
  const releaseOnClose = (closeId: string | undefined): void => {
    if (closeId === undefined) {
      return;
    }
    const ses = sessions.get(closeId);
    if (ses !== undefined) {
      releaseSession(closeId, ses);
    }
  };

  /** Span attrs for a finished turn — first_prompt only when the
   *  prompt actually crossed (a cancelled held prompt never got the
   *  slot), stop_reason/error when the wire carried them. */
  const turnAttrs = (
    pr: NonNullable<PendingRequest['prompt']>,
    stopReason: string | undefined,
    failed: boolean
  ): Record<string, string | number | boolean> => ({
    ...(pr.first !== undefined ? { 'acp.proxy.first_prompt': pr.first } : {}),
    ...(stopReason !== undefined ? { 'acp.stop_reason': stopReason } : {}),
    ...(failed ? { 'acp.error': true } : {}),
  });

  /** Land the turn's bookkeeping — span attrs + plane stop — for the
   *  prompt a response discharges. Runs on error responses too: a
   *  failed prompt still ends its turn. */
  const finishTurn = (req: PendingRequest, m: AnyMessage): void => {
    const pr = req.prompt;
    if (pr === undefined) {
      return;
    }
    const result = wire(m).result;
    const stopReason = isRecord(result) ? str(result['stopReason']) : undefined;
    const failed = wire(m).error !== undefined;
    pr.span.end(turnAttrs(pr, stopReason, failed), failed ? 'error' : 'ok');
    sessions
      .get(pr.sessionId)
      ?.plane?.stop(stopReason, failed ? { error: 'session/prompt error' } : {});
  };

  /** The turn-end stop gate (spec bro-u2eps §2). The client prompt's
   *  response is HELD — the pending entry stays so session/cancel can
   *  still settle it — while the seam evaluates on the session's
   *  writeQ (the gate's own re-prompt and the client's next prompt
   *  keep downstream wire order behind the verdict). Outcomes:
   *  - pass / throw / downstream dead → the held response crosses
   *    verbatim; an eval crash is a log line, never a wire break.
   *  - block → exactly ONE proxy-originated `session/prompt` carrying
   *    the gate's message (plus any advisory lines the turn produced),
   *    under a namespaced string id that cannot collide with client
   *    ids. The held response is DISCARDED — when the gate turn's
   *    response lands it answers the client's id: the client asked
   *    for a turn, the turn that actually ends the session's work is
   *    the answer. The gate turn's own end-of-turn is never gated —
   *    "gates, not loops": a repeated stop lets through, the same
   *    rule as the hook Stop gate's stop_hook_active. */
  const evalStopGate = (clientId: JsonRpcId, ses: ProxySession, sessionId: string): void => {
    const gate = opts.seam?.stopGate;
    const cwd = ses.cwd;
    if (gate === undefined || cwd === undefined) {
      return;
    }
    ses.writeQ = ses.writeQ.then(async () => {
      if (!pending.has(clientId) || downDead.fired) {
        return;
      }
      let outcome: { block?: string; hints?: string[] } | undefined;
      try {
        outcome = await gate(cwd, sessionId);
      } catch (e) {
        log(`acp proxy: stop gate eval failed (session ${sessionId}) — ${(e as Error).message}`);
      }
      // a cancel raced the eval — its 'cancelled' already landed
      if (!pending.has(clientId) || downDead.fired) {
        return;
      }
      const held = pending.get(clientId)?.heldResponse;
      if (outcome?.block === undefined || outcome.block === '') {
        if (outcome?.hints !== undefined) {
          ses.advisory.push(...outcome.hints);
        }
        pending.delete(clientId);
        if (held !== undefined) {
          writeUp(held);
        }
        return;
      }
      const gateId: JsonRpcId = `bro-gate-${++gateSeq}`;
      // the re-prompt is a real downstream turn — it gets its own
      // span (documented choice, spec §2): folding it into the client
      // turn's span would hide the gate's work inside a turn that
      // already ended, and the plane's start/stop pair would lose its
      // bookend for the crossed work.
      const gateSpan = otelSpan(
        'acp.proxy.turn',
        { 'acp.session': sessionId, 'acp.proxy.gate': true },
        { parent: ses.span?.ctx }
      );
      const done = latch();
      pending.set(gateId, {
        method: 'session/prompt',
        prompt: { sessionId, span: gateSpan },
        gateFor: clientId,
        gateDone: done.fire,
      });
      const prompt: ContentBlock[] = [{ type: 'text', text: outcome.block }];
      for (const line of ses.advisory.splice(0)) {
        prompt.push({ type: 'text', text: line });
      }
      ses.plane?.start();
      writeDown({
        jsonrpc: '2.0',
        id: gateId,
        method: 'session/prompt',
        params: { sessionId, prompt },
      } as AnyMessage);
      // the gate turn is crossed work — session-scoped writes that
      // arrive while it runs (the client's next prompt) queue behind
      // its discharge, never interleave mid-turn on the downstream
      // leg. This callback IS the writeQ slot — awaiting the turn
      // inside it holds the position for every writer, whenever it
      // enqueued; a .then() chained here would only guard writers
      // that arrive after this line, letting a prompt that queued
      // during eval race the gate turn (PR #1067 review).
      await done.promise;
    });
  };

  /** a2c response — route verbatim; the bookkeeping it lands (session
   *  bind, turn span) rides on the pending entry it discharges. The
   *  two exceptions (spec bro-u2eps §2): a gate re-prompt's response
   *  answers the CLIENT id it was sent for, and a hooked session's
   *  prompt response holds for the turn-end stop gate. */
  const onAgentResponse = (m: AnyMessage): void => {
    const id = wire(m).id as JsonRpcId;
    const req = pending.get(id);
    if (req === undefined) {
      // every crossed request registers a pending entry, so an a2c
      // response with none is a wire anomaly — a duplicate, or an
      // answer to an already-discharged id. The proxy is the wire:
      // forward verbatim, but name it so the stderr log can see it.
      log(`acp proxy: unmatched agent response id ${String(id)} — forwarding`);
      writeUp(m);
      return;
    }
    pending.delete(id);
    // a gate turn ended — its response answers the held client
    // request under the client's own id (the held original never
    // crosses — the client's request resolves once). Never re-gated:
    // the second end-of-turn passes unconditionally.
    if (req.gateFor !== undefined) {
      const clientReq = pending.get(req.gateFor);
      pending.delete(req.gateFor);
      finishTurn(req, m);
      req.gateDone?.();
      if (clientReq !== undefined) {
        writeUp({ ...m, id: req.gateFor } as AnyMessage);
      }
      return;
    }
    if (wire(m).error === undefined) {
      // an error response stamps nothing — a failed open must not
      // register a session the next attempt would collide with, and a
      // failed close never ran
      stampSession(req.bind, wire(m).result);
      releaseOnClose(req.close);
    }
    const ses = req.prompt === undefined ? undefined : sessions.get(req.prompt.sessionId);
    if (
      req.prompt !== undefined &&
      ses !== undefined &&
      !hooksOff &&
      opts.seam?.stopGate !== undefined &&
      ses.cwd !== undefined &&
      wire(m).error === undefined
    ) {
      // hold the response for the gate verdict — the turn's own
      // span/plane bookkeeping still closes on THIS response: the
      // client's turn really did end here, and the gate re-prompt
      // opens its own turn span rather than extending a closed one
      finishTurn(req, m);
      req.heldResponse = m;
      pending.set(id, req);
      evalStopGate(id, ses, req.prompt.sessionId);
      return;
    }
    finishTurn(req, m);
    writeUp(m);
  };

  /** c2a routing — a malformed message is dropped, never answered:
   *  the proxy is not a peer, it is the wire. */
  const routeC2A = (m: AnyMessage): void => {
    if (isRequest(m)) {
      onClientRequest(m);
    } else if (isNotification(m)) {
      onClientNotification(m);
    } else if (isResponse(m)) {
      onClientResponse(m);
    }
  };

  /** a2c routing — requests register on the a2c pending table (the
   *  permission seam may hold or answer them); responses discharge
   *  the c2a table; notifications cross untouched. */
  const routeA2C = (m: AnyMessage): void => {
    if (isNotification(m)) {
      onAgentNotification(m);
    } else if (isResponse(m)) {
      onAgentResponse(m);
    } else if (isRequest(m)) {
      onAgentRequest(m);
    }
  };

  /** Read `stream` until EOF, routing each message through `route`. */
  const pump = async (
    stream: Stream,
    route: (m: AnyMessage) => void,
    tag: string
  ): Promise<void> => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const m = value;
      try {
        route(m);
      } catch (e) {
        log(`acp proxy: dropped ${tag} ${wire(m).method ?? 'message'}: ${(e as Error).message}`);
      }
    }
  };

  const verdict = await Promise.race([
    pump(upstream, routeC2A, 'c→a').then(
      () => 'up' as const, // client closed its side of the wire
      () => 'up' as const
    ),
    pump(downstream, routeA2C, 'a→c').then(
      () => 'down' as const, // agent closed its side of the wire
      () => 'down' as const
    ),
    downDead.promise.then(() => 'down' as const),
    upDead.promise.then(() => 'up' as const),
  ]);

  // downstream dead → every request still in flight fails visibly on
  // the upstream wire; a dead agent never silently eats a prompt
  if (verdict === 'down') {
    for (const [id, req] of [...pending]) {
      if (!pending.delete(id)) {
        continue; // already discharged — a gate pair's client half
      }
      if (req.gateFor !== undefined) {
        // the gate re-prompt's id is proxy-originated — the owed
        // upstream answer lands under the CLIENT's id, and the held
        // pending entry discharges with it (one answer per request).
        // `owed` is false when the client entry already discharged
        // itself — a second write under its id would be a duplicate
        // response.
        const owed = pending.delete(req.gateFor);
        req.gateDone?.();
        req.prompt?.span.endDetached({ 'acp.error': 'downstream closed' }, 'error');
        if (owed) {
          writeUp({
            jsonrpc: '2.0',
            id: req.gateFor,
            error: { code: -32603, message: 'acp proxy: downstream agent closed' },
          } as AnyMessage);
        }
        continue;
      }
      // a gate-held response's turn span already ended at hold time —
      // only the upstream answer is still owed
      if (req.heldResponse === undefined) {
        req.prompt?.span.endDetached({ 'acp.error': 'downstream closed' }, 'error');
      }
      writeUp({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'acp proxy: downstream agent closed' },
      } as AnyMessage);
    }
  }

  // upstream dead → every a2c request still in flight is answered
  // downstream: a client that can never answer must not leave the
  // agent stalled on its question (the mirror of the sweep above).
  // Permission asks get the wire's honest outcome — cancelled;
  // anything else gets the same internal error a dead peer earns.
  if (verdict === 'up') {
    for (const [id, req] of pendingA2C) {
      pendingA2C.delete(id);
      if (req.permission !== undefined) {
        notePermission(req.sessionId === undefined ? undefined : sessions.get(req.sessionId), {
          title: req.permission.title ?? req.permission.toolCallId ?? 'permission request',
          toolCallId: req.permission.toolCallId,
          decidedBy: 'proxy',
          verdict: 'cancelled',
          reason: 'upstream client closed',
        });
        writeDown({
          jsonrpc: '2.0',
          id,
          result: { outcome: { outcome: 'cancelled' } },
        } as AnyMessage);
      } else {
        writeDown({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: 'acp proxy: upstream client closed' },
        } as AnyMessage);
      }
    }
  }

  for (const ses of sessions.values()) {
    // endDetached — the process exits right after this return, an
    // in-flight fetch here never lands (spec bro-huy5o.11 §endDetached)
    ses.span?.endDetached({ 'acp.proxy.verdict': verdict });
    await ses.plane?.drain();
  }
  // both legs close — the writer locks release and the streams settle
  for (const w of [upWriter, downWriter]) {
    try {
      await w.close();
    } catch {
      /* already closed / broken pipe — teardown is best-effort */
    }
  }
  return verdict === 'up' ? 0 : 1;
}

/**
 * The CLI entry — spawn `<cmd>`, wire the proxy's own stdio as the
 * upstream transport and the child's stdio as downstream, run the pump,
 * then reap. `command` is already tokenized (everything after `--`),
 * exec'd directly — never through a shell.
 */
export async function runAcpProxy(command: string[], opts: AcpProxyOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const bin = command[0];
  if (bin === undefined) {
    log('acp proxy: empty downstream command');
    return 2;
  }
  const child: ChildProcess = spawn(bin, command.slice(1), {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: acpChildEnv(),
  });
  // a failed exec answers 'error' ASYNC — the stream wrap below must
  // not synchronously unwrap null stdio first, and the proxy must not
  // wait for the client's EOF to report a spawn that never happened:
  // the exit race ends the run with the downstream-dead verdict.
  const execFailed = new Promise<number>(resolve => {
    child.once('error', e => {
      log(`acp proxy: cannot exec '${bin}' — ${e.message}`);
      resolve(1);
    });
  });
  if (child.stdin === null || child.stdout === null) {
    log(`acp proxy: cannot exec '${bin}' — no stdio pipes`);
    child.kill();
    return 1;
  }
  const downstream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  );
  const upstream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );
  const code = await Promise.race([acpProxy(upstream, downstream, opts), execFailed]);
  // upstream end → close the agent; a wedged child still dies on the
  // process exit that follows
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  return code;
}
