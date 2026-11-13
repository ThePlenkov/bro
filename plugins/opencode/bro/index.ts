// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Plugin } from '@opencode/plugin';
import { Rpc } from '@opencode/plugin/rpc';

//#region packages/agent-plugins/adapter-core/src/core.ts
/** How long a normal hook probe may take. */
const HOOK_TIMEOUT_MS = 15e3;
/** session-start/post-compaction list `bd ready` and scan worktrees —
 *  measured at 20-40s in a loaded repo. */
const REHYDRATION_TIMEOUT_MS = 45e3;
/** Cap on a hook's stdout — a runaway child must not eat the heap. */
const MAX_OUTPUT = 1 << 20;
/** A hung CLI must not wedge an adapter: `/bro`, `bro_status` and the
 *  bro tool are interactive reads, and a wedged dolt lock can stall
 *  them forever. The kill takes the detached process group down. */
const RUN_TIMEOUT_MS = 6e4;
/** How long a failed CLI resolution stays cached before a retry —
 *  PATH, a local install or npx can appear mid-session, but
 *  re-probing the npx rung on every keystroke would be worse than
 *  the outage. */
const RESOLVE_RETRY_MS = 6e4;
/**
 * `node` on PATH, not process.execPath — a host may ship as a compiled
 * binary whose execPath IS that binary, so running it with our own
 * entry script would re-enter the host instead of running the script.
 */
function jsRuntime() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}
/** The bro CLI bundled next to this adapter (`dist/index.js`). */
function siblingCli() {
  for (const rel of ['./index.js', '../dist/index.js']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
/** The bro CLI of the checkout this adapter was loaded from — the
 *  development path: the adapter's own source tree wins over any
 *  published package, so a local edit is live without a rebuild. */
function checkoutCli() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
/**
 * SIGKILL a hung child on a timer. The child is spawned detached, so
 * killing the pid's group takes the grandchildren down too — a hook
 * that spawns `bd` must not leave a dolt server behind.
 */
function killAfter(child, ms, onTimeout) {
  const timer = setTimeout(() => {
    try {
      if (child.pid !== void 0) process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    onTimeout();
  }, ms);
  timer.unref?.();
  return timer;
}
/** Does this command exit zero? Used to probe whether a candidate CLI
 *  actually speaks bro's hook protocol — an older bro on PATH fails the
 *  probe instead of failing every hook. */
async function exitsZero(cmd, args) {
  const { promise, resolve } = Promise.withResolvers();
  let child;
  try {
    child = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch {
    return false;
  }
  const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(false));
  child.on('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
  child.on('close', code => {
    clearTimeout(timer);
    resolve(code === 0);
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end('');
  return promise;
}
/**
 * The CLI ladder, in order: the pinned command, the bundled sibling,
 * the checkout's dist, `bro` on PATH, and finally the pinned npx
 * package. Every tier is probed with `bro hooks` — the silent
 * capability probe — so a tier that resolves to something that is not
 * bro is skipped rather than failing every hook.
 */
async function resolveCommand(opts = {}) {
  const pinned = opts.command;
  if (typeof pinned === 'string' && pinned.trim() !== '') {
    const [cmd, ...args] = pinned.split(/\s+/).filter(p => p !== '');
    if (cmd !== void 0 && (await exitsZero(cmd, [...args, 'hooks'])))
      return {
        cmd,
        args,
      };
  } else if (pinned !== void 0 && typeof pinned === 'object' && pinned !== null) {
    const cmd = typeof pinned.cmd === 'string' ? pinned.cmd : '';
    const args = Array.isArray(pinned.args) ? pinned.args.filter(a => typeof a === 'string') : [];
    if (cmd !== '' && (await exitsZero(cmd, [...args, 'hooks'])))
      return {
        cmd,
        args,
      };
  }
  for (const entry of [siblingCli(), checkoutCli()])
    if (entry !== null && (await exitsZero(jsRuntime(), [entry, 'hooks'])))
      return {
        cmd: jsRuntime(),
        args: [entry],
      };
  if (await exitsZero('bro', ['hooks']))
    return {
      cmd: 'bro',
      args: [],
    };
  const specs = opts.npxSpecs ?? (opts.npxPin !== void 0 ? [opts.npxPin] : []);
  if (specs.length > 0 && (await exitsZero('npx', ['--version']))) {
    for (const spec of specs)
      if (await exitsZero('npx', ['-y', '--prefer-offline', spec, 'hooks']))
        return {
          cmd: 'npx',
          args: ['-y', '--prefer-offline', spec],
        };
  }
  return null;
}
/**
 * The env an in-process adapter stamps on its `bro hooks` spawn so the
 * CLI's adapter emit path can journal the session into the hook spool
 * (specs/bro-izpyk.9.md): `BRO_HOOK_HOST` is the ledger host name (and
 * the launch marker — presence means "direct adapter call, no run.sh"),
 * `BRO_HOOK_PROOT` this module's own directory (the installed plugin
 * root), `BRO_HOOK_ADAPTER` the adapter version parsed off the npx pin.
 * A CLI that predates the marker ignores the env — rollout is safe in
 * both directions.
 */
function hookEmitEnv(kind, opts = {}) {
  const env = {
    BRO_HOOK_HOST: kind,
    BRO_HOOK_PROOT: dirname(fileURLToPath(import.meta.url)),
  };
  const at = opts.npxPin?.lastIndexOf('@') ?? -1;
  if (opts.npxPin !== void 0 && at > 0) env.BRO_HOOK_ADAPTER = opts.npxPin.slice(at + 1);
  return env;
}
/**
 * Run one `bro hooks <event>` with the payload on stdin; resolve null on
 * every failure mode — spawn error, timeout, nonzero exit, garbage out.
 * `extraEnv` rides on the spawn env (the adapter's `hookEmitEnv` block).
 */
async function callHook(command, event, payload, cwd, timeoutMs, extraEnv) {
  const { promise, resolve } = Promise.withResolvers();
  let child;
  try {
    child = spawn(command.cmd, [...command.args, 'hooks', event], {
      cwd,
      env:
        extraEnv === void 0
          ? void 0
          : {
              ...process.env,
              ...extraEnv,
            },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch {
    return null;
  }
  let settled = false;
  const settle = value => {
    if (!settled) {
      settled = true;
      resolve(value);
    }
  };
  const timer = killAfter(child, timeoutMs, () => settle(null));
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', chunk => {
    const remaining = MAX_OUTPUT - out.length;
    if (remaining > 0) out += chunk.slice(0, remaining);
  });
  child.on('error', () => {
    clearTimeout(timer);
    settle(null);
  });
  child.on('close', code => {
    clearTimeout(timer);
    settle(code === 0 ? parseControl(out) : null);
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(JSON.stringify(payload));
  return promise;
}
/**
 * Scan for the first parseable control line — unrelated chatter on
 * stdout must not swallow the answer.
 */
function parseControl(out) {
  for (const line of out.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}
/**
 * The context half of a control object: bro's "here is what you should
 * know" text. Empty means the hook had nothing to add.
 */
function contextOf(control) {
  const text = control?.hookSpecificOutput?.additionalContext;
  return typeof text === 'string' ? text.trim() : '';
}
/** Spawn `command args`, capture stdout+stderr, kill the process group
 *  on timeout. Never rejects — every failure mode lands in `error` or
 *  a null `code`, because a read-verb caller's only question is what
 *  printed. The nonzero exit IS the answer for gate verbs like
 *  `act status`, so the code travels in the result. */
function runCommand(command, args, options) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let settled = false;
    const settle = result => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const cap = (buf, chunk) =>
      buf.length < MAX_OUTPUT ? buf + chunk.slice(0, MAX_OUTPUT - buf.length) : buf;
    let stdout = '';
    let stderr = '';
    const timer = killAfter(child, options.timeoutMs, () =>
      settle({
        code: null,
        stdout,
        stderr,
        error: `timed out after ${options.timeoutMs}ms`,
      })
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      stdout = cap(stdout, chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderr = cap(stderr, chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      settle({
        code: null,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on('close', code => {
      clearTimeout(timer);
      settle({
        code,
        stdout,
        stderr,
        error: null,
      });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}
/**
 * The lazy, retrying CLI resolver every adapter shares: resolution
 * costs spawn probes, so it runs on first use and a *failed* answer
 * expires after RESOLVE_RETRY_MS instead of poisoning the instance —
 * PATH, a local install or npx can appear mid-session.
 */
function createCommandResolver(opts = {}) {
  let resolved;
  let failedAt;
  return () => {
    if (resolved !== void 0 && (failedAt === void 0 || Date.now() - failedAt < RESOLVE_RETRY_MS))
      return resolved;
    failedAt = void 0;
    resolved = resolveCommand(opts).then(cmd => {
      if (cmd === null) failedAt = Date.now();
      return cmd;
    });
    return resolved;
  };
}

//#endregion
//#region packages/agent-plugins/opencode/src/rpc.ts
const bead = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    assignee: { type: 'string' },
  },
  required: ['id', 'title'],
  additionalProperties: false,
};
const boardOutput = {
  type: 'object',
  properties: {
    dirty: { type: 'number' },
    dir: { type: 'string' },
    branch: { type: 'string' },
    inWork: {
      type: 'array',
      items: bead,
    },
    ready: {
      type: 'array',
      items: bead,
    },
    readyTotal: { type: 'number' },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          state: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          worktree: { type: 'string' },
          pid: { type: 'number' },
          step: { type: 'string' },
        },
        required: ['id', 'state'],
        additionalProperties: false,
      },
    },
    fleetMax: { type: 'number' },
    runs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          state: { type: 'string' },
          startedAt: { type: 'number' },
        },
        required: ['slug', 'state'],
        additionalProperties: false,
      },
    },
    watch: {
      type: 'object',
      properties: {
        ageMs: { type: 'number' },
        attention: { type: 'number' },
      },
      required: ['ageMs', 'attention'],
      additionalProperties: false,
    },
    act: {
      type: 'object',
      properties: {
        pr: { type: 'number' },
        url: { type: 'string' },
      },
      required: ['pr', 'url'],
      additionalProperties: false,
    },
    worktrees: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          branch: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    attention: { type: 'number' },
  },
  required: [
    'dirty',
    'inWork',
    'ready',
    'readyTotal',
    'agents',
    'fleetMax',
    'runs',
    'worktrees',
    'attention',
  ],
  additionalProperties: false,
};
const Bro = Rpc.define({
  id: 'bro',
  methods: {
    board: {
      input: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: boardOutput,
    },
    notify: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          text: { type: 'string' },
          title: { type: 'string' },
          variant: {
            type: 'string',
            enum: ['info', 'success', 'warning', 'error'],
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { delivered: { type: 'boolean' } },
        required: ['delivered'],
        additionalProperties: false,
      },
      errors: {
        no_session: {
          type: 'object',
          properties: { sessionID: { type: 'string' } },
          required: ['sessionID'],
          additionalProperties: false,
        },
      },
    },
    prompt: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          text: { type: 'string' },
          agent: { type: 'string' },
        },
        required: ['sessionID', 'text'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { accepted: { type: 'boolean' } },
        required: ['accepted'],
        additionalProperties: false,
      },
      errors: {
        no_session: {
          type: 'object',
          properties: { sessionID: { type: 'string' } },
          required: ['sessionID'],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: 'object',
        properties: {
          inWork: { type: 'number' },
          ready: { type: 'number' },
          agents: { type: 'number' },
        },
        required: ['inWork', 'ready', 'agents'],
        additionalProperties: false,
      },
    },
    attention: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          message: { type: 'string' },
          severity: {
            type: 'string',
            enum: ['info', 'warning', 'error'],
          },
        },
        required: ['title', 'message', 'severity'],
        additionalProperties: false,
      },
    },
  },
});
/** The RPC id as it appears in the HTTP route (`/api/rpc/bro/board`). */
const BRO_RPC_ID = Bro.id;
/** `bro status --json` is the raw wire format; this turns it into the
 *  board the contract publishes and the TUI renders. It lives in ONE
 *  place on purpose: the server part serves the parsed board over RPC
 *  and the TUI part reads THAT — so the sidebar and the RPC can never
 *  disagree about what the board is.
 *
 *  Every field is defensive: JSON arrives unverified, and one malformed
 *  row must drop that row, never the whole board. */
/** JSON numbers arrive unverified — counts, pids and epoch stamps are
 *  integers by contract; a float (or non-number coerced by Number())
 *  means the payload is not what `bro status` emits. */
const asInt = value => (typeof value === 'number' && Number.isInteger(value) ? value : void 0);
/** JSON array elements may be null or primitives — read fields only off
 *  real objects or the cast crashes the whole board parse. */
const asObj = value => (typeof value === 'object' && value !== null ? value : null);
function parseBeads(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.id !== 'string' || typeof o.title !== 'string') return [];
    const bead$1 = {
      id: o.id,
      title: o.title,
    };
    if (typeof o.assignee === 'string') bead$1.assignee = o.assignee;
    return [bead$1];
  });
}
function parseAgents(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.id !== 'string' || typeof o.state !== 'string') return [];
    const agent = {
      id: o.id,
      state: o.state,
    };
    if (typeof o.provider === 'string') agent.provider = o.provider;
    if (typeof o.model === 'string') agent.model = o.model;
    if (typeof o.worktree === 'string') agent.worktree = o.worktree;
    const pid = asInt(o.pid);
    if (pid !== void 0) agent.pid = pid;
    if (typeof o.step === 'string') agent.step = o.step;
    return [agent];
  });
}
function parseRuns(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.slug !== 'string' || typeof o.state !== 'string') return [];
    const run = {
      slug: o.slug,
      state: o.state,
    };
    const startedAt = asInt(o.startedAt);
    if (startedAt !== void 0) run.startedAt = startedAt;
    return [run];
  });
}
function parseWorktrees(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const o = asObj(row);
    if (o === null) return [];
    if (typeof o.name !== 'string') return [];
    const wt = { name: o.name };
    if (typeof o.branch === 'string') wt.branch = o.branch;
    if (typeof o.path === 'string') wt.path = o.path;
    return [wt];
  });
}
/** The empty board — a rig with no bro, a failed read, a parse error.
 *  The widget hides on an empty board; the RPC still answers. */
function emptyBoard() {
  return {
    dirty: 0,
    inWork: [],
    ready: [],
    readyTotal: 0,
    agents: [],
    fleetMax: 0,
    runs: [],
    worktrees: [],
    attention: 0,
  };
}
/** Parse `bro status --json` output into the board. Unparseable output
 *  yields the EMPTY board — never a throw, never a partial lie. */
function parseBoard(out) {
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return emptyBoard();
  }
  const o = asObj(parsed);
  if (o === null) return emptyBoard();
  const beads = asObj(o.beads) ?? {};
  const fleet = asObj(o.fleet) ?? {};
  const loop = asObj(o.loop) ?? {};
  const watch = asObj(o.watch);
  const act = asObj(o.act);
  const board = {
    dirty: asInt(o.dirty) ?? 0,
    inWork: parseBeads(beads.inProgress),
    ready: parseBeads(beads.ready),
    readyTotal: asInt(beads.readyTotal) ?? 0,
    agents: parseAgents(fleet.agents),
    fleetMax: asInt(fleet.maxConcurrent) ?? 0,
    runs: parseRuns(loop.runs),
    worktrees: parseWorktrees(o.worktrees),
    attention: asInt(o.attention) ?? 0,
  };
  if (typeof o.dir === 'string') board.dir = o.dir;
  if (typeof o.branch === 'string') board.branch = o.branch;
  if (watch !== null)
    board.watch = {
      ageMs: asInt(watch.ageMs) ?? 0,
      attention: asInt(watch.attention) ?? 0,
    };
  if (act !== null && typeof act.pr === 'number' && typeof act.url === 'string')
    board.act = {
      pr: act.pr,
      url: act.url,
    };
  return board;
}

//#endregion
//#region packages/agent-plugins/opencode/src/opencode.ts
/** Last-resort npx fallback specs, pinned first then latest — gen-plugins
 *  lists this file in VERSIONED_SOURCES, so the pin is rewritten to
 *  plugin.json's version on every gen/release run. */
const NPX_SPECS = ['@broject/bro@0.3.0', '@broject/bro'];
/** Env stamped on every `bro hooks` spawn so the CLI's adapter emit
 *  path journals this session into the hook spool — the in-process
 *  adapters bypass run.sh, which owns the shell-side writer
 *  (specs/bro-izpyk.9.md). A CLI that predates the marker ignores
 *  the env, so old↔new mixes degrade to the pre-emit status quo. */
const HOOK_ENV = hookEmitEnv('opencode', { npxPin: NPX_SPECS[0] });
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
/** Did the tool succeed? bro arms its gates and cites skills only on success,
 * so a false positive here is worse than a false negative.
 *
 *  opencode's bash metadata is `{ output, exit, truncated }` — there is no
 *  `error` field on a nonzero exit, so keying on `error` alone reads every
 *  failure as a success. Honour `exit` when the tool reports it and fall back
 *  to the error key for tools that only set that. */
function toolSucceeded(metadata) {
  if (metadata?.error !== void 0) return false;
  return typeof metadata?.exit === 'number' ? metadata.exit === 0 : true;
}
function makeCore(input) {
  const directory = input.directory;
  const options = input.options;
  const log = input.log;
  const getCommand = createCommandResolver({
    command: options?.command,
    npxSpecs: NPX_SPECS,
  });
  const notify = (level, message) => {
    log(level, message).catch(() => {});
  };
  const probe = async (event, payload, timeoutMs = HOOK_TIMEOUT_MS) => {
    const resolved = await getCommand();
    if (!resolved) {
      notify('debug', `bro probe skipped (no cli) for event=${event}`);
      return null;
    }
    const result = await callHook(resolved, event, payload, directory, timeoutMs, HOOK_ENV);
    if (result === null) notify('debug', `bro probe returned null for event=${event}`);
    return result;
  };
  /** Spawn `<bro> args` and capture stdout — the read-verb path tool
   * executions and commands share. Never rejects: no resolved CLI,
   * a spawn error, or a timeout resolves with what printed. The code
   * travels in the result because a nonzero exit IS the answer for
   * gate verbs like `act status`. */
  const exec = args =>
    getCommand().then(async resolved => {
      if (resolved === null)
        return {
          code: 127,
          out: '',
          err: 'no bro command resolved',
        };
      const result = await runCommand(resolved.cmd, [...resolved.args, ...args], {
        cwd: directory,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      return {
        code:
          result.code ??
          (result.error !== null && result.error.startsWith('timed out') ? 124 : 127),
        out: result.stdout.trim(),
        err: (result.stderr !== '' ? result.stderr : (result.error ?? '')).trim(),
      };
    });
  /** Rehydration is per session, not per turn: the context hook runs on every
   * request, so the probe runs once and the answer is re-pushed each turn —
   * which is also what carries it across compaction. The cache holds the
   * in-flight promise, not its result, so a `session.created` prime and a
   * first turn racing each other share one probe instead of two. A FAILED
   * probe is evicted rather than cached — timing out once is not the
   * session's verdict, and the next turn deserves a retry; only a real
   * answer (including an empty one) is sticky. */
  const rehydration = /* @__PURE__ */ new Map();
  const hydrate = (sessionID, event) => {
    const pending = rehydration.get(sessionID);
    if (pending) return pending;
    notify('debug', `bro hydrate starting for session=${sessionID} event=${event}`);
    const started = probe(event, { session_id: sessionID }, REHYDRATION_TIMEOUT_MS).then(
      control => {
        if (control === null && rehydration.get(sessionID) === started)
          rehydration.delete(sessionID);
        const ctx = contextOf(control);
        if (ctx)
          notify(
            'debug',
            `bro hydrate injected context for session=${sessionID} len=${ctx.length}`
          );
        return ctx;
      }
    );
    rehydration.set(sessionID, started);
    return started;
  };
  /** Sessions that already got their one re-prompt. */
  const gated = /* @__PURE__ */ new Set();
  const persistGated = () => {
    input.persist?.save([...gated]).catch(() => {});
  };
  /** Ids deleted while the persisted snapshot is still in flight — the
   * merge would otherwise resurrect the gate onto a session reusing the
   * id and its first block would be swallowed as a repeat. */
  const retiredDuringLoad = /* @__PURE__ */ new Set();
  let persistLoaded = input.persist === void 0;
  if (input.persist)
    input.persist
      .load()
      .then(stored => {
        if (Array.isArray(stored)) {
          for (const id of stored)
            if (typeof id === 'string' && !retiredDuringLoad.has(id)) gated.add(id);
        }
      })
      .catch(() => {})
      .finally(() => {
        persistLoaded = true;
        retiredDuringLoad.clear();
      });
  /** Sessions whose last assistant turn finished cleanly. */
  const clean = /* @__PURE__ */ new Set();
  /** Sessions observed alive. `session.deleted` is the only retirement, and
   * the idle gate suspends on real I/O — liveness is re-checked after each
   * suspending await before the re-prompt goes out, never assumed. The
   * value is an instance token minted per observing event, not membership:
   * a delete followed by an id-reusing create leaves the map occupied by a
   * *different* session, and a bare `has` would wave a stale gate through
   * to it. */
  const live = /* @__PURE__ */ new Map();
  let liveSeq = 0;
  /** `session.deleted` retires the per-session structures — they live as
   * long as the plugin process, not the session, so without this a
   * long-lived server accumulates dead entries. */
  const onSessionDeleted = props => {
    const sessionID = asRecord(props.info)?.id ?? props.sessionID;
    if (typeof sessionID !== 'string') return;
    rehydration.delete(sessionID);
    if (!persistLoaded) retiredDuringLoad.add(sessionID);
    if (gated.delete(sessionID)) persistGated();
    clean.delete(sessionID);
    live.delete(sessionID);
  };
  /** `session.compacted` re-primes the cache so the next turn pushes
   * post-compaction state instead of the pre-compaction snapshot. */
  const onSessionCompacted = props => {
    const sessionID = props.sessionID;
    if (typeof sessionID !== 'string') return;
    rehydration.delete(sessionID);
    hydrate(sessionID, 'post-compaction');
  };
  /** Turn completion is the stop gate — `session.idle` on v1 hosts,
   *  `session.execution.succeeded` on v2. Gated sessions pass
   *  `stop_hook_active`, so bro skips its own re-evaluation — the
   *  one-shot guard is bro's, not duplicated here. */
  const onSessionIdle = async props => {
    const sessionID = props.sessionID;
    if (typeof sessionID !== 'string' || !clean.delete(sessionID)) return;
    const instance = live.get(sessionID);
    const stillAlive = () => instance !== void 0 && live.get(sessionID) === instance;
    const control = await probe('stop', {
      session_id: sessionID,
      stop_hook_active: gated.has(sessionID),
    });
    const reason = typeof control?.reason === 'string' ? control.reason.trim() : '';
    if (control?.decision !== 'block') {
      const hint = contextOf(control);
      if (hint) await log('info', hint);
      return;
    }
    if (!stillAlive()) return;
    if (gated.has(sessionID)) {
      await log(
        'info',
        `stop gate: already gated — not re-prompting (${reason || 'unfinished bro work'})`
      );
      return;
    }
    gated.add(sessionID);
    persistGated();
    const message = reason || 'unfinished bro work';
    await log('warn', `stop gate: ${message}`);
    if (!stillAlive()) return;
    try {
      await input.reprompt(sessionID, message);
    } catch (err) {
      await log('error', `stop gate could not re-prompt: ${errorText(err)}`);
    }
  };
  /** Dispatches the v2 event stream into core handlers.
   *
   *  opencode ≥2.x never emits the v1 names — `session.idle` is declared
   *  in the schema but nothing publishes it (opencode#55358), and
   *  `session.created`/`message.updated`/`session.compacted` are absent
   *  from the public stream (verified live on 2.2.7). The v2 lifecycle
   *  is `session.execution.{started,succeeded,failed,interrupted}` plus
   *  `session.compaction.*` and `session.deleted` (that name survived).
   *  A succeeded execution is simultaneously the clean-turn verdict and
   *  the idle moment, so it feeds both the `clean` set and the stop
   *  gate in one step. */
  const onEvent = async (type, props) => {
    const sessionID = typeof props.sessionID === 'string' ? props.sessionID : void 0;
    if (sessionID !== void 0 && !live.has(sessionID)) live.set(sessionID, ++liveSeq);
    switch (type) {
      case 'session.execution.started':
        if (sessionID !== void 0) hydrate(sessionID, 'session-start');
        break;
      case 'session.execution.succeeded':
        if (sessionID !== void 0) {
          clean.add(sessionID);
          await onSessionIdle({ sessionID });
        }
        break;
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        if (sessionID !== void 0) clean.delete(sessionID);
        break;
      case 'session.compaction.succeeded':
      case 'session.compaction.ended':
        onSessionCompacted(props);
        break;
      case 'session.deleted':
        onSessionDeleted(props);
        break;
    }
  };
  return {
    probe,
    hydrate,
    onEvent,
    exec,
  };
}
/**
 * Mint a declared RPC error, tolerating a host that hands us no context.
 *
 * The contract's `errors` map is the promise to the caller: `no_session`
 * comes back as `no_session`, not as a 500 and not as a crash. The host
 * provides `context.error`; when it is missing we still have to answer
 * with SOMETHING shaped like the declared error, so we build it by hand.
 */
function declaredError(context, type, message, data) {
  if (typeof context?.error === 'function')
    try {
      return context.error(type, message, data);
    } catch {}
  return {
    type,
    message,
    data,
  };
}
/** Permission evaluation carries `resources` — for a bash ask, the command
 * segments. The classifier wants the whole ask joined. */
function evalCommand(event) {
  const resources = Array.isArray(event.resources)
    ? event.resources.filter(r => typeof r === 'string')
    : [];
  if (resources.length > 0) return resources.join(' && ');
  for (const key of ['command', 'cmd', 'pattern']) {
    const value = event.metadata?.[key];
    if (typeof value === 'string') return value;
  }
  return '';
}
/** bro read-verbs exposed as `bro_<name>` model tools — args pinned so
 * the model gets reads, never arbitrary bro. */
const BRO_TOOLS = [
  {
    name: 'status',
    description:
      'bro live board — beads in-progress/ready, fleet agents, drill frame, branch (--json)',
    args: ['status', '--json'],
  },
  {
    name: 'convoy_status',
    description: 'bro molecule DAG — done/ready/blocked steps for the open convoy',
    args: ['convoy', 'status'],
  },
  {
    name: 'act_status',
    description:
      'PR review exit gate — nonzero while blocked; the exit code IS the verdict (--json)',
    args: ['act', 'status', '--json'],
  },
  {
    name: 'fleet',
    description: 'fleet snapshot — mols × steps × agents × worktrees × PRs',
    args: ['fleet'],
  },
  {
    name: 'next',
    description: 'bro next actionable work — pick the next ready bead respecting constraints',
    args: ['next', '--list'],
  },
  {
    name: 'drill_status',
    description: 'current drill frame status — scoped investigation context',
    args: ['work', 'drill', 'status'],
  },
  {
    name: 'review_threads',
    description: 'unresolved PR review threads for current branch/PR',
    args: ['review', 'act', 'threads'],
  },
  {
    name: 'worktree_status',
    description: 'worktree and branch hygiene — dirty/uncommitted changes',
    args: ['status', '--json'],
  },
];
/** Tool registration options — `codemode: false` keeps the reads as
 * direct `bro_*` function tools; the plugin SDK's `Info.options` type
 * predates the field, so the literal is widened once here. */
const BRO_TOOL_OPTIONS = {
  namespace: 'bro',
  codemode: false,
};
/** `/bro` arguments — whitespace-split with "…"/'…' holding a multiword
 * value together (`/bro learn capture "a note"` must not shred the
 * note into four argv entries). Unmatched quotes degrade to the plain
 * token — a mangled command still runs. */
function splitArgs(input) {
  const args = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    args.push(m[1] ?? m[2] ?? m[3] ?? m[0]);
  return args;
}
/** Where the nudge lands on a tool result — `output`/`content` take text
 * directly; anything else rides metadata as `broContext`. */
function appendToolResult(result, text) {
  if (result === null) return { metadata: { broContext: text } };
  if (typeof result.output === 'string')
    return {
      ...result,
      output: `${result.output}\n\n${text}`,
    };
  if (typeof result.content === 'string')
    return {
      ...result,
      content: `${result.content}\n\n${text}`,
    };
  return {
    ...result,
    metadata: {
      ...asRecord(result.metadata),
      broContext: text,
    },
  };
}
/** Parse a `SKILL.md` frontmatter block — `name`, `description`, and the
 * optional `autoinvoke` flag. A file without frontmatter is not a skill;
 * it is skipped rather than half-registered. */
function parseSkill(markdown) {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) return null;
  const front = markdown.slice(3, end);
  const name = /^\s*name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  const description = /^\s*description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (!name || !description) return null;
  return {
    name: name.replace(/^["']|["']$/g, ''),
    description: description.replace(/^["']|["']$/g, ''),
  };
}
/** The directories that may hold bro's skills, most specific first:
 *  an explicit option, the materialized sibling `skills/`, the npm
 *  package's `skills/`, then the checkout's `skills/`.
 *
 *  An explicit `skillsDir` is AUTHORITATIVE: it is the only root tried.
 *  Falling back to the checkout when it points nowhere would register a
 *  different skill set than the operator asked for — a silent mismatch
 *  between what was configured and what opencode learned. */
function skillRoots(options) {
  if (typeof options?.skillsDir === 'string' && options.skillsDir.trim() !== '')
    return [options.skillsDir];
  const roots = [];
  roots.push(fileURLToPath(new URL('./skills', import.meta.url)));
  roots.push(fileURLToPath(new URL('../skills', import.meta.url)));
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    roots.push(join(dir, 'skills'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}
async function BroSetup(ctx) {
  const log = (level, message) => {
    try {
      console.error(`[bro] ${level}: ${message}`);
    } catch {}
    return Promise.resolve(void 0);
  };
  const core = makeCore({
    directory: ctx.location?.directory ?? process.cwd(),
    options: ctx.options,
    log,
    reprompt: (sessionID, text) => {
      const session = ctx.session;
      const fn = session?.prompt?.bind(session) ?? session?.synthetic?.bind(session);
      return fn
        ? fn({
            sessionID,
            text,
          })
        : Promise.resolve(void 0);
    },
    persist:
      ctx.storage?.get !== void 0 && ctx.storage?.set !== void 0
        ? {
            load: () => ctx.storage?.get?.('stop-gated') ?? Promise.resolve(void 0),
            save: ids =>
              Promise.resolve(ctx.storage?.set?.('stop-gated', [...ids])).then(() => void 0),
          }
        : void 0,
  });
  const pendingPromptContext = /* @__PURE__ */ new Map();
  const registrations = [];
  const register = r => {
    if (r) registrations.push(r.catch(() => void 0));
  };
  register(
    ctx.session?.hook?.('context', async event => {
      const sessionID = event.sessionID;
      if (!sessionID || event.system === void 0) return;
      const text = await core.hydrate(sessionID, 'session-start');
      if (text)
        event.system.push({
          type: 'text',
          text,
        });
      if (sessionID) {
        const pending = pendingPromptContext.get(sessionID);
        if (pending && event.system !== void 0) {
          event.system.push({
            type: 'text',
            text: pending,
          });
          pendingPromptContext.delete(sessionID);
        }
      }
    })
  );
  register(
    ctx.session?.hook?.('compaction', async event => {
      try {
        const text = contextOf(
          await core.probe('pre-compact', { session_id: event.sessionID }, REHYDRATION_TIMEOUT_MS)
        );
        if (text && event.system !== void 0)
          event.system.push({
            type: 'text',
            text,
          });
      } catch {}
    })
  );
  register(
    ctx.session?.hook?.('prompt', async event => {
      const prompt = event.prompt;
      if (prompt === void 0) return;
      const text = contextOf(
        await core.probe('prompt-submit', {
          session_id: event.sessionID,
          prompt: prompt.text ?? '',
        })
      );
      if (text && event.sessionID) pendingPromptContext.set(event.sessionID, text);
    })
  );
  register(
    ctx.tool?.hook?.('execute.before', async event => {
      const control = await core.probe('pre-tool', {
        session_id: event.sessionID,
        tool_name: event.tool,
        tool_input: asRecord(event.input) ?? {},
      });
      if (control === null) return;
      const override = asRecord(asRecord(control.hookSpecificOutput)?.tool_input);
      if (override)
        event.input = {
          ...asRecord(event.input),
          ...override,
        };
      if (control.decision === 'block' || control.decision === 'deny') {
        const reason = typeof control.reason === 'string' ? control.reason.trim() : '';
        throw new Error(reason || 'blocked by bro');
      }
    })
  );
  register(
    ctx.tool?.hook?.('execute.after', async event => {
      const result = asRecord(event.result);
      const text = contextOf(
        await core.probe('post-tool', {
          session_id: event.sessionID,
          tool_name: event.tool,
          tool_input: asRecord(event.input) ?? asRecord(event.args) ?? {},
          tool_response: {
            success: event.status !== 'error' && toolSucceeded(asRecord(result?.metadata)),
          },
        })
      );
      if (text) event.result = appendToolResult(result, text);
    })
  );
  register(
    ctx.permission?.hook?.('evaluate', async event => {
      const command = evalCommand(event);
      if (!command) return;
      const control = await core.probe('permission', {
        tool_input: { command },
        session_id: event.sessionID,
      });
      if (control?.decision === 'approve') event.effect = 'allow';
      else if (control?.decision === 'deny' || control?.decision === 'block') {
        event.effect = 'deny';
        const reason = typeof control?.reason === 'string' ? control.reason.trim() : '';
        if (reason) event.message = reason;
      }
    })
  );
  register(
    ctx.shell?.hook?.('create.before', event => {
      if (event.env === void 0) return;
      event.env.BRO_AGENT_ID ??= 'opencode';
    })
  );
  register(
    ctx.tool?.transform?.(editor => {
      editor.namespace?.({
        name: 'bro',
        description: 'bro orchestration reads',
      });
      for (const tool of BRO_TOOLS)
        editor.add?.({
          name: tool.name,
          description: tool.description,
          input: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          options: BRO_TOOL_OPTIONS,
          execute: async () => {
            const { code, out, err } = await core.exec(tool.args);
            const body = out || err || '(no output)';
            return { content: code === 0 ? body : `exit ${code}: ${body}` };
          },
        });
    })
  );
  register(
    ctx.command?.transform?.(editor => {
      const run = async (sessionID, argv, label) => {
        if (!sessionID || !ctx.session?.prompt) return;
        const { code, out, err } = await core.exec(argv);
        let body = out || err || '(no output)';
        body = body
          .split('\n')
          .filter(l => {
            const t = l.trim().toLowerCase();
            if (!t) return true;
            const words = t.split(/\s+/);
            if (words[0] === 'bro' && words[1] === 'learn') return false;
            return true;
          })
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const suffix = code === 0 ? '' : ` (exit ${code})`;
        await ctx.session.prompt({
          sessionID,
          text: `${label}${suffix}:\n${body}`,
        });
      };
      editor.add?.({
        name: 'bro',
        description: 'bro orchestration — `/bro [args]` runs the CLI and submits the output',
        execute: async ({ sessionID, prompt }) => {
          const args = splitArgs(prompt?.text ?? '');
          const verb = args.length > 0 ? args : ['status'];
          await run(sessionID, verb, `bro ${verb.join(' ')}`);
        },
      });
      editor.add?.({
        name: 'act',
        description: 'shortcut for `/bro act` — PR review gate/threads (bro act)',
        execute: async ({ sessionID, prompt }) => {
          const verb = ['act', ...splitArgs(prompt?.text ?? '')];
          await run(sessionID, verb, `bro ${verb.join(' ')}`);
        },
      });
    })
  );
  if (typeof ctx.options?.mcpPort === 'number') {
    const mcpPort = ctx.options.mcpPort;
    register(
      ctx.mcp?.transform?.(editor => {
        editor.set?.('bro', {
          type: 'remote',
          url: `http://127.0.0.1:${mcpPort}`,
        });
      })
    );
  }
  const boardSnapshot = async () => {
    const { code, out } = await core.exec(['status', '--json']);
    if (code !== 0 || out === '') return emptyBoard();
    return parseBoard(out);
  };
  const rpcRegistration = ctx.rpc?.register?.(Bro, {
    board: async () => boardSnapshot(),
    notify: async (input, _context) => {
      const { sessionID, text, title, variant } = asRecord(input) ?? {};
      if (typeof text !== 'string' || text.trim() === '') return { delivered: false };
      const body = typeof title === 'string' && title.trim() !== '' ? title : 'bro';
      const message = variant === 'error' || variant === 'warning' ? `⚠ ${text}` : text;
      if (typeof sessionID === 'string' && sessionID !== '')
        try {
          await ctx.session?.prompt?.({
            sessionID,
            text: `${body}: ${message}`,
          });
          return { delivered: true };
        } catch {}
      await emitRpc('attention', {
        title: body,
        message,
        severity: variant === 'error' ? 'error' : variant === 'warning' ? 'warning' : 'info',
      });
      return { delivered: true };
    },
    prompt: async (input, context) => {
      const { sessionID, text, agent } = asRecord(input) ?? {};
      if (typeof sessionID !== 'string' || sessionID === '')
        return declaredError(context, 'no_session', 'sessionID is required', { sessionID: '' });
      if (typeof text !== 'string' || text.trim() === '') return { accepted: false };
      try {
        if (typeof agent === 'string' && agent !== '')
          await ctx.session?.switchAgent?.({
            sessionID,
            agent,
          });
        await ctx.session?.prompt?.({
          sessionID,
          text,
        });
        return { accepted: true };
      } catch {
        return declaredError(context, 'no_session', 'session not available', { sessionID });
      }
    },
  });
  let emitRpc = async () => void 0;
  register(
    (rpcRegistration ?? Promise.resolve(void 0))?.then(reg => {
      if (reg !== void 0)
        emitRpc = async (name, data) => {
          try {
            await reg.events.emit(name, data);
          } catch {}
        };
      return reg;
    })
  );
  const skills = await collectBroSkills(ctx.options);
  if (skills.length > 0)
    register(
      ctx.skill?.transform?.(editor => {
        for (const skill of skills)
          editor.add?.({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            path: skill.path,
            content: skill.content,
          });
      })
    );
  const controller = new AbortController();
  const stream = ctx.event?.subscribe?.({ signal: controller.signal });
  if (stream)
    (async () => {
      for await (const raw of stream) {
        const e = asRecord(raw);
        const type = typeof e?.type === 'string' ? e.type : '';
        if (type)
          core.onEvent(type, asRecord(e?.properties) ?? asRecord(e?.data) ?? {}).catch(() => {});
      }
    })().catch(() => {});
  await log('info', `plugin ready — ${skills.length} bro skill(s), RPC 'bro' registered`);
  return async () => {
    controller.abort();
    for (const pending of registrations)
      try {
        await (await pending)?.dispose?.();
      } catch {}
  };
}
/** Read bro's skills off disk and shape them for opencode's registry.
 *  Every failure mode — a missing tree, an unreadable file, a file
 *  without frontmatter — drops that one skill, never the whole set. */
async function collectBroSkills(options) {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of skillRoots(options)) {
    let entries;
    try {
      if (!existsSync(root)) continue;
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(root, entry, 'SKILL.md');
      let content;
      try {
        if (!statSync(path).isFile()) continue;
        content = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkill(content);
      if (parsed === null) continue;
      const id = entry;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: parsed.name ?? entry,
        description: parsed.description ?? '',
        path,
        content,
      });
    }
    if (out.length > 0) break;
  }
  return out;
}
/** `Plugin.define` at runtime — opencode's own loader is what reads the
 *  default export, and the published contract asks for this exact shape.
 *  The cast below narrows the SDK's stricter signature back to the
 *  structural one the implementation actually honours. */
const defined = Plugin.define({
  id: 'bro',
  setup: BroSetup,
});
var opencode_default = defined;

//#endregion
export { BroSetup, collectBroSkills, opencode_default as default, skillRoots, toolSucceeded };
