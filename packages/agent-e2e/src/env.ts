/** Fixture environment for agent-plugin e2e: an isolated HOME, a git
 *  project opted into bro, a `bro` PATH shim pinned to THIS checkout's
 *  built CLI, and a scrubbed env — so a spawned host CLI exercises the
 *  real plugin → `bro hooks` chain with zero user state. */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root — this file is packages/agent-e2e/src/env.ts. */
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
/** The built CLI the PATH shim points at — e2e requires `npm run build`. */
export const BRO_DIST = join(REPO, 'packages', 'cli', 'dist', 'index.js');

const AMBIENT_GIT =
  /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_CONFIG($|_)|GIT_TEMPLATE_DIR$)/;

const tmpDirs: string[] = [];
let tmpSweepArmed = false;

/** mkdtemp under a per-process sweep — deleted on exit, pass or fail. */
export function tmpDir(prefix: string): string {
  if (!tmpSweepArmed) {
    tmpSweepArmed = true;
    process.once('exit', () => {
      for (const d of tmpDirs.splice(0)) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // straggler writes — same contract as cli's testrepo sweep
        }
      }
    });
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function git(args: string[], cwd: string): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !AMBIENT_GIT.test(k))
  ) as NodeJS.ProcessEnv;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = devNull;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

export interface E2eEnv {
  /** Temp root holding home/proj/bin — swept on process exit. */
  root: string;
  /** Isolated HOME — host configs and bro state land here. */
  home: string;
  /** The project the host runs in — git-initialized, bro.config.json'd. */
  proj: string;
  /** PATH shim dir containing `bro` → this checkout's dist. */
  binDir: string;
  /** Env for spawned hosts: scrubbed ambient + pins. */
  env: NodeJS.ProcessEnv;
}

export interface MakeEnvOpts {
  /** Extra files to drop into the project before the init commit. */
  seed?: (proj: string) => void;
  /** Extra env vars merged over the scrubbed base. */
  env?: Record<string, string>;
  /** Skip the bro.config.json opt-in marker. */
  noBro?: boolean;
}

/** Build the whole fixture: home + project + bro shim + env. */
export function makeEnv(opts: MakeEnvOpts = {}): E2eEnv {
  if (!existsSync(BRO_DIST)) {
    throw new Error(`agent-e2e needs a built CLI at ${BRO_DIST} — run npm run build first`);
  }
  const root = tmpDir('bro-agent-e2e-');
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  const binDir = join(root, 'bin');
  for (const d of [home, proj, binDir, join(home, '.config')]) {
    mkdirSync(d, { recursive: true });
  }

  git(['init', '-q', '-b', 'main', proj], root);
  git(['config', 'user.email', 'e2e@t'], proj);
  git(['config', 'user.name', 'e2e'], proj);
  opts.seed?.(proj);
  if (!opts.noBro) {
    writeFileSync(join(proj, 'bro.config.json'), '{}\n');
  }
  git(['add', '-A'], proj);
  git(['commit', '-qm', 'init', '--allow-empty'], proj);

  const shim = join(binDir, 'bro');
  writeFileSync(shim, `#!/bin/sh\nexec node "${BRO_DIST}" "$@"\n`);
  chmodSync(shim, 0o755);

  // scrub ambient GIT_*/BRO_* — a host child must see only fixture state
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !AMBIENT_GIT.test(k) && !k.startsWith('BRO_') && k !== 'GIT_CONFIG_GLOBAL'
    )
  ) as NodeJS.ProcessEnv;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = devNull;
  Object.assign(
    env,
    {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TERM: 'dumb',
      NO_COLOR: '1',
    },
    opts.env
  );

  return { root, home, proj, binDir, env };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** ms until settle. */
  ms: number;
}

/** Spawn and collect — bounded, never throws on nonzero exit.
 *  ASYNC on purpose: spawnSync would freeze this process's event loop
 *  and starve an in-process mock server (LLMock) the child is calling. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}
): Promise<RunResult> {
  const started = Date.now();
  // spawn does not refresh PWD — a stale PWD makes PWD-respecting
  // hosts (opencode resolves its project dir from $PWD, not getcwd())
  // anchor the session to the harness's own cwd instead of opts.cwd.
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...(opts.env ?? process.env), PWD: cwd };
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // own process group so the timeout kill takes grandchildren
      // (bd/dolt/gh a hook may spawn) down with the child
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      finish(null);
    }, opts.timeoutMs ?? 120_000);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => {
      stdout += c;
    });
    child.stderr.on('data', c => {
      stderr += c;
    });
    child.on('error', () => finish(null));
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

/** `bro` on the fixture PATH — runs the worktree's built CLI. */
export function runBro(e: E2eEnv, args: string[], cwd = e.proj): Promise<RunResult> {
  return run('bro', args, { cwd, env: e.env });
}

/** First PATH hit for `cmd`, or null — host drivers skip when the
 *  external binary isn't installed (CI may not carry every agent CLI). */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, cmd);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}
