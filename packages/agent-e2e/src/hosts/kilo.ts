/** kilo host driver — headless `kilo run` against a fixture-registered
 *  OpenAI-compatible provider pointed at aimock, with the bro plugin
 *  installed through the REAL `bro plugins install kilo` path (module
 *  copy + kilo.json `plugin` registration) into the fixture HOME. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { E2eEnv } from '../env.ts';
import { type RunResult, run } from '../env.ts';

const MODEL_ID = 'e2e-mock-1';

/** Merge a `mock` provider into the fixture kilo.json — preserves the
 *  `plugin` array `bro plugins install kilo` registers. */
export function writeKiloProviderConfig(e: E2eEnv, baseUrl: string): void {
  const dir = join(e.env.XDG_CONFIG_HOME as string, 'kilo');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'kilo.json');
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }
  cfg.provider = {
    ...((cfg.provider as Record<string, unknown> | undefined) ?? {}),
    mock: {
      npm: '@ai-sdk/openai-compatible',
      name: 'MockLLM',
      env: ['MOCK_LLM_API_KEY'],
      options: {
        baseURL: `${baseUrl}/v1`,
        apiKey: '{env:MOCK_LLM_API_KEY}',
      },
      models: {
        [MODEL_ID]: { name: 'Mock Model', tool_call: true },
      },
    },
  };
  cfg.model = `mock/${MODEL_ID}`;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

/** Install the bro kilo plugin via the real CLI install path — copies
 *  the module and registers a file:/// entry in kilo.json. */
export async function installKiloPlugin(e: E2eEnv): Promise<RunResult> {
  return run('bro', ['plugins', 'install', 'kilo', '--global'], {
    cwd: e.proj,
    env: e.env,
    timeoutMs: 60_000,
  });
}

/** One headless turn: `kilo run --format json <prompt>`. */
export function runKilo(e: E2eEnv, prompt: string, timeoutMs = 120_000): Promise<RunResult> {
  return run('kilo', ['run', '--format', 'json', prompt], {
    cwd: e.proj,
    env: { ...e.env, MOCK_LLM_API_KEY: 'e2e' },
    timeoutMs,
  });
}
