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
import type { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
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
  let pos: string[];
  try {
    pos = positionals(argv, VALUE_FLAGS, { strict: true });
  } catch (e) {
    if (e instanceof CommandError) {
      usage(e.message);
    }
    throw e;
  }
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
 *  error naming class + entry, never a silent re-route. */
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
    const resolved = resolveStepClass(routing, providers, { class: sel.class });
    const entry = getProvider(providers, resolved.provider);
    if (entry.type !== 'acp') {
      die(
        `fleet.routing.${resolved.class}.chain[0] → providers.${resolved.provider} is a ${entry.type} entry — bro acp needs an acp one`
      );
    }
    return { name: resolved.provider, entry, via: `fleet.routing.${resolved.class}` };
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

// ── the advertised slash set ───────────────────────────────────────────────

/** Commands that can never be a session turn: protocol servers whose
 *  stdio IS a wire (acp/mcp/serve/herdr/acp-worker), and turns that
 *  cannot end (daemon/watch/watchdog/loop). Hidden commands never
 *  advertise either — they are machine-facing by definition. */
export const SLASH_BLOCKLIST: ReadonlySet<string> = new Set([
  'acp',
  'acp-worker',
  'daemon',
  'herdr',
  'loop',
  'mcp',
  'serve',
  'watch',
  'watchdog',
]);

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

/** `node <argv1>` spawns a `bro` child identical to this process —
 *  dist/index.js installed, src/index.ts in dev (node ≥22.18 strips
 *  types natively). Resolved once against the server's cwd — the
 *  child's own cwd is the session repo, never the server's. */
const cliEntry = resolve(process.argv[1] ?? 'bro');

function defaultCliArgv(argv: string[]): string[] {
  return [process.execPath, cliEntry, ...argv];
}

/** Spawn `bro <argv>` inside the session repo, streaming stdout as
 *  agent_message_chunk updates. A non-zero exit, an exec failure, or
 *  the timeout reports in-band as the turn's own text — the command's
 *  failure is turn content, never a wire error. `signal` (the cancel)
 *  SIGTERMs the child. */
async function runSlash(
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
    const child = spawn(bin, argv.slice(1), { cwd, env: acpChildEnv() });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGTERM');
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => chunk(d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2048);
    });
    child.on('error', e => {
      cleanup();
      chunk(`\`bro ${argv.slice(1).join(' ')}\` — cannot exec ${bin}: ${e.message}`);
      resolve();
    });
    child.on('close', code => {
      cleanup();
      if (timedOut) {
        chunk(`\n\n— slash command timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      if (code !== 0 && code !== null) {
        const tail = stderr.trim();
        chunk(
          `\n\n— \`bro ${argv.slice(1).join(' ')}\` exited ${code}${tail === '' ? '' : `: ${tail}`}`
        );
      }
      resolve();
    });
  });
}

/** The overlay's local-turn handler: a leading `/name` in the
 *  advertised set runs `bro <name> <args>` on bro's side; anything
 *  else — plain text, an unknown slash — returns undefined and the
 *  prompt crosses downstream (the agent's own slash vocabulary
 *  composes with bro's). */
function slashPrompt(
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
    // the session's cwd — never the server's own: a client that opened
    // its session in another repo gets THAT repo's `bro`, or nothing
    await runSlash(
      cliArgv([m.name, ...args]),
      turn.cwd ?? process.cwd(),
      timeoutMs,
      turn.signal,
      chunk
    );
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
  };
}

/** The registry document `bro contract dump --json` emits — lazily
 *  imported so this module never pays the registry's init cost on the
 *  proxy path (and plugins.ts's own acp registration stays acyclic). */
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
