import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorExitCode, runDoctorChecks, type DoctorCheck } from './doctor.ts';
import { doltManifest, doltStoreCommit, procStat, scrubEnv, testGit } from '@broject/core';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

/** Scripted tools — PATH is set to the shim dir ONLY, so nothing real
 *  leaks in: git is a symlink to the real binary (repo probes need it);
 *  bd/gh/bro/npx are env-scripted shims, or absent entirely. */
const BD_SHIM = `#!/bin/sh
case "$1" in
  --version) echo 'bd version 1.3.0 (fake)' ;;
  dolt)
    if [ "$2" = "remote" ] && [ "$3" = "list" ]; then
      if [ "\${FAKE_BD_DOLT_FAIL:-0}" = "1" ]; then echo 'unknown command' >&2; exit 1; fi
      printf '%s' "\${FAKE_BD_DOLT:-}"
      exit 0
    fi
    exit 1 ;;
  list|ready)
    [ "\${FAKE_BD_LIST_FAIL:-0}" = "1" ] && { echo 'no beads database' >&2; exit 1; }
    [ "\${FAKE_BD_DRIFT:-0}" = "1" ] && { echo '{"issues":[]}'; exit 0; }
    [ "\${FAKE_BD_FLAG_DRIFT:-0}" = "1" ] && { echo 'Error: unknown flag: --json' >&2; exit 1; }
    echo '[]' ;;
  info) echo "{\\"schema_version\\":\${FAKE_BD_SCHEMA:-1}}" ;;
  *) exit 1 ;;
esac
`;
const GH_SHIM = `#!/bin/sh
case "$1" in
  --version) echo 'gh version 2.80.0 (fake)' ;;
  auth) exit \${FAKE_GH_AUTH:-0} ;;
  *) exit 1 ;;
esac
`;
const FAIL_SHIM = '#!/bin/sh\nexit 1\n';
const BRO_SHIM = '#!/bin/sh\n[ "$1" = "--version" ] && { echo "0.2.3"; exit 0; }\nexit 0\n';
const CURL_SHIM = '#!/bin/sh\necho "curl 8.5.0 (fake)"\n';

interface EnvOpts {
  /** object → JSON.stringify'd; string → written verbatim (invalid JSON tests) */
  config?: object | string;
  /** written verbatim as bro.config.ts */
  configTs?: string;
  /** object → bro.config.local.json (gitignored local layer) */
  configLocal?: object;
  /** object → $XDG_CONFIG_HOME/bro/config.json (global user layer) */
  configGlobal?: object;
  beadsDir?: boolean;
  /** true → a placeholder origin; a string → used verbatim as the origin url */
  remote?: boolean | string;
  /** shims to drop into bin/ — absent name = binary missing from PATH */
  bins?: Array<'bd' | 'gh' | 'bro' | 'npx' | 'curl'>;
  env?: Record<string, string>;
}

function withEnv(opts: EnvOpts, fn: (dir: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-doctor-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  symlinkSync(realGit, join(bin, 'git'));
  const shims: Record<string, string> = {
    bd: BD_SHIM,
    gh: GH_SHIM,
    bro: BRO_SHIM,
    npx: FAIL_SHIM,
    curl: CURL_SHIM,
  };
  for (const name of opts.bins ?? []) {
    const path = join(bin, name);
    writeFileSync(path, shims[name]!);
    chmodSync(path, 0o755);
  }
  testGit(['init', '-q', dir]);
  if (opts.remote) {
    const url = typeof opts.remote === 'string' ? opts.remote : 'https://example.com/x.git';
    testGit(['-C', dir, 'remote', 'add', 'origin', url]);
  }
  if (opts.beadsDir) {
    mkdirSync(join(dir, '.beads'));
  }
  if (opts.config !== undefined) {
    writeFileSync(
      join(dir, 'bro.config.json'),
      typeof opts.config === 'string' ? opts.config : JSON.stringify(opts.config)
    );
  }
  if (opts.configTs !== undefined) {
    writeFileSync(join(dir, 'bro.config.ts'), opts.configTs);
  }
  if (opts.configLocal !== undefined) {
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify(opts.configLocal));
  }
  if (opts.configGlobal !== undefined) {
    const gdir = join(dir, 'xdg', 'bro');
    mkdirSync(gdir, { recursive: true });
    writeFileSync(join(gdir, 'config.json'), JSON.stringify(opts.configGlobal));
  }
  const prevPath = process.env.PATH;
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  // the global config layer (~/.config/bro or $XDG_CONFIG_HOME/bro) must
  // not leak the dev machine's real user config into probes
  saved.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
  // ambient credentials must not leak into probes — unless the test
  // itself provides the var via opts.env
  for (const k of [
    'DEVIN_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_ROOT',
    'PLUGIN_ROOT',
    'BEADS_DIR',
    'SONAR_TOKEN',
    'CODACY_API_TOKEN',
    'CODACY_PROJECT_TOKEN',
    'CODESCENE_TOKEN',
    'CODESCENE_PROJECT_ID',
    // session pins — a leaked BRO_/DEVIN_SESSION_ID would let the
    // ambient session claim the fixture's build stamp
    'BRO_SESSION_ID',
    'BRO_AGENT_ID',
    'DEVIN_SESSION_ID',
    'CLAUDE_SESSION_ID',
    'CODEX_SESSION_ID',
    'OPENCODE_SESSION_ID',
    // client/conductor evidence — the dev machine's real claude env and
    // serve pins must not leak into the classifier-guard probe
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'BRO_PROVIDER_BACKEND',
  ].filter(k => opts.env === undefined || !(k in opts.env))) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // absent CLAUDE_CONFIG_DIR the conductor probe reads the real
  // ~/.claude — pin it at an empty fixture dir instead
  if (opts.env === undefined || !('CLAUDE_CONFIG_DIR' in opts.env)) {
    saved.CLAUDE_CONFIG_DIR ??= process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'xdg', 'claude-home');
  }
  // absent XDG_DATA_HOME the devin-wiring probe reads the real
  // ~/.local/share — pin it at an empty fixture dir instead
  if (opts.env === undefined || !('XDG_DATA_HOME' in opts.env)) {
    saved.XDG_DATA_HOME ??= process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(dir, 'xdg', 'data');
  }
  const run = async (): Promise<void> => {
    process.env.PATH = bin;
    await fn(dir);
  };
  return run().finally(() => {
    process.env.PATH = prevPath;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

/** The two-file fixture the conductor guard reads as "live endpoint +
 *  client riding it": serve.json under .git/bro, the client's
 *  ANTHROPIC_BASE_URL under .claude — `baseUrl` may differ from
 *  serveUrl when the test exercises loopback-alias equality, extraEnv
 *  merges into the client settings. */
function liveServeClient(
  dir: string,
  serveUrl: string,
  baseUrl = serveUrl,
  extraEnv: Record<string, string> = {}
): void {
  mkdirSync(join(dir, '.git', 'bro'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'bro', 'serve.json'),
    JSON.stringify({ pid: process.pid, url: serveUrl, dir, startedAt: 'x', token: 't' })
  );
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl, ...extraEnv } })
  );
}

const byName = (checks: DoctorCheck[], name: string): DoctorCheck =>
  checks.find(c => c.name === name)!;

/** A fixture dolt store — a git repo holding `refs/dolt/data` whose head
 *  tree is manifest + table files. `missing` names tables the manifest
 *  claims but the tree never gets (the bro-orcdv corruption). */
function doltStore(base: string, missing: string[] = []): { dir: string; head: string } {
  const dir = join(base, 'doltstore');
  testGit(['init', '-q', dir]);
  const ok = 'a'.repeat(32);
  const files: Record<string, string> = {
    manifest: doltManifest(Object.fromEntries([ok, ...missing].map(t => [t, 1]))),
    [ok]: 'x',
  };
  const head = doltStoreCommit(dir, files);
  return { dir, head };
}

/** A fake bro dev checkout — packages/cli/dist + the @broject/bro
 *  package.json inside its own git repo (nested under the env dir's repo;
 *  --show-toplevel still resolves to the nested root). */
function fakeCheckout(base: string): { checkout: string; entry: string } {
  const checkout = join(base, 'bro-checkout');
  const distDir = join(checkout, 'packages', 'cli', 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(checkout, 'packages', 'cli', 'package.json'), '{"name":"@broject/bro"}');
  const entry = join(distDir, 'index.js');
  writeFileSync(entry, '// dist\n');
  execFileSync('git', ['init', '-q', checkout]);
  return { checkout, entry };
}

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

/** Empty commit; an ISO date pins author+committer time so the test
 *  controls the commit↔dist ordering instead of racing wall clock. */
function commitAt(checkout: string, isoDate?: string): void {
  const env =
    isoDate === undefined
      ? process.env
      : { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  execFileSync('git', ['-C', checkout, ...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'x'], {
    env,
  });
}

/** A resolved `bro` entry in Devin's plugin lockfile under the test's
 *  XDG_DATA_HOME — the plugin half of the duplicate wiring. */
function resolvedBroPlugin(dir: string): void {
  const data = join(dir, 'data');
  process.env.XDG_DATA_HOME = data;
  mkdirSync(join(data, 'devin', 'cli', 'plugins'), { recursive: true });
  writeFileSync(
    join(data, 'devin', 'cli', 'plugins', 'lock.json'),
    JSON.stringify({ resolved: [{ name: 'bro' }] })
  );
}

/** The project-local `.devin/hooks.v1.json` chain — the file half. */
function writeDevinChain(dir: string, chain: object): void {
  mkdirSync(join(dir, '.devin'));
  writeFileSync(join(dir, '.devin', 'hooks.v1.json'), JSON.stringify(chain));
}

/** A live recorded supervisor — daemon.json pins a real child's pid
 *  against its /proc start, so daemonProbe reports live while the test
 *  controls which entry the "daemon" exec'd. Kill the returned child
 *  when done. */
function fakeDaemon(dir: string, argv: string[]): ReturnType<typeof spawn> {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore' })
  mkdirSync(join(dir, '.git', 'bro'), { recursive: true })
  writeFileSync(
    join(dir, '.git', 'bro', 'daemon.json'),
    JSON.stringify({
      pid: child.pid,
      everySec: 60,
      spawnedAt: new Date().toISOString(),
      cmd: 'bro daemon run --every 60',
      pidStart: procStat(child.pid!)?.start,
    })
  )
  return child
}

describe('bro doctor', () => {
  test('healthy env — every probe ok, exit 0', () => {
    // the dolt remote is a local fixture — a git+https URL would make
    // the dolt-store probe do a real network fetch in the test suite
    const base = mkdtempSync(join(tmpdir(), 'bro-doctor-store-'));
    try {
      const { dir: store } = doltStore(base);
      return withEnv(
        {
          config: { stores: ['jsonl', 'beads'] },
          beadsDir: true,
          remote: true,
          bins: ['bd', 'gh', 'bro'],
          env: { FAKE_BD_DOLT: `origin\tgit+file://${store}\n` },
        },
        dir => {
          const checks = runDoctorChecks(dir);
          for (const name of [
            'node',
            'git',
            'repo',
            'gh',
            'bd',
            'bd-compat',
            'bd-backend',
            'bd-store',
            'hooks',
            'hooks-wiring',
            'config',
            'git-remote',
            'dolt-remote',
            'dolt-store',
          ]) {
            assert.equal(
              byName(checks, name)?.status,
              'ok',
              `${name}: ${JSON.stringify(byName(checks, name))}`
            );
          }
          assert.equal(doctorExitCode(checks), 0);
        }
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('missing bd fails when beads is an active store', () =>
    withEnv({ config: {}, beadsDir: true, bins: ['gh'] }, dir => {
      const checks = runDoctorChecks(dir);
      assert.equal(byName(checks, 'bd').status, 'fail');
      assert.equal(byName(checks, 'dolt-remote').status, 'skip');
      assert.equal(doctorExitCode(checks), 1);
    }));

  test('missing bd only warns under jsonl-only stores', () =>
    withEnv({ config: { stores: ['jsonl'] }, bins: ['gh', 'bro'] }, dir => {
      const checks = runDoctorChecks(dir);
      assert.equal(byName(checks, 'bd').status, 'warn');
      assert.equal(doctorExitCode(checks), 0);
    }));

  test('tasks row names the serving backend — beads by default', () =>
    withEnv(
      {
        config: { stores: ['jsonl', 'beads'] },
        beadsDir: true,
        remote: true,
        bins: ['bd', 'gh', 'bro'],
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'tasks');
        assert.equal(c.status, 'ok');
        assert.match(c.detail, /^beads/);
      }
    ));

  test('tasks row mirrors bd health when beads serves', () =>
    withEnv(
      { config: { stores: ['jsonl', 'beads'] }, beadsDir: true, bins: ['gh', 'bro'] },
      dir => {
        const c = byName(runDoctorChecks(dir), 'tasks');
        assert.equal(c.status, 'fail');
        assert.match(c.detail, /beads.*bd/);
      }
    ));

  test('connectors.tasks=github makes the tasks row healthy without bd', () =>
    withEnv(
      {
        config: { stores: ['jsonl'], connectors: { tasks: 'github' } },
        remote: 'git@github.com:acme/widgets.git',
        bins: ['gh', 'bro'],
      },
      dir => {
        // githubConnector is registered by ../plugins.ts (doctor.ts
        // imports it) — the pin resolves through the real registry
        const checks = runDoctorChecks(dir);
        const tasks = byName(checks, 'tasks');
        assert.equal(tasks.status, 'ok', JSON.stringify(tasks));
        assert.match(tasks.detail, /github.*connectors\.tasks=github/);
        // and the absence of bd never gates the run
        assert.equal(byName(checks, 'bd').status, 'warn');
        assert.equal(doctorExitCode(checks), 0);
      }
    ));

  test('gh present but unauthenticated fails', () =>
    withEnv({ bins: ['gh'], env: { FAKE_GH_AUTH: '1' } }, dir => {
      const checks = runDoctorChecks(dir);
      assert.equal(byName(checks, 'gh').status, 'fail');
      assert.match(byName(checks, 'gh').hint ?? '', /gh auth login/);
      assert.equal(doctorExitCode(checks), 1);
    }));

  test('gh missing entirely fails', () =>
    withEnv({ bins: [] }, dir => {
      assert.equal(byName(runDoctorChecks(dir), 'gh').status, 'fail');
    }));

  test('present-but-broken binary says "not usable", never "not found"', () =>
    withEnv({ bins: [] }, dir => {
      // gh exists on PATH but isn't executable — EACCES, not ENOENT
      writeFileSync(join(dir, 'bin', 'gh'), FAIL_SHIM);
      const c = byName(runDoctorChecks(dir), 'gh');
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /not usable/);
      assert.doesNotMatch(c.detail, /not found/);
    }));

  test('invalid bro.config.json fails the config check', () =>
    withEnv({ config: '{ not json', bins: [] }, dir => {
      const checks = runDoctorChecks(dir);
      assert.equal(byName(checks, 'config').status, 'fail');
      assert.equal(doctorExitCode(checks), 1);
    }));

  test('a throwing bro.config.ts fails — loadable, not just present', () =>
    withEnv({ configTs: 'throw new Error("boom")\n', bins: ['gh'] }, dir => {
      const checks = runDoctorChecks(dir);
      assert.equal(byName(checks, 'config').status, 'fail');
      assert.equal(doctorExitCode(checks), 1);
    }));

  test('unknown config keys warn — typoed sections silently no-op', () =>
    withEnv({ config: { stores: ['jsonl'], sdd2: { mode: 'gate' } }, bins: ['gh'] }, dir => {
      const c = byName(runDoctorChecks(dir), 'config');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /sdd2/);
    }));

  test('config layers: provenance names the winning layer per section', () =>
    withEnv(
      {
        config: { stores: ['jsonl'], sdd: { mode: 'gate' } },
        configLocal: { fleet: { maxConcurrent: 1 } },
        configGlobal: { providers: { p: { type: 'cli', command: 'x' } } },
        bins: ['gh'],
      },
      dir => {
        const rows = runDoctorChecks(dir).filter(c => c.name === 'config');
        assert.ok(
          rows.some(
            c =>
              /project bro\.config\.json/.test(c.detail) &&
              /local bro\.config\.local\.json/.test(c.detail)
          ),
          JSON.stringify(rows)
        );
        const prov = rows.find(c => c.detail.startsWith('sections:'));
        assert.ok(prov, JSON.stringify(rows));
        assert.match(prov.detail, /sdd←project/);
        assert.match(prov.detail, /fleet←local/);
        assert.match(prov.detail, /providers←global/);
        assert.equal(doctorExitCode(runDoctorChecks(dir)), 0);
      }
    ));

  test('operator sections in the committed file warn — they leak to every clone', () =>
    withEnv({ config: { providers: { p: { type: 'cli', command: 'x' } } }, bins: ['gh'] }, dir => {
      const rows = runDoctorChecks(dir).filter(c => c.name === 'config' && c.status === 'warn');
      assert.ok(
        rows.some(c => /operator sections in committed config: providers/.test(c.detail)),
        JSON.stringify(rows)
      );
    }));

  test('policy sections in the global file warn — they hit every project', () =>
    withEnv({ configGlobal: { sdd: { mode: 'gate' } }, bins: ['gh'] }, dir => {
      const rows = runDoctorChecks(dir).filter(c => c.name === 'config' && c.status === 'warn');
      assert.ok(
        rows.some(c => /policy sections in global config: sdd/.test(c.detail)),
        JSON.stringify(rows)
      );
    }));

  test('core-only sections are known — no plugin declares them (retro bro-8ccl)', () =>
    withEnv(
      {
        config: {
          stores: ['jsonl'],
          connectors: { github: {} },
          providers: [{ name: 'orcarouter', type: 'api', baseUrl: 'https://x' }],
          fleet: { maxConcurrent: 4 },
          query: { concurrency: 4, env: {} },
          pack: 'packs',
        },
        bins: ['gh'],
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'config');
        assert.equal(c.status, 'ok');
        assert.doesNotMatch(c.detail, /unknown keys/);
      }
    ));

  test('drifted bd output shape fails when beads is an active store', () =>
    withEnv(
      {
        config: { stores: ['jsonl', 'beads'] },
        beadsDir: true,
        bins: ['bd', 'gh'],
        env: { FAKE_BD_DRIFT: '1' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'bd-compat');
        assert.equal(c.status, 'fail');
        assert.match(c.detail, /expected an array/);
        assert.equal(doctorExitCode(runDoctorChecks(dir)), 1);
      }
    ));

  test('drifted bd only warns under jsonl-only stores', () =>
    withEnv(
      { config: { stores: ['jsonl'] }, bins: ['bd', 'gh'], env: { FAKE_BD_FLAG_DRIFT: '1' } },
      dir => {
        const c = byName(runDoctorChecks(dir), 'bd-compat');
        assert.equal(c.status, 'warn');
        assert.match(c.detail, /unknown flag/);
        assert.equal(doctorExitCode(runDoctorChecks(dir)), 0);
      }
    ));

  test('bd store schema newer than bro knows warns/fails via compat', () =>
    withEnv(
      { config: { stores: ['jsonl'] }, bins: ['bd', 'gh'], env: { FAKE_BD_SCHEMA: '2' } },
      dir => {
        const c = byName(runDoctorChecks(dir), 'bd-compat');
        assert.equal(c.status, 'warn');
        assert.match(c.detail, /schema_version 2/);
      }
    ));

  test('no store — compat is unproven but ok', () =>
    withEnv(
      {
        config: { stores: ['jsonl', 'beads'] },
        bins: ['bd', 'gh'],
        env: { FAKE_BD_LIST_FAIL: '1' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'bd-compat');
        assert.equal(c.status, 'ok');
        assert.match(c.detail, /unproven/);
      }
    ));

  test('pre-Dolt bd — backend warns, store probe skips', () =>
    withEnv(
      { beadsDir: true, remote: true, bins: ['bd', 'gh'], env: { FAKE_BD_DOLT_FAIL: '1' } },
      dir => {
        const checks = runDoctorChecks(dir);
        assert.equal(byName(checks, 'bd-backend').status, 'warn');
        assert.equal(byName(checks, 'dolt-remote').status, 'skip');
      }
    ));

  test('.beads without a dolt remote warns — state stays local-only', () =>
    withEnv(
      { beadsDir: true, remote: true, bins: ['bd', 'gh'], env: { FAKE_BD_DOLT: '' } },
      dir => {
        const checks = runDoctorChecks(dir);
        assert.equal(byName(checks, 'dolt-remote').status, 'warn');
      }
    ));

  test('dolt-store fails on a manifest naming missing tables — and names the last good head', () => {
    const base = mkdtempSync(join(tmpdir(), 'bro-doctor-corrupt-'));
    try {
      const store = join(base, 'doltstore');
      testGit(['init', '-q', store]);
      const t = 'a'.repeat(32);
      const gone = 'b'.repeat(32);
      const good = doltStoreCommit(store, { manifest: doltManifest({ [t]: 1 }), [t]: 'x' });
      doltStoreCommit(store, { manifest: doltManifest({ [t]: 1, [gone]: 1 }), [t]: 'x' }, good);
      return withEnv(
        {
          beadsDir: true,
          remote: true,
          bins: ['bd', 'gh'],
          env: { FAKE_BD_DOLT: `origin\tgit+file://${store}\n` },
        },
        dir => {
          const c = byName(runDoctorChecks(dir), 'dolt-store');
          assert.equal(c.status, 'fail', JSON.stringify(c));
          assert.ok(c.detail.includes(gone), c.detail);
          assert.ok(c.detail.includes(good.slice(0, 12)), `last good head: ${c.detail}`);
          assert.match(c.hint ?? '', /refs\/dolt\/data/);
          assert.equal(doctorExitCode(runDoctorChecks(dir)), 1);
        }
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('dolt-store is ok when the remote published no data ref yet', () => {
    const base = mkdtempSync(join(tmpdir(), 'bro-doctor-empty-'));
    try {
      const store = join(base, 'doltstore');
      testGit(['init', '-q', store]); // repo exists, refs/dolt/data never pushed
      return withEnv(
        {
          beadsDir: true,
          remote: true,
          bins: ['bd', 'gh'],
          env: { FAKE_BD_DOLT: `origin\tgit+file://${store}\n` },
        },
        dir => {
          const c = byName(runDoctorChecks(dir), 'dolt-store');
          assert.equal(c.status, 'ok', JSON.stringify(c));
          assert.match(c.detail, /nothing published/);
        }
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('dolt-store warns when the remote is unreachable — transport is not corruption', () =>
    withEnv(
      {
        beadsDir: true,
        remote: true,
        bins: ['bd', 'gh'],
        env: { FAKE_BD_DOLT: 'origin\tgit+file:///nonexistent/gone.git\n' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'dolt-store');
        assert.equal(c.status, 'warn', JSON.stringify(c));
        assert.match(c.detail, /unverifiable/);
      }
    ));

  test('dolt-store skips non-git remotes', () =>
    withEnv(
      {
        beadsDir: true,
        remote: true,
        bins: ['bd', 'gh'],
        env: { FAKE_BD_DOLT: 'hub\tdolthub://org/db\n' },
      },
      dir => {
        assert.equal(byName(runDoctorChecks(dir), 'dolt-store').status, 'skip');
      }
    ));

  test('dolt-store verifies a plain noms dir remote in place', () => {
    const base = mkdtempSync(join(tmpdir(), 'bro-doctor-noms-'));
    try {
      const noms = join(base, 'noms');
      mkdirSync(noms);
      const gone = 'b'.repeat(32);
      writeFileSync(join(noms, 'manifest'), doltManifest({ [gone]: 2 }));
      return withEnv(
        {
          beadsDir: true,
          remote: true,
          bins: ['bd', 'gh'],
          env: { FAKE_BD_DOLT: `local\tfile://${noms}\n` },
        },
        dir => {
          const c = byName(runDoctorChecks(dir), 'dolt-store');
          assert.equal(c.status, 'fail', JSON.stringify(c));
          assert.ok(c.detail.includes(gone), c.detail);
        }
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('.beads present but unreadable fails the store probe', () =>
    withEnv({ beadsDir: true, bins: ['bd', 'gh'], env: { FAKE_BD_LIST_FAIL: '1' } }, dir => {
      const checks = runDoctorChecks(dir);
      assert.equal(byName(checks, 'bd-store').status, 'fail');
      assert.equal(doctorExitCode(checks), 1);
    }));

  test('hooks: no bro, no npx → warn "no resolution"; bro on PATH → ok', () =>
    withEnv({ bins: ['gh'] }, dir => {
      const c = byName(runDoctorChecks(dir), 'hooks');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /no resolution/);
    }).then(() =>
      withEnv({ bins: ['gh', 'bro'] }, dir => {
        const c = byName(runDoctorChecks(dir), 'hooks');
        assert.equal(c.status, 'ok');
        assert.match(c.detail, /PATH/);
      })
    ));

  test('hooks-wiring: bro chain + resolved bro plugin → warn', () =>
    withEnv({ bins: ['gh'] }, dir => {
      resolvedBroPlugin(dir);
      writeDevinChain(dir, {
        PostToolUse: [
          {
            matcher: '^exec$',
            hooks: [{ type: 'command', command: '"$DEVIN_PROJECT_DIR/hooks/run.sh" post-tool' }],
          },
        ],
      });
      const c = byName(runDoctorChecks(dir), 'hooks-wiring');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /two hook launchers/);
      assert.match(c.hint ?? '', /drop \.devin\/hooks\.v1\.json/);
    }));

  test('hooks-wiring: mixed bro + foreign chain → warn scopes to bro events, hint keeps the file', () =>
    withEnv({ bins: ['gh'] }, dir => {
      resolvedBroPlugin(dir);
      writeDevinChain(dir, {
        PostToolUse: [
          {
            matcher: '^exec$',
            hooks: [{ type: 'command', command: '"$DEVIN_PROJECT_DIR/hooks/run.sh" post-tool' }],
          },
        ],
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: '"$DEVIN_PROJECT_DIR/tools/lint.sh" || true' }],
          },
        ],
      });
      const c = byName(runDoctorChecks(dir), 'hooks-wiring');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /PostToolUse/);
      assert.doesNotMatch(c.detail, /Stop/);
      assert.doesNotMatch(c.hint ?? '', /drop/);
      assert.match(c.hint ?? '', /remove the bro hook entries/);
    }));

  test('hooks-wiring: bro chain with no resolved plugin → ok sole wiring', () =>
    withEnv({ bins: ['gh'] }, dir => {
      writeDevinChain(dir, {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'bro hooks stop || true; exit 0' }],
          },
        ],
      });
      const c = byName(runDoctorChecks(dir), 'hooks-wiring');
      assert.equal(c.status, 'ok');
      assert.match(c.detail, /sole bro wiring/);
    }));

  test('hooks-wiring: no project chain → ok', () =>
    withEnv({ bins: ['gh'] }, dir => {
      const c = byName(runDoctorChecks(dir), 'hooks-wiring');
      assert.equal(c.status, 'ok');
      assert.match(c.detail, /no project-local/);
    }));

  test('hooks-wiring: a foreign-tool chain + resolved plugin → ok, not duplicate', () =>
    withEnv({ bins: ['gh'] }, dir => {
      resolvedBroPlugin(dir);
      writeDevinChain(dir, {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: '"$DEVIN_PROJECT_DIR/tools/lint.sh" || true' }],
          },
        ],
      });
      const c = byName(runDoctorChecks(dir), 'hooks-wiring');
      assert.equal(c.status, 'ok');
      assert.match(c.detail, /no bro hooks/);
    }));

  test('bro-dist: PATH-bro into a dev checkout warns when dist predates HEAD', () =>
    withEnv({ bins: ['gh'] }, dir => {
      const { checkout, entry } = fakeCheckout(dir);
      commitAt(checkout); // HEAD committer time = now
      const stale = new Date(Date.now() - 3_600_000);
      utimesSync(entry, stale, stale);
      symlinkSync(entry, join(dir, 'bin', 'bro'));
      const c = byName(runDoctorChecks(dir), 'bro-dist');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /predates HEAD/);
      assert.match(c.hint ?? '', /npm run build/);
    }));

  test('bro-dist: fresh dist over an old HEAD is ok', () =>
    withEnv({ bins: ['gh'] }, dir => {
      const { checkout, entry } = fakeCheckout(dir);
      commitAt(checkout, '2000-01-01T00:00:00Z');
      // dist rebuilt after the ref moved — the backdated commit's %ct is
      // old, but the reflog move already happened before the build
      utimesSync(entry, new Date(), new Date());
      symlinkSync(entry, join(dir, 'bin', 'bro'));
      const c = byName(runDoctorChecks(dir), 'bro-dist');
      assert.equal(c.status, 'ok');
      assert.match(c.detail, /covers HEAD/);
    }));

  test('bro-dist: a backdated commit still warns — ref-move time is the signal, not %ct', () =>
    withEnv({ bins: ['gh'] }, dir => {
      const { checkout, entry } = fakeCheckout(dir);
      // commit dated 2000 but created now — after the dist write. Commit
      // time says "covered"; the ref actually moved after the build
      commitAt(checkout, '2000-01-01T00:00:00Z');
      symlinkSync(entry, join(dir, 'bin', 'bro'));
      const c = byName(runDoctorChecks(dir), 'bro-dist');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /predates HEAD/);
    }));

  test('bro-dist: an upstream ahead of a covered HEAD still warns — the merge landed after the build', () =>
    withEnv({ bins: ['gh'] }, dir => {
      const { checkout, entry } = fakeCheckout(dir);
      const bare = join(dir, 'origin.git');
      execFileSync('git', ['init', '-q', '--bare', bare]);
      execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', bare]);
      commitAt(checkout, '2000-01-01T00:00:00Z');
      const branch = execFileSync('git', ['-C', checkout, 'branch', '--show-current'], {
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['-C', checkout, 'push', '-qu', 'origin', `HEAD:${branch}`]);
      // a second clone lands a backdated commit on origin — commit time
      // (2001) predates the dist build, but the fetch moves @{u} after it
      const other = join(dir, 'other');
      execFileSync('git', ['clone', '-q', bare, other]);
      commitAt(other, '2001-01-01T00:00:00Z');
      execFileSync('git', ['-C', other, 'push', '-q', 'origin', `HEAD:${branch}`]);
      utimesSync(entry, new Date(), new Date()); // dist built before the fetch
      execFileSync('git', ['-C', checkout, 'fetch', '-q', 'origin']);
      symlinkSync(entry, join(dir, 'bin', 'bro'));
      const c = byName(runDoctorChecks(dir), 'bro-dist');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /predates @\{u\}/);
      assert.match(c.hint ?? '', /npm run build/);
    }));

  test('daemon: down is ordinary — no supervisor, recorded dead', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'daemon')
      assert.equal(c.status, 'ok')
      assert.match(c.detail, /down — no supervisor/)
    }).then(() =>
      withEnv({ bins: ['gh'] }, (dir) => {
        mkdirSync(join(dir, '.git', 'bro'), { recursive: true })
        writeFileSync(
          join(dir, '.git', 'bro', 'daemon.json'),
          JSON.stringify({ pid: 999999, everySec: 60, spawnedAt: new Date().toISOString() })
        )
        const c = byName(runDoctorChecks(dir), 'daemon')
        assert.equal(c.status, 'ok')
        assert.match(c.detail, /recorded pid 999999 is dead/)
      })
    ))

  test('daemon: this repo\'s dist borrows the bro-dist verdict — fresh covers, stale warns', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      // dir itself is the bro checkout — the daemon exec'd its own dist
      const distDir = join(dir, 'packages', 'cli', 'dist')
      mkdirSync(distDir, { recursive: true })
      writeFileSync(join(dir, 'packages', 'cli', 'package.json'), '{"name":"@broject/bro","version":"0.2.5"}')
      const entry = join(distDir, 'index.js')
      writeFileSync(entry, 'setTimeout(() => {}, 1e9)\n')
      commitAt(dir)
      const child = fakeDaemon(dir, [process.execPath, entry])
      try {
        const stale = new Date(Date.now() - 3_600_000)
        utimesSync(entry, stale, stale)
        let c = byName(runDoctorChecks(dir), 'daemon')
        assert.equal(c.status, 'warn')
        assert.match(c.detail, /predates HEAD/)
        utimesSync(entry, new Date(), new Date())
        c = byName(runDoctorChecks(dir), 'daemon')
        assert.equal(c.status, 'ok')
        assert.match(c.detail, /covers HEAD/)
      } finally {
        child.kill()
      }
    }))

  test('daemon: an installed binary in a bro checkout warns — protections not live', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      // this repo builds bro v0.2.5; the daemon runs a published v0.2.4
      mkdirSync(join(dir, 'packages', 'cli'), { recursive: true })
      writeFileSync(join(dir, 'packages', 'cli', 'package.json'), '{"name":"@broject/bro","version":"0.2.5"}')
      const pkg = join(dir, 'lib', 'node_modules', '@broject', 'bro')
      mkdirSync(join(pkg, 'dist'), { recursive: true })
      writeFileSync(join(pkg, 'package.json'), '{"name":"@broject/bro","version":"0.2.4"}')
      const entry = join(pkg, 'dist', 'index.js')
      writeFileSync(entry, 'setTimeout(() => {}, 1e9)\n')
      const child = fakeDaemon(dir, [process.execPath, entry])
      try {
        const c = byName(runDoctorChecks(dir), 'daemon')
        assert.equal(c.status, 'warn')
        assert.match(c.detail, /installed, not this repo's build \(v0\.2\.5\)/)
        assert.match(c.detail, /v0\.2\.4/)
        assert.match(c.hint ?? '', /rebuilt/)
      } finally {
        child.kill()
      }
    }))

  test('daemon: a different bro checkout\'s dist warns', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      const { entry } = fakeCheckout(dir)
      writeFileSync(entry, 'setTimeout(() => {}, 1e9)\n')
      const child = fakeDaemon(dir, [process.execPath, entry])
      try {
        const c = byName(runDoctorChecks(dir), 'daemon')
        assert.equal(c.status, 'warn')
        assert.match(c.detail, /different bro checkout/)
      } finally {
        child.kill()
      }
    }))

  test('daemon: outside a bro repo, entry = resolved bro → ok; foreign → warn', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      const entry = join(dir, 'installed-bro.js')
      writeFileSync(entry, 'setTimeout(() => {}, 1e9)\n')
      symlinkSync(entry, join(dir, 'bin', 'bro'))
      const child = fakeDaemon(dir, [process.execPath, entry])
      try {
        const c = byName(runDoctorChecks(dir), 'daemon')
        assert.equal(c.status, 'ok')
        assert.match(c.detail, /up — pid/)
      } finally {
        child.kill()
      }
    }).then(() =>
      withEnv({ bins: ['gh', 'bro'] }, (dir) => {
        // PATH-bro is the shim; the daemon runs a different file
        const entry = join(dir, 'other-bro.js')
        writeFileSync(entry, 'setTimeout(() => {}, 1e9)\n')
        const child = fakeDaemon(dir, [process.execPath, entry])
        try {
          const c = byName(runDoctorChecks(dir), 'daemon')
          assert.equal(c.status, 'warn')
          assert.match(c.detail, /`bro` resolves/)
        } finally {
          child.kill()
        }
      })
    ))

  test('daemon: an argv that names no entry skips honestly', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      const child = fakeDaemon(dir, [process.execPath, '-e', 'setTimeout(() => {}, 1e9)'])
      try {
        const c = byName(runDoctorChecks(dir), 'daemon')
        assert.equal(c.status, 'skip')
        assert.match(c.detail, /unverifiable/)
      } finally {
        child.kill()
      }
    }))

  test('providers: configured entries are listed as name (kind, model)', () =>
    withEnv(
      {
        config: {
          providers: {
            orca: {
              type: 'api',
              baseUrl: 'http://x/v1',
              models: { ['qwen3-coder']: 'openai-compat' },
            },
            local: { type: 'cli', command: 'devin -p' },
          },
        },
        bins: ['gh'],
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'providers');
        assert.equal(c.status, 'ok');
        assert.match(c.detail, /orca \(api, qwen3-coder\)/);
        assert.match(c.detail, /local \(cli\)/);
      }
    ));

  test('providers: an apiKeyEnv naming an unset var warns — the name is never echoed', () =>
    withEnv(
      {
        config: {
          providers: {
            orca: {
              type: 'api',
              baseUrl: 'http://x/v1',
              apiKeyEnv: 'ORCA_UNSET_KEY',
              models: { ['m']: 'openai-compat' },
            },
          },
        },
        bins: ['gh'],
      },
      dir => {
        const rows = runDoctorChecks(dir).filter(c => c.name === 'providers');
        const warn = rows.find(c => c.status === 'warn');
        assert.ok(warn, JSON.stringify(rows));
        assert.match(warn.detail, /providers\.orca\.apiKeyEnv/);
        // an all-caps pasted key passes isEnvName — the value is never echoed
        assert.doesNotMatch(warn.detail, /ORCA_UNSET_KEY/);
      }
    ));

  test('providers: a set auth env reports ok', () =>
    withEnv(
      {
        config: {
          providers: {
            orca: {
              type: 'api',
              baseUrl: 'http://x/v1',
              apiKeyEnv: 'ORCA_SET_KEY',
              models: { ['m']: 'openai-compat' },
            },
          },
        },
        bins: ['gh'],
        env: { ORCA_SET_KEY: 'sk-test' },
      },
      dir => {
        const rows = runDoctorChecks(dir).filter(c => c.name === 'providers' && c.status === 'ok');
        assert.ok(rows.some(c => /auth env set/.test(c.detail)));
      }
    ));

  test('providers: consumer refs to missing entries warn — even with an empty registry', () =>
    withEnv(
      {
        config: {
          judge: { provider: 'ghost' },
          agents: { native: { provider: 'also-ghost' } },
        },
        bins: ['gh'],
      },
      dir => {
        const rows = runDoctorChecks(dir).filter(c => c.name === 'providers');
        assert.match(rows[0]!.detail, /none configured/);
        const warns = rows.filter(c => c.status === 'warn');
        assert.ok(warns.some(c => c.detail.includes("judge.provider names 'ghost'")));
        assert.ok(warns.some(c => c.detail.includes("agents.native.provider names 'also-ghost'")));
      }
    ));

  test('providers: a call-surface kind named for spawn warns', () =>
    withEnv(
      {
        config: {
          providers: {
            typesafe: {
              type: 'api',
              baseUrl: 'https://api.typesafe.ai',
              apiKeyEnv: 'TYPESAFE_API_KEY',
              models: { ['jev-1']: 'systemone' },
            },
          },
          agents: { native: { provider: 'typesafe' } },
        },
        bins: ['gh'],
        env: { TYPESAFE_API_KEY: 'sk-test' },
      },
      dir => {
        const rows = runDoctorChecks(dir).filter(c => c.name === 'providers');
        const warn = rows.find(c => c.status === 'warn');
        assert.ok(warn, JSON.stringify(rows));
        assert.ok(
          warn.detail.includes('agents.native.provider') &&
            warn.detail.includes('no spawn surface'),
          warn.detail
        );
      }
    ));

  test('providers: judge.provider resolving a synthesized alias does not warn', () =>
    withEnv({ config: { judge: { provider: 'systemone' } }, bins: ['gh'] }, dir => {
      const rows = runDoctorChecks(dir).filter(c => c.name === 'providers');
      assert.ok(!rows.some(c => c.status === 'warn'), JSON.stringify(rows));
    }));

  test('build row: absent stamp is ok; a foreign session or a stamp behind HEAD warns (bro-fatja)', () =>
    withEnv({ bins: ['gh'] }, dir => {
      // git init ran with no commit — a stamp needs HEAD, make one
      testGit(['-C', dir, 'config', 'user.email', 't@t']);
      testGit(['-C', dir, 'config', 'user.name', 't']);
      testGit(['-C', dir, 'commit', '-qm', 'init', '--allow-empty']);
      const head = testGit(['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.match(byName(runDoctorChecks(dir), 'build').detail, /no stamped build/);

      const stampFile = join(dir, '.git', 'bro', 'last-build.json');
      mkdirSync(join(dir, '.git', 'bro'), { recursive: true });
      const write = (s: object) => writeFileSync(stampFile, JSON.stringify(s));

      // unresolvable current session: a foreign-named stamp still
      // reports attribution without claiming "not yours"
      write({
        session: 'other-sess',
        ts: Date.now(),
        head,
        inputs: 'x'.repeat(64),
        via: 'post-merge',
      });
      let c = byName(runDoctorChecks(dir), 'build');
      assert.equal(c.status, 'ok', JSON.stringify(c));
      assert.match(c.detail, /other-sess.*post-merge/);

      // resolved session + foreign stamp → the bead's headline warn
      process.env.BRO_SESSION_ID = 'me';
      c = byName(runDoctorChecks(dir), 'build');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /another session rebuilt since your write/);

      // own stamp → ok
      write({ session: 'me', ts: Date.now(), head, inputs: 'x'.repeat(64), via: 'build' });
      assert.equal(byName(runDoctorChecks(dir), 'build').status, 'ok');

      // stamp behind HEAD warns — even when it was mine
      write({
        session: 'me',
        ts: Date.now(),
        head: 'deadbeef',
        inputs: 'x'.repeat(64),
        via: 'build',
      });
      c = byName(runDoctorChecks(dir), 'build');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /behind HEAD/);
    }));

  test('not a git repo — repo warns, remote probes are skipped', () =>
    withEnv({ bins: ['gh'] }, dir => {
      const bare = mkdtempSync(join(tmpdir(), 'bro-doctor-bare-'));
      try {
        const checks = runDoctorChecks(bare);
        assert.equal(byName(checks, 'repo').status, 'warn');
        assert.equal(byName(checks, 'git-remote'), undefined);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    }));

  test('mesh rows: absent when unconfigured; census + dolt probe when peers exist', async () => {
    // no mesh section at all — the group stays silent
    await withEnv({ remote: true, bins: ['gh', 'bd'] }, dir => {
      const checks = runDoctorChecks(dir);
      assert.equal(
        checks.find(c => c.name === 'mesh'),
        undefined
      );
      assert.equal(
        checks.find(c => c.name === 'mesh-peers'),
        undefined
      );
    });
    // configured peers: rig derived from origin, census counts
    // transports, dolt missing (PATH is shims only) → warn
    await withEnv(
      {
        remote: 'https://github.com/acme/widgets.git',
        bins: ['gh', 'bd'],
        config: {
          mesh: {
            peers: {
              // a github.com remote now derives the `github` plane —
              // a non-github host keeps this a beads-remote census
              rigb: { rig: 'mesh://acme/rigb', remote: 'https://gitlab.com/acme/rigb.git' },
              local: { rig: 'mesh://acme/local', remote: '/nonexistent' },
            },
          },
        },
      },
      dir => {
        const checks = runDoctorChecks(dir);
        assert.equal(byName(checks, 'mesh').status, 'ok');
        assert.match(byName(checks, 'mesh').detail, /rig mesh:\/\/acme\/widgets/);
        assert.match(byName(checks, 'mesh-peers').detail ?? '', /2 peer\(s\), 2 beads-remote/);
        assert.equal(byName(checks, 'mesh-dolt').status, 'warn');
      }
    );
    // peers configured but no rig pin and no origin → unaddressable warn
    await withEnv(
      {
        bins: ['gh', 'bd'],
        config: {
          mesh: {
            peers: {
              rigb: { rig: 'mesh://acme/rigb', remote: 'https://github.com/acme/rigb.git' },
            },
          },
        },
      },
      dir => {
        const checks = runDoctorChecks(dir);
        assert.equal(byName(checks, 'mesh').status, 'warn');
      }
    );
    // a binding the section passes but parsePeer rejects (bogus
    // explicit transport) → the census warns instead of miscounting
    await withEnv(
      {
        remote: 'https://github.com/acme/widgets.git',
        bins: ['gh', 'bd'],
        config: {
          mesh: {
            peers: {
              bad: { rig: 'mesh://a/b', remote: 'x', transport: 'bogus' },
              good: { rig: 'mesh://a/b', remote: '/p' },
            },
          },
        },
      },
      dir => {
        assert.equal(byName(runDoctorChecks(dir), 'mesh-peers').status, 'warn');
      }
    );
  });

  test('debt-sonarcloud: absent when the source is unconfigured', () =>
    withEnv({ config: { debt: { sources: ['review-threads'] } }, bins: ['gh'] }, dir => {
      assert.equal(
        runDoctorChecks(dir).find(c => c.name === 'debt-sonarcloud'),
        undefined
      );
    }));

  test('debt-sonarcloud: configured but SONAR_TOKEN unset warns with the remediation', () =>
    withEnv(
      {
        config: {
          stores: ['jsonl'],
          debt: {
            sources: ['review-threads', 'sonarcloud'],
            sourceConfig: { sonarcloud: { project_key: 'pk' } },
          },
        },
        bins: ['gh'],
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'debt-sonarcloud');
        assert.equal(c.status, 'warn');
        assert.match(c.detail, /SONAR_TOKEN/);
        assert.match(c.hint ?? '', /Generate Tokens/);
        assert.equal(doctorExitCode(runDoctorChecks(dir)), 0);
      }
    ));

  test('debt-sonarcloud: token set but no project key warns', () =>
    withEnv(
      {
        config: { debt: { sources: ['sonarcloud'] } },
        bins: ['gh', 'curl'],
        env: { SONAR_TOKEN: 'squ' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'debt-sonarcloud');
        assert.equal(c.status, 'warn');
        assert.match(c.detail, /project key/);
      }
    ));

  test('debt-sonarcloud: token + config key + curl → ok naming the project', () =>
    withEnv(
      {
        config: {
          debt: {
            sources: ['sonarcloud'],
            sourceConfig: { sonarcloud: { project_key: 'acme_widgets' } },
          },
        },
        bins: ['gh', 'curl'],
        env: { SONAR_TOKEN: 'squ' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'debt-sonarcloud');
        assert.equal(c.status, 'ok', JSON.stringify(c));
        assert.match(c.detail, /acme_widgets/);
      }
    ));

  test('debt-sonarcloud: run from a nested dir still reads the root properties file', () =>
    withEnv(
      {
        config: { debt: { sources: ['sonarcloud'] } },
        bins: ['gh', 'curl'],
        env: { SONAR_TOKEN: 'squ' },
      },
      dir => {
        writeFileSync(join(dir, 'sonar-project.properties'), 'sonar.projectKey=rootkey\n');
        const sub = join(dir, 'packages', 'deep');
        mkdirSync(sub, { recursive: true });
        const c = byName(runDoctorChecks(sub), 'debt-sonarcloud');
        assert.equal(c.status, 'ok', JSON.stringify(c));
        assert.match(c.detail, /rootkey/);
      }
    ));

  test('debt-codacy: absent when unconfigured; no token warns with remediation', () =>
    withEnv({ config: { debt: { sources: ['review-threads'] } }, bins: ['gh'] }, dir => {
      assert.equal(
        runDoctorChecks(dir).find(c => c.name === 'debt-codacy'),
        undefined
      );
    }).then(() =>
      withEnv({ config: { debt: { sources: ['codacy'] } }, bins: ['gh'] }, dir => {
        const c = byName(runDoctorChecks(dir), 'debt-codacy');
        assert.equal(c.status, 'warn');
        assert.match(c.detail, /CODACY_API_TOKEN/);
      })
    ));

  test('debt-codacy: token + curl → ok; a cleartext host warns', () =>
    withEnv(
      {
        config: { debt: { sources: ['codacy'] } },
        bins: ['gh', 'curl'],
        env: { CODACY_API_TOKEN: 'ct' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'debt-codacy');
        assert.equal(c.status, 'ok', JSON.stringify(c));
        assert.match(c.detail, /CODACY_API_TOKEN set/);
      }
    ).then(() =>
      withEnv(
        {
          config: {
            debt: {
              sources: ['codacy'],
              sourceConfig: { codacy: { host: 'http://codacy.internal' } },
            },
          },
          bins: ['gh', 'curl'],
          env: { CODACY_PROJECT_TOKEN: 'cpt' },
        },
        dir => {
          const c = byName(runDoctorChecks(dir), 'debt-codacy');
          assert.equal(c.status, 'warn');
          assert.match(c.detail, /cleartext/);
        }
      )
    ));

  test('debt-codescene: token without a project id warns; config id → ok', () =>
    withEnv(
      {
        config: { debt: { sources: ['codescene'] } },
        bins: ['gh', 'curl'],
        env: { CODESCENE_TOKEN: 'cs' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'debt-codescene');
        assert.equal(c.status, 'warn');
        assert.match(c.detail, /project id/);
      }
    ).then(() =>
      withEnv(
        {
          config: {
            debt: { sources: ['codescene'], sourceConfig: { codescene: { project_id: 42 } } },
          },
          bins: ['gh', 'curl'],
          env: { CODESCENE_TOKEN: 'cs' },
        },
        dir => {
          const c = byName(runDoctorChecks(dir), 'debt-codescene');
          assert.equal(c.status, 'ok', JSON.stringify(c));
          assert.match(c.detail, /project 42/);
        }
      )
    ));

  test('conductor: a classifier pin naming an acp-served wire warns (bro-9ww2q)', () =>
    withEnv(
      {
        config: {
          providers: { 'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-max' } },
        },
        bins: ['gh'],
      },
      dir => {
        mkdirSync(join(dir, '.claude'), { recursive: true });
        writeFileSync(
          join(dir, '.claude', 'settings.local.json'),
          JSON.stringify({
            env: {
              ANTHROPIC_DEFAULT_HAIKU_MODEL: 'devin/swe-2-max',
            },
          })
        );
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'warn', JSON.stringify(c));
        assert.match(c.detail, /ANTHROPIC_DEFAULT_HAIKU_MODEL=devin\/swe-2-max/);
        assert.match(c.detail, /providers\.devin-acp/);
      }
    ));

  test('conductor: a live acp-backed endpoint + client base url warns with no pin at all', () =>
    withEnv(
      {
        config: {
          providers: { 'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-max' } },
        },
        bins: ['gh'],
        env: { BRO_PROVIDER_BACKEND: 'devin-acp' },
      },
      dir => {
        liveServeClient(dir, 'http://127.0.0.1:44927');
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'warn', JSON.stringify(c));
        assert.match(c.detail, /acp conductor \(providers\.devin-acp\)/);
        assert.match(c.detail, /classifier rides it too/);
      }
    ));

  test('conductor: a live serve with no acp backend stays ok — the byte proxy forwards classifiers fine', () =>
    withEnv(
      {
        config: {
          providers: { 'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-max' } },
        },
        bins: ['gh'],
      },
      dir => {
        const url = 'http://127.0.0.1:44927';
        liveServeClient(dir, url, url, { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' });
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'ok', JSON.stringify(c));
      }
    ));

  test('conductor: a clean dedicated classifier lane wins — the main-model pin is not evaluated', () =>
    withEnv(
      {
        config: {
          providers: { 'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-max' } },
        },
        bins: ['gh'],
      },
      dir => {
        mkdirSync(join(dir, '.claude'), { recursive: true });
        writeFileSync(
          join(dir, '.claude', 'settings.local.json'),
          JSON.stringify({
            env: {
              ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
              ANTHROPIC_DEFAULT_SONNET_MODEL: 'devin/swe-2-max',
            },
          })
        );
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'ok', JSON.stringify(c));
      }
    ));

  test('conductor: process-env pins count — <acp-name>/<id> is conductor vocabulary', () =>
    withEnv(
      {
        config: {
          providers: { 'devin-acp': { type: 'acp', command: 'devin acp' } },
        },
        bins: ['gh'],
        env: { ANTHROPIC_SMALL_FAST_MODEL: 'devin-acp/swe-2-max' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'warn', JSON.stringify(c));
        assert.match(c.detail, /ANTHROPIC_SMALL_FAST_MODEL=devin-acp\/swe-2-max/);
        assert.match(c.detail, /providers\.devin-acp/);
      }
    ));

  test('conductor: a localhost-spelled client url still matches the 127.0.0.1 serve', () =>
    withEnv(
      {
        config: {
          providers: { 'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-max' } },
        },
        bins: ['gh'],
        env: { BRO_PROVIDER_BACKEND: 'devin-acp' },
      },
      dir => {
        liveServeClient(dir, 'http://127.0.0.1:44927', 'http://localhost:44927/');
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'warn', JSON.stringify(c));
        assert.match(c.detail, /acp conductor \(providers\.devin-acp\)/);
      }
    ));

  test('conductor: a serve.json pointing off-loopback is not live-endpoint evidence', () =>
    withEnv(
      {
        config: {
          providers: { 'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-max' } },
        },
        bins: ['gh'],
        env: { BRO_PROVIDER_BACKEND: 'devin-acp' },
      },
      dir => {
        liveServeClient(dir, 'http://203.0.113.9:44927');
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'ok', JSON.stringify(c));
      }
    ));

  test('conductor: two acp entries claiming one bare id are both named in the warn', () =>
    withEnv(
      {
        config: {
          providers: {
            'acp-a': { type: 'acp', command: 'devin acp --model swe-2-max' },
            'acp-b': { type: 'acp', command: 'other acp --model=swe-2-max' },
          },
        },
        bins: ['gh'],
        env: { ANTHROPIC_SMALL_FAST_MODEL: 'swe-2-max' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'warn', JSON.stringify(c));
        assert.match(c.detail, /providers\.acp-a/);
        assert.match(c.detail, /providers\.acp-b/);
      }
    ));

  test('conductor: a pin prefixed by a configured non-acp provider is the client’s own route', () =>
    withEnv(
      {
        config: {
          providers: {
            'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-max' },
            openrouter: {
              type: 'api',
              baseUrl: 'https://x',
              models: { 'swe-2-max': 'openai-compat' },
            },
          },
        },
        bins: ['gh'],
        env: { ANTHROPIC_SMALL_FAST_MODEL: 'openrouter/swe-2-max' },
      },
      dir => {
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'ok', JSON.stringify(c));
      }
    ));

  test('conductor: no acp providers and no client pins → quiet ok', () =>
    withEnv(
      { config: { providers: { local: { type: 'cli', command: 'x -p' } } }, bins: ['gh'] },
      dir => {
        const c = byName(runDoctorChecks(dir), 'conductor');
        assert.equal(c.status, 'ok', JSON.stringify(c));
        assert.match(c.detail, /no acp-backed serve endpoint/);
      }
    ));

  test('config-schema: a clean config reports one ok row', () =>
    withEnv({ config: { sdd: { mode: 'gate' } }, bins: ['gh'] }, dir => {
      const rows = runDoctorChecks(dir).filter(c => c.name === 'config-schema');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, 'ok');
    }));

  test('config-schema: malformed values warn by default, fail under --strict', () =>
    withEnv(
      { config: { sdd: { mode: 'gtae' }, fleet: { maxConcurrent: '1' } }, bins: ['gh'] },
      dir => {
        const rows = runDoctorChecks(dir).filter(c => c.name === 'config-schema');
        assert.ok(rows.length > 0);
        assert.ok(
          rows.every(r => r.status === 'warn'),
          JSON.stringify(rows)
        );
        // the file+layer is named, the exact path pinpoints the bad value
        const detail = rows.map(r => r.detail).join('\n');
        assert.match(detail, /bro\.config\.json/);
        assert.match(detail, /sdd\.mode/);
        assert.match(detail, /fleet\.maxConcurrent/);
        const strict = runDoctorChecks(dir, { strict: true }).filter(
          c => c.name === 'config-schema'
        );
        assert.ok(
          strict.every(r => r.status === 'fail'),
          JSON.stringify(strict)
        );
      }
    ));

  test('config-schema: $schema is a known key, not an unknown-key warn', () =>
    withEnv(
      {
        config: {
          $schema: 'https://unpkg.com/@broject/bro/schemas/bro.config.schema.json',
          sdd: { mode: 'gate' },
        },
        bins: ['gh'],
      },
      dir => {
        const warns = runDoctorChecks(dir).filter(c => c.name === 'config' && c.status === 'warn');
        assert.ok(!warns.some(c => c.detail.includes('$schema')), JSON.stringify(warns));
      }
    ));
});
