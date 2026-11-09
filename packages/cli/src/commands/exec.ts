/**
 * `bro exec <cmd>` — run a shell command and report its finish through
 * the connector seam (spec bro-84zrj). The command itself is dumb: exec
 * the argv under `sh -c` with an inherited stdin and forwarded
 * stdout/stderr, keep a bounded output tail, then fan a `taskFinish`
 * probe out to every connector's hooks. What a probe DOES with the
 * report is connector policy — the herdr connector prompts the pane so
 * an agent whose host has no task-exit wake (devin) still hears its
 * own background task land.
 *
 * Exit code is the child's: the wrapper is transparent — `bro exec cmd`
 * in a pipeline reads exactly like `cmd`, plus the report-back. Output
 * capture costs the child its TTY (a tail needs pipes; stdin stays
 * inherited so prompts still read keys) — that is the documented
 * trade-off, a pty would be a different tool.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';
import { printUsage, taskFinishProbes } from '@broject/core';
import { envProvenance } from './githooks.ts';
import { agentOwner } from './proc-owner.ts';

/** Interleaved stdout+stderr kept for the report — enough for a
 *  verdict digest, never a log replay. */
const TAIL_BYTES = 4096;

/** Ring-buffer the last `cap` BYTES of interleaved child output —
 *  chunks stay buffers so the cap is honest and a multibyte character
 *  split across chunks decodes whole. */
function makeTail(cap: number): { push: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  let total = 0;
  return {
    push(chunk: Buffer): void {
      chunks.push(chunk);
      total += chunk.length;
      while (total > cap && chunks.length > 0) {
        const head = chunks[0]!;
        const excess = total - cap;
        if (head.length <= excess) {
          chunks.shift();
          total -= head.length;
        } else {
          chunks[0] = head.subarray(excess);
          total = cap;
        }
      }
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/** Pipe the child stream to the parent fd and the tail — honouring
 *  backpressure so a slow downstream cannot grow an unbounded queue. */
function forwardOutput(
  from: Readable | null,
  to: NodeJS.WriteStream,
  tail: { push: (chunk: Buffer) => void }
): void {
  if (from === null) return;
  from.on('data', (chunk: Buffer) => {
    tail.push(chunk);
    if (!to.write(chunk)) from.pause();
  });
  to.on('drain', () => from.resume());
}

/** A terminal signal aimed at the wrapper still reaches the child —
 *  the probes run on its close either way. */
function forwardSignals(child: ChildProcess): () => void {
  const handlers = (['SIGINT', 'SIGTERM'] as const).map(sig => {
    const h = (): void => {
      child.kill(sig);
    };
    process.on(sig, h);
    return [sig, h] as const;
  });
  return () => {
    for (const [sig, h] of handlers) process.off(sig, h);
  };
}

function awaitClose(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolve => {
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

/** The child's real status: its code, else the conventional
 *  128+signal a shell would report. */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const n = signal === null ? undefined : osConstants.signals[signal];
  return 128 + (n ?? 1);
}

export async function runExecCommand(argv: string[]): Promise<void> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.length === 0) {
    printUsage('usage: bro exec <cmd> [args…]', 2);
    return;
  }
  // help is the wrapper's own flag — argv[0] is the command slot, so
  // `bro exec printf --help` still runs printf
  if (args[0] === '--help' || args[0] === '-h') {
    printUsage('usage: bro exec <cmd> [args…]', 0);
    return;
  }
  const cmd = args.join(' ');
  const tail = makeTail(TAIL_BYTES);
  const t0 = Date.now();
  const child = spawn('sh', ['-c', cmd], { stdio: ['inherit', 'pipe', 'pipe'] }); // NOSONAR — running the caller's line under the ambient PATH shell is the command's contract
  forwardOutput(child.stdout, process.stdout, tail);
  forwardOutput(child.stderr, process.stderr, tail);
  const unforward = forwardSignals(child);
  const { code, signal } = await awaitClose(child);
  unforward();
  // Set BEFORE the probes: exitCode (never exit()) lets pending
  // forwarded writes drain, and if a wedged probe lets the loop drain
  // early the process still reports the child's status.
  process.exitCode = exitCodeFor(code, signal);
  const out = tail.text().trim();
  // Fail-open and never allowed to change the verdict: the probes are
  // advisory, the child's exit code is the contract.
  try {
    await taskFinishProbes(
      {
        dir: process.cwd(),
        sessionId: envProvenance(process.env).session,
        owner: agentOwner(),
      },
      {
        cmd,
        exitCode: code,
        durationMs: Date.now() - t0,
        ...(signal !== null && { signal }),
        ...(out !== '' && { tail: out }),
      }
    );
  } catch {
    // a wedged probe must not eat the child's exit code
  }
}
