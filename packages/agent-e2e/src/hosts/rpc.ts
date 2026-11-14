/** Shared pi/omp RPC-mode driver — `--mode rpc` speaks JSONL on
 *  stdin/stdout; a `prompt` record whose text is an extension command
 *  (`/bro …`) is handled in-process, never reaching the model. This is
 *  the only headless surface that dispatches registered commands. */
import { type ChildProcess, spawn } from 'node:child_process';
import type { E2eEnv } from '../env.ts';

export interface RpcRunResult {
  /** `handled` = an extension command consumed the prompt (no model
   *  turn); `started` = it went to the LLM as a normal prompt. pi reports
   *  this in `data.disposition`; omp's response record carries only
   *  `success` — check `success` there. */
  disposition: string | null;
  /** omp-style `response` record `success` flag (null on pi). */
  success: boolean | null;
  /** Every protocol record observed, parsed. */
  records: Record<string, unknown>[];
  stderr: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Spawn `<bin> --mode rpc`, send one prompt, wait for the run to settle
 *  then kill. A `/bro`-style command answers `disposition:"handled"` with
 *  no model turn (no agent_settled), so the wait ends on the response
 *  record plus a short grace for hook processes to journal. */
export async function runRpcPrompt(
  e: E2eEnv,
  bin: 'pi' | 'omp',
  message: string,
  opts: { model?: string; apiKey?: string; graceMs?: number; timeoutMs?: number } = {}
): Promise<RpcRunResult> {
  const model = opts.model ?? 'e2e/e2e-mock-1';
  const child: ChildProcess = spawn(
    bin,
    ['--mode', 'rpc', '--no-session', '--model', model, '--api-key', opts.apiKey ?? 'e2e'],
    { cwd: e.proj, env: e.env, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const records: Record<string, unknown>[] = [];
  let stderr = '';
  let buf = '';
  let disposition: string | null = null;
  let success: boolean | null = null;
  let settled = false;
  let answered = false;
  const state = { changed: Promise.withResolvers<void>() };
  const poke = () => state.changed.resolve();
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx < 0) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === '') continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        records.push(rec);
        if (rec.type === 'response' && rec.command === 'prompt') {
          disposition = (rec.data as { disposition?: string } | undefined)?.disposition ?? null;
          success = typeof rec.success === 'boolean' ? rec.success : null;
          answered = true;
          poke();
        }
        if (rec.type === 'agent_settled') {
          settled = true;
          poke();
        }
      } catch {
        // non-JSON noise on stdout — ignore
      }
    }
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  const kill = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  };
  const guard = setTimeout(kill, opts.timeoutMs ?? 60_000);
  child.stdin?.write(`${JSON.stringify({ id: 'p1', type: 'prompt', message })}\n`);

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  // wait for the prompt answer (or a model turn to settle), then a
  // grace window so async hook spawns can land in the journal
  while (Date.now() < deadline && !(answered || settled)) {
    await Promise.race([state.changed.promise, sleep(250)]);
  }
  await sleep(opts.graceMs ?? 2_500);
  clearTimeout(guard);
  kill();
  return { disposition, success, records, stderr };
}
