#!/usr/bin/env node
/**
 * acp-watch — the pane command behind action `acp:watch` (spec bro-5vjpg).
 * Spawns an ACP-server child (`--cmd`, default `devin acp`), drives
 * initialize → session/new → optional session/prompt over NDJSON
 * JSON-RPC, and renders the session/update stream line-mode through
 * AcpRenderer. Readonly: no composer, no mid-turn prompt — a permission
 * request gets the fixed auto-answer policy so the session never
 * stalls on a viewer with no input.
 *
 * Backend-agnostic by contract: the only protocol spoken is ACP — the
 * command is a parameter and nothing here branches on who serves it.
 * Dependency-free like every plugin source: the client is ~100 lines
 * of NDJSON JSON-RPC, so an installed plugin outside the repo keeps
 * working.
 *
 *   node src/acp-watch.ts [--cmd 'devin acp'] [--prompt '…'] [--cwd DIR]
 *   node src/acp-watch.ts --fixture test/fixtures/session.jsonl
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  AcpRenderer,
  safe,
  type PermissionRequestLike,
  type SessionUpdateLike,
} from './acp-render.ts';
import { shellWords } from './lib.ts';

const PROTOCOL_VERSION = 1;

/** Loose wire shapes — the plugin carries no SDK dep; the renderer
 *  narrows what it needs. */
interface RpcError {
  code?: number;
  message?: string;
}
interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

interface Cli {
  cmd: string;
  /** parsed argv form of cmd — the spawn vector, no shell */
  cmdArgv: string[];
  prompt?: string;
  cwd: string;
  fixture?: string;
  color: boolean;
  permit: PermitMode;
}

/** Permission auto-answer modes — `auto` is the spec's fixed policy
 *  (reads → always, else → once); `reads` approves only read-kind
 *  tools and rejects the rest; `none` rejects everything. The pane
 *  stays readonly either way — this only bounds what the OWNED child
 *  may do unattended. */
export type PermitMode = 'auto' | 'reads' | 'none';

const PERMIT_MODES = new Set<string>(['auto', 'reads', 'none']);

const asPermit = (flag: string, v: string): PermitMode => {
  if (!PERMIT_MODES.has(v)) throw new Error(`${flag} must be auto|reads|none, got ${v}`);
  return v as PermitMode;
};

/** env transports — the pane command line would otherwise leak the
 *  prompt into `ps` argv (any local user reads it); env is
 *  owner-only. Env overrides flag state by spec. */
const finalizeCli = (cli: Cli, env: NodeJS.ProcessEnv): Cli => {
  cli.prompt ??= env.ACP_WATCH_PROMPT;
  if (env.ACP_WATCH_PERMIT !== undefined) {
    cli.permit = asPermit('ACP_WATCH_PERMIT', env.ACP_WATCH_PERMIT);
  }
  cli.cmdArgv = shellWords(cli.cmd);
  if (cli.cmdArgv.length === 0) throw new Error('--cmd must name an executable');
  return cli;
};

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Cli {
  const cli: Cli = {
    cmd: 'devin acp',
    cmdArgv: [],
    cwd: process.cwd(),
    color: env.NO_COLOR === undefined,
    permit: 'auto',
  };
  const VALUE_FLAGS: Record<string, 'cmd' | 'prompt' | 'cwd' | 'fixture' | 'permit'> = {
    '--cmd': 'cmd',
    '--prompt': 'prompt',
    '--cwd': 'cwd',
    '--fixture': 'fixture',
    '--permit': 'permit',
  };
  const TOGGLES = new Set(['--no-color', '--plain']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (TOGGLES.has(a)) {
      cli.color = false;
      continue;
    }
    const key = VALUE_FLAGS[a];
    if (key === undefined) throw new Error(`unknown arg ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (key === 'permit') cli.permit = asPermit('--permit', v);
    else cli[key] = v;
  }
  return finalizeCli(cli, env);
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The wire pump: child stdio ↔ NDJSON ↔ the renderer. `send` writes a
 * frame; inbound messages dispatch to response settlement (pending
 * map), inbound requests (permission/fs-read/method-not-found), or
 * notifications (session/update + ext sidebands).
 */
export class Wire {
  readonly renderer: AcpRenderer;
  private readonly write: (msg: RpcMessage) => void;
  private readonly pending = new Map<
    number | string,
    { res: (v: unknown) => void; rej: (e: Error) => void; method: string }
  >();
  private nextId = 0;
  /** The prompt turn's own request — its response is the turn boundary. */
  promptId: number | string | undefined;
  /** Turn-boundary consumer — the runner assigns renderer.turnEnd. */
  onTurnEnd: ((reason: string | undefined) => void) | undefined;
  /** Permission auto-answer mode — run() sets it from --permit/env. */
  permit: PermitMode = 'auto';
  /** prompt settled — resolve(value) with the stopReason. */
  private turnSettled: ((reason: string | undefined) => void) | undefined;
  private turnDone = false;

  constructor(write: (msg: RpcMessage) => void, renderer: AcpRenderer) {
    this.write = write;
    this.renderer = renderer;
  }

  /** The turn boundary fires once — a real prompt response draws the
   *  `turn complete` marker; transport death only settles the pump
   *  (the closed marker carries that story). */
  private settleTurn(reason: string | undefined): void {
    if (this.turnDone) return;
    this.turnDone = true;
    this.turnReason = reason;
    if (reason !== undefined) this.onTurnEnd?.(reason);
    this.turnSettled?.(reason);
    this.turnSettled = undefined;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    if (method === 'session/prompt') this.promptId = id;
    const p = new Promise<unknown>((res, rej) => this.pending.set(id, { res, rej, method }));
    this.write({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  /** The fs/read_text_file serve — advertised and readonly-honest:
   *  the file's content, or a JSON-RPC error. */
  private fsRead(params: unknown): RpcMessage {
    const p = (params ?? {}) as { path?: unknown };
    if (typeof p.path !== 'string') {
      return { error: { code: -32602, message: 'fs/read_text_file: path must be a string' } };
    }
    try {
      return { result: { content: readFileSync(p.path, 'utf8') } };
    } catch (err) {
      return { error: { code: -32000, message: `fs/read_text_file: ${errMsg(err)}` } };
    }
  }

  private answer(id: number | string | null, body: RpcMessage): void {
    this.write({ jsonrpc: '2.0', id, ...body });
  }

  /** One decoded wire line — shared by the live child and the fixture. */
  onMessage(msg: RpcMessage): void {
    const isResponse = msg.method === undefined;
    if (isResponse) return this.onResponse(msg);
    if (msg.id === null || msg.id === undefined) return this.onNotification(msg);
    return this.onRequest(msg);
  }

  private onResponse(msg: RpcMessage): void {
    const slot = msg.id === null || msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (slot !== undefined) {
      this.pending.delete(msg.id as number | string);
      if (msg.error !== undefined) {
        slot.rej(
          new Error(`${slot.method} failed (${msg.error.code ?? '?'}): ${msg.error.message ?? '?'}`)
        );
      } else {
        slot.res(msg.result);
      }
    }
    this.maybeSettle(msg);
  }

  /** a response carrying a prompt result settles the turn whether
   *  or not we minted the id (fixture replays carry recorded ids) */
  private maybeSettle(msg: RpcMessage): void {
    const stop = (msg.result as { stopReason?: string } | undefined)?.stopReason;
    if (stop === undefined && msg.id !== this.promptId) return;
    this.settleTurn(
      msg.error !== undefined ? `error: ${msg.error.message ?? '?'}` : (stop ?? 'unknown')
    );
  }

  private onNotification(msg: RpcMessage): void {
    // session/update renders; ext methods notice-dim
    if (msg.method === 'session/update') {
      const params = (msg.params ?? {}) as { update?: SessionUpdateLike };
      if (params.update !== undefined) this.renderer.update(params.update);
    } else {
      this.renderer.notice(msg.method ?? '?', msg.params);
    }
  }

  /** inbound request — serve permission/fs-read, method-not-found the rest */
  private onRequest(msg: RpcMessage): void {
    const id = msg.id as number | string;
    switch (msg.method) {
      case 'session/request_permission': {
        const outcome = this.renderer.permission(
          (msg.params ?? {}) as PermissionRequestLike,
          this.permit
        );
        this.answer(id, { result: { outcome } });
        return;
      }
      case 'fs/read_text_file':
        this.answer(id, this.fsRead(msg.params));
        return;
      default:
        // every other inbound request is an unadvertised cap —
        // visible line, honest method-not-found
        this.renderer.unhandled(msg.method ?? '?');
        this.answer(id, { error: { code: -32601, message: `${msg.method}: method not found` } });
        return;
    }
  }

  onLine(line: string): void {
    const t = line.trim();
    if (t === '') return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(t) as RpcMessage;
    } catch {
      this.renderer.notice('unparseable', { message: t.slice(0, 120) });
      return;
    }
    try {
      this.onMessage(msg);
    } catch (err) {
      this.renderer.notice('render-error', { message: errMsg(err) });
    }
  }

  /** Fail every in-flight request — transport death settles the pump. */
  kill(reason: string): void {
    for (const [, slot] of this.pending) {
      slot.rej(new Error(reason));
    }
    this.pending.clear();
    this.settleTurn(undefined);
  }

  private turnReason: string | undefined;

  /** The live pump's settle handle — resolves when the turn ends
   *  (prompt response or transport death), already-resolved when the
   *  boundary raced the caller. */
  whenTurnDone(): Promise<string | undefined> {
    if (this.turnDone) return Promise.resolve(this.turnReason);
    return new Promise<string | undefined>(res => {
      this.turnSettled = res;
    });
  }
}

interface Pump {
  wire: Wire;
  child: ChildProcess;
  /** mutable — the exit handler writes, the teardown reads */
  exit: { done: boolean; detail: string };
  flushStderr: () => void;
}

/** Child + wire + stderr tally — the plumbing half of a run. */
function spawnPump(cli: Cli, renderer: AcpRenderer, out: (s: string) => void): Pump {
  // --cmd is argv words, never a shell line: shellWords parses quotes
  // and escapes but performs no expansion, so the command cannot
  // re-parse into a different program (CodeQL: no env-derived shell).
  const child: ChildProcess = spawn(cli.cmdArgv[0] as string, cli.cmdArgv.slice(1), {
    cwd: cli.cwd,
    // BRO_HOOKS=0 — a machine backend: bro hooks no-op in the child
    // tree (same pin the acp provider sets for its spawns)
    env: { BRO_HOOKS: '0', ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = { done: false, detail: 'transport closed' };
  const wire = new Wire(msg => {
    try {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* transport already gone */
    }
  }, renderer);
  // stdin EPIPE arrives as a stream error, not a write() throw —
  // transport death is already handled on 'exit'
  child.stdin?.on('error', () => {});
  child.once('error', err => {
    if (!exit.done) {
      exit.done = true;
      exit.detail = `spawn failed: ${err.message}`;
      wire.kill(exit.detail);
    }
  });
  child.once('exit', (code, signal) => {
    if (!exit.done) {
      exit.done = true;
      exit.detail = `child exited (code ${String(code)}, signal ${String(signal)})`;
      wire.kill(exit.detail);
    }
  });
  // stderr is the child's diagnostic stream, not the protocol — an
  // INFO-tracing backend would drown the session render. Only
  // error-ish lines surface; the rest tally into one line at close.
  let stderrSuppressed = 0;
  const stderrIsSignal = (l: string): boolean => /error|panic|warn|fatal/i.test(l);
  child.stderr?.on('data', (d: Buffer) => {
    for (const l of d.toString().split('\n')) {
      if (l === '') continue;
      if (stderrIsSignal(l)) out(`\u001b[2m‹stderr› ${safe(l)}\u001b[0m`);
      else stderrSuppressed++;
    }
  });
  const flushStderr = (): void => {
    if (stderrSuppressed > 0)
      out(`\u001b[2m‹stderr› ${stderrSuppressed} diagnostic lines\u001b[0m`);
    stderrSuppressed = 0;
  };
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', l => wire.onLine(l));
  return { wire, child, exit, flushStderr };
}

/** initialize → protocol check → session/new. Returns the session id,
 *  or undefined after rendering `closed` — the caller exits 1. */
async function handshake(
  pump: Pump,
  cli: Cli,
  renderer: AcpRenderer,
  out: (s: string) => void
): Promise<string | undefined> {
  const die = (why: string): undefined => {
    pump.flushStderr();
    renderer.closed(why);
    pump.child.kill('SIGKILL');
    return undefined;
  };
  const init = (await pump.wire
    .request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'bro-acp-watch', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
    })
    .catch(err => err)) as { protocolVersion?: number } | Error;
  if (init instanceof Error) return die(`initialize — ${init.message}; ${pump.exit.detail}`);
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    return die(
      `agent negotiated protocol ${String(init.protocolVersion)} — this watcher speaks v${PROTOCOL_VERSION} only`
    );
  }
  out(`\u001b[2m── acp watch: ${cli.cmd} (cwd ${cli.cwd}) ──\u001b[0m`);
  const session = (await pump.wire
    .request('session/new', { cwd: cli.cwd, mcpServers: [] })
    .catch(err => err)) as { sessionId?: string } | Error;
  if (session instanceof Error) return die(`session/new — ${session.message}; ${pump.exit.detail}`);
  const sessionId = session.sessionId ?? '?';
  out(`\u001b[2m── session ${sessionId} ──\u001b[0m`);
  return sessionId;
}

/** TERM first so a graceful backend can flush, KILL is the grace
 *  timer's backstop; resolves once the child is gone. */
async function reap(pump: Pump): Promise<void> {
  const grave = setTimeout(() => pump.child.kill('SIGKILL'), 1500);
  pump.child.kill('SIGTERM');
  await new Promise<void>(res => {
    if (pump.exit.done) res();
    else pump.child.once('exit', () => res());
  });
  clearTimeout(grave);
}

/** spawn → wire → handshake → optional prompt → teardown. Returns the
 *  process exit code — 0 when the turn ended `end_turn` or no prompt
 *  was asked, non-zero on everything else. */
export async function run(
  cli: Cli,
  renderer: AcpRenderer,
  out: (s: string) => void
): Promise<number> {
  const pump = spawnPump(cli, renderer, out);
  const { wire, child, exit, flushStderr } = pump;
  wire.onTurnEnd = reason => renderer.turnEnd(reason);
  wire.permit = cli.permit;
  const turnDone = wire.whenTurnDone();

  // pane close / ctrl+c — courtesy-cancel the session then die; the
  // child's own exit settles the pump regardless
  let sessionId: string | undefined;
  const onSignal = (sig: 'SIGINT' | 'SIGTERM'): void => {
    if (sessionId !== undefined) {
      try {
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`
        );
      } catch {
        /* transport already gone */
      }
    }
    flushStderr();
    renderer.closed(`watcher ${sig}`);
    child.kill('SIGKILL');
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  sessionId = await handshake(pump, cli, renderer, out);
  if (sessionId === undefined) return 1;

  if (cli.prompt === undefined) {
    out(`\u001b[2m── no prompt — watching; close the pane to exit ──\u001b[0m`);
    await turnDone; // settles only on transport death
    flushStderr();
    renderer.closed(exit.detail);
    return 0;
  }

  // prompt answers carry the stop reason — the turn's own boundary.
  // The request rejection is read through the settle path, so the
  // direct promise just swallows it (no unhandled rejection).
  void wire
    .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: cli.prompt }] })
    .catch(() => {});
  const stopReason = await turnDone;
  // readonly v1: the turn's end is the session's end
  await reap(pump);
  flushStderr();
  renderer.closed(exit.detail);
  return stopReason === 'end_turn' ? 0 : 1;
}

/** Fixture replay — the recorded wire (one JSON-RPC message per line)
 *  feeds the same onMessage path the live child does, so the test
 *  exercises notification dispatch, the permission answer, and the
 *  turn boundary without spawning an agent. */
export function runFixture(file: string, renderer: AcpRenderer): number {
  const wire = new Wire(() => {}, renderer);
  wire.onTurnEnd = reason => renderer.turnEnd(reason);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    wire.onLine(line);
  }
  renderer.end();
  renderer.closed('fixture replayed');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  let cli: Cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`acp-watch: ${errMsg(err)}`);
    process.exit(2);
  }
  const renderer = new AcpRenderer(out, { color: cli.color });
  let code: number;
  try {
    code =
      cli.fixture !== undefined ? runFixture(cli.fixture, renderer) : await run(cli, renderer, out);
  } catch (err) {
    renderer.closed(errMsg(err));
    code = 1;
  }
  process.exit(code);
}
