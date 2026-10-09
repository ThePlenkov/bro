import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorExitCode, runDoctorChecks, type DoctorCheck } from './doctor.ts'

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
`
const GH_SHIM = `#!/bin/sh
case "$1" in
  --version) echo 'gh version 2.80.0 (fake)' ;;
  auth) exit \${FAKE_GH_AUTH:-0} ;;
  *) exit 1 ;;
esac
`
const FAIL_SHIM = '#!/bin/sh\nexit 1\n'
const BRO_SHIM = '#!/bin/sh\n[ "$1" = "--version" ] && { echo "0.2.3"; exit 0; }\nexit 0\n'

interface EnvOpts {
  /** object → JSON.stringify'd; string → written verbatim (invalid JSON tests) */
  config?: object | string
  /** written verbatim as bro.config.ts */
  configTs?: string
  /** object → bro.config.local.json (gitignored local layer) */
  configLocal?: object
  /** object → $XDG_CONFIG_HOME/bro/config.json (global user layer) */
  configGlobal?: object
  beadsDir?: boolean
  /** true → a placeholder origin; a string → used verbatim as the origin url */
  remote?: boolean | string
  /** shims to drop into bin/ — absent name = binary missing from PATH */
  bins?: Array<'bd' | 'gh' | 'bro' | 'npx'>
  env?: Record<string, string>
}

function withEnv(opts: EnvOpts, fn: (dir: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-doctor-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  symlinkSync(realGit, join(bin, 'git'))
  const shims: Record<string, string> = { bd: BD_SHIM, gh: GH_SHIM, bro: BRO_SHIM, npx: FAIL_SHIM }
  for (const name of opts.bins ?? []) {
    const path = join(bin, name)
    writeFileSync(path, shims[name]!)
    chmodSync(path, 0o755)
  }
  execFileSync('git', ['init', '-q', dir])
  if (opts.remote) {
    const url = typeof opts.remote === 'string' ? opts.remote : 'https://example.com/x.git'
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url])
  }
  if (opts.beadsDir) {
    mkdirSync(join(dir, '.beads'))
  }
  if (opts.config !== undefined) {
    writeFileSync(
      join(dir, 'bro.config.json'),
      typeof opts.config === 'string' ? opts.config : JSON.stringify(opts.config)
    )
  }
  if (opts.configTs !== undefined) {
    writeFileSync(join(dir, 'bro.config.ts'), opts.configTs)
  }
  if (opts.configLocal !== undefined) {
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify(opts.configLocal))
  }
  if (opts.configGlobal !== undefined) {
    const gdir = join(dir, 'xdg', 'bro')
    mkdirSync(gdir, { recursive: true })
    writeFileSync(join(gdir, 'config.json'), JSON.stringify(opts.configGlobal))
  }
  const prevPath = process.env.PATH
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  // the global config layer (~/.config/bro or $XDG_CONFIG_HOME/bro) must
  // not leak the dev machine's real user config into probes
  saved.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(dir, 'xdg')
  for (const k of ['DEVIN_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'BEADS_DIR']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  const run = async (): Promise<void> => {
    process.env.PATH = bin
    await fn(dir)
  }
  return run().finally(() => {
    process.env.PATH = prevPath
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })
}

const byName = (checks: DoctorCheck[], name: string): DoctorCheck =>
  checks.find((c) => c.name === name)!

describe('bro doctor', () => {
  test('healthy env — every probe ok, exit 0', () =>
    withEnv(
      {
        config: { stores: ['jsonl', 'beads'] },
        beadsDir: true,
        remote: true,
        bins: ['bd', 'gh', 'bro'],
        env: { FAKE_BD_DOLT: 'origin\tgit+https://example.com/x.git\n' },
      },
      (dir) => {
        const checks = runDoctorChecks(dir)
        for (const name of [
          'node', 'git', 'repo', 'gh', 'bd', 'bd-compat', 'bd-backend', 'bd-store',
          'hooks', 'config', 'git-remote', 'dolt-remote',
        ]) {
          assert.equal(byName(checks, name)?.status, 'ok', `${name}: ${JSON.stringify(byName(checks, name))}`)
        }
        assert.equal(doctorExitCode(checks), 0)
      }
    ))

  test('missing bd fails when beads is an active store', () =>
    withEnv({ config: {}, beadsDir: true, bins: ['gh'] }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(byName(checks, 'bd').status, 'fail')
      assert.equal(byName(checks, 'dolt-remote').status, 'skip')
      assert.equal(doctorExitCode(checks), 1)
    }))

  test('missing bd only warns under jsonl-only stores', () =>
    withEnv({ config: { stores: ['jsonl'] }, bins: ['gh', 'bro'] }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(byName(checks, 'bd').status, 'warn')
      assert.equal(doctorExitCode(checks), 0)
    }))

  test('tasks row names the serving backend — beads by default', () =>
    withEnv({ config: { stores: ['jsonl', 'beads'] }, beadsDir: true, remote: true, bins: ['bd', 'gh', 'bro'] }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'tasks')
      assert.equal(c.status, 'ok')
      assert.match(c.detail, /^beads/)
    }))

  test('tasks row mirrors bd health when beads serves', () =>
    withEnv({ config: { stores: ['jsonl', 'beads'] }, beadsDir: true, bins: ['gh', 'bro'] }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'tasks')
      assert.equal(c.status, 'fail')
      assert.match(c.detail, /beads.*bd/)
    }))

  test('connectors.tasks=github makes the tasks row healthy without bd', () =>
    withEnv(
      {
        config: { stores: ['jsonl'], connectors: { tasks: 'github' } },
        remote: 'git@github.com:acme/widgets.git',
        bins: ['gh', 'bro'],
      },
      (dir) => {
        // githubConnector is registered by ../plugins.ts (doctor.ts
        // imports it) — the pin resolves through the real registry
        const checks = runDoctorChecks(dir)
        const tasks = byName(checks, 'tasks')
        assert.equal(tasks.status, 'ok', JSON.stringify(tasks))
        assert.match(tasks.detail, /github.*connectors\.tasks=github/)
        // and the absence of bd never gates the run
        assert.equal(byName(checks, 'bd').status, 'warn')
        assert.equal(doctorExitCode(checks), 0)
      }
    ))

  test('gh present but unauthenticated fails', () =>
    withEnv({ bins: ['gh'], env: { FAKE_GH_AUTH: '1' } }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(byName(checks, 'gh').status, 'fail')
      assert.match(byName(checks, 'gh').hint ?? '', /gh auth login/)
      assert.equal(doctorExitCode(checks), 1)
    }))

  test('gh missing entirely fails', () =>
    withEnv({ bins: [] }, (dir) => {
      assert.equal(byName(runDoctorChecks(dir), 'gh').status, 'fail')
    }))

  test('present-but-broken binary says "not usable", never "not found"', () =>
    withEnv({ bins: [] }, (dir) => {
      // gh exists on PATH but isn't executable — EACCES, not ENOENT
      writeFileSync(join(dir, 'bin', 'gh'), FAIL_SHIM)
      const c = byName(runDoctorChecks(dir), 'gh')
      assert.equal(c.status, 'fail')
      assert.match(c.detail, /not usable/)
      assert.doesNotMatch(c.detail, /not found/)
    }))

  test('invalid bro.config.json fails the config check', () =>
    withEnv({ config: '{ not json', bins: [] }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(byName(checks, 'config').status, 'fail')
      assert.equal(doctorExitCode(checks), 1)
    }))

  test('a throwing bro.config.ts fails — loadable, not just present', () =>
    withEnv({ configTs: 'throw new Error("boom")\n', bins: ['gh'] }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(byName(checks, 'config').status, 'fail')
      assert.equal(doctorExitCode(checks), 1)
    }))

  test('unknown config keys warn — typoed sections silently no-op', () =>
    withEnv({ config: { stores: ['jsonl'], sdd2: { mode: 'gate' } }, bins: ['gh'] }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'config')
      assert.equal(c.status, 'warn')
      assert.match(c.detail, /sdd2/)
    }))

  test('config layers: provenance names the winning layer per section', () =>
    withEnv(
      {
        config: { stores: ['jsonl'], sdd: { mode: 'gate' } },
        configLocal: { fleet: { maxConcurrent: 1 } },
        configGlobal: { providers: { p: { type: 'cli', command: 'x' } } },
        bins: ['gh'],
      },
      (dir) => {
        const rows = runDoctorChecks(dir).filter((c) => c.name === 'config')
        assert.ok(
          rows.some((c) => /project bro\.config\.json/.test(c.detail) && /local bro\.config\.local\.json/.test(c.detail)),
          JSON.stringify(rows)
        )
        const prov = rows.find((c) => c.detail.startsWith('sections:'))
        assert.ok(prov, JSON.stringify(rows))
        assert.match(prov.detail, /sdd←project/)
        assert.match(prov.detail, /fleet←local/)
        assert.match(prov.detail, /providers←global/)
        assert.equal(doctorExitCode(runDoctorChecks(dir)), 0)
      }
    ))

  test('operator sections in the committed file warn — they leak to every clone', () =>
    withEnv({ config: { providers: { p: { type: 'cli', command: 'x' } } }, bins: ['gh'] }, (dir) => {
      const rows = runDoctorChecks(dir).filter((c) => c.name === 'config' && c.status === 'warn')
      assert.ok(rows.some((c) => /operator sections in committed config: providers/.test(c.detail)), JSON.stringify(rows))
    }))

  test('policy sections in the global file warn — they hit every project', () =>
    withEnv({ configGlobal: { sdd: { mode: 'gate' } }, bins: ['gh'] }, (dir) => {
      const rows = runDoctorChecks(dir).filter((c) => c.name === 'config' && c.status === 'warn')
      assert.ok(rows.some((c) => /policy sections in global config: sdd/.test(c.detail)), JSON.stringify(rows))
    }))

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
      (dir) => {
        const c = byName(runDoctorChecks(dir), 'config')
        assert.equal(c.status, 'ok')
        assert.doesNotMatch(c.detail, /unknown keys/)
      }
    ))

  test('drifted bd output shape fails when beads is an active store', () =>
    withEnv(
      { config: { stores: ['jsonl', 'beads'] }, beadsDir: true, bins: ['bd', 'gh'], env: { FAKE_BD_DRIFT: '1' } },
      (dir) => {
        const c = byName(runDoctorChecks(dir), 'bd-compat')
        assert.equal(c.status, 'fail')
        assert.match(c.detail, /expected an array/)
        assert.equal(doctorExitCode(runDoctorChecks(dir)), 1)
      }
    ))

  test('drifted bd only warns under jsonl-only stores', () =>
    withEnv({ config: { stores: ['jsonl'] }, bins: ['bd', 'gh'], env: { FAKE_BD_FLAG_DRIFT: '1' } }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'bd-compat')
      assert.equal(c.status, 'warn')
      assert.match(c.detail, /unknown flag/)
      assert.equal(doctorExitCode(runDoctorChecks(dir)), 0)
    }))

  test('bd store schema newer than bro knows warns/fails via compat', () =>
    withEnv({ config: { stores: ['jsonl'] }, bins: ['bd', 'gh'], env: { FAKE_BD_SCHEMA: '2' } }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'bd-compat')
      assert.equal(c.status, 'warn')
      assert.match(c.detail, /schema_version 2/)
    }))

  test('no store — compat is unproven but ok', () =>
    withEnv({ config: { stores: ['jsonl', 'beads'] }, bins: ['bd', 'gh'], env: { FAKE_BD_LIST_FAIL: '1' } }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'bd-compat')
      assert.equal(c.status, 'ok')
      assert.match(c.detail, /unproven/)
    }))

  test('pre-Dolt bd — backend warns, store probe skips', () =>
    withEnv(
      { beadsDir: true, remote: true, bins: ['bd', 'gh'], env: { FAKE_BD_DOLT_FAIL: '1' } },
      (dir) => {
        const checks = runDoctorChecks(dir)
        assert.equal(byName(checks, 'bd-backend').status, 'warn')
        assert.equal(byName(checks, 'dolt-remote').status, 'skip')
      }
    ))

  test('.beads without a dolt remote warns — state stays local-only', () =>
    withEnv({ beadsDir: true, remote: true, bins: ['bd', 'gh'], env: { FAKE_BD_DOLT: '' } }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(byName(checks, 'dolt-remote').status, 'warn')
    }))

  test('.beads present but unreadable fails the store probe', () =>
    withEnv({ beadsDir: true, bins: ['bd', 'gh'], env: { FAKE_BD_LIST_FAIL: '1' } }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(byName(checks, 'bd-store').status, 'fail')
      assert.equal(doctorExitCode(checks), 1)
    }))

  test('hooks: no bro, no npx → warn "no resolution"; bro on PATH → ok', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      const c = byName(runDoctorChecks(dir), 'hooks')
      assert.equal(c.status, 'warn')
      assert.match(c.detail, /no resolution/)
    }).then(() =>
      withEnv({ bins: ['gh', 'bro'] }, (dir) => {
        const c = byName(runDoctorChecks(dir), 'hooks')
        assert.equal(c.status, 'ok')
        assert.match(c.detail, /PATH/)
      })
    ))

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
      (dir) => {
        const c = byName(runDoctorChecks(dir), 'providers')
        assert.equal(c.status, 'ok')
        assert.match(c.detail, /orca \(api, qwen3-coder\)/)
        assert.match(c.detail, /local \(cli\)/)
      }
    ))

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
      (dir) => {
        const rows = runDoctorChecks(dir).filter((c) => c.name === 'providers')
        const warn = rows.find((c) => c.status === 'warn')
        assert.ok(warn, JSON.stringify(rows))
        assert.match(warn.detail, /providers\.orca\.apiKeyEnv/)
        // an all-caps pasted key passes isEnvName — the value is never echoed
        assert.doesNotMatch(warn.detail, /ORCA_UNSET_KEY/)
      }
    ))

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
      (dir) => {
        const rows = runDoctorChecks(dir).filter(
          (c) => c.name === 'providers' && c.status === 'ok'
        )
        assert.ok(rows.some((c) => /auth env set/.test(c.detail)))
      }
    ))

  test('providers: consumer refs to missing entries warn — even with an empty registry', () =>
    withEnv(
      {
        config: {
          judge: { provider: 'ghost' },
          agents: { native: { provider: 'also-ghost' } },
        },
        bins: ['gh'],
      },
      (dir) => {
        const rows = runDoctorChecks(dir).filter((c) => c.name === 'providers')
        assert.match(rows[0]!.detail, /none configured/)
        const warns = rows.filter((c) => c.status === 'warn')
        assert.ok(warns.some((c) => c.detail.includes("judge.provider names 'ghost'")))
        assert.ok(warns.some((c) => c.detail.includes("agents.native.provider names 'also-ghost'")))
      }
    ))

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
      (dir) => {
        const rows = runDoctorChecks(dir).filter((c) => c.name === 'providers')
        const warn = rows.find((c) => c.status === 'warn')
        assert.ok(warn, JSON.stringify(rows))
        assert.ok(
          warn.detail.includes('agents.native.provider') && warn.detail.includes('no spawn surface'),
          warn.detail
        )
      }
    ))

  test('providers: judge.provider resolving a synthesized alias does not warn', () =>
    withEnv({ config: { judge: { provider: 'systemone' } }, bins: ['gh'] }, (dir) => {
      const rows = runDoctorChecks(dir).filter((c) => c.name === 'providers')
      assert.ok(!rows.some((c) => c.status === 'warn'), JSON.stringify(rows))
    }))

  test('not a git repo — repo warns, remote probes are skipped', () =>
    withEnv({ bins: ['gh'] }, (dir) => {
      const bare = mkdtempSync(join(tmpdir(), 'bro-doctor-bare-'))
      try {
        const checks = runDoctorChecks(bare)
        assert.equal(byName(checks, 'repo').status, 'warn')
        assert.equal(byName(checks, 'git-remote'), undefined)
      } finally {
        rmSync(bare, { recursive: true, force: true })
      }
    }))

  test('mesh rows: absent when unconfigured; census + dolt probe when peers exist', async () => {
    // no mesh section at all — the group stays silent
    await withEnv({ remote: true, bins: ['gh', 'bd'] }, (dir) => {
      const checks = runDoctorChecks(dir)
      assert.equal(checks.find((c) => c.name === 'mesh'), undefined)
      assert.equal(checks.find((c) => c.name === 'mesh-peers'), undefined)
    })
    // configured peers: rig derived from origin, census counts
    // transports, dolt missing (PATH is shims only) → warn
    await withEnv(
      {
        remote: 'https://github.com/acme/widgets.git',
        bins: ['gh', 'bd'],
        config: {
          mesh: {
            peers: {
              rigb: { rig: 'mesh://acme/rigb', remote: 'https://github.com/acme/rigb.git' },
              local: { rig: 'mesh://acme/local', remote: '/nonexistent' },
            },
          },
        },
      },
      (dir) => {
        const checks = runDoctorChecks(dir)
        assert.equal(byName(checks, 'mesh').status, 'ok')
        assert.match(byName(checks, 'mesh-peers').detail ?? '', /2 peer\(s\), 2 beads-remote/)
        assert.equal(byName(checks, 'mesh-dolt').status, 'warn')
      }
    )
    // peers configured but no rig pin and no origin → unaddressable warn
    await withEnv(
      {
        bins: ['gh', 'bd'],
        config: { mesh: { peers: { rigb: { rig: 'mesh://acme/rigb', remote: 'https://github.com/acme/rigb.git' } } } },
      },
      (dir) => {
        const checks = runDoctorChecks(dir)
        assert.equal(byName(checks, 'mesh').status, 'warn')
      }
    )
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
      (dir) => {
        assert.equal(byName(runDoctorChecks(dir), 'mesh-peers').status, 'warn')
      }
    )
  })
})
