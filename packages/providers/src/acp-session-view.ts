/**
 * The readonly `session/load` attach (spec bro-nwl5g) — `bro herdr
 * session-view`'s ACP leg. Spawns the provider's acp command, runs
 * initialize → agentCapabilities.loadSession gate → session/load, and
 * streams the replayed (then live) `session/update` notifications to a
 * caller sink. NO prompt, NO writes — a viewer never authorizes work:
 * permission asks are denied, unadvertised agent→client calls answer
 * method-not-found (the acp-worker trust posture).
 *
 * The provider command is operator-authored config — the same trusted
 * `sh -c` contract acp-worker carries; DATA (session id, cwd) rides
 * protocol params, never the command text.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  AgentApp,
  ClientRequestHandler,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';

/** What one attach needs — self-contained so the pane never re-reads
 *  config mid-run. */
export interface AcpSessionViewSpec {
  /** `providers.<name>.command` — trusted config, exec'd via `sh -c`. */
  command: string;
  /** The acp session id to load (the registry's acpSessionId). */
  sessionId: string;
  /** The session's cwd — the worktree. */
  cwd: string;
  /** The configured provider name — log/error text reads it. */
  provider?: string;
  /** Child env — default process.env with BRO_HOOKS=0 (a machine
   *  backend; the acp-worker pin). */
  env?: Record<string, string | undefined>;
  /** The in-process test seam — a fakeAcpAgent() app. */
  peer?: AgentApp;
  /** Every session/update for OUR session — replay, then live. */
  update?: (u: SessionUpdate) => void;
  /** Status lines — attach/close/failure text the pane renders dim. */
  note?: (line: string) => void;
  /** The agent's stderr — mirrored so provider walls reach the pane's
   *  diagnostics. */
  err?: (text: string) => void;
  /** Fires once `session/load` resolved — the replay drained and live
   *  updates follow. The attach itself stays open until the transport
   *  dies or `signal` aborts; this callback is the one-shot surface
   *  (`--once`, tests) waiting on. */
  attached?: () => void;
  /** Pane teardown → detach: close the transport and kill the child. */
  signal?: AbortSignal;
  /** permission auto-answer — default deny. The pane's renderer may
   *  render-and-deny through its own policy chip. */
  permission?: ClientRequestHandler<RequestPermissionRequest, RequestPermissionResponse>;
  /** Handshake bounds — initialize gets INIT_MS, session/load gets
   *  LOAD_MS (a replay streams updates the whole call; a wedged agent
   *  must not pin the pane). */
  initMs?: number;
  loadMs?: number;
}

export interface AcpSessionViewResult {
  /** session/load resolved — the replay ran and live updates flow. */
  attached: boolean;
  /** Why attach failed, or how the attach ended (transport death). */
  reason: string;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const INIT_MS = 15_000;
const LOAD_MS = 60_000;

/** A viewer never authorizes — reject when offered, cancel otherwise. */
const denyPermission: ClientRequestHandler<
  RequestPermissionRequest,
  RequestPermissionResponse
> = ctx => {
  const reject = ctx.params.options.find(
    o => o.kind === 'reject_once' || o.kind === 'reject_always'
  );
  return {
    outcome:
      reject === undefined
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: reject.optionId },
  };
};

/** Agent→client methods the viewer does not serve — registered so the
 *  attempt is visible in the pane, answered method-not-found (the
 *  capability-honesty posture: unadvertised, never emulated). */
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

/** Attach to one ACP session and stream its updates until the
 *  transport dies or `spec.signal` aborts. Never throws — the verdict
 *  is the result record; a failed attach hands the caller the fallback
 *  decision. */
export async function runAcpSessionView(spec: AcpSessionViewSpec): Promise<AcpSessionViewResult> {
  const note = spec.note ?? (() => {});
  const errOut = spec.err ?? (() => {});
  const by = spec.provider === undefined ? 'acp' : `acp provider '${spec.provider}'`;

  // a pre-aborted signal never replays to addEventListener — bail before
  // spawn or the detach lands on the floor and the child still starts.
  if (spec.signal?.aborted === true) {
    return { attached: false, reason: 'viewer detached' };
  }

  const app = client({ name: 'bro-session-view' }).onRequest(
    'session/request_permission',
    spec.permission ?? denyPermission
  );
  for (const m of UNADVERTISED_METHODS) {
    app.onRequest<unknown, never>(
      m,
      p => p,
      (): never => {
        note(`unadvertised agent→client call ${m} — method-not-found`);
        throw RequestError.methodNotFound(m);
      }
    );
  }
  app.onNotification('session/update', ctx => {
    if (ctx.params.sessionId === spec.sessionId) {
      spec.update?.(ctx.params.update);
    }
  });

  const child: ChildProcess | undefined =
    spec.peer === undefined
      ? spawn(
          'sh', // NOSONAR — PATH lookup is the contract (same as acp-worker)
          ['-c', spec.command],
          {
            // NOSONAR — operator-authored config string; only DATA is
            // forbidden from the shell, and none reaches it.
            cwd: spec.cwd,
            env: { BRO_HOOKS: '0', ...process.env, ...spec.env },
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        )
      : undefined;
  child?.stderr?.on('data', (d: Buffer) => errOut(d.toString()));

  const conn =
    spec.peer !== undefined
      ? app.connect(spec.peer)
      : app.connect(
          ndJsonStream(
            Writable.toWeb(child!.stdin!) as WritableStream<Uint8Array>,
            Readable.toWeb(child!.stdout!) as ReadableStream<Uint8Array>
          )
        );

  let settled = false;
  let doneResolve!: (r: AcpSessionViewResult) => void;
  const done = new Promise<AcpSessionViewResult>(r => {
    doneResolve = r;
  });
  const settle = (r: AcpSessionViewResult): void => {
    if (settled) return;
    settled = true;
    conn.close();
    child?.kill('SIGKILL');
    doneResolve(r);
  };
  // a spawn that cannot start the shell emits 'error' — unhandled it
  // throws the process; routed, it becomes the same failed-attach verdict.
  child?.once('error', (e: Error) => {
    settle({ attached: false, reason: `${by} spawn failed — ${e.message}` });
  });
  conn.signal.addEventListener('abort', () => {
    settle({ attached: attachedOnce, reason: 'transport closed' });
  });
  spec.signal?.addEventListener('abort', () => {
    settle({ attached: attachedOnce, reason: 'viewer detached' });
  });

  let attachedOnce = false;
  const op = async (): Promise<void> => {
    const init = await conn.agent.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'bro-session-view', version: '1' },
        // the readonly posture — fs/terminal/elicitation all covered
        // and all unserved; unadvertised calls answer method-not-found
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: {},
        },
      },
      { cancellationSignal: AbortSignal.timeout(spec.initMs ?? INIT_MS) }
    );
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `${by}: agent negotiated protocol ${init.protocolVersion} — the viewer speaks v${PROTOCOL_VERSION} only`
      );
    }
    if (init.agentCapabilities?.loadSession !== true) {
      settle({ attached: false, reason: `${by} does not advertise loadSession` });
      return;
    }
    await conn.agent.request(
      'session/load',
      { sessionId: spec.sessionId, cwd: spec.cwd, mcpServers: [] },
      { cancellationSignal: AbortSignal.timeout(spec.loadMs ?? LOAD_MS) }
    );
    attachedOnce = true;
    spec.attached?.();
    note(`attached ${spec.sessionId} — live updates stream until detach`);
  };

  void op().catch((err: unknown) => {
    settle({ attached: false, reason: `${by} — ${errMsg(err)}` });
  });
  return done;
}
