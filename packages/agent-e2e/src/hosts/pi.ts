/** pi host driver — headless `pi -p` against a fixture-registered
 *  OpenAI-compatible provider pointed at aimock, with the bro plugin
 *  installed through the REAL `bro plugins install pi` path into the
 *  fixture HOME. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { E2eEnv } from '../env.ts';
import { run, type RunResult } from '../env.ts';

const MODEL_ID = 'e2e-mock-1';

/** Register a custom openai-completions provider in the fixture pi
 *  home — `models.json` is pi's user provider config (models-store.json
 *  is only the fetched-catalog cache). */
export function writePiProviderConfig(e: E2eEnv, baseUrl: string): void {
  const agentDir = join(e.home, '.pi', 'agent');
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

/** Install the bro pi plugin via the real CLI install path — lands in
 *  `<home>/.pi/agent/extensions/bro.ts` under the fixture HOME. */
export async function installPiPlugin(e: E2eEnv): Promise<RunResult> {
  return run('bro', ['plugins', 'install', 'pi', '--global'], {
    cwd: e.proj,
    env: e.env,
    timeoutMs: 60_000,
  });
}

/** One headless turn: `pi -p <prompt> --model e2e/<id>`. */
export function runPi(e: E2eEnv, prompt: string, timeoutMs = 90_000): Promise<RunResult> {
  return run('pi', ['-p', prompt, '--model', `e2e/${MODEL_ID}`, '--api-key', 'e2e'], {
    cwd: e.proj,
    env: e.env,
    timeoutMs,
  });
}
