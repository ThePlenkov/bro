/**
 * `bro doctor` — environment diagnostics. bro orchestrates gh + bd + git +
 * worktrees + spawned agents — external tools with independent failure
 * modes — and until now there was no diagnostic entrypoint when a setup
 * breaks.
 *
 *   bro doctor [--json]
 *
 * One line per probe: ✓ ok, ! warn, ✗ fail, - skipped. Exit 1 on any
 * failure; warnings pass. Probes are read-only — a broken tool reports as
 * a failing check, never as a crash.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { bdTry, gitTry, probeConfigFile } from '@broject/core'
import { loadBroConfig, pluginConfigSections } from '../plugins.ts'

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface DoctorCheck {
  name: string
  status: DoctorStatus
  detail: string
  /** remediation — only on warn/fail */
  hint?: string
}

const check = (
  name: string,
  status: DoctorStatus,
  detail: string,
  hint?: string
): DoctorCheck => ({ name, status, detail, ...(hint ? { hint } : {}) })

/** `--version` probe — the same PATH-is-the-contract lookup every bro
 *  shell-out uses. `missing` is true only on ENOENT: a binary that
 *  exists but can't spawn (EACCES) or times out is present-but-broken,
 *  and reporting it "not found" would send the user reinstalling a tool
 *  that's actually installed. */
function probeBin(name: string): {
  found: boolean
  missing?: boolean
  version?: string
  err?: string
} {
  const p = spawnSync(name, ['--version'], { // NOSONAR — PATH lookup is the contract (same as gh/bd/git)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (p.error) {
    const code = (p.error as NodeJS.ErrnoException).code
    return { found: false, missing: code === 'ENOENT', err: p.error.message }
  }
  if (p.status !== 0) {
    return { found: false, err: (p.stderr ?? '').trim() || `exit ${p.status}` }
  }
  const m = /(\d+\.\d+[\w.-]*)/.exec(`${p.stdout ?? ''} ${p.stderr ?? ''}`)
  return { found: true, version: m?.[1] }
}

/** Present-but-broken vs absent — a spawn failure is never "not found". */
function binProblem(p: { missing?: boolean; err?: string }): string {
  return p.missing === true ? 'not found' : `not usable${p.err ? ` (${p.err})` : ''}`
}

/** Repo root for dir, or null outside a worktree. */
function repoRoot(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--show-toplevel'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null
}

/** Main checkout root — mirrors loadConfig's linked-worktree config
 *  inheritance (`--git-common-dir` → `<main>/.git`). */
function mainRoot(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
  if (r.code !== 0 || r.out.trim() === '') {
    return null
  }
  const common = resolve(dir, r.out.trim())
  return basename(common) === '.git' ? dirname(common) : null
}

function isDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

// --- individual probes ------------------------------------------------------

function checkNode(): DoctorCheck {
  // the real capability gate is type stripping (bro.config.ts loads via
  // createRequire), not the version number — same probe config.ts uses
  const ts = (process.features as { typescript?: unknown }).typescript
  return ts
    ? check('node', 'ok', `v${process.versions.node}`)
    : check(
        'node',
        'warn',
        `v${process.versions.node} — no native type stripping`,
        'bro.config.ts needs Node ≥22.18 — bro.config.json still works'
      )
}

function checkGh(): DoctorCheck {
  const gh = probeBin('gh')
  if (!gh.found) {
    return check('gh', 'fail', binProblem(gh), 'install the GitHub CLI — https://cli.github.com')
  }
  const auth = spawnSync('gh', ['auth', 'status'], { // NOSONAR — PATH lookup is the contract
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 15_000,
  })
  return auth.status === 0
    ? check('gh', 'ok', `${gh.version ?? 'present'} authed`)
    : check('gh', 'fail', `${gh.version ?? 'present'} not authenticated`, 'run `gh auth login`')
}

/** Hooks replay run.sh's resolution order: local dist walking up from the
 *  plugin root → `bro` on PATH passing the `bro hooks` probe → npx
 *  fallback. Nothing resolving is a warn, not a fail — hooks fail open
 *  by design, so a broken chain degrades to silent no-ops, not errors. */
function checkHooks(dir: string): DoctorCheck {
  const envRoot =
    process.env.DEVIN_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? process.env.PLUGIN_ROOT
  let d = resolve(envRoot?.startsWith('/') ? envRoot : dir)
  for (;;) {
    const dist = join(d, 'packages', 'cli', 'dist', 'index.js')
    if (statSync(dist, { throwIfNoEntry: false })?.isFile()) {
      return check('hooks', 'ok', `resolves via local dist — ${dist}`)
    }
    const parent = dirname(d)
    if (parent === d) {
      break
    }
    d = parent
  }
  if (probeBin('bro').found) {
    const probe = spawnSync('bro', ['hooks'], { // NOSONAR — PATH lookup is the contract
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    // `bro hooks` with no event is a silent no-op — same probe run.sh runs
    if (probe.status === 0) {
      return check('hooks', 'ok', 'resolves via `bro` on PATH')
    }
  }
  if (probeBin('npx').found) {
    return check(
      'hooks',
      'warn',
      'npx @broject/bro fallback only',
      'every lifecycle event pays the npx resolution — `npm i -g @broject/bro` or the agent plugin resolves locally'
    )
  }
  return check(
    'hooks',
    'warn',
    'no resolution — lifecycle hooks silently no-op',
    'install @broject/bro or the agent plugin to get session-start context and the stop gate'
  )
}

/** Top-level keys bro knows — anything else in bro.config.json is almost
 *  certainly a typo'd section that silently no-ops. */
function knownConfigKeys(): Set<string> {
  return new Set([
    'stores',
    'store', // legacy v0.1.0
    'personality',
    'plugins',
    ...Object.keys(pluginConfigSections()),
  ])
}

/** Config-file probe: which file wins (loadConfig order — cwd .ts, cwd
 *  .json, main-root .ts, main-root .json), whether it LOADS (existence
 *  alone proves nothing — a throwing .ts silently falls back to
 *  jsonl-only), and whether the keys are known. */
function checkConfig(dirs: string[]): DoctorCheck {
  for (const dir of dirs) {
    for (const name of ['bro.config.ts', 'bro.config.json']) {
      const path = join(dir, name)
      const state = probeConfigFile(path)
      if (state === null) {
        continue
      }
      if (state === 'broken') {
        return check(
          'config',
          'fail',
          `${name} failed to load`,
          'fix or remove it — a broken config silently falls back to jsonl-only stores'
        )
      }
      if (name.endsWith('.ts')) {
        return check('config', 'ok', `${name} loads (takes precedence over .json)`)
      }
      // probe already ok'd the file — re-parse only to inspect keys
      let raw: Record<string, unknown> = {}
      try {
        raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        return check('config', 'ok', name)
      }
      const unknown = Object.keys(raw).filter((k) => !knownConfigKeys().has(k))
      return unknown.length > 0
        ? check(
            'config',
            'warn',
            `${name} — unknown keys: ${unknown.join(', ')}`,
            'unknown sections silently no-op — check for typos'
          )
        : check('config', 'ok', name)
    }
  }
  return check('config', 'ok', 'no bro.config — running on defaults')
}

export function runDoctorChecks(dir: string = process.cwd()): DoctorCheck[] {
  const checks: DoctorCheck[] = [checkNode()]

  const git = probeBin('git')
  checks.push(
    git.found
      ? check('git', 'ok', git.version ?? 'present')
      : check('git', 'fail', binProblem(git), 'every bro command shells out to git')
  )
  const root = repoRoot(dir)
  const cfg = loadBroConfig(dir)
  checks.push(
    root
      ? check('repo', 'ok', `worktree root ${root} · stores: ${cfg.stores.join(', ')}`)
      : check('repo', 'warn', 'not inside a git worktree', 'worktree/branch/sync commands need a repo')
  )

  checks.push(checkGh())

  // --- bd: presence, Dolt-era compat, store readability --------------------
  // a store is live when .beads exists at the root OR BEADS_DIR pins one
  // (the loop harness runs worktrees against a shared store that way)
  const beadsDir =
    (root !== null && isDir(join(root, '.beads'))) ||
    (typeof process.env.BEADS_DIR === 'string' &&
      process.env.BEADS_DIR !== '' &&
      isDir(process.env.BEADS_DIR))
  const beadsActive = cfg.stores.includes('beads')
  const bd = probeBin('bd')
  if (!bd.found) {
    checks.push(
      beadsActive
        ? check('bd', 'fail', binProblem(bd), 'install beads (https://github.com/gastownhall/beads) or set "stores": ["jsonl"]')
        : check('bd', 'warn', binProblem(bd), 'beads store is off — nothing needs it')
    )
  } else {
    checks.push(check('bd', 'ok', bd.version ?? 'present'))
    // `bd dolt` existing at all proves the Dolt-era backend bro's beads
    // integration assumes — an older bd fails the probe, which is the
    // version-compat signal (pre-Dolt bd can't serve the store)
    const dolt = bdTry(['dolt', 'remote', 'list'], 15_000, dir)
    checks.push(
      dolt.code === 0
        ? check('bd-backend', 'ok', 'dolt remotes reachable')
        : check('bd-backend', 'warn', '`bd dolt` failed', `bd predates the Dolt backend — upgrade beads${dolt.err ? ` (${dolt.err})` : ''}`)
    )
    if (beadsDir) {
      const list = bdTry(['list', '--json', '-n', '1'], 15_000, dir)
      checks.push(
        list.code === 0
          ? check('bd-store', 'ok', 'beads store readable')
          : check('bd-store', 'fail', 'beads store present but `bd list` failed', list.err || 'inspect the store or re-run `bd init`')
      )
    } else if (beadsActive) {
      checks.push(check('bd-store', 'ok', 'no .beads — auto-inits stealth on first use'))
    }
  }

  checks.push(checkHooks(dir))
  checks.push(
    checkConfig([dir, root, mainRoot(dir)].filter((d): d is string => d !== null))
  )

  // --- remotes: git sync.remote + the beads dolt remote --------------------
  if (root !== null) {
    const remote = gitTry(['-C', dir, 'remote', 'get-url', cfg.sync.remote])
    checks.push(
      remote.code === 0
        ? check('git-remote', 'ok', `${cfg.sync.remote} → ${remote.out.trim()}`)
        : check('git-remote', 'warn', `no "${cfg.sync.remote}" remote`, 'bro sync and beads replication stay local-only')
    )
    if (beadsDir) {
      if (!bd.found) {
        checks.push(check('dolt-remote', 'skip', 'needs bd'))
      } else {
        const remotes = bdTry(['dolt', 'remote', 'list'], 15_000, dir)
        const names = remotes.out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
        checks.push(
          remotes.code !== 0
            ? check('dolt-remote', 'skip', '`bd dolt remote list` failed')
            : names.length > 0
              ? check('dolt-remote', 'ok', names.join(', '))
              : check('dolt-remote', 'warn', 'none configured', 'beads state is local-only — `bd dolt remote add` inside .beads syncs it across machines')
        )
      }
    }
  }

  return checks
}

export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0
}

const ICONS: Record<DoctorStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' }

export function runDoctorCommand(argv: string[]): void {
  const json = argv.includes('--json')
  const checks = runDoctorChecks()
  if (json) {
    console.log(JSON.stringify({ ok: doctorExitCode(checks) === 0, checks }, null, 2))
  } else {
    for (const c of checks) {
      console.log(`${ICONS[c.status]} ${c.name.padEnd(10)} ${c.detail}`)
      if (c.hint) {
        console.log(`  ${' '.repeat(10)} → ${c.hint}`)
      }
    }
    const fails = checks.filter((c) => c.status === 'fail').length
    const warns = checks.filter((c) => c.status === 'warn').length
    console.log(
      fails === 0 && warns === 0
        ? '\nbro doctor: all checks pass'
        : `\nbro doctor: ${fails} failure(s), ${warns} warning(s)`
    )
  }
  process.exit(doctorExitCode(checks))
}
