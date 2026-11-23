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
interface PendingRequest {
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
interface PendingA2C {
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

/** A thrown value's log text — a seam/hook can reject with ANYTHING
 *  (null, a bare string, a non-Error object); reading `e.message`
 *  inside the catch throws a second error on a nullish reject. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
const CLOSE_GRACE_MS = 1_000;

/** The backpressure ledger for one writable leg (bro-0w2tg): writes
 *  still issue immediately and in order, but their settle promises
 *  now feed `depth` — a writer.write() settles only when the peer's
 *  sink accepts the encoded line, so a peer that stops reading lets
 *  un-awaited writes queue without bound. `holds` charges work that
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
interface Outbound {
  /** Issue a wire write — order-preserved, fire-and-forget exactly
   *  like the un-awaited write was: a rejection fires the leg's dead
   *  latch. A leg already declared dead accepts nothing — its queued
   *  writes abandon at teardown either way, and a peer that resumes
   *  mid-close must never execute work its callers already lost. */
  send(m: AnyMessage): void;
  /** Charge one accepted-but-unwritten slot against the bound —
   *  returns the idempotent release, which the caller runs when its
   *  write issues (the write's own depth takes the slot over) or the
   *  work dies unrouted. */
  hold(): () => void;
  /** Synchronous room check — the pump's fast path. */
  spare(): boolean;
  /** Resolves once the ledger drops below the high-water mark —
   *  or immediately when the leg is already dead: a stalled leg's
   *  verdict belongs to the teardown race, never a sleeping pump. */
  room(): Promise<void>;
  /** Resolves on the leg's NEXT write settle — FIFO one-shot: each
   *  caller's wait ends on exactly one settle, in the order writes
   *  land. The intake bypass count decays on it — a bypassed
   *  control's charge is ordinary depth once its write issues, so
   *  holding the charge until room() returns would park the read
   *  behind ledger holds the bypass no longer represents. A dead
   *  leg releases every waiter. */
  nextSettle(): Promise<void>;
  /** The last write progress — teardown's close grace resets on it. */
  lastProgressAt(): number;
}

const outbound = (
  writer: WritableStreamDefaultWriter<AnyMessage>,
  dead: ReturnType<typeof latch>,
  stallMs: number
): Outbound => {
  let depth = 0;
  let holds = 0;
  let lastProgress = Date.now();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const waiters = new Set<() => void>();
  const settleWaiters: Array<() => void> = [];
  const full = (): boolean => !dead.fired && depth + holds >= ACP_PROXY_WRITE_HIGH_WATER;
  const release = (): void => {
    for (const w of waiters) w();
    waiters.clear();
  };
  const disarm = (): void => {
    if (stall !== undefined) {
      clearTimeout(stall);
      stall = undefined;
    }
  };
  /** The stall bound lives only while depth is nonzero — a leg with
   *  unsettled writes but no settle for stallMs is dead (the peer
   *  stopped reading); any settle is progress and moves the deadline.
   *  ONE deadline rearmed from the last progress — not an interval:
   *  an interval's tick alignment lets silence run nearly a whole
   *  extra period past the mark before a tick even looks. And not a
   *  per-write deadline: under a healthy flood each write settles
   *  behind the queue, so the deadline rides the LAST progress and a
   *  busy leg only pushes it out. Holds never arm it —
   *  accepted-but-unwritten work is not evidence the peer stopped
   *  reading. */
  const rearm = (): void => {
    if (dead.fired || depth === 0) {
      return;
    }
    if (stall !== undefined) {
      clearTimeout(stall);
      stall = undefined;
    }
    stall = setTimeout(
      () => {
        stall = undefined;
        if (dead.fired || depth === 0) {
          return;
        }
        if (Date.now() - lastProgress >= stallMs) {
          dead.fire();
        } else {
          rearm(); // the clock moved backwards — measure the remainder
        }
      },
      Math.max(stallMs - (Date.now() - lastProgress), 1)
    );
    stall.unref();
  };
  const arm = (): void => {
    if (stall !== undefined || dead.fired || depth === 0) {
      return;
    }
    lastProgress = Date.now();
    rearm();
  };
  // a dead leg releases every waiter and never measures stalls again
  void dead.promise.then(() => {
    disarm();
    release();
    for (const w of settleWaiters.splice(0)) {
      w();
    }
  });
  const settled = (): void => {
    depth--;
    lastProgress = Date.now();
    if (depth === 0) {
      disarm();
    } else {
      rearm();
    }
    settleWaiters.shift()?.();
    if (!full()) {
      release();
    }
  };
  return {
    send(m) {
      if (dead.fired) {
        return;
      }
      depth++;
      arm();
      writer.write(m).then(settled, () => {
        settled();
        dead.fire();
      });
    },
    hold() {
      holds++;
      let freed = false;
      return () => {
        if (freed) {
          return;
        }
        freed = true;
        holds--;
        if (!full()) {
          release();
        }
      };
    },
    nextSettle() {
      // pends even with depth 0 — the caller's own write is usually
      // the settle it waits for; a dead leg drains every waiter
      return dead.fired
        ? Promise.resolve()
        : new Promise<void>(r => {
            settleWaiters.push(r);
          });
    },
    spare() {
      return !full();
    },
    room() {
      return !full()
        ? Promise.resolve()
        : new Promise<void>(r => {
            waiters.add(r);
          });
    },
    lastProgressAt() {
      return lastProgress;
    },
  };
};

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
  /** The pumps' intake holds — caller-owned arrays (not pump-private)
   *  so the route layer can settle what a leapfrogged control
   *  overtook: the c2a hold is read by the session/cancel and
   *  $/cancel_request sweeps for work queued ahead of the cancel
   *  that must still not cross; the a2c hold is read by the cancel's
   *  intake-ask sweep (a parked ask still settles cancelled) and by
   *  the pump's own ordering pull — a response must not overtake
   *  held messages of the session it ends. */
  const heldC2A: AnyMessage[] = [];
  const heldA2C: AnyMessage[] = [];
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

  /** Per-leg backpressure ledgers — the pumps pause on room(), the
   *  writes themselves keep their fire-and-forget shape (order-
   *  preserved, errors fire the leg's dead latch). The stall bound is
   *  clamped into Node's timer range — a delay past 2^31-1 (Infinity
   *  included) coerces to ~1ms, which would declare healthy legs dead
   *  almost immediately instead of "much later" as configured. */
  const MAX_TIMER_MS = 2_147_483_647;
  const rawStall = opts.writeStallMs ?? ACP_PROXY_WRITE_STALL_MS;
  const stallMs = Number.isNaN(rawStall)
    ? ACP_PROXY_WRITE_STALL_MS
    : Math.min(Math.max(rawStall, 1), MAX_TIMER_MS);
  const downOut = outbound(downWriter, downDead, stallMs);
  const upOut = outbound(upWriter, upDead, stallMs);
  const writeDown = (m: AnyMessage): void => {
    downOut.send(m);
  };
  const writeUp = (m: AnyMessage): void => {
    upOut.send(m);
  };

  /** Set the moment a pump's EOF/death wins the verdict — BEFORE the
   *  teardown sweep aborts in-flight turns. A prompt still queued in
   *  a session writeQ has no abort armed yet, and on an upstream
   *  close nothing discharges its pending entry: without this flag a
   *  queued slash command would spawn AFTER the client died. The
   *  latch twin releases a pump parked on outbound backpressure —
   *  an EOF verdict never touches the dead latches, and a parked pump
   *  must not linger for the stalled leg's writeStallMs. */
  let wireDone = false;
  const wireDoneLatch = latch();

  /** Answer an upstream request ourselves — only the held-prompt
   *  cancel path uses this; the proxy never synthesizes success. */
  const answerUpstream = (id: JsonRpcId, result: unknown): void => {
    writeUp({ jsonrpc: '2.0', id, result } as AnyMessage);
  };

  /** Session-scoped downstream writes queue through the session's
   *  writeQ so nothing overtakes a first prompt still collecting its
   *  injection. Non-session methods write immediately — a session id
   *  is the only ordering key the wire gives us. The queue is charged
   *  against the down leg's bound at accept: a prompt backed up behind
   *  a slow seam has not written yet, so without the hold the wire
   *  count would read zero while the session's backlog — and the
   *  intake feeding it — grew without bound. Both then-arms run the
   *  task so a writeQ rejection can never strand a queued write AND
   *  its charged slot; the release fires when the write issues (its
   *  own depth takes the slot over) or the dead leg skips it. */
  const writeDownFor = (sessionId: string | undefined, m: AnyMessage): void => {
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (ses === undefined) {
      writeDown(m);
      return;
    }
    const release = downOut.hold();
    const queued = (): void => {
      release();
      if (!downDead.fired) {
        writeDown(m);
      }
    };
    ses.writeQ = ses.writeQ.then(queued, queued);
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
    // charge the down leg's bound AT ACCEPT — a prompt waiting on the
    // seam has no wire depth yet, so without the hold a prompt flood
    // parks nothing while pending/writeQ/held grow past the mark.
    // The slot lives on the entry: a session/cancel settling this
    // prompt while it still waits in the writeQ frees the slot at
    // settle (abortHeld), not whenever the seam ahead of it returns.
    const release = downOut.hold();
    // the queued cross reads its payload through a cell the settle
    // path clears via `detach` — a prompt cancelled while still
    // queued behind a stuck writeQ is discharged from `pending`, and
    // without the detach its message and params would stay retained
    // by this closure for the life of the queue (the chain itself
    // can't be unlinked, the payload it would act on can)
    const cell: { m?: AnyMessage; params?: Record<string, unknown> } = {
      m,
      params: target.params,
    };
    const entry: PendingRequest = {
      method: 'session/prompt',
      prompt: {
        sessionId: target.sessionId,
        span: turn,
        release,
        detach: () => {
          cell.m = undefined;
          cell.params = undefined;
        },
      },
    };
    pending.set(id, entry);
    target.ses.held.add(id);
    const { sessionId, ses } = target;
    // the entry is captured AT ENQUEUE — if a cancel discharges the
    // id and a new request reuses it before this queued write runs,
    // `pending.get(id)` inside crossPrompt would return the NEW
    // request's entry and every identity check would pass for the
    // stale turn. Both then-arms dispatch so a writeQ rejection can
    // never strand the charged slot
    const queued = (): Promise<void> => {
      const cm = cell.m;
      const cp = cell.params;
      cell.m = undefined;
      cell.params = undefined;
      return cm === undefined || cp === undefined
        ? Promise.resolve()
        : crossPrompt({ m: cm, id, own: entry, release, params: cp, sessionId, ses });
    };
    target.ses.writeQ = target.ses.writeQ.then(queued, queued);
  };

  /** Still writable? pending discharged → the cancel path already
   *  answered this prompt upstream; downstream dead → nothing crosses
   *  anyway; the wire closed → queued work never starts. Identity,
   *  not presence: a reused id belongs to the newer request. The two
   *  check points bracket the seam collection — the abortable
   *  window. */
  const crossable = (id: JsonRpcId, own: PendingRequest): boolean =>
    pending.get(id) === own && !downDead.fired && !wireDone;

  /** Up-leg room for a LOCAL turn's answer — the c2a intake bound
   *  watches the DOWN leg only, so a client that keeps prompting but
   *  stops reading replies would let local results queue on upOut
   *  past the mark until the stall bound declared the leg dead (the
   *  stall limits duration, not count). Parking the answer inside the
   *  session's writeQ IS the intake pause: cancellation and reply
   *  processing stay live — a session/cancel answers the entry
   *  upstream through abortHeld and the discharged entry fails the
   *  post-wait recheck — and a dead leg or shutdown releases the
   *  wait outright. (Mid-turn `emit` writes keep their
   *  fire-and-forget depth charge — one turn's emit volume is the
   *  residual the stall bound still owns.) */
  const upRoom = (): Promise<unknown> => Promise.race([upOut.room(), wireDoneLatch.promise]);

  /** The held write, run inside the session's writeQ: "first prompt" =
   *  first to actually CROSS, decided here under the serialized queue —
   *  a cancelled held prompt never claims the slot, and two queued
   *  prompts can't both take it. `release` frees the bound slot the
   *  accept charged — the crossed write's own depth takes it over. */
  const crossPrompt = async (held: {
    m: AnyMessage;
    id: JsonRpcId;
    own: PendingRequest;
    release: () => void;
    params: Record<string, unknown>;
    sessionId: string;
    ses: ProxySession;
  }): Promise<void> => {
    const { m, id, own, release, params, sessionId, ses } = held;
    try {
      if (!crossable(id, own)) {
        return;
      }
      // agent mode (spec bro-tegz2): the overlay's local turn handler
      // gets the prompt before the injection/forward path — inside the
      // session's writeQ, so local work serializes with crossed prompts
      // exactly like a downstream turn. A non-undefined return answers
      // upstream and nothing crosses; undefined falls through. A local
      // turn never claims the first-prompt slot, never feeds the gate —
      // it produces no downstream response to hold.
      const overlay = opts.agent?.prompt;
      if (overlay !== undefined) {
        const ctrl = new AbortController();
        own.abort = () => ctrl.abort();
        let result: { stopReason: string } | undefined;
        let threw = false;
        let failure: unknown;
        try {
          result = await overlay({
            sessionId,
            cwd: ses.cwd,
            text: promptText(params),
            emit: update => {
              // guarded by the pending entry — a cancel that landed
              // mid-turn already answered and discharged it, and a
              // request that reused the id is a different turn: a late
              // emit must not reach either wire
              if (pending.get(id) === own && !upDead.fired) {
                writeUp({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: { sessionId, update },
                } as AnyMessage);
              }
            },
            signal: ctrl.signal,
          });
        } catch (e) {
          // a `throw undefined` is still a crashed handler — a boolean
          // flag, not the thrown value, decides the error path
          threw = true;
          failure = e;
        } finally {
          own.abort = undefined;
        }
        if (threw) {
          // a crashed handler is a -32603 upstream — never a fake
          // success; a cancel that already answered wins the race, and
          // a reused id belongs to its new request. The answer gates
          // on up-leg room like any local result
          if (pending.get(id) === own) {
            await upRoom();
            if (pending.get(id) === own) {
              // the held marker this request owns goes with its
              // discharge — dropping pending first would orphan it
              // (every later cancel would walk a dead id forever)
              ses.held.delete(id);
              pending.delete(id);
              own.prompt?.span.end({ 'acp.proxy.local': true, 'acp.error': true }, 'error');
              writeUp({
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32603,
                  message: `acp agent: local turn failed — ${failure instanceof Error ? failure.message : String(failure)}`,
                },
              } as AnyMessage);
            }
          }
          return;
        }
        if (result !== undefined) {
          if (pending.get(id) === own) {
            // the local result is an upstream write the c2a bound
            // can't see — admit it only once the up leg has room so
            // a client that stopped reading throttles local intake
            // instead of being found by the stall bound
            await upRoom();
            if (pending.get(id) === own) {
              ses.held.delete(id);
              pending.delete(id);
              own.prompt?.span.end({
                'acp.proxy.local': true,
                'acp.stop_reason': result.stopReason,
              });
              answerUpstream(id, result);
            }
          }
          return;
        }
        // the overlay declined — the verbatim path resumes; the await
        // was a cancel window, so re-check before the seam collection
        if (!crossable(id, own)) {
          return;
        }
      }
      const first = !ses.seenPrompt;
      const injected = await injectPrompt(m, params, sessionId, ses);
      if (!crossable(id, own)) {
        return;
      }
      if (own.prompt !== undefined) own.prompt.first = first;
      ses.seenPrompt = true;
      // a settled collection that crosses closes the slot; an
      // unsettled one stays owed — the next prompt retries
      ses.sessionCtxDone = ses.sessionCtxDone || injected.sessionCtxSettled;
      ses.plane?.start();
      writeDown(injected.m);
    } finally {
      // the charged slot frees with the write attempt — a crossed
      // prompt's depth took it over inside the try, every other exit
      // leaves no write to claim it
      release();
      // drop the held marker only while the id still names THIS
      // request — a reused id's marker belongs to the newer request
      if (pending.get(id) === own) {
        ses.held.delete(id);
      }
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
      const req = pending.get(id);
      const pr = req?.prompt;
      if (pr === undefined || pr.sessionId !== sessionId) {
        continue;
      }
      pending.delete(id);
      // the charged bound slot frees WITH the settle — the queued
      // cross would hold it until every prompt ahead of it finished
      // its seam wait, and holds never arm the stall clock: a
      // cancelled backlog behind a stuck seam would pin the leg full
      // (and every sibling session's intake with it) for dead work.
      // Idempotent — the queued cross's own exit release is a no-op
      pr.release?.();
      // the queued cross's payload goes with the settle — a prompt
      // still parked behind a stuck queue must not pin its message
      // for the life of the wait
      pr.detach?.();
      // agent mode: a local turn in flight dies with its answer — the
      // SIGTERM lands before `cancelled` crosses
      req?.abort?.();
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

  /** Answer every INTAKE-held session/prompt of the session upstream
   *  `stopReason:'cancelled'` — a control message that overtook the
   *  c2a pump's hold must still reach the prompts queued ahead of it:
   *  they never routed, so there is no pending entry, span, or
   *  writeQ slot to discharge — the settle is the same upstream
   *  answer the writeQ-held prompts get, minus the bookkeeping.
   *  Pulling them out of the hold keeps the wire's own rule: never a
   *  prompt after its cancel. Returns the count — the pulls count as
   *  proxy-handled exactly like the writeQ-held ones. */
  const abortIntakePrompts = (sessionId: string): number => {
    let aborted = 0;
    for (let i = heldC2A.length - 1; i >= 0; i--) {
      const m = heldC2A[i] as AnyMessage;
      if (wire(m).method !== 'session/prompt' || sessionIdOf(m) !== sessionId) {
        continue;
      }
      heldC2A.splice(i, 1);
      aborted++;
      answerUpstream(wire(m).id as JsonRpcId, { stopReason: 'cancelled' });
    }
    return aborted;
  };

  /** Answer every INTAKE-held permission ask of the session
   *  downstream `cancelled` — an ask still parked in heldA2C behind
   *  a full upstream ledger never reached pendingA2C, so
   *  abortHeldAsks cannot see it: a cancel that overtook the hold
   *  must pull it here or the eval would later show the client a
   *  permission prompt for a turn it already cancelled. Other
   *  sessions' asks stay in order; asks already forwarded upstream
   *  keep their relay — same rule as the held prompts, one
   *  direction over. Returns the count. */
  const abortIntakeAsks = (sessionId: string, reason: string): number => {
    let aborted = 0;
    for (let i = heldA2C.length - 1; i >= 0; i--) {
      const m = heldA2C[i] as AnyMessage;
      if (wire(m).method !== PERMISSION_METHOD || wire(m).id === undefined) {
        continue;
      }
      if (sessionIdOf(m) !== sessionId) {
        continue;
      }
      heldA2C.splice(i, 1);
      const tc = paramsOf(m)?.['toolCall'];
      const toolCall = isRecord(tc) ? tc : undefined;
      aborted++;
      notePermission(sessions.get(sessionId), {
        title: str(toolCall?.['title']) ?? str(toolCall?.['toolCallId']) ?? 'permission request',
        toolCallId: str(toolCall?.['toolCallId']),
        decidedBy: 'proxy',
        verdict: 'cancelled',
        reason,
      });
      answerPermission(wire(m).id as JsonRpcId, { outcome: 'cancelled' });
    }
    return aborted;
  };

  /** Release a session — held prompts answered, state dropped, span
   *  ended, plane drained. Runs on a successful session/close response
   *  (a failed close leaves the session live — the close never took). */
  const releaseSession = (sessionId: string, ses: ProxySession): void => {
    abortHeld(ses, sessionId);
    abortGateHeld(sessionId);
    abortHeldAsks(sessionId, 'session closed while the policy evaluated');
    abortIntakeAsks(sessionId, 'session closed before the ask crossed');
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
    // intake-held prompts first — a cancel that overtook the pump's
    // hold still reaches the prompts queued ahead of it, and the pull
    // counts as proxy-handled exactly like the writeQ-held settle
    // below (their whole target set never crossed either)
    const intakeAborted = sessionId === undefined ? 0 : abortIntakePrompts(sessionId);
    const ses = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (ses === undefined || sessionId === undefined) {
      return true;
    }
    // gate-held prompts answer upstream the same way held ones do —
    // a cancel settles the client's request 'cancelled' and the gate
    // eval (or the gate turn's late response) lands on an empty slot.
    // Held permission asks settle downstream the same way — the wire
    // never shows an ask after its cancel either — including asks
    // still parked in the a2c intake hold (no pending entry yet)
    const aborted =
      intakeAborted +
      abortHeld(ses, sessionId) +
      abortGateHeld(sessionId) +
      abortHeldAsks(sessionId, 'session cancelled while the policy evaluated') +
      abortIntakeAsks(sessionId, 'session cancelled before the ask crossed');
    if (aborted === 0) {
      return true;
    }
    return [...pending.values()].some(p => p.prompt?.sessionId === sessionId);
  };

  /** A $/cancel_request whose TARGET still sits in the c2a intake
   *  hold settles it right there — a control message that overtook
   *  the hold must still reach the request queued ahead of it. The
   *  request never crossed, so the proxy answers it upstream itself:
   *  a prompt gets the wire's own cancelled outcome, anything else
   *  the JSON-RPC -32800 the SDK's abort path emits for a cancelled
   *  request. The notification still forwards verbatim — a target
   *  that already crossed is the agent's to cancel. */
  const settleIntakeCancel = (m: AnyMessage): void => {
    const target = paramsOf(m)?.['id'];
    if (target === undefined) {
      return;
    }
    const idx = heldC2A.findIndex(h => wire(h).id === target);
    if (idx < 0) {
      return;
    }
    const req = heldC2A.splice(idx, 1)[0] as AnyMessage;
    const id = wire(req).id as JsonRpcId;
    if (wire(req).method === 'session/prompt') {
      answerUpstream(id, { stopReason: 'cancelled' });
      return;
    }
    writeUp({
      jsonrpc: '2.0',
      id,
      error: { code: -32800, message: 'request cancelled' },
    } as AnyMessage);
  };

  /** c2a notification — verbatim modulo the cancel checks. */
  const onClientNotification = (m: AnyMessage): void => {
    if (wire(m).method === '$/cancel_request') {
      settleIntakeCancel(m);
    }
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
        log(`acp proxy: tool_call hook eval failed (session ${sessionId}) — ${errText(e)}`);
      }
    });
  };

  /** Compose the overlay's surface with the downstream's last-announced
   *  list — a local name shadows a same-named downstream command,
   *  matching the precedence the local-turn handler gives it (a /name
   *  bro serves never reaches the agent). */
  const mergedCommands = (ses: ProxySession): AvailableCommand[] => {
    const local = opts.agent?.commands ?? [];
    const names = new Set(local.map(c => c.name));
    return [...local, ...ses.downstreamCommands.filter(c => !names.has(c.name))];
  };

  /** One upstream available_commands_update announcing the merged list. */
  const commandsUpdate = (sessionId: string, commands: AvailableCommand[]): AnyMessage =>
    ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
      },
    }) as AnyMessage;

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
    const entry: PendingA2C = { method: PERMISSION_METHOD, sessionId, permission: perm };
    pendingA2C.set(id, entry);
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
    // charge the up leg's bound AT ACCEPT — a held ask mid-eval has no
    // wire depth yet, so without the hold an ask flood parks nothing
    // while pendingA2C entries and detached evals grow past the mark.
    // The slot lives on the entry so a settle that lands mid-eval —
    // cancel, close, teardown — frees it at settle time instead of
    // whenever the policy returns
    const release = upOut.hold();
    entry.release = release;
    void (async () => {
      try {
        let outcome: AcpProxyPermissionVerdict | undefined;
        try {
          outcome = await fn(cwd, sessionId, call);
        } catch (e) {
          log(`acp proxy: permission eval failed (session ${sessionId}) — ${errText(e)}`);
        }
        settlePermission(m, id, ses, sessionId, outcome);
      } finally {
        // the slot frees with the settle — a forwarded ask's own write
        // depth took it over, an answered one left nothing on the leg
        release();
      }
    })().catch((e: unknown) => {
      // a settle crash must not escape as an unhandled rejection —
      // and a still-held ask must not strand the agent on its
      // question: the seam's own fail-open posture, the ask crosses
      // verbatim (an entry already discharged has nothing to settle)
      try {
        log(`acp proxy: permission settle failed (session ${sessionId}) — ${errText(e)}`);
        const req = pendingA2C.get(id);
        if (req?.permission?.held === true) {
          req.permission.held = false;
          writeUp(m);
        }
      } catch {
        /* the writer is gone — the teardown sweep answers what it can */
      }
    });
  };

  /** Answer every held permission ask of the session downstream
   *  `cancelled` — a cancel/close settles the ask where it stands:
   *  held asks never crossed, so the wire never shows an ask after
   *  its cancel. Forwarded asks keep their pending entry — the
   *  client's own answer is owed the relay. `reason` is the caller's
   *  why: a session/cancel and a clean session/close settle the same
   *  held ask with different semantics, and the journal row should
   *  say which it was. The loop iterates a snapshot — the body
   *  deletes from the table it walks (the `[...pending]` discipline
   *  the downstream sweep already uses). Returns the count. */
  const abortHeldAsks = (sessionId: string, reason: string): number => {
    let aborted = 0;
    for (const [id, req] of [...pendingA2C]) {
      if (req.sessionId !== sessionId || req.permission?.held !== true) {
        continue;
      }
      pendingA2C.delete(id);
      // the charged slot frees WITH the settle — a policy eval still
      // parked after its ask was cancelled must not keep the ledger
      // full (the idempotent release makes the eval's own exit a
      // no-op, never a double-free)
      req.release?.();
      aborted++;
      notePermission(sessions.get(sessionId), {
        title: req.permission.title ?? req.permission.toolCallId ?? 'permission request',
        toolCallId: req.permission.toolCallId,
        decidedBy: 'proxy',
        verdict: 'cancelled',
        reason,
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
    // a response can land for a still-held ask (a raced/forged client
    // reply — a held ask never crossed, so no legit client could
    // answer it): the early discharge frees its slot the same way
    req.release?.();
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
        // exact kind match — pickPermissionOption's own discipline: a
        // closed enum, never a prefix read ('allowance' is not allow)
        const kind = perm.options.find(o => o.optionId === optionId)?.kind;
        if (kind === 'allow_once' || kind === 'allow_always') {
          verdict = 'approved';
        } else if (kind === 'reject_once' || kind === 'reject_always') {
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
        // agent mode: an available_commands_update is the session's
        // CURRENT command list, not a delta — forwarding the
        // downstream's verbatim would drop bro's surface exactly like
        // bro's own announce dropped its. Cache it and publish the
        // merge instead (spec bro-tegz2).
        if (
          opts.agent?.commands !== undefined &&
          update['sessionUpdate'] === 'available_commands_update'
        ) {
          ses.downstreamCommands = Array.isArray(update['availableCommands'])
            ? (update['availableCommands'] as AvailableCommand[])
            : [];
          writeUp(commandsUpdate(sessionId, mergedCommands(ses)));
          return;
        }
      }
    }
    writeUp(m);
  };

  /** Stamp session state on a successful session-open response — the
   *  RESPONSE's sessionId wins: session/fork's params carry the SOURCE
   *  id, the fork's own id only exists in the result. load/resume
   *  responses may omit it → the request param is the fallback.
   *  Returns the newly stamped session id — a repeat id (reused open,
   *  a fork the client already opened) stamps nothing and returns
   *  undefined. */
  const stampSession = (bind: PendingRequest['bind'], result: unknown): string | undefined => {
    if (bind === undefined) {
      return undefined;
    }
    const sid = (isRecord(result) ? str(result['sessionId']) : undefined) ?? bind.sessionId;
    if (sid === undefined || sessions.has(sid)) {
      return undefined;
    }
    const cwd = bind.cwd;
    sessions.set(sid, {
      cwd,
      seenPrompt: false,
      sessionCtxDone: opts.seam?.sessionContext === undefined,
      held: new Set(),
      writeQ: Promise.resolve(),
      advisory: [],
      downstreamCommands: [],
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
    return sid;
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
        log(`acp proxy: stop gate eval failed (session ${sessionId}) — ${errText(e)}`);
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
    // agent mode (spec bro-tegz2): initialize answers with bro's own
    // identity — bro IS the agent here. The downstream's original
    // agentInfo survives under _meta.bro.downstreamAgent; capabilities,
    // auth methods, and the protocol version stay verbatim — the
    // downstream negotiates what prompts can do.
    const overlayInfo = opts.agent?.agentInfo;
    if (overlayInfo !== undefined && req.method === 'initialize' && wire(m).error === undefined) {
      const result = wire(m).result;
      if (isRecord(result)) {
        const meta = isRecord(result['_meta']) ? result['_meta'] : {};
        const bro = isRecord(meta['bro']) ? meta['bro'] : {};
        m = {
          ...m,
          result: {
            ...result,
            agentInfo: overlayInfo,
            _meta: { ...meta, bro: { ...bro, downstreamAgent: result['agentInfo'] } },
          },
        } as AnyMessage;
      }
    }
    let stamped: string | undefined;
    if (wire(m).error === undefined) {
      // an error response stamps nothing — a failed open must not
      // register a session the next attempt would collide with, and a
      // failed close never ran
      stamped = stampSession(req.bind, wire(m).result);
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
    // agent mode: a newly stamped session announces bro's command
    // surface — ONE available_commands_update written AFTER the open
    // response crossed (the client must know the session before its
    // commands arrive), never before and never twice per session id.
    // The announced list is the merge — a downstream announce that
    // landed first composes rather than being clobbered.
    if (stamped !== undefined && opts.agent?.commands !== undefined) {
      const ses = sessions.get(stamped);
      if (ses !== undefined) {
        writeUp(commandsUpdate(stamped, mergedCommands(ses)));
      }
    }
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

  /** Read `stream` until EOF or wire shutdown, routing each message
   *  through `route`. `out` is the writable leg this pump feeds: once
   *  its ledger reaches the high-water mark the ROUTE side pauses —
   *  consumed intake waits in `held` — and once `held` reaches its own
   *  mark the READ side pauses too, so a stalled leg bounds the wire's
   *  whole in-flight footprint instead of growing a backlog no stall
   *  clock governs. The already-issued read stays out so an EOF queued
   *  behind the flood still surfaces the moment drain makes room (a
   *  stalled read sees a close only when its own queue position
   *  arrives).
   *
   *  `ctrl` names the leg's control plane — intake that exists only
   *  to stop or finish work the wire already accepted. A full ledger
   *  must never sit between a peer and the message that frees it:
   *  the local turn a session/cancel aborts can be the very thing
   *  the ledger is full OF, so a control message routes immediately,
   *  pause or not — but the hold it passes is NOT flushed on its
   *  account. What room allows drains in stream order ahead of it;
   *  under saturation it simply overtakes the rest (flushing the
   *  hold regardless turned every control into an intake amplifier —
   *  the hold drained, the read refilled it, the next control
   *  flushed again, and queued writes grew without bound until the
   *  stall). `held` is a caller-owned array for exactly this: the
   *  route layer can still settle what a leapfrogged control
   *  overtook — a session/cancel pulls that session's held prompts
   *  and answers them cancelled upstream, a $/cancel_request pulls
   *  its named request — so the wire keeps its rule that no work
   *  shows after its cancel. The one residual a single FIFO cannot
   *  fix: control queued BEHIND a saturated hold is unreachable
   *  until drain — jumping it ahead means reading the data first,
   *  which is the memory this bound refuses to spend.
   *
   *  The bypass itself is bounded too: controls routed past a full
   *  ledger are accepted in-flight work the hold cannot see, so they
   *  count into the same read-side mark — enough bypasses pause the
   *  read exactly like a saturated hold, and a control flood meets
   *  the bound instead of writing past the ledger without limit.
   *
   *  Shutdown wakes every wait below through ONE latch subscription —
   *  each wait parks a removable resolver in `wakes`, never a
   *  per-message callback on the shared latch — and the exit drains
   *  the hold so every accepted message lands in the table the
   *  teardown sweep answers from — including the read still
   *  outstanding at the exit: one that already resolved IS an
   *  accepted message (its sender's write completed), so it is routed
   *  into the same table rather than dropped with the pump. */
  const pump = async (
    stream: Stream,
    route: (m: AnyMessage) => void,
    tag: string,
    out: Outbound,
    ctrl: (m: AnyMessage) => boolean,
    held: AnyMessage[],
    precede?: (heldMsg: AnyMessage, ctrl: AnyMessage) => boolean
  ): Promise<void> => {
    const reader = stream.readable.getReader();
    const wakes = new Set<() => void>();
    void wireDoneLatch.promise.then(() => {
      for (const w of wakes) w();
      wakes.clear();
    });
    /** `p`, or early resolve on shutdown — `undefined` marks the wake. */
    const untilStop = <T>(p: Promise<T>): Promise<T | undefined> => {
      // a wait may end early — a rejection on the abandoned branch
      // must still count as handled
      void p.catch(() => {});
      if (wireDone) {
        return Promise.resolve(undefined);
      }
      return new Promise<T | undefined>(resolve => {
        const wake = (): void => resolve(undefined);
        wakes.add(wake);
        void p.then(
          v => {
            wakes.delete(wake);
            resolve(v);
          },
          () => {
            wakes.delete(wake);
            resolve(undefined);
          }
        );
      });
    };
    const deliver = (m: AnyMessage): void => {
      try {
        route(m);
      } catch (e) {
        log(`acp proxy: dropped ${tag} ${wire(m).method ?? 'message'}: ${errText(e)}`);
      }
    };
    let read: Promise<ReadableStreamReadResult<AnyMessage>> | undefined = reader.read();
    let eof = false;
    /** Intake paused at the read bound with NO read outstanding — the
     *  prefetched one already landed in the hold. Distinct from EOF:
     *  the loop still owes the room wait, just no second read. */
    let intakePaused = false;
    /** A pre-done read — where a wait still needs a promise while the
     *  intake is paused or spent, this resolves immediately so the
     *  loop falls through to its own break conditions. */
    const READ_DONE = Promise.resolve<ReadableStreamReadResult<AnyMessage>>({
      value: undefined,
      done: true,
    });
    /** Controls routed past a FULL ledger — accepted in-flight work
     *  neither `held` nor the ledger's own hold count sees. Enough of
     *  them pause the read side exactly like a saturated hold: a
     *  cancel or response flood meets the wire's bound instead of
     *  writing past it without limit (local cancellation never blocks
     *  — every consumed control still settles the instant it routes;
     *  the bound gates only consuming MORE). The charge decays on the
     *  leg's NEXT write settle, not on room(): bypassed work is
     *  ordinary depth once issued, and holds can keep the ledger
     *  "full" while the wire drains fine — counting until room would
     *  park the read behind work the charge no longer represents
     *  (the exact deadlock this bound exists to prevent). */
    let bypassed = 0;
    const bypass = (): void => {
      bypassed++;
      // FIFO one-shot — the oldest outstanding charge ends on each
      // settle; a bypass whose route wrote nothing decays on whatever
      // lands next, which errs toward holding the bound, never
      // toward unbounded intake
      void out.nextSettle().then(() => {
        bypassed = Math.max(0, bypassed - 1);
      });
    };
    /** ONE outstanding room() subscription at a time — the parked wait
     *  re-arms on every intake result, and a waiter that loses the
     *  race stays registered until the next release, so re-arming per
     *  read grew the ledger's waiter set alongside the hold it exists
     *  to bound. A pending room promise is reused across iterations;
     *  its own settle clears the slot so a stale resolution can never
     *  fake room later. */
    let roomWait: Promise<'room'> | undefined;
    const roomReady = (): Promise<'room'> => {
      roomWait ??= out.room().then(() => {
        roomWait = undefined;
        return 'room' as const;
      });
      return roomWait;
    };
    /** Route one consumed message — data intake joins the hold; a
     *  control message routes NOW: it only ever stops or finishes
     *  work the wire already accepted, so parking it behind the gate
     *  could deadlock the release it carries. The hold drains ahead
     *  of it only as far as the ledger's own gate allows — flushing
     *  the whole hold on every control is the amplifier that let a
     *  data/cancel alternation outrun the bound. Past the gate the
     *  control overtakes the queue, and the route-side sweeps settle
     *  its targets out of the hold it jumped. */
    const accept = (m: AnyMessage): void => {
      if (!ctrl(m)) {
        held.push(m);
        return;
      }
      while (held.length > 0 && out.spare()) {
        deliver(held.shift() as AnyMessage);
      }
      if (out.spare()) {
        bypassed = 0;
        deliver(m);
        return;
      }
      // routed past a saturated ledger — first pull whatever ordering
      // owes ahead of this control: a response must not overtake held
      // messages of the session it ends. The pulled writes ISSUE
      // first — still a bypass, never awaited — so the control's
      // liveness is untouched and only the wire order is repaired
      if (precede !== undefined) {
        let keep = 0;
        for (let i = 0; i < held.length; i++) {
          const h = held[i] as AnyMessage;
          if (precede(h, m)) {
            bypass();
            deliver(h);
          } else {
            held[keep++] = h;
          }
        }
        held.length = keep;
      }
      // routed past a saturated ledger — count it: the hold and the
      // bypass together are the intake in flight, and their sum is
      // the read-side bound below
      bypass();
      deliver(m);
    };
    for (;;) {
      // route what room allows — the fast path is a synchronous check;
      // a dead leg reads as room so the hold flushes before the exit
      while (held.length > 0 && out.spare()) {
        deliver(held.shift() as AnyMessage);
      }
      if (wireDone || eof || (read === undefined && !intakePaused)) {
        break;
      }
      // the hold AND the bypassed controls are the intake in flight —
      // a saturated SUM pauses the read side. While a read is still
      // outstanding the wait is room OR that read: a read issued
      // before the pause is accepted work in flight, so its
      // rejection must be handled inside the wait (a parked promise
      // with no handler is an unhandled rejection that outlives the
      // pump), and its EOF or message is already on the wire — the
      // bound spends the ONE prefetch slot for exactly this. Once it
      // lands the intake pauses outright: a paused pump issues no
      // new read until room re-opens it.
      if (held.length + bypassed >= ACP_PROXY_READ_HIGH_WATER) {
        const r: 'room' | { readonly read: ReadableStreamReadResult<AnyMessage> } | undefined =
          read === undefined
            ? await untilStop(roomReady())
            : await untilStop(Promise.race([roomReady(), read.then(v => ({ read: v }) as const)]));
        if (r === undefined) break;
        if (r === 'room') {
          bypassed = 0;
          intakePaused = false;
          // intake re-opens — the one prefetch read goes back out so
          // an EOF queued behind the flood still surfaces early
          read ??= reader.read();
          continue;
        }
        // the prefetch landed while saturated — accepted work joins
        // the hold, and the intake pauses (no new read) until room
        read = undefined;
        intakePaused = true;
        if (r.read.done) {
          eof = true;
        } else {
          accept(r.read.value);
        }
        continue;
      }
      if (held.length === 0) {
        // nothing to route — the intake read is the only wait worth
        // taking (room opening would find an empty hold anyway)
        const r: ReadableStreamReadResult<AnyMessage> | undefined = await untilStop(
          read ?? READ_DONE
        );
        if (r === undefined) break;
        read = r.done ? undefined : reader.read();
        if (r.done) {
          eof = true;
        } else {
          accept(r.value);
        }
        continue;
      }
      // parked with a hold to drain — room, more input, or shutdown,
      // whichever moves first; intake keeps running either way
      const r = await untilStop(
        Promise.race([roomReady(), (read ?? READ_DONE).then(v => ({ read: v }) as const)])
      );
      if (r === undefined) break;
      if (r === 'room') continue;
      read = r.read.done ? undefined : reader.read();
      if (r.read.done) {
        eof = true;
      } else {
        accept(r.read.value);
      }
    }
    // flush the hold — a message the pump accepted is never dropped
    // unrouted: registered now, its pending entry exists before the
    // teardown sweep reads the table it answers from
    while (held.length > 0) {
      deliver(held.shift() as AnyMessage);
    }
    // a read issued before the pause may already have RESOLVED — its
    // message left the transport (the peer's write completed) yet
    // never routed: skipping it would strand an accepted request
    // outside the table the teardown sweep answers. The race is a
    // peek, not a wait — an already-settled read's race subscription
    // was queued first so it wins; a still-pending read accepted
    // nothing and loses nothing
    if (read !== undefined) {
      const r = await Promise.race([read, Promise.resolve(undefined)]).catch(() => undefined);
      if (r !== undefined) {
        if (r.done) {
          eof = true;
        } else {
          deliver(r.value);
        }
      }
    }
    // a leg ended by shutdown — never by its own EOF — cancels its
    // reader so the peer's queued writes learn the wire is gone
    // instead of parking on the stall. The release starts with the
    // call; the sweep's wait only needs the drain above, so the
    // settle never needs an await here
    if (!eof) {
      void reader.cancel().catch(() => {});
    }
  };

  /** The control plane each direction's pump bypasses the route gate
   *  for — intake that only ever stops or finishes work already
   *  accepted. Responses qualify on BOTH legs: the id-keyed terminal
   *  half of a request the wire took, owed its discharge however full
   *  the data path ahead of it is. c2a adds the liveness notifications
   *  — session/cancel and JSON-RPC's own $/cancel_request — whose
   *  whole job is ending accepted work, the one message class that
   *  can release the holds a saturated ledger is made of. */
  const c2aCtrl = (m: AnyMessage): boolean =>
    isResponse(m) ||
    (isNotification(m) &&
      (wire(m).method === 'session/cancel' || wire(m).method === '$/cancel_request'));
  const a2cCtrl = (m: AnyMessage): boolean => isResponse(m);

  /** a2c ordering — a response bypassing the route gate must not
   *  overtake held messages of its OWN session: the turn's updates
   *  reach the client before the response that ends it (other
   *  sessions' held traffic it may pass — no ordering owed). The
   *  response's session comes from the pending entry it discharges —
   *  a prompt's sessionId or a close's target; a response with no
   *  entry can't be ordered and jumps alone. */
  const a2cPrecede = (heldMsg: AnyMessage, ctrlMsg: AnyMessage): boolean => {
    const id = wire(ctrlMsg).id;
    const req = id === undefined ? undefined : pending.get(id);
    const sessionId = req?.prompt?.sessionId ?? req?.close;
    return sessionId !== undefined && sessionIdOf(heldMsg) === sessionId;
  };

  const pumpUp = pump(upstream, routeC2A, 'c→a', downOut, c2aCtrl, heldC2A);
  const pumpDown = pump(downstream, routeA2C, 'a→c', upOut, a2cCtrl, heldA2C, a2cPrecede);
  const verdict = await Promise.race([
    pumpUp.then(
      () => 'up' as const, // client closed its side of the wire
      () => 'up' as const
    ),
    pumpDown.then(
      () => 'down' as const, // agent closed its side of the wire
      () => 'down' as const
    ),
    downDead.promise.then(() => 'down' as const),
    upDead.promise.then(() => 'up' as const),
  ]);

  // the wire is closing — a local turn still in flight dies with the
  // proxy: the abort hook only fires from abortHeld (session/cancel),
  // so a client or downstream close mid-turn would leave the slash
  // child running until its own timeout, holding the CLI open. The
  // flag lands FIRST: a prompt still queued in a session writeQ has
  // no abort armed yet, and without it crossPrompt would start that
  // queued slash command after the client already died. The latch
  // twin wakes any pump parked on backpressure for its own cleanup.
  wireDone = true;
  wireDoneLatch.fire();
  for (const req of pending.values()) {
    req.abort?.();
  }

  // a pump parked on backpressure may still hold consumed-but-unrouted
  // intake — let both pumps drain before the sweeps read the tables,
  // so a request the wire accepted is answered, never dropped silently
  await Promise.allSettled([pumpUp, pumpDown]);

  // a leg already declared dead aborts NOW — before the sweeps queue
  // their answers on the live leg: a dead writer left writable through
  // the live leg's close grace lets a peer that resumes mid-teardown
  // execute writes whose callers already ate the sweep's error. The
  // close loop still skips the dead leg's close handling; the abort
  // is idempotent there (an in-flight write may still complete —
  // abort() does not cancel a write the sink already took)
  for (const { w, dead } of [
    { w: upWriter, dead: upDead },
    { w: downWriter, dead: downDead },
  ]) {
    if (dead.fired) {
      void w.abort().catch(() => {});
    }
  }

  // downstream dead → every request still in flight fails visibly on
  // the upstream wire; a dead agent never silently eats a prompt
  if (verdict === 'down') {
    for (const [id, req] of [...pending]) {
      if (!pending.delete(id)) {
        continue; // already discharged — a gate pair's client half
      }
      // a still-held prompt's charged slot frees with the sweep — the
      // queued cross's own release would wait on the seam ahead of it;
      // its payload goes too — the wire ended before it crossed
      req.prompt?.release?.();
      req.prompt?.detach?.();
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
    for (const [id, req] of [...pendingA2C]) {
      pendingA2C.delete(id);
      req.release?.();
      if (req.permission !== undefined) {
        notePermission(req.sessionId === undefined ? undefined : sessions.get(req.sessionId), {
          title: req.permission.title ?? req.permission.toolCallId ?? 'permission request',
          toolCallId: req.permission.toolCallId,
          decidedBy: 'proxy',
          verdict: 'cancelled',
          reason: 'upstream client closed',
        });
        // the same denyPermission/cancelled shape answerPermission
        // writes everywhere else — result.outcome is the ACP
        // RequestPermissionOutcome union, its own `outcome`
        // discriminant is the second nesting level
        answerPermission(id, { outcome: 'cancelled' });
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
  // both legs close — the writer locks release and the streams
  // settle. A leg the stall bound already declared dead must never
  // flush its queue: a peer resuming mid-close would execute writes
  // whose callers already ate the error, so it aborts outright. A
  // live leg's close() queues behind pending writes — it gets
  // CLOSE_GRACE_MS of silence to land what was owed, the clock
  // resetting on every write that still drains (a slow peer making
  // progress is owed its replies; only a full grace of none abandons
  // the queue). An unflushed writer can't be aborted — abort() on a
  // writer with a queued close rejects — so the lock releases and the
  // stream itself dies; the abandoned close settles on its own (it
  // may pend forever on a pure-JS sink, so it must not be awaited).
  for (const { w, out, dead, writable } of [
    { w: upWriter, out: upOut, dead: upDead, writable: upstream.writable },
    { w: downWriter, out: downOut, dead: downDead, writable: downstream.writable },
  ]) {
    if (dead.fired) {
      void w.abort().catch(() => {});
      continue;
    }
    const closed = w.close().then(
      () => true,
      () => true // already closed / broken pipe — teardown is best-effort
    );
    let last = out.lastProgressAt();
    let flushed = false;
    for (;;) {
      flushed = await Promise.race([
        closed,
        new Promise<boolean>(r => {
          const grace = setTimeout(() => r(false), CLOSE_GRACE_MS);
          grace.unref();
        }),
      ]);
      if (flushed) {
        break;
      }
      const progress = out.lastProgressAt();
      if (progress <= last) {
        break; // a full grace without a landed write — the peer isn't draining
      }
      last = progress;
    }
    if (!flushed) {
      void w.abort().catch(() => {
        try {
          w.releaseLock();
          void writable.abort().catch(() => {});
        } catch {
          /* lock already gone — the abandoned close settles alone */
        }
      });
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
