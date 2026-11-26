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
 *
 * Writes carry the peer's own backpressure (bro-0w2tg): a leg whose
 * sink stops accepting queues outbound writes only to a high-water
 * mark, pausing the pump that feeds it until drain — and a leg with
 * no write progress for `writeStallMs` is declared dead, so a stalled
 * peer ends in the normal verdict/teardown path, not a memory climb.
 * Intake is bounded the same way — a pump whose consumed-but-unrouted
 * hold reaches its own mark stops reading — while liveness traffic
 * (request answers, session/cancel) still routes past a full queue:
 * the gate must never sit between a peer and the message that frees
 * it. The bypass moves the control message only — the queued data it
 * overtakes keeps its bound, and a cancel still settles the work it
 * jumped straight out of the hold.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  AnyMessage,
  AvailableCommand,
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

/** One local turn on bro's side of the wire (spec bro-tegz2) — a
 *  slash command running inside the session's serialized writeQ.
 *  `emit` streams session/update notifications upstream, guarded by
 *  the prompt's pending entry: a cancelled turn emits nothing.
 *  `signal` fires on session/cancel — the running command's cue to
 *  die; the client has already been answered `cancelled` by then. */
export interface AcpAgentTurn {
  sessionId: string;
  /** session/new's cwd — the local command's repo; never the proxy's. */
  cwd: string | undefined;
  /** The prompt's flattened text — the slash parse reads this. */
  text: string;
  emit(update: SessionUpdate): void;
  signal: AbortSignal;
}

/** The agent-mode overlay (spec bro-tegz2): bro IS the agent — its
 *  own identity on initialize, its command surface announced per
 *  session, and a local-turn handler ahead of the verbatim path.
 *  Everything else stays the pump's: free-form prompts forward
 *  downstream with the seam; cancel/close/gate keep their meanings. */
export interface AcpAgentOverlay {
  /** bro's identity for the initialize answer — the downstream's
   *  original agentInfo survives under _meta.bro.downstreamAgent.
   *  Capabilities stay verbatim: the downstream negotiates what
   *  prompts can do; bro never claims caps it won't serve. */
  agentInfo?: { name: string; version?: string; title?: string };
  /** Commands announced once per stamped session — one upstream
   *  available_commands_update right after the open response crosses. */
  commands?: AvailableCommand[];
  /** The local turn handler — runs inside the session's writeQ before
   *  the injection/forward path. A non-undefined return answers the
   *  prompt request upstream and nothing crosses; `undefined` falls
   *  through to today's verbatim + seam path. A throw answers a
   *  -32603 error upstream — never a synthesized success. */
  prompt?(turn: AcpAgentTurn): Promise<{ stopReason: string } | undefined>;
}

export type OverlayPrompt = NonNullable<AcpAgentOverlay['prompt']>;

export interface AcpProxyOptions {
  seam?: AcpProxySeam;
  /** Agent mode (spec bro-tegz2) — bro's own surface on top of the
   *  verbatim pump: identity, command announcement, local turns. */
  agent?: AcpAgentOverlay;
  /** Write-stall bound (ms) — a leg whose outbound writes make no
   *  progress for this long is declared dead: the peer stopped
   *  reading, and the verdict race/teardown sweep handle it like any
   *  dead leg. Defaults to ACP_PROXY_WRITE_STALL_MS. */
  writeStallMs?: number;
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
export interface ProxySession {
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
  /** The downstream's last-announced slash-command list — cached so
   *  the overlay's own surface composes with it instead of replacing
   *  it: an available_commands_update is the session's CURRENT list,
   *  not a delta (spec bro-tegz2). */
  downstreamCommands: AvailableCommand[];
  /** undefined when the session has no cwd — the plane resolves inside
   *  the session repo or doesn't exist. */
  plane: AgentTurnPlane | undefined;
  span: OtelSpan | undefined;
}

/** A request forwarded downstream that has not answered yet — on a
 *  dead agent the pending entries fail visibly, never vanish. */
export interface PendingRequest {
  method: string;
  /** session/prompt bookkeeping — the turn span and its session.
   *  `first` stamps at cross time (first prompt to actually write
   *  downstream) for the span's first_prompt attr. `release` is the
   *  bound slot the prompt's accept charged — kept on the entry so a
   *  cancel/close settling the prompt while it still sits in the
   *  writeQ frees the slot AT SETTLE, not whenever the seam ahead of
   *  it returns: a cancelled backlog behind a stuck seam otherwise
   *  keeps the ledger full forever (holds never arm the stall clock),
   *  and a full leg stalls every sibling session's intake. The
   *  release is idempotent — the queued cross's own exit still runs
   *  it safely. `detach` drops the queued cross's payload cell — a
   *  prompt settled while still queued behind a stuck writeQ must
   *  not pin its message and params for the life of the wait (the
   *  chain itself can't be unlinked, but the payload it would act
   *  on can go). */
  prompt?: {
    sessionId: string;
    span: OtelSpan;
    first?: boolean;
    release?: () => void;
    detach?: () => void;
  };
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
  /** Agent-mode bookkeeping — armed while the overlay's local turn
   *  runs: session/cancel's abortHeld fires it so the running command
   *  dies with its `cancelled` answer instead of finishing alone. */
  abort?: () => void;
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
export interface PendingA2C {
  method: string;
  sessionId?: string;
  /** The bound slot a held ask's policy eval occupies — kept on the
   *  entry so a cancel/close settling the ask mid-eval frees the slot
   *  AT SETTLE, not whenever a stuck policy returns: parked evals
   *  otherwise keep the ledger full forever (holds never arm the
   *  stall clock, so nothing would recover the leg). The release is
   *  idempotent — the eval's own exit still runs it safely. */
  release?: () => void;
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
export function latch(): { promise: Promise<void>; fire: () => void; fired: boolean } {
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

export const wire = (m: AnyMessage): Wire => m as Wire;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isRequest = (m: AnyMessage): boolean =>
  typeof wire(m).method === 'string' && wire(m).id !== undefined;

export const isNotification = (m: AnyMessage): boolean =>
  typeof wire(m).method === 'string' && wire(m).id === undefined;

export const isResponse = (m: AnyMessage): boolean =>
  wire(m).method === undefined && wire(m).id !== undefined;

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A thrown value's log text — a seam/hook can reject with ANYTHING
 *  (null, a bare string, a non-Error object); reading `e.message`
 *  inside the catch throws a second error on a nullish reject. */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A broken stop probe must be visible, but a long-lived session must not
 * turn every prompt into a warning. This is deliberately process-local:
 * diagnostics are best effort and must never add a persistence failure path
 * to the fail-open gate. */
const STOP_GATE_DIAG_INTERVAL_MS = 15 * 60_000;
interface StopGateProbeContext {
  gate: NonNullable<AcpProxySeam['stopGate']>;
  cwd: string;
  sessionId: string;
  outages: Map<string, number>;
  log: (line: string) => void;
}

export const runStopGateProbe = async ({
  gate,
  cwd,
  sessionId,
  outages,
  log,
}: StopGateProbeContext): Promise<{ block?: string; hints?: string[] } | undefined> => {
  try {
    const outcome = await gate(cwd, sessionId);
    const prefix = `${sessionId}\u0000`;
    const active = [...outages.keys()].filter(key => key.startsWith(prefix));
    for (const outage of active) {
      outages.delete(outage);
    }
    if (active.length > 0) {
      log(`acp proxy: stop gate probe recovered (session ${sessionId})`);
    }
    return outcome;
  } catch (e) {
    const cause = errText(e);
    const failureClass = /timeout|timed out/i.test(cause)
      ? 'timeout'
      : /not found|enoent|cannot exec|spawn/i.test(cause)
        ? 'spawn'
        : 'probe-error';
    const key = `${sessionId}\u0000${failureClass}`;
    const now = Date.now();
    const last = outages.get(key);
    if (last === undefined || now - last >= STOP_GATE_DIAG_INTERVAL_MS) {
      outages.set(key, now);
      log(
        `acp proxy: stop gate probe unavailable (session ${sessionId}; ${cause}) — the stop is unguarded`
      );
    }
    return undefined;
  }
};

export const paramsOf = (m: AnyMessage): Record<string, unknown> | undefined => {
  const p = wire(m).params;
  return isRecord(p) ? p : undefined;
};

export const sessionIdOf = (m: AnyMessage): string | undefined => str(paramsOf(m)?.['sessionId']);

/** Flatten a prompt's text blocks for the prompt-submit probes — the
 *  same join the fake agent does (`text` blocks concat, non-text
 *  contributes nothing — the probes read prompt text, not images). */
export const promptText = (params: Record<string, unknown>): string =>
  (Array.isArray(params['prompt']) ? params['prompt'] : [])
    .map(b => (isRecord(b) && b['type'] === 'text' ? (str(b['text']) ?? '') : ''))
    .join('');

/** Outbound backpressure bounds (bro-0w2tg): the per-leg count of
 *  unsettled writer.write() promises at which the feeding pump pauses
 *  (HIGH_WATER), and the write-progress silence after which a leg is
 *  declared dead (STALL_MS — the bound that lets a stalled peer fall
 *  into the normal verdict/teardown path instead of parking the wire
 *  forever). */
export const ACP_PROXY_WRITE_HIGH_WATER = 64;
export const ACP_PROXY_WRITE_STALL_MS = 30_000;

/** Inbound backpressure bound (bro-0w2tg): the count of consumed-but-
 *  unrouted messages a pump may hold before its READ side pauses too —
 *  the write mark bounds what the peer owes, this bounds what the
 *  backlog in between can grow to. A saturated hold makes room only
 *  when the outbound ledger drains, so a stalled leg caps the wire's
 *  whole in-flight footprint instead of letting a fast sender outrun
 *  every timeout the legs carry. */
export const ACP_PROXY_READ_HIGH_WATER = 64;

/** Teardown's flush grace — writer.close() queues behind writes a
 *  stalled peer can never accept, so a leg gets this long to land
 *  what was owed before abort() abandons the queue (the verdict has
 *  already settled — a peer that cannot read the answers cannot miss
 *  them). The clock resets on every landed write: a live peer that
 *  keeps draining is owed its replies, only a full grace of silence
 *  abandons the queue. */
export const CLOSE_GRACE_MS = 1_000;

/** The backpressure ledger for one writable leg (bro-0w2tg): writes
 *  still issue immediately and in order, but their awaited settle promises
 *  now feed `depth` — a writer.write() settles only when the peer's
 *  sink accepts the encoded line, so a peer that stops reading lets
 *  writes queue only to the high-water bound. `holds` charges work that
 *  was accepted but has not written yet — a session prompt queued on
 *  its writeQ behind a slow seam, a permission ask mid-eval — so the
 *  bound covers intake the wire count cannot see yet. Once depth plus
 *  holds reaches ACP_PROXY_WRITE_HIGH_WATER the read pump feeding this
 *  leg pauses on room() until the queue drains — the peer's own read
 *  pace is the throttle and no message is ever dropped (a dropped
 *  request breaks the session's id pairing). Writes produced outside
 *  the pump's own route — seam answers, abort sweeps, the teardown
 *  flush — are bounded reactions to messages already received, so
 *  they share the ledger without needing their own pause. */
