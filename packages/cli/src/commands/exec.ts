/**
 * `bro exec <cmd>` — run a shell command and report its finish through
 * the connector seam (spec bro-84zrj). The command itself is dumb: exec
 * the argv under `sh -c` with a passthrough tty, keep a bounded output
 * tail, then fan a `taskFinish` probe out to every connector's hooks.
 * What a probe DOES with the report is connector policy — the herdr
 * connector prompts the pane so an agent whose host has no task-exit
 * wake (devin) still hears its own background task land.
 *
 * Exit code is the child's: the wrapper is transparent — `bro exec cmd`
 * in a pipeline reads exactly like `cmd`, plus the report-back.
 */
import { spawn } from 'node:child_process';
import { hasHelpFlag, printUsage, taskFinishProbes } from '@broject/core';
import { envProvenance } from './githooks.ts';
import { agentOwner } from './proc-owner.ts';

/** Interleaved stdout+stderr kept for the report — enough for a
 *  verdict digest, never a log replay. */
const TAIL_BYTES = 4096;

/** Ring-buffer the last `cap` bytes of interleaved child output. */
function makeTail(cap: number): { push: (chunk: Buffer) => void; text: () => string } {
  let buf = '';
  return {
    push(chunk: Buffer): void {
      buf = (buf + chunk.toString('utf8')).slice(-cap);
    },
    text(): string {
      return buf;
    },
  };
}

export async function runExecCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv) || argv.length === 0) {
    printUsage('usage: bro exec <cmd> [args…]', argv.length === 0 ? 2 : 0);
  }
  const cmd = argv.join(' ');
  const tail = makeTail(TAIL_BYTES);
  const t0 = Date.now();
  const child = spawn('sh', ['-c', cmd], { stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    tail.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    tail.push(chunk);
  });
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
    resolve => {
      child.on('error', () => resolve({ code: null, signal: null }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    }
  );
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
  process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
}
