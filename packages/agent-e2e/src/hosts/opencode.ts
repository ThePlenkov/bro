/** opencode host driver — installs the generated catalog plugin into
 *  the fixture HOME, writes a project opencode.json pointing the
 *  `mock` provider at the llm-mock endpoint, and runs `opencode run`
 *  headless. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, run, runBro, type E2eEnv, type RunResult } from '../env.ts';

const PLUGIN_SRC = join(REPO, 'plugins', 'opencode', 'bro');

/** Materialize the plugin the way `bro plugins install opencode
 *  --global` would — but by copy, so the driver doesn't depend on the
 *  CLI's artifact resolution (that path has its own tests). */
export function installOpencodePlugin(e: E2eEnv): string {
  const dest = join(e.env.XDG_CONFIG_HOME as string, 'opencode', 'plugins', 'bro');
  mkdirSync(dest, { recursive: true });
  for (const f of ['index.ts', 'tui.tsx', 'rpc.ts']) {
    const src = join(PLUGIN_SRC, f);
    if (existsSync(src)) {
      copyFileSync(src, join(dest, f));
    }
  }
  const readme = join(PLUGIN_SRC, 'README.md');
  if (existsSync(readme)) {
    copyFileSync(readme, join(dest, 'README.md'));
  }
  return dest;
}

/** Project-level opencode.json: a `mock` provider on the llm-mock
 *  endpoint, openai-compatible chat completions. */
export function writeOpencodeConfig(e: E2eEnv, mockUrl: string, model = 'mock-1'): void {
  writeFileSync(
    join(e.proj, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: `mock/${model}`,
        providers: {
          mock: {
            name: 'MockLLM',
            env: ['MOCK_LLM_API_KEY'],
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: `${mockUrl}/v1` },
            models: { [model]: { name: 'Mock Model' } },
          },
        },
      },
      null,
      2
    )
  );
}

export interface OpencodeRunOpts {
  model?: string;
  timeoutMs?: number;
  /** Extra args appended after the message (e.g. --session). */
  args?: string[];
}

/** `opencode run --standalone --auto --format json` — headless, private
 *  server, auto-approved permissions, JSON event stream on stdout. */
export async function runOpencode(
  e: E2eEnv,
  prompt: string,
  opts: OpencodeRunOpts = {}
): Promise<RunResult> {
  return run(
    'opencode',
    [
      'run',
      '--standalone',
      '--auto',
      '--format',
      'json',
      ...(opts.model !== undefined ? ['-m', opts.model] : []),
      ...(opts.args ?? []),
      prompt,
    ],
    {
      cwd: e.proj,
      env: { ...e.env, MOCK_LLM_API_KEY: 'e2e' },
      timeoutMs: opts.timeoutMs ?? 180_000,
    }
  );
}

export { runBro };
