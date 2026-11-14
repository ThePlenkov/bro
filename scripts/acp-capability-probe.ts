#!/usr/bin/env node
/**
 * acp-capability-probe — what does each installed ACP agent actually
 * advertise?
 *
 * The interactive pane's design hinges on ONE unknown: whether an agent
 * supports `session/load` (resume a finished session) or
 * `sessionCapabilities.resume` (resume without replay). The spec
 * (bro-5vjpg) left it open; this probe answers it for the agents on
 * THIS box.
 *
 * It speaks the wire by hand — one NDJSON JSON-RPC frame on stdin, one
 * on stdout — because the answer must not depend on bro's SDK version
 * or on the provider config: the probe asks the AGENT, not our own
 * assumptions about it.
 *
 *   node scripts/acp-capability-probe.ts                 # probe the known set
 *   node scripts/acp-capability-probe.ts --cmd 'devin acp' --cmd 'kilo acp'
 *
 * Exit code: 0 when every probe ran (a refusal is a RESULT, not a
 * failure — the answer is "this agent does not advertise X"), 1 when
 * a probe could not be run at all.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = 1;

/** The agents worth asking. A missing binary is a skip, not a failure. */
const DEFAULT_COMMANDS = [
  'devin acp',
  'kilo acp',
  'opencode acp',
  'claude-code-acp',
  'copilot --acp --stdio',
  'gemini --acp',
  'qwen --acp',
];

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** argv words — no shell, no expansion. Same discipline as the providers. */
function shellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote !== undefined) throw new Error('unclosed quote');
  if (started) out.push(cur);
  return out;
}

/** What one agent answered. */
export interface ProbeResult {
  command: string;
  /** the agent answered `initialize` */
  initialized: boolean;
  protocolVersion?: number;
  agentName?: string;
  agentTitle?: string;
  agentVersion?: string;
  /** `agentCapabilities.loadSession` — session/load is available */
  loadSession: boolean;
  /** `agentCapabilities.sessionCapabilities.resume` — session/resume */
  resume: boolean;
  /** `agentCapabilities.sessionCapabilities.delete` — session/delete */
  deleteSession: boolean;
  /** `agentCapabilities.sessionCapabilities.list` — session/list */
  listSessions: boolean;
  /** promptCapabilities — image/audio/embeddedContext */
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  /** the agent's own capability bag — verbatim, for the report */
  agentCapabilities?: unknown;
  /** why the probe failed, when it did */
  error?: string;
  /** the probe's wall-clock budget */
  elapsedMs: number;
}

/** One probe run — spawn, initialize, read the answer, kill. */
export function probe(command: string, timeoutMs = 20_000): Promise<ProbeResult> {
  const started = Date.now();
  const argv = shellWords(command);
  const base: ProbeResult = {
    command,
    initialized: false,
    loadSession: false,
    resume: false,
    deleteSession: false,
    listSessions: false,
    promptImage: false,
    promptAudio: false,
    promptEmbeddedContext: false,
    elapsedMs: 0,
  };
  if (argv.length === 0) {
    return Promise.resolve({ ...base, error: 'empty command', elapsedMs: 0 });
  }

  return new Promise<ProbeResult>(resolve => {
    let settled = false;
    const finish = (patch: Partial<ProbeResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ...base, ...patch, elapsedMs: Date.now() - started });
    };

    const child = spawn(argv[0] as string, argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BRO_HOOKS: '0' },
    });
    child.stdin?.on('error', () => {});
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
    timer.unref?.();

    child.once('error', err => finish({ error: `spawn failed: ${err.message}` }));

    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    // a child that exits without answering (auth wall, crash, wrong
    // command) closes stdout — the probe must settle on that, not
    // wait out the wall: a hang reads as "still trying", a closed
    // stream reads as "no answer"
    rl.on('close', () => finish({ error: 'stream closed without an initialize answer' }));
    child.once('exit', (code, signal) => {
      finish({ error: `agent exited (code ${String(code)}, signal ${String(signal)})` });
    });
    rl.on('line', line => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(trimmed) as RpcMessage;
      } catch {
        return;
      }
      if (msg.id !== 1) return; // not our initialize answer
      if (msg.error !== undefined) {
        finish({
          error: `initialize error ${String(msg.error.code)}: ${msg.error.message ?? '?'}`,
        });
        return;
      }
      const result = (msg.result ?? {}) as {
        protocolVersion?: number;
        agentCapabilities?: {
          loadSession?: boolean;
          promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
          sessionCapabilities?: {
            resume?: unknown;
            delete?: unknown;
            list?: unknown;
          };
        };
        agentInfo?: { name?: string; title?: string; version?: string };
      };
      const caps = result.agentCapabilities;
      const sessionCaps = caps?.sessionCapabilities;
      finish({
        initialized: true,
        protocolVersion: result.protocolVersion,
        agentName: result.agentInfo?.name,
        agentTitle: result.agentInfo?.title,
        agentVersion: result.agentInfo?.version,
        loadSession: caps?.loadSession === true,
        resume: sessionCaps?.resume !== undefined,
        deleteSession: sessionCaps?.delete !== undefined,
        listSessions: sessionCaps?.list !== undefined,
        promptImage: caps?.promptCapabilities?.image === true,
        promptAudio: caps?.promptCapabilities?.audio === true,
        promptEmbeddedContext: caps?.promptCapabilities?.embeddedContext === true,
        agentCapabilities: caps,
      });
    });
    child.stderr?.resume(); // the agent's diagnostics are not our answer

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'bro-acp-probe', version: '0.1.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      })}\n`
    );
  });
}

/** The report — one line per agent, the capability flags as marks. */
export function formatResult(r: ProbeResult): string {
  if (!r.initialized) {
    return `${r.command.padEnd(24)} — ${r.error ?? 'no answer'}`;
  }
  const mark = (b: boolean): string => (b ? 'yes' : ' no');
  return [
    r.command.padEnd(24),
    `v${String(r.protocolVersion ?? '?')}`,
    `load=${mark(r.loadSession)}`,
    `resume=${mark(r.resume)}`,
    `del=${mark(r.deleteSession)}`,
    `list=${mark(r.listSessions)}`,
    `img=${mark(r.promptImage)}`,
    `audio=${mark(r.promptAudio)}`,
    `embed=${mark(r.promptEmbeddedContext)}`,
    r.agentName !== undefined ? `(${r.agentName})` : '',
  ]
    .filter(s => s !== '')
    .join(' ');
}

/** The CLI — probe the given commands (or the default set). */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commands: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cmd' && argv[i + 1] !== undefined) {
      commands.push(argv[++i] as string);
    }
  }
  const list = commands.length > 0 ? commands : DEFAULT_COMMANDS;
  const results: ProbeResult[] = [];
  for (const cmd of list) {
    try {
      results.push(await probe(cmd));
    } catch (err) {
      results.push({
        command: cmd,
        initialized: false,
        loadSession: false,
        resume: false,
        deleteSession: false,
        listSessions: false,
        promptImage: false,
        promptAudio: false,
        promptEmbeddedContext: false,
        error: errMsg(err),
        elapsedMs: 0,
      });
    }
  }
  for (const r of results) process.stdout.write(`${formatResult(r)}\n`);
  // a refusal is an ANSWER; only a probe that never ran is a failure
  process.exit(results.some(r => r.error !== undefined && !r.initialized) ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
