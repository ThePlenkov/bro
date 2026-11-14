/**
 * The ACP client half — one persistent session over stdio
 * (spec bro-t4uin).
 *
 * ACP is one protocol, so this speaks ACP and NOTHING else: no
 * agent's name appears here, the command is a parameter. What the
 * protocol does NOT have is the thing a human needs — a place to put
 * a follow-up while a turn is running. The baseline is
 * `session/new` · `session/prompt` · `session/cancel` ·
 * `session/update`; a second concurrent `session/prompt` on one
 * session is an ERROR, not a queue (our own broker enforces it —
 * `serve-acp.ts`: "a prompt turn is in flight — a second concurrent
 * prompt is an error"). So the queue lives HERE, in the client.
 *
 * The rows this emits are the ARCHIVE's shapes
 * (`packages/acp/session/src/archive/rows.ts`): the same
 * `kind:'turn'|'prompt'|'update'|'permission'` records the
 * `.events.jsonl` file carries. That is the seam that keeps the
 * renderer untouched — the live feed and the file replay are the same
 * bytes, so the model, the fold policy and every card already work.
 *
 * Dependency-free NDJSON JSON-RPC, like
 * `plugins/herdr/src/acp-watch.ts`: the protocol code must stay
 * Node-testable, because the TUI's walls (Solid's Bun-only JSX
 * transform, OpenTUI's Bun-only native FFI) must not reach it.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** The protocol version this client speaks. */
export const PROTOCOL_VERSION = 1;

/** One wire message — the loose shape, parsed defensively. */
export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** One session/update notification's payload. */
export interface SessionUpdateLike {
  sessionUpdate: string;
  [k: string]: unknown;
}

/** One permission request's payload. */
export interface PermissionRequestLike {
  sessionId?: string;
  toolCall?: { toolCallId?: string; title?: string | null; kind?: string | null } | null;
  options?: { optionId?: string; name?: string; kind?: string }[] | null;
}

/** One permission option — the agent's own option, verbatim. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/**
 * The verdict vocabulary the archive already speaks
 * (`packages/providers/src/acp-worker.ts`): 'approved' | 'denied' |
 * 'cancelled'. The live pane answers with the same words, so a row
 * means the same thing whether it came from a headless driver or
 * from a human at a keyboard.
 */
export type PermissionVerdict = 'approved' | 'denied' | 'cancelled';

/**
 * The rows the client emits — the archive's shapes.
 *
 * `kind:'update'` carries the raw `session/update` payload; `kind:'turn'`
 * bookends a prompt turn; `kind:'prompt'` is the human's own message
 * (the archive journals it so a replay can say what was asked);
 * `kind:'permission'` is an ask, and the SAME kind with a `verdict`
 * is its answer.
 */
export type ClientRow =
  | { kind: 'turn'; phase: 'start' | 'stop'; ts: string; stopReason?: string; error?: string }
  | { kind: 'prompt'; ts: string; text: string }
  | { kind: 'update'; ts: string; update: SessionUpdateLike }
  | {
      kind: 'permission';
      ts: string;
      title: string;
      toolCallId: string;
      /** 'ask' opens the card, 'answer' closes it — the headless
       *  driver's single row carries neither and means both */
      phase?: 'ask' | 'answer';
      /** the agent's own options — a pane lists them, the answer
       *  must pick one of them */
      options?: PermissionOption[];
      /** the answer's verdict — absent on the ask itself */
      verdict?: PermissionVerdict;
      /** the answer's optionId — the AGENT's id, never an invented one */
      optionId?: string;
      /** the answer's option kind — allow_once / reject_once / … */
      optionKind?: string;
    };

/** What the agent answered at `initialize`. */
export interface AgentCapabilities {
  /** the agent supports `session/load` — a finished session can be continued */
  loadSession: boolean;
  /** the agent supports `session/resume` — continue WITHOUT replaying history */
  resume: boolean;
  /** prompt capabilities — image/audio/embeddedContext */
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  /** the agent's own name, for the pane's header */
  agentName?: string;
  agentVersion?: string;
  /** the negotiated protocol version */
  protocolVersion: number;
  /** the agent's capability bag, verbatim */
  raw: unknown;
}

/** A permission ask the human must answer. */
export interface PermissionAsk {
  /** the agent's request id — the answer carries it back */
  requestId: number | string;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
}

/** The client's knobs. */
export interface AcpClientOptions {
  /** the agent command — argv words, NEVER a shell line */
  command: string[];
  /** the session's working directory */
  cwd?: string;
  /** child env — defaults to `process.env` */
  env?: Record<string, string | undefined>;
  /**
   * Continue an existing session instead of opening a new one.
   * `session/load` is the portable spelling (every probed agent
   * supports it); `resume` is the newer one only kilo/opencode
   * advertise — so `load` is the default and `resume` is opt-in.
   */
  sessionId?: string;
  /** use `session/resume` when continuing — needs `resume: true` */
  useResume?: boolean;
  /** the client name on the wire */
  clientName?: string;
  /** one row out — the feed's currency */
  onRow?: (row: ClientRow) => void;
  /** a permission ask — the caller answers with `answerPermission` */
  onPermission?: (ask: PermissionAsk) => void;
  /** a diagnostic line — stderr mirrors, transport notes */
  onNote?: (line: string) => void;
  /** the session's state changed — the queue, the pending ask, the
   *  status. A UI re-renders on this; it never polls. */
  onState?: () => void;
  /** the handshake's deadline */
  initMs?: number;
  /** the prompt turn's deadline */
  turnMs?: number;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Is a capability advertised? ACP's capability maps hold an OPTION
 * BAG per name (`resume: {}`), so the name being there is the
 * advertisement — but an explicit `null` or `false` is a no.
 */
const advertised = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false;

/** The default handshake budget — an agent that never answers must not pin the pane. */
const INIT_MS = 20_000;
/** The default turn budget — a wedged agent must not hang the composer forever. */
const TURN_MS = 600_000;

/** The client's own state — what a UI needs to render honestly. */
export type ClientState = 'idle' | 'starting' | 'live' | 'busy' | 'closed' | 'failed';

/** One queued prompt — visible, numbered, never silently dropped. */
export interface QueuedPrompt {
  /** the queue ordinal — 1 is the next to run */
  ordinal: number;
  text: string;
}

/**
 * The ACP client — one session, one prompt at a time, a queue for the
 * rest.
 *
 * The queue is the whole point of this package: ACP forbids a second
 * concurrent `session/prompt`, so a human who types during a turn
 * needs somewhere for the text to wait. `prompt()` never rejects for
 * "busy" — it queues, and the queue drains itself when the running
 * turn ends.
 */
export class AcpClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }
  >();
  /** the queue — a prompt sent while busy waits here */
  private readonly queue: string[] = [];
  /** the permission asks waiting for an answer, keyed by request id */
  private readonly asks = new Map<number | string, PermissionAsk>();
  private state: ClientState = 'idle';
  /** the session's id — `session/new`'s answer or the loaded one */
  private session: string | undefined;
  private caps: AgentCapabilities | undefined;
  /** the turn's deadline timer — a wedged agent must not hang the composer */
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly opts: AcpClientOptions) {}

  /** The client's state — a UI renders this, never guesses it. */
  get status(): ClientState {
    return this.state;
  }

  /** The negotiated capabilities — undefined before the handshake. */
  get capabilities(): AgentCapabilities | undefined {
    return this.caps;
  }

  /** The session's id — undefined before the handshake. */
  get sessionId(): string | undefined {
    return this.session;
  }

  /** The queued prompts, in order — the pane renders these as pending rows. */
  get pendingPrompts(): QueuedPrompt[] {
    return this.queue.map((text, i) => ({ ordinal: i + 1, text }));
  }

  /** A prompt is in flight. */
  get busy(): boolean {
    return this.state === 'busy';
  }

  /** The session is over — closed by the human or dead by the agent. */
  get dead(): boolean {
    return this.state === 'closed' || this.state === 'failed';
  }

  /** A permission ask is waiting for an answer. */
  get awaitingPermission(): PermissionAsk | undefined {
    const first = this.asks.values().next();
    return first.done === true ? undefined : first.value;
  }

  private row(row: ClientRow): void {
    try {
      this.opts.onRow?.(row);
    } catch (err) {
      this.note(`row sink failed — ${errMsg(err)}`);
    }
  }

  private note(line: string): void {
    try {
      this.opts.onNote?.(line);
    } catch {
      /* a diagnostic sink never breaks the client */
    }
  }

  /** The state moved — the queue, the pending ask, the status. A UI
   *  redraws on this; it never polls for it. */
  private notifyState(): void {
    try {
      this.opts.onState?.();
    } catch (err) {
      this.note(`state sink failed — ${errMsg(err)}`);
    }
  }

  /** One outbound frame — NDJSON, one object per line. */
  private send(msg: RpcMessage): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error('acp client: the transport is gone');
    }
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** One request — the response settles the promise. */
  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        const slot = this.pending.get(id);
        if (slot === undefined) return;
        this.pending.delete(id);
        slot.reject(new Error(`acp client: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    }
    return p;
  }

  /** One notification — no answer expected. */
  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * The handshake — spawn, `initialize`, then open the session
   * (`session/new`, or `session/load`/`session/resume` to continue
   * an existing one).
   *
   * The agent's own capabilities decide the rest: a `session/load`
   * against an agent that does not advertise `loadSession` is a
   * refusal, not a silent no-op — the client says so and stays
   * closed.
   */
  async start(): Promise<AgentCapabilities> {
    if (this.state !== 'idle') throw new Error(`acp client: already ${this.state}`);
    this.state = 'starting';
    try {
      this.spawnTransport();
      const caps = await this.handshake();
      await this.openSession();
      this.state = 'live';
      this.notifyState();
      return caps;
    } catch (err) {
      this.fail(errMsg(err));
      throw err;
    }
  }

  /** Spawn the agent and wire the transport to the client. */
  private spawnTransport(): void {
    const argv = this.opts.command;
    if (argv.length === 0) throw new Error('acp client: the command must name an executable');
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: this.opts.cwd ?? process.cwd(),
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin?.on('error', () => {
      /* the transport's death is handled by the exit handler */
    });
    child.once('error', err => {
      this.fail(`spawn failed: ${err.message}`);
    });
    child.once('exit', (code, signal) => {
      this.fail(`agent exited (code ${String(code)}, signal ${String(signal)})`);
    });
    child.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim() !== '') this.note(`‹stderr› ${line.slice(0, 200)}`);
      }
    });
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on('line', line => this.onLine(line));
    rl.on('close', () => this.fail('transport closed'));
  }

  /** The handshake — `initialize`, and the capabilities it answers with. */
  private async handshake(): Promise<AgentCapabilities> {
    const init = (await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: this.opts.clientName ?? 'bro', version: '1' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      this.opts.initMs ?? INIT_MS
    )) as {
      protocolVersion?: number;
      agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
        sessionCapabilities?: { resume?: unknown };
      };
      agentInfo?: { name?: string; version?: string };
    };
    const ac = init.agentCapabilities;
    const caps: AgentCapabilities = {
      loadSession: ac?.loadSession === true,
      // ACP's `sessionCapabilities` is a MAP of names to option bags:
      // `resume: {}` means "yes, I support it" — the capability is the
      // NAME being there. An explicit null/false is a no.
      resume: advertised(ac?.sessionCapabilities?.resume),
      promptImage: ac?.promptCapabilities?.image === true,
      promptAudio: ac?.promptCapabilities?.audio === true,
      promptEmbeddedContext: ac?.promptCapabilities?.embeddedContext === true,
      ...(init.agentInfo?.name !== undefined ? { agentName: init.agentInfo.name } : {}),
      ...(init.agentInfo?.version !== undefined ? { agentVersion: init.agentInfo.version } : {}),
      protocolVersion: init.protocolVersion ?? PROTOCOL_VERSION,
      raw: ac,
    };
    if (caps.protocolVersion !== PROTOCOL_VERSION) {
      this.fail(
        `agent negotiated protocol ${caps.protocolVersion} — this client speaks v${PROTOCOL_VERSION} only`
      );
      throw new Error(`acp client: unsupported protocol ${caps.protocolVersion}`);
    }
    this.caps = caps;
    return caps;
  }

  /** Open the session — new, or continue an existing one. */
  private async openSession(): Promise<void> {
    const cwd = this.opts.cwd ?? process.cwd();
    this.session =
      this.opts.sessionId === undefined
        ? await this.newSession(cwd)
        : await this.continueSession(cwd, this.opts.sessionId);
  }

  /** A fresh session — `session/new`. */
  private async newSession(cwd: string): Promise<string> {
    const result = (await this.request(
      'session/new',
      { cwd, mcpServers: [] },
      this.opts.initMs ?? INIT_MS
    )) as {
      sessionId?: string;
    };
    return result.sessionId ?? '?';
  }

  /**
   * Continue an existing session — `session/load` (the portable
   * spelling) or `session/resume` (opt-in).
   *
   * A `session/load` against an agent that does not advertise
   * `loadSession` is a refusal, not a silent no-op — the client says
   * so and stays closed.
   */
  private async continueSession(cwd: string, sessionId: string): Promise<string> {
    const resume = this.opts.useResume === true;
    if (resume && this.caps?.resume !== true) {
      throw new Error(
        'acp client: the agent does not advertise sessionCapabilities.resume — use session/load'
      );
    }
    if (!resume && this.caps?.loadSession !== true) {
      throw new Error(
        'acp client: the agent does not advertise loadSession — cannot continue the session'
      );
    }
    const result = (await this.request(
      resume ? 'session/resume' : 'session/load',
      { sessionId, cwd, mcpServers: [] },
      this.opts.initMs ?? INIT_MS
    )) as { sessionId?: string };
    return result.sessionId ?? sessionId;
  }

  /**
   * Send a prompt.
   *
   * NEVER rejects for "busy": a prompt that arrives during a turn is
   * QUEUED and drains itself when the turn ends. The caller gets the
   * queue's state from `pendingPrompts` — the pane renders it, so a
   * human sees their message waiting rather than delivered.
   */
  async prompt(text: string): Promise<void> {
    if (this.state !== 'live' && this.state !== 'busy') {
      throw new Error(`acp client: not live (${this.state})`);
    }
    if (this.state === 'busy') {
      this.queue.push(text);
      this.notifyState();
      return;
    }
    await this.runTurn(text);
  }

  /** The turn itself — one prompt, its row, its updates, its end. */
  private async runTurn(text: string): Promise<void> {
    this.state = 'busy';
    this.notifyState();
    this.row({ kind: 'prompt', ts: new Date().toISOString(), text });
    this.row({ kind: 'turn', phase: 'start', ts: new Date().toISOString() });
    const id = this.nextId++;
    const settled = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method: 'session/prompt' });
    });
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'session/prompt',
      params: { sessionId: this.session, prompt: [{ type: 'text', text }] },
    });
    this.turnTimer = setTimeout(() => {
      // the slot is rejected HERE: fail() rejects what is left in the
      // map, and this one is already gone — a turn that waited on a
      // promise nobody could settle would hang the pane forever
      const slot = this.pending.get(id);
      if (slot === undefined) return;
      this.pending.delete(id);
      slot.reject(new Error('acp client: the turn timed out'));
      this.fail('the turn timed out');
    }, this.opts.turnMs ?? TURN_MS);
    this.turnTimer.unref?.();
    try {
      const result = (await settled) as { stopReason?: string };
      const stopReason = result.stopReason ?? 'unknown';
      this.row({
        kind: 'turn',
        phase: 'stop',
        ts: new Date().toISOString(),
        stopReason,
      });
    } catch (err) {
      this.row({
        kind: 'turn',
        phase: 'stop',
        ts: new Date().toISOString(),
        stopReason: 'error',
        error: errMsg(err),
      });
    } finally {
      if (this.turnTimer !== undefined) clearTimeout(this.turnTimer);
      this.turnTimer = undefined;
      if (!this.dead) this.state = 'live';
      this.notifyState();
    }
    // the queue drains itself — the next queued prompt runs now
    void this.drain();
  }

  /** Drain the queue — one prompt at a time, the next after the last. */
  private async drain(): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return;
    if (this.state === 'busy') return;
    const next = this.queue.shift();
    if (next === undefined) return;
    await this.runTurn(next);
  }

  /**
   * Cancel the in-flight turn — `session/cancel`.
   *
   * The queue SURVIVES a cancel: cancelling stops the running turn,
   * it does not discard what the human typed. A cancel with nothing
   * in flight is a no-op, never an error.
   */
  cancel(): boolean {
    if (this.state !== 'busy' || this.session === undefined) return false;
    try {
      this.notify('session/cancel', { sessionId: this.session });
      this.notifyState();
      return true;
    } catch (err) {
      this.note(`cancel failed — ${errMsg(err)}`);
      return false;
    }
  }

  /**
   * Answer a permission ask — the agent's own `optionId`.
   *
   * The client NEVER invents an approval: the option must be one of
   * the agent's own, an unknown request id is refused loudly rather
   * than answered into the void, and an ask with no options at all
   * has nothing to select — that path is `denyPermission`.
   */
  answerPermission(requestId: number | string, optionId: string): boolean {
    const ask = this.asks.get(requestId);
    if (ask === undefined) return false;
    const option = ask.options.find(o => o.optionId === optionId);
    if (option === undefined) {
      this.note(`permission answer refused — '${optionId}' is not one of the agent's options`);
      return false;
    }
    this.asks.delete(requestId);
    const kind = option.kind;
    const verdict: PermissionVerdict = kind.startsWith('reject') ? 'denied' : 'approved';
    this.row({
      kind: 'permission',
      phase: 'answer',
      ts: new Date().toISOString(),
      title: ask.title,
      toolCallId: ask.toolCallId,
      options: ask.options,
      verdict,
      optionId,
      optionKind: kind,
    });
    try {
      this.send({
        jsonrpc: '2.0',
        id: requestId,
        result: { outcome: { outcome: 'selected', optionId } },
      });
      this.notifyState();
      return true;
    } catch (err) {
      this.note(`permission answer failed — ${errMsg(err)}`);
      return false;
    }
  }

  /** Deny a permission ask — the safe fallback for "nobody answered". */
  denyPermission(requestId: number | string): boolean {
    const ask = this.asks.get(requestId);
    if (ask === undefined) return false;
    this.asks.delete(requestId);
    this.row({
      kind: 'permission',
      phase: 'answer',
      ts: new Date().toISOString(),
      title: ask.title,
      toolCallId: ask.toolCallId,
      options: ask.options,
      verdict: 'cancelled',
    });
    try {
      this.send({
        jsonrpc: '2.0',
        id: requestId,
        result: { outcome: { outcome: 'cancelled' } },
      });
      this.notifyState();
      return true;
    } catch (err) {
      this.note(`permission denial failed — ${errMsg(err)}`);
      return false;
    }
  }

  /**
   * Deny EVERY outstanding ask — the "nobody answered" path.
   *
   * The client never approves on its own, so the way an unanswered
   * ask must end is a denial: a hung pane that exits must not leave
   * the agent waiting for a yes it will never get. Returns how many
   * asks were denied.
   */
  denyAllPermissions(): number {
    const ids = [...this.asks.keys()];
    let denied = 0;
    for (const id of ids) if (this.denyPermission(id)) denied += 1;
    return denied;
  }

  /** One inbound line — dispatch by shape. */
  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      this.note(`unparseable frame — ${trimmed.slice(0, 120)}`);
      return;
    }
    try {
      this.dispatch(msg);
    } catch (err) {
      this.note(`dispatch failed — ${errMsg(err)}`);
    }
  }

  /** The dispatch — a response, a notification, or an inbound request. */
  private dispatch(msg: RpcMessage): void {
    // a response (no method) — settles a pending request
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      this.onResponse(msg);
      return;
    }
    // a notification
    if (msg.id === undefined || msg.id === null) {
      this.onNotification(msg);
      return;
    }
    // an inbound request — the agent asking the client something
    this.onRequest(msg);
  }

  /** A response to one of our requests — it settles the promise. */
  private onResponse(msg: RpcMessage): void {
    const id = msg.id as number | string;
    const slot = this.pending.get(id);
    if (slot === undefined) return;
    this.pending.delete(id);
    if (msg.error !== undefined) {
      slot.reject(
        new Error(`${slot.method} failed (${msg.error.code ?? '?'}): ${msg.error.message ?? '?'}`)
      );
      return;
    }
    slot.resolve(msg.result);
  }

  /** A notification — `session/update` is the feed's currency. */
  private onNotification(msg: RpcMessage): void {
    if (msg.method === 'session/update') {
      const params = (msg.params ?? {}) as { update?: SessionUpdateLike };
      if (params.update !== undefined) {
        this.row({ kind: 'update', ts: new Date().toISOString(), update: params.update });
      }
      return;
    }
    if (msg.method !== undefined) this.note(`${msg.method}`);
  }

  /** An inbound request — the permission ask, or an unadvertised cap. */
  private onRequest(msg: RpcMessage): void {
    if (msg.method === 'session/request_permission') {
      this.onPermissionRequest(msg);
      return;
    }
    // every other inbound request is an unadvertised cap — visible,
    // answered method-not-found (capability honesty beats emulation)
    try {
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `${msg.method}: method not found` },
      });
    } catch {
      /* the transport is gone */
    }
  }

  /** The permission ask — surfaced to the caller, never auto-answered. */
  private onPermissionRequest(msg: RpcMessage): void {
    const params = (msg.params ?? {}) as PermissionRequestLike;
    const toolCall = params.toolCall ?? {};
    const options = (params.options ?? []).map(o => ({
      optionId: o.optionId ?? '',
      name: o.name ?? o.optionId ?? '',
      kind: o.kind ?? 'unknown',
    }));
    const ask: PermissionAsk = {
      requestId: msg.id as number | string,
      toolCallId: toolCall.toolCallId ?? 'unknown',
      title: toolCall.title ?? 'permission request',
      options,
    };
    this.asks.set(ask.requestId, ask);
    this.row({
      kind: 'permission',
      phase: 'ask',
      ts: new Date().toISOString(),
      title: ask.title,
      toolCallId: ask.toolCallId,
      options,
    });
    this.notifyState();
    this.opts.onPermission?.(ask);
  }

  /** The failure path — every pending request rejects, the state says why. */
  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'failed';
    for (const [, slot] of this.pending) slot.reject(new Error(reason));
    this.pending.clear();
    this.asks.clear();
    this.note(reason);
    this.notifyState();
    // a dead session must not leave an agent process running
    void this.terminateChild();
  }

  /** Kill the child and wait for it to go — SIGTERM, then SIGKILL. */
  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    child.stdin?.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Close the client — the transport dies with it. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.state !== 'failed') this.state = 'closed';
    for (const [, slot] of this.pending) slot.reject(new Error('client closed'));
    this.pending.clear();
    // an unanswered ask ends as a denial — never as a silent yes
    this.denyAllPermissions();
    if (this.turnTimer !== undefined) clearTimeout(this.turnTimer);
    this.turnTimer = undefined;
    this.notifyState();
    await this.terminateChild();
  }
}
