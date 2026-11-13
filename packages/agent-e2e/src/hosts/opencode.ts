/** opencode host driver — installs the generated catalog plugin into
 *  the fixture HOME, writes a project opencode.json pointing the
 *  `mock` provider at the llm-mock endpoint, and runs `opencode run`
 *  headless. */
import { spawn, type ChildProcess } from 'node:child_process';
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

/* Serve mode — `opencode run` exits with the turn, so session.idle (the
 *  stop gate's trigger) never reaches the plugin. `opencode serve` keeps
 *  the session processor alive server-side: prompt via the v2 API, the
 *  gate fires, the reprompt lands as a second turn — all observable. */

export interface OpencodeServer {
  url: string;
  /** SIGKILL the server's process group. */
  stop(): Promise<void>;
}

const SERVER_PASSWORD = 'e2e';

/** `opencode serve` on a random localhost port, fixture env, plugin
 *  already installed. Resolves once /doc answers; kills on timeout. */
export async function startOpencodeServer(
  e: E2eEnv,
  opts: { port?: number; timeoutMs?: number } = {}
): Promise<OpencodeServer> {
  const port = opts.port ?? 16000 + Math.floor(Math.random() * 2000);
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    'opencode',
    ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: e.proj,
      env: { ...e.env, MOCK_LLM_API_KEY: 'e2e', OPENCODE_PASSWORD: SERVER_PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }
  );
  let stderrTail = '';
  child.stderr?.on('data', c => {
    stderrTail = (stderrTail + c).slice(-4000);
  });
  child.stdout?.on('data', () => {});
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    try {
      const r = await fetch(`${url}/doc`);
      if (r.ok) {
        break;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      throw new Error(`opencode serve did not start:\n${stderrTail}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return {
    url,
    stop: () =>
      new Promise(resolve => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
        child.once('close', () => resolve());
        setTimeout(resolve, 3000).unref?.();
      }),
  };
}

/** One `opencode api --server <url> <operation>` call — the supported
 *  client path (handles OPENCODE_PASSWORD auth). `params` fill OpenAPI
 *  path/query params (`sessionID` etc.), `data` is the JSON body. */
export async function opencodeApi(
  e: E2eEnv,
  serverUrl: string,
  operation: string,
  opts: { data?: unknown; params?: Record<string, string> } = {}
): Promise<unknown> {
  const args = ['api', '--server', serverUrl, operation];
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    args.push('--param', `${k}=${v}`);
  }
  if (opts.data !== undefined) {
    args.push('--data', JSON.stringify(opts.data));
  }
  const res = await run('opencode', args, {
    cwd: e.proj,
    env: { ...e.env, OPENCODE_PASSWORD: SERVER_PASSWORD },
    timeoutMs: 30_000,
  });
  if (res.code !== 0) {
    throw new Error(
      `opencode api ${operation} exited ${res.code}: ${(res.stderr || res.stdout).slice(-500)}`
    );
  }
  const out = res.stdout.trim();
  return out === '' ? undefined : (JSON.parse(out) as unknown);
}
