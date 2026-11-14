/**
 * `bro acp` agent mode — bro IS the agent (specs/bro-tegz2.md). The
 * ACP client (Zed, JetBrains, `devin acp`, any `* acp` binary) spawns
 * this process as its stdio agent; bro advertises its own CLI contract
 * as slash commands (`/act status`, `/next`, `/drill …` — run as real
 * `bro` children inside the session's repo) and forwards free-form
 * prompts to the configured downstream provider — `--provider`, else
 * `fleet.routing.<class>` chain head, else the first acp entry.
 *
 * The wire is the SAME `runAcpProxy` pump `bro acp proxy` runs — the
 * agent-mode overlay adds bro's initialize identity, the per-session
 * `available_commands_update`, and local-turn interception. It is not
 * a second ACP server and not the brouter facade (bro-te3yf): the
 * generic "stdio endpoint in front of a configured provider" surface
 * belongs to `brouter acp`; this surface is bro's own.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AvailableCommand, Stream } from '@agentclientprotocol/sdk';
import {
  CommandError,
  EXIT,
  flag,
  getProvider,
  loadConfig,
  positionals,
  resolveStepClass,
} from '@broject/core';
import type { ProviderEntry, RoutingTable } from '@broject/core';
import { acpChildEnv, acpProxy, runAcpProxy, shellWords } from '@broject/providers';
import type {
  AcpAgentOverlay,
  AcpAgentTurn,
  AcpProxyOptions,
  AcpProxySeam,
} from '@broject/providers';
import { buildDump, type ContractDump } from './contract-dump.ts';
import {
  collectPermission,
  collectPromptContext,
  collectSessionContext,
  collectStopGate,
  collectToolCallGuards,
} from './hooks.ts';
import { VERSION } from '../version.ts';

const USAGE = `usage:
  bro acp [--provider <name> | --class <name>]
  bro acp proxy -- <agent cmd…>`;

function usage(line: string): never {
  throw new CommandError(`${line}\n${USAGE}`, EXIT.usage, USAGE);
}

/** config error — wrong provider kind, no acp entry, dead lane. */
function die(msg: string): never {
  throw new CommandError(`error: ${msg}`, EXIT.error);
}

// ── argv ──────────────────────────────────────────────────────────────────

export interface AcpAgentSel {
  provider?: string;
  class?: string;
}

const VALUE_FLAGS = new Set(['--provider', '--class']);

/** Agent-mode flags — the bare form IS the server: every token must be
 *  a known flag; anything else is a usage error (a positional reads as
 *  the subcommand typos meant). `--provider` and `--class` are mutually
 *  exclusive — a pin and a lane can't both answer "which provider". */
export function acpAgentFlags(argv: string[]): AcpAgentSel {
  const pos = strictPositionals(argv);
  if (pos.length > 0) {
    usage(`error: unknown subcommand '${pos[0]}'`);
  }
  const provider = flag(argv, '--provider');
  const cls = flag(argv, '--class');
  if (provider !== undefined && cls !== undefined) {
    usage('error: --provider and --class are mutually exclusive');
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(cls === undefined ? {} : { class: cls }),
  };
}

/** Strict positionals — a CommandError out of the parser is a usage
 *  error carrying this command's own usage text. */
function strictPositionals(argv: string[]): string[] {
  try {
    return positionals(argv, VALUE_FLAGS, { strict: true });
  } catch (e) {
    if (e instanceof CommandError) {
      usage(e.message);
    }
    throw e;
  }
}

// ── provider selection — fleet.routing class → chain head ─────────────────

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>;

export interface AcpAgentProvider {
  name: string;
  entry: AcpEntry;
  /** the rule that picked it — the log line's provenance */
  via: string;
}

/** `--provider` pin → the class chain head → the first acp entry. The
 *  head must SPEAK acp — `resolveStepClass` already guarantees a spawn
 *  surface (`cli` entries pass it), so a non-acp head is a config
 *  error naming class + entry, never a silent re-route. The same rule
 *  for `--class` itself: a named lane with no routing table is a
 *  config error, not a quiet fallthrough to whatever comes first. */
export function resolveAcpAgentProvider(
  providers: Record<string, ProviderEntry>,
  routing: RoutingTable | undefined,
  sel: AcpAgentSel
): AcpAgentProvider {
  if (sel.provider !== undefined) {
    const entry = getProvider(providers, sel.provider);
    if (entry.type !== 'acp') {
      die(`providers.${sel.provider} is a ${entry.type} entry — bro acp needs an acp one`);
    }
    return { name: sel.provider, entry, via: '--provider' };
  }
  if (routing !== undefined && Object.keys(routing).length > 0) {
    return pickRoutedProvider(providers, routing, sel.class);
  }
  // a named lane with no routing table is a config error — silently
  // falling to the first acp entry would run a provider the operator
  // never routed to
  if (sel.class !== undefined) {
    die(
      `--class ${sel.class} — no fleet.routing table configured; declare fleet.routing.${sel.class}.chain or drop --class`
    );
  }
  const first = Object.entries(providers).find(([, e]) => e.type === 'acp');
  if (first === undefined) {
    die('no acp provider configured — declare providers.<name> of type acp or pass --provider');
  }
  return {
    name: first[0],
    entry: first[1] as AcpEntry,
    via: 'the first acp provider in the config',
  };
}

/** The routing leg — `resolveStepClass` already guarantees a spawn
 *  surface (a `cli` head passes it), so a non-acp head is a config
 *  error naming class + entry, never a silent re-route. */
function pickRoutedProvider(
  providers: Record<string, ProviderEntry>,
  routing: RoutingTable,
  cls: string | undefined
): AcpAgentProvider {
  const resolved = resolveStepClass(routing, providers, { class: cls });
  const entry = getProvider(providers, resolved.provider);
  if (entry.type !== 'acp') {
    die(
      `fleet.routing.${resolved.class}.chain[0] → providers.${resolved.provider} is a ${entry.type} entry — bro acp needs an acp one`
    );
  }
  return { name: resolved.provider, entry, via: `fleet.routing.${resolved.class}` };
}

// ── the advertised slash set ───────────────────────────────────────────────

/** Commands that can never be a session turn: protocol servers whose
 *  stdio IS a wire (acp/mcp/serve/herdr/acp-worker), and turns that
 *  cannot end — daemons, watchers, and waiters whose normal runtime
 *  dwarfs SLASH_TIMEOUT_MS (daemon/watch/watchdog/loop/wait). Hidden
 *  commands never advertise either — they are machine-facing by
 *  definition. */
export const SLASH_BLOCKLIST: ReadonlySet<string> = new Set([
  'acp',
  'acp-worker',
  'daemon',
  'herdr',
  'loop',
  'mcp',
  'serve',
  'wait',
  'watch',
  'watchdog',
]);

/** Argv-level blocks on otherwise-advertised commands — the command
 *  has bounded subs worth a turn, but these shapes are unbounded
 *  waiters or repaint loops that would hold the turn (and the
 *  session's writeQ) until SLASH_TIMEOUT_MS: `convoy wait`/`mesh wait`
 *  are poll loops, `drive --every` re-arms supervision cadences,
 *  `fleet --live`/`--every` is a TTY repaint. Checked at invocation —
 *  the name stays advertised for its bounded subs. */
const SLASH_SUB_BLOCKLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  convoy: new Set(['wait']),
  mesh: new Set(['wait']),
};
const SLASH_FLAG_BLOCKLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  drive: new Set(['--every']),
  fleet: new Set(['--every', '--live']),
};

/** Why this argv can never be a session turn — a `/name sub` or
 *  `/name --flag` that is an unbounded waiter/loop. Returns the
 *  blocked shape for the in-band refusal, undefined when runnable. */
export function slashTurnBlocked(name: string, args: string[]): string | undefined {
  if (args[0] !== undefined && SLASH_SUB_BLOCKLIST[name]?.has(args[0]) === true) {
    return `${name} ${args[0]}`;
  }
  const flags = SLASH_FLAG_BLOCKLIST[name];
  if (flags === undefined) {
    return undefined;
  }
  const hit = args.find(a => flags.has(a) || flags.has(a.split('=')[0] ?? ''));
  return hit === undefined ? undefined : `${name} ${hit}`;
}

/** The contract document → the wire's availableCommands: every
 *  non-hidden, non-serving command, hint = declared subs or 'args'. */
export function advertisedCommands(dump: ContractDump): AvailableCommand[] {
  return Object.values(dump.commands)
    .filter(c => !c.hidden && !SLASH_BLOCKLIST.has(c.name))
    .map(c => ({
      name: c.name,
      description: c.summary,
      input: { hint: Object.keys(c.contract?.subs ?? {}).join('|') || 'args' },
    }));
}

/** `/name args…` at the very start of the flattened prompt — strict:
 *  leading context or whitespace means free-form text, not a command.
 *  The args stay RAW — tokenizing is the runner's job (an unclosed
 *  quote is the command's own error to report). */
const SLASH_RE = /^\/([A-Za-z][\w-]*)[ \t]*([\s\S]*)$/;

export function matchSlash(text: string): { name: string; args: string } | undefined {
  const m = SLASH_RE.exec(text);
  return m === null ? undefined : { name: m[1] ?? '', args: m[2] ?? '' };
}

// ── the slash runner ────────────────────────────────────────────────────────

/** A slash command is a turn — bounded, not a daemon lease. */
export const SLASH_TIMEOUT_MS = 5 * 60_000;

/** SIGTERM→SIGKILL grace: a child that ignores the term signal gets
 *  this long to exit before the hard kill. Exported for tests. */
export const KILL_GRACE_MS = 1_500;

/** `node <argv1>` spawns a `bro` child identical to this process —
 *  dist/index.js installed, src/index.ts in dev (node ≥22.18 strips
 *  types natively). Resolved once against the server's cwd — the
 *  child's own cwd is the session repo, never the server's. */
const cliEntry = resolve(process.argv[1] ?? 'bro');

function defaultCliArgv(argv: string[]): string[] {
  return [process.execPath, cliEntry, ...argv];
}

/** Spawn `bro <argv>` inside the session repo, streaming stdout as
 *  agent_message_chunk updates. A non-zero exit, a signal death, an
 *  exec failure, or the timeout reports in-band as the turn's own
 *  text — the command's failure is turn content, never a wire error.
 *  `signal` (the cancel) SIGTERMs the child. Exported for tests. */
export async function runSlash(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  chunk: (text: string) => void
): Promise<void> {
  const bin = argv[0];
  if (bin === undefined) {
    chunk('bro acp: empty slash argv — nothing to exec');
    return;
  }
  await new Promise<void>(resolve => {
    let stderr = '';
    let timedOut = false;
    let reported = false;
    const cmd = `\`bro ${argv.slice(1).join(' ')}\``;
    const child = spawn(bin, argv.slice(1), {
      cwd,
      env: acpChildEnv(),
      // own process group — a `bro` child shells out (`exec` → sh -c
      // → descendants) and a signal to the direct child alone never
      // reaches them; a detached group also stops receiving signals
      // aimed at the agent's own group, which is exactly right here
      detached: process.platform !== 'win32',
      // stdin is 'ignore', not a pipe the parent never ends — a
      // command that reads stdin to EOF (`exec`, `resume`) would
      // wait forever on a write end nobody owns
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killRun = (sig: 'SIGTERM' | 'SIGKILL') => {
      if (process.platform === 'win32' || child.pid === undefined) {
        child.kill(sig);
        return;
      }
      try {
        process.kill(-child.pid, sig);
      } catch {
        // the group already exited
      }
    };
    // stdout/stderr cross chunk boundaries — a multibyte sequence
    // split between two 'data' events decodes through a StringDecoder
    // (the same accumulator acp-terminal.ts uses); a per-chunk
    // toString() would emit U+FFFD pairs mid-character
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killing = false;
    const terminate = () => {
      if (killing) {
        return;
      }
      killing = true;
      killRun('SIGTERM');
      // a child that traps SIGTERM or keeps its stdout pipe open
      // would hold 'close' — and every prompt queued behind it in
      // the session writeQ — until the timeout cap; escalate after
      // a short grace
      killTimer = setTimeout(() => killRun('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => terminate();
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // a cancel that landed while the turn queued in the session's
    // writeQ already consumed the abort event — the listener never
    // re-fires for it, so kill the child explicitly
    if (signal.aborted) {
      onAbort();
    }
    child.stdout.on('data', (d: Buffer) => chunk(outDec.write(d)));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + errDec.write(d)).slice(-2048);
    });
    child.on('error', e => {
      cleanup();
      reported = true;
      chunk(`${cmd} — cannot exec ${bin}: ${e.message}`);
      resolve();
    });
    child.on('close', (code, sig) => {
      cleanup();
      if (reported) {
        return; // the exec failure already wrote the verdict
      }
      if (timedOut) {
        chunk(`\n\n— slash command timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      // code === null is a signal death — outside the timeout/cancel
      // paths (an external kill, OOM) the turn must still SAY the
      // command died rather than read as a clean run
      if (code !== 0) {
        const tail = stderr.trim();
        const how = code === null ? `killed by ${sig ?? 'signal'}` : `exited ${code}`;
        chunk(`\n\n— ${cmd} ${how}${tail === '' ? '' : `: ${tail}`}`);
      }
      resolve();
    });
  });
}

/** The overlay's local-turn handler: a leading `/name` in the
 *  advertised set runs `bro <name> <args>` on bro's side; anything
 *  else — plain text, an unknown slash — returns undefined and the
 *  prompt crosses downstream (the agent's own slash vocabulary
 *  composes with bro's). Exported for tests. */
export function slashPrompt(
  commands: AvailableCommand[],
  deps: AcpAgentDeps
): NonNullable<AcpAgentOverlay['prompt']> {
  const names = new Set(commands.map(c => c.name));
  const cliArgv = deps.cliArgv ?? defaultCliArgv;
  const timeoutMs = deps.slashTimeoutMs ?? SLASH_TIMEOUT_MS;
  return async (turn: AcpAgentTurn) => {
    const m = matchSlash(turn.text);
    if (m === undefined || !names.has(m.name)) {
      return undefined;
    }
    const chunk = (text: string): void => {
      turn.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    };
    let args: string[];
    try {
      args = m.args.trim() === '' ? [] : shellWords(m.args);
    } catch (e) {
      chunk(`bro ${m.name}: ${e instanceof Error ? e.message : String(e)}`);
      return { stopReason: 'end_turn' };
    }
    // a name-level pass is not enough — sub/flag shapes that can
    // never end inside a turn refuse in-band (the bounded siblings
    // stay reachable)
    const blocked = slashTurnBlocked(m.name, args);
    if (blocked !== undefined) {
      chunk(`bro acp: \`bro ${blocked}\` is an unbounded wait/loop — it cannot be a session turn`);
      return { stopReason: 'end_turn' };
    }
    // the session's cwd — never the server's own: a session opened
    // without one (load/resume/fork carry no cwd to stamp) has no
    // repo to run in — refuse in-band rather than claim work inside
    // the wrong project
    if (turn.cwd === undefined) {
      chunk(
        'bro acp: this session carries no working directory (session/new.cwd) — slash commands need a session opened in a repo'
      );
      return { stopReason: 'end_turn' };
    }
    await runSlash(cliArgv([m.name, ...args]), turn.cwd, timeoutMs, turn.signal, chunk);
    return { stopReason: 'end_turn' };
  };
}

// ── the server ─────────────────────────────────────────────────────────────

export interface AcpAgentDeps {
  /** config root — defaults to the server's cwd (the client spawns the
   *  agent inside its own repo) */
  dir?: string;
  /** test seam — both legs in-process; absent = process stdio upstream
   *  + the provider's spawned command downstream */
  streams?: { upstream: Stream; downstream: Stream };
  /** the advertised set — absent builds it from the live registry */
  commands?: AvailableCommand[];
  /** slash child argv template — defaults to `node <cli> <argv>` */
  cliArgv?: (argv: string[]) => string[];
  /** the slash run's cap — default SLASH_TIMEOUT_MS */
  slashTimeoutMs?: number;
  /** seam override — absent wires the real hook collectors */
  seam?: AcpProxySeam;
  /** the initialize identity — absent = bro + this build's version */
  agentInfo?: { name: string; version?: string; title?: string };
  log?: (line: string) => void;
}

/** The hook seam `bro acp proxy` wires — the same collectors, the same
 *  per-session cwd rule. Agent mode adds the local surface; it never
 *  subtracts the seam. */
export function acpHookSeam(): AcpProxySeam {
  return {
    sessionContext: async (cwd, sessionId) => {
      const r = await collectSessionContext(cwd, sessionId);
      // `settled` must cross the seam — an unsettled probe set is
      // incomplete context: the proxy retries it on the next prompt
      return {
        text: r.lines.length === 0 ? undefined : r.lines.join('\n'),
        settled: r.settled,
      };
    },
    promptContext: async (cwd, sessionId, prompt) => {
      const r = await collectPromptContext(cwd, sessionId, prompt);
      return r.lines.length === 0 ? undefined : r.lines.join('\n');
    },
    toolCall: async (cwd, sessionId, call) => {
      const r = await collectToolCallGuards(cwd, sessionId, call);
      return r.lines.length === 0 ? undefined : r.lines;
    },
    stopGate: async (cwd, sessionId) => {
      const r = await collectStopGate(cwd, sessionId);
      return r.block === undefined && r.hints.length === 0 ? undefined : r;
    },
    // the permission leg (spec bro-9qopj): the PermissionRequest
    // hook's policy as a library call — allow/deny answer downstream
    // on the spot, ask forwards to the client. `call` arrives as the
    // proxy's AcpProxyPermissionCall shape; AcpPermissionCall is the
    // same structure declared on this side of the module edge.
    permission: async (cwd, sessionId, call) => collectPermission(cwd, sessionId, call),
  };
}

/** The registry document `bro contract dump --json` emits — lazily
 *  imported so this module never pays the registry's init cost on the
 *  proxy path (and plugins.ts's own acp registration stays acyclic).
 *  It reflects the plugins loaded for the SERVER's cwd while slash
 *  children load their own plugins from the session cwd — a session
 *  opened in a repo with different `plugins:` config sees a set that
 *  diverges both ways (an advertised name the child's registry lacks
 *  fails in-band as bro's own usage error; a repo-local command the
 *  server never loaded isn't advertised and falls through downstream).
 *  Per-session contract dumps are a deliberate follow-up — the static
 *  set is the documented v1 boundary. */
async function contractDump(): Promise<ContractDump> {
  const { PLUGINS, GROUP_META } = await import('../plugins.ts');
  return buildDump(PLUGINS, GROUP_META);
}

/** Serve bro-as-agent until the client ends the wire — 0 on a clean
 *  client close, 1 when the downstream died first (the pump's own
 *  verdict, same as proxy mode). */
export async function runAcpAgent(sel: AcpAgentSel, deps: AcpAgentDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const commands = deps.commands ?? advertisedCommands(await contractDump());
  const agent: AcpAgentOverlay = {
    agentInfo: deps.agentInfo ?? {
      name: 'bro',
      version: VERSION,
      title: 'bro — ACP agent mode',
    },
    commands,
    prompt: slashPrompt(commands, deps),
  };
  const opts: AcpProxyOptions = { seam: deps.seam ?? acpHookSeam(), agent, log };
  if (deps.streams !== undefined) {
    return acpProxy(deps.streams.upstream, deps.streams.downstream, opts);
  }
  const config = loadConfig(deps.dir ?? process.cwd());
  const providers = config.providers ?? {};
  const pick = resolveAcpAgentProvider(providers, config.fleet?.routing, sel);
  log(`bro acp: agent mode — downstream is ${pick.name} (${pick.via})`);
  // the downstream argv is the entry's own command — the same spawn
  // shape acpOpen uses for acp entries (shell words + --profile)
  const argv = [
    ...shellWords(pick.entry.command),
    ...(pick.entry.profile === undefined ? [] : ['--profile', pick.entry.profile]),
  ];
  return runAcpProxy(argv, opts);
}
