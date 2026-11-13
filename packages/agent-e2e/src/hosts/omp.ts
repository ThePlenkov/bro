/** omp host driver — headless `omp -p` against a fixture-registered
 *  OpenAI-compatible provider pointed at aimock. omp shares pi's
 *  extension lineage: `~/.omp/agent/models.json` providers config,
 *  `extensions/` auto-load, `-p` print mode. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { E2eEnv } from '../env.ts';
import { run, type RunResult } from '../env.ts';

const MODEL_ID = 'e2e-mock-1';

/** Register a custom openai-completions provider — same models.json
 *  schema pi reads, under omp's own agent dir. */
export function writeOmpProviderConfig(e: E2eEnv, baseUrl: string): void {
  const agentDir = join(e.home, '.omp', 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          e2e: {
            baseUrl,
            api: 'openai-completions',
            apiKey: 'e2e',
            models: [{ id: MODEL_ID, name: 'E2E Mock' }],
          },
        },
      },
      null,
      2
    )
  );
}

/** Install the bro omp plugin via the real CLI install path — lands in
 *  `<home>/.omp/agent/extensions/bro.ts` under the fixture HOME. */
export async function installOmpPlugin(e: E2eEnv): Promise<RunResult> {
  return run('bro', ['plugins', 'install', 'omp', '--global'], {
    cwd: e.proj,
    env: e.env,
    timeoutMs: 60_000,
  });
}

/** One headless turn: `omp -p <prompt> --model e2e/<id>`. */
export function runOmp(e: E2eEnv, prompt: string, timeoutMs = 90_000): Promise<RunResult> {
  return run('omp', ['-p', prompt, '--model', `e2e/${MODEL_ID}`, '--api-key', 'e2e'], {
    cwd: e.proj,
    env: e.env,
    timeoutMs,
  });
}
