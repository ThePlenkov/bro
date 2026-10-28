/** `bro fleet delegate` — the CLI surface over the delegate core
 *  (delegate.ts). Parses argv into a DelegateRequest, prints the
 *  result contract; the core owns mode semantics. */
import { CommandError, EXIT, hasHelpFlag, printUsage, type ExitCode } from '@broject/core';
import { flag, positionals } from './args.ts';
import { loadAgentEnv } from '../agent-connectors.ts';
import {
  delegate,
  MAX_TIMEOUT_SEC,
  type DelegateDetachResult,
  type DelegateOpts,
  type DelegateRequest,
  type DelegateResult,
  type DelegateWaitResult,
} from './delegate.ts';

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `usage:
  bro fleet delegate [prompt…] [--prompt <text>] [--prompt-file <file>]
              [--provider <name> | --class <name>] [--model <m>]
              [--wait [--timeout <sec>] | --detach [--connector <name>]
               [--worktree <path>] [--auto-approve]] [--beads-dir <dir>]
              [--json]
              --wait (default) asks another agent synchronously: one
              pooled ACP turn against the resolved providers.<name> acp
              entry — the reply text lands on stdout, --json adds
              provider/model/stopReason provenance. --detach does real
              work: the registry spawn 'bro agents run' takes (routing,
              walls, fleet cap, quotas), returning the new agentId. The
              caller's BRO_AGENT_ID rides as delegatedBy provenance on
              both — 'agent A activates agent B' is auditable.`,
    exitCode
  );
}

// a function declaration — tsc only treats calls to never-returning
// declarations as terminating the control flow (same convention as
// agents.ts's die)
function die(msg: string): never {
  throw new CommandError(`error: ${msg}`, EXIT.error)
}

const VALUE_FLAGS = new Set([
  '--prompt',
  '--prompt-file',
  '--provider',
  '--class',
  '--model',
  '--timeout',
  '--connector',
  '--worktree',
  '--beads-dir',
]);

const DETACH_ONLY: Array<[flag: string, present: (argv: string[]) => boolean]> = [
  ['--connector', argv => flag(argv, '--connector') !== undefined],
  ['--worktree', argv => flag(argv, '--worktree') !== undefined],
  ['--auto-approve', argv => argv.includes('--auto-approve')],
];

function parseTimeout(argv: string[], mode: 'wait' | 'detach'): number | undefined {
  const raw = flag(argv, '--timeout');
  if (raw === undefined) {
    return undefined;
  }
  if (mode !== 'wait') {
    die('--timeout only applies to --wait');
  }
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0 || sec > MAX_TIMEOUT_SEC) {
    die(`--timeout must be 1..${MAX_TIMEOUT_SEC} seconds`);
  }
  return sec;
}

function parseMode(argv: string[]): 'wait' | 'detach' {
  const wait = argv.includes('--wait');
  const detach = argv.includes('--detach');
  if (wait && detach) {
    die('--wait and --detach are mutually exclusive');
  }
  return detach ? 'detach' : 'wait';
}

function checkModeFlags(argv: string[], mode: 'wait' | 'detach'): void {
  if (mode === 'detach') {
    return;
  }
  const used = DETACH_ONLY.filter(([, present]) => present(argv)).map(([f]) => f);
  if (used.length > 0) {
    die(`${used.join(', ')} only apply to --detach`);
  }
}

function parseArgv(argv: string[]): DelegateRequest {
  const pos = positionals(argv, VALUE_FLAGS);
  const mode = parseMode(argv);
  checkModeFlags(argv, mode);
  const promptFlag = flag(argv, '--prompt');
  if (promptFlag !== undefined && pos.length > 0) {
    die('positional text and --prompt are the same channel — pick one');
  }
  return {
    prompt: promptFlag ?? (pos.length > 0 ? pos.join(' ') : undefined),
    promptFile: flag(argv, '--prompt-file'),
    mode,
    provider: flag(argv, '--provider'),
    class: flag(argv, '--class'),
    model: flag(argv, '--model'),
    timeoutSec: parseTimeout(argv, mode),
    connector: flag(argv, '--connector'),
    worktree: flag(argv, '--worktree'),
    autoApprove: argv.includes('--auto-approve') ? true : undefined,
    beadsDir: flag(argv, '--beads-dir'),
  };
}

function printWait(result: DelegateWaitResult): void {
  // the reply IS the output — provenance rides stderr so a pipeline
  // consumer never parses badge text out of the answer
  const cls = result.class === undefined ? '' : ` · class ${result.class}`;
  console.error(`provider ${result.provider} · model ${result.model}${cls} · ${result.stopReason}`);
  console.log(result.text);
}

function printDetach(result: DelegateDetachResult): void {
  const info = result.agent;
  const pid = info.pid === undefined ? '' : ` pid ${info.pid}`;
  console.log(`agent ${info.id} ${info.state} for ${info.molStep} (${info.backend}${pid})`);
  if (result.delegatedBy !== undefined) {
    console.log(`  delegatedBy: ${result.delegatedBy}`);
  }
  if (info.provider !== undefined) {
    const model = info.model === undefined ? '' : ` · model ${info.model}`;
    console.log(`  provider: ${info.provider}${model}`);
  }
  if (info.log !== undefined) {
    console.log(`  log: ${info.log}`);
  }
  if (info.worktree !== undefined) {
    console.log(`  worktree: ${info.worktree}`);
  }
}

export async function runDelegateCommand(argv: string[], opts: DelegateOpts = {}): Promise<void> {
  if (hasHelpFlag(argv)) {
    usage(0);
  }
  const dir = process.cwd();
  const req = parseArgv(argv);
  let result: DelegateResult;
  try {
    result = await delegate(dir, loadAgentEnv(dir), req, opts);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.mode === 'wait') {
    printWait(result);
  } else {
    printDetach(result);
  }
}
