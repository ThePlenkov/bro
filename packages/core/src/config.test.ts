import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  DEFAULT_CONFIG,
  defineConfig,
  globalConfigDir,
  loadConfig,
  loadConfigLayers,
  repoOptedIn,
} from './config.ts'

// the global layer reads $XDG_CONFIG_HOME/bro — pin it to an empty tmp
// for the whole file so a dev machine's real user config can't leak in
const XDG = mkdtempSync(join(tmpdir(), 'bro-xdg-'))
const prevXdg = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = XDG
process.on('exit', () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
})

/** Write a raw object as the global layer under a fresh XDG dir; returns
 *  a restore function. */
function withGlobalConfig(raw: unknown, name: 'config.json' | 'config.ts' = 'config.json'): () => void {
  const dir = join(XDG, 'bro')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(
    file,
    typeof raw === 'string' ? raw : JSON.stringify(raw)
  )
  return () => {
    try {
      rmSync(file)
    } catch {
      // already removed
    }
  }
}

function load(raw?: unknown): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
  if (raw !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(raw))
  }
  return loadConfig(dir)
}

describe('loadConfig stores', () => {
  test('no config file → beads on by default', () => {
    assert.deepEqual(load().stores, ['jsonl', 'beads'])
  })

  test('config without a stores key → beads on by default', () => {
    assert.deepEqual(load({ personality: 'mentor' }).stores, ['jsonl', 'beads'])
  })

  test('explicit stores: ["jsonl"] is the opt-out', () => {
    assert.deepEqual(load({ stores: ['jsonl'] }).stores, ['jsonl'])
  })

  test('explicit stores keeps jsonl first, dedupes', () => {
    assert.deepEqual(load({ stores: ['beads', 'jsonl', 'beads'] }).stores, [
      'jsonl',
      'beads',
    ])
  })

  test('unknown backend names are dropped, not fatal', () => {
    assert.deepEqual(load({ stores: ['beed'] }).stores, ['jsonl'])
  })

  test('legacy store: "jsonl" stays jsonl-only', () => {
    assert.deepEqual(load({ store: 'jsonl' }).stores, ['jsonl'])
  })

  test('legacy store: "beads"/"both" → jsonl + beads', () => {
    assert.deepEqual(load({ store: 'beads' }).stores, ['jsonl', 'beads'])
    assert.deepEqual(load({ store: 'both' }).stores, ['jsonl', 'beads'])
  })

  test('mistyped legacy store value falls back to jsonl-only', () => {
    assert.deepEqual(load({ store: 'beed' }).stores, ['jsonl'])
  })

  test('non-array stores field falls back to jsonl-only', () => {
    assert.deepEqual(load({ stores: 'bead' }).stores, ['jsonl'])
  })

  test('malformed config file falls back to jsonl-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    writeFileSync(join(dir, 'bro.config.json'), '{oops')
    assert.deepEqual(loadConfig(dir).stores, ['jsonl'])
  })

  test('stores array beats legacy store field', () => {
    assert.deepEqual(load({ store: 'beads', stores: ['jsonl'] }).stores, ['jsonl'])
  })

  test('DEFAULT_CONFIG itself is jsonl + beads', () => {
    assert.deepEqual(DEFAULT_CONFIG.stores, ['jsonl', 'beads'])
  })
})

describe('loadConfig pack', () => {
  test('absent pack → undefined, not a default leak', () => {
    assert.equal(load().pack, undefined)
  })

  test('a string pack name passes through', () => {
    assert.equal(load({ pack: '@scope/my-pack' }).pack, '@scope/my-pack')
  })

  test('non-string pack values are dropped with a warning', () => {
    for (const bad of [{ n: 1 }, ['a'], 42, '']) {
      assert.equal(load({ pack: bad }).pack, undefined, `pack ${JSON.stringify(bad)}`)
    }
  })
})

describe('loadConfig root shape', () => {
  test('non-object JSON roots fall back to jsonl-only', () => {
    for (const root of ['str', [1, 2], 42, null, true]) {
      assert.deepEqual(load(root).stores, ['jsonl'], `root ${JSON.stringify(root)}`)
    }
  })

  test('empty object is a valid config', () => {
    assert.deepEqual(load({}), DEFAULT_CONFIG)
  })

  test('nested debt config merges over defaults', () => {
    assert.equal(load({ debt: { dir: 'debt-out' } }).debt.dir, 'debt-out')
    assert.equal(load({ debt: { dir: 'debt-out' } }).personality, 'terse')
  })

  test('non-string sync fields fall back to defaults', () => {
    const cfg = load({ sync: { remote: null, ref: 'refs/bro/custom' } })
    assert.equal(cfg.sync.remote, 'origin')
    assert.equal(cfg.sync.ref, 'refs/bro/custom')
  })

  test('non-object sync section falls back to defaults', () => {
    assert.deepEqual(load({ sync: 'x' }).sync, DEFAULT_CONFIG.sync)
  })

  test('sync.beads: only a boolean counts, default on', () => {
    assert.equal(load({}).sync.beads, true)
    assert.equal(load({ sync: { beads: false } }).sync.beads, false)
    assert.equal(load({ sync: { beads: 'no' } }).sync.beads, true)
  })

  test('act.ignoreChecks normalizes strings to rules with defaults', () => {
    const cfg = load({ act: { ignoreChecks: ['kilo', 42, 'flaky-bot', '', '  '] } })
    assert.deepEqual(cfg.act.ignoreChecks, [
      { name: 'kilo', consecutiveFailures: 3, threadWindowDays: 7 },
      { name: 'flaky-bot', consecutiveFailures: 3, threadWindowDays: 7 },
    ])
  })

  test('act.ignoreChecks rule objects tune the condition', () => {
    const cfg = load({
      act: {
        ignoreChecks: [
          { name: 'kilo', consecutiveFailures: 5, threadWindowDays: 2 },
          { name: 'partial' }, // missing knobs take the defaults
          { name: '' }, // blank name is dropped
          { consecutiveFailures: 2 }, // nameless is dropped
          ['nope'], // nested junk is dropped
        ],
      },
    })
    assert.deepEqual(cfg.act.ignoreChecks, [
      { name: 'kilo', consecutiveFailures: 5, threadWindowDays: 2 },
      { name: 'partial', consecutiveFailures: 3, threadWindowDays: 7 },
    ])
  })

  test('act.ignoreChecks invalid rule fields fall back to defaults', () => {
    const cfg = load({
      act: {
        ignoreChecks: [
          { name: 'kilo', consecutiveFailures: 0, threadWindowDays: -1 },
          { name: 'x', consecutiveFailures: 'many', threadWindowDays: null },
        ],
      },
    })
    assert.deepEqual(cfg.act.ignoreChecks, [
      { name: 'kilo', consecutiveFailures: 3, threadWindowDays: 7 },
      { name: 'x', consecutiveFailures: 3, threadWindowDays: 7 },
    ])
  })

  test('non-object act section falls back to defaults', () => {
    assert.deepEqual(load({ act: 'x' }).act, DEFAULT_CONFIG.act)
  })

  test('act.maxRounds keeps only non-negative integers', () => {
    assert.equal(load({ act: { maxRounds: 5 } }).act.maxRounds, 5)
    assert.equal(load({ act: { maxRounds: 0 } }).act.maxRounds, 0)
    for (const bad of [-1, 1.5, '3', true, null]) {
      assert.equal(
        load({ act: { maxRounds: bad } }).act.maxRounds,
        DEFAULT_CONFIG.act.maxRounds
      )
    }
  })

  test('act.docsPaths keeps only non-blank strings', () => {
    const cfg = load({ act: { docsPaths: ['*.md', 42, '', '  ', 'specs/'] } })
    assert.deepEqual(cfg.act.docsPaths, ['*.md', 'specs/'])
    assert.deepEqual(load({ act: { docsPaths: 'x' } }).act.docsPaths, DEFAULT_CONFIG.act.docsPaths)
  })

  test('act.docsMaxRounds keeps only non-negative integers', () => {
    assert.equal(load({ act: { docsMaxRounds: 1 } }).act.docsMaxRounds, 1)
    assert.equal(load({ act: { docsMaxRounds: 0 } }).act.docsMaxRounds, 0)
    for (const bad of [-1, 1.5, '2', true, null]) {
      assert.equal(
        load({ act: { docsMaxRounds: bad } }).act.docsMaxRounds,
        DEFAULT_CONFIG.act.docsMaxRounds
      )
    }
  })
})

describe('loadConfig fleet', () => {
  test('no fleet section → the default cap of 3', () => {
    assert.equal(load().fleet.maxConcurrent, 3)
  })

  test('fleet.maxConcurrent keeps only non-negative integers — 0 disables', () => {
    assert.equal(load({ fleet: { maxConcurrent: 7 } }).fleet.maxConcurrent, 7)
    assert.equal(load({ fleet: { maxConcurrent: 0 } }).fleet.maxConcurrent, 0)
    for (const bad of [-1, 1.5, '4', true, null]) {
      assert.equal(
        load({ fleet: { maxConcurrent: bad } }).fleet.maxConcurrent,
        DEFAULT_CONFIG.fleet.maxConcurrent
      )
    }
  })

  test('non-object fleet section falls back to defaults', () => {
    assert.equal(load({ fleet: 'wide' }).fleet.maxConcurrent, 3)
  })

  test('fleet.profiles parses named presets; absent section → {}', () => {
    assert.deepEqual(load().fleet.profiles, {})
    const cfg = load({
      fleet: {
        profiles: {
          cheap: { provider: 'kilo', model: 'qwen3-coder', backend: 'tmux' },
          strong: { provider: 'kilo', autoApprove: true },
        },
      },
    })
    assert.deepEqual(cfg.fleet.profiles.cheap, {
      provider: 'kilo',
      model: 'qwen3-coder',
      backend: 'tmux',
    })
    assert.deepEqual(cfg.fleet.profiles.strong, { provider: 'kilo', autoApprove: true })
  })

  test('a profile with no provider drops; bad optional fields drop alone', () => {
    const cfg = load({
      fleet: {
        profiles: {
          noprov: { model: 'x' },
          badmodel: { provider: 'kilo', model: 42, autoApprove: 'yes' },
          junk: 'nope',
          ok: { provider: 'kilo' },
        },
      },
    })
    assert.equal(cfg.fleet.profiles.noprov, undefined)
    assert.equal(cfg.fleet.profiles.junk, undefined)
    assert.deepEqual(cfg.fleet.profiles.badmodel, { provider: 'kilo' })
    assert.deepEqual(cfg.fleet.profiles.ok, { provider: 'kilo' })
  })

  test('a non-object profiles map drops the whole section', () => {
    assert.deepEqual(load({ fleet: { profiles: 'x' } }).fleet.profiles, {})
    assert.deepEqual(load({ fleet: { profiles: [1] } }).fleet.profiles, {})
  })
})

function loadTs(
  source: string,
  json?: unknown,
  pkg: unknown = { type: 'module' }
): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
  writeFileSync(join(dir, 'bro.config.ts'), source)
  if (json !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(json))
  }
  // a dir with no package.json resolves .ts as CommonJS on Node ≤24 —
  // `export default` then fails to transform. Tests model real repos,
  // so the module type is always explicit (default ESM, the canonical form)
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  return loadConfig(dir)
}

describe('loadConfig bro.config.ts', () => {
  test('export default object loads', () => {
    const cfg = loadTs('export default { personality: "mentor" }')
    assert.equal(cfg.personality, 'mentor')
    assert.deepEqual(cfg.stores, ['jsonl', 'beads'])
  })

  test('module.exports object loads in a CJS repo', () => {
    const cfg = loadTs(
      'module.exports = { debt: { dir: "d" } }',
      undefined,
      { type: 'commonjs' }
    )
    assert.equal(cfg.debt.dir, 'd')
  })

  test('module.exports in an ESM repo applies or falls back cleanly', () => {
    // plain Node throws "module is not defined" → jsonl-only; tsx's CJS
    // interop applies it — either way the result must be a whole config,
    // never a half-loaded one
    const cfg = loadTs(
      'module.exports = { personality: "sarcastic" }',
      undefined,
      { type: 'module' }
    )
    assert.ok(['sarcastic', 'terse'].includes(cfg.personality))
  })

  test('.ts with import statements loads', () => {
    // require() can't take ESM syntax on every runtime — the subprocess
    // import() fallback must carry configs with real imports
    const cfg = loadTs(
      'import { join } from "node:path"\nexport default { personality: join("men", "tor") }'
    )
    assert.equal(cfg.personality, join('men', 'tor'))
  })

  test('.ts wins over .json when both exist', () => {
    const cfg = loadTs('export default { personality: "sarcastic" }', {
      personality: 'mentor',
    })
    assert.equal(cfg.personality, 'sarcastic')
  })

  test('non-Error throw falls back cleanly', () => {
    const cfg = loadTs('throw null')
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('broken .ts falls back to jsonl-only, never to .json', () => {
    const cfg = loadTs('export default {{{', { stores: ['jsonl', 'beads'] })
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('non-object .ts export falls back to jsonl-only', () => {
    const cfg = loadTs('export default 42')
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('export default null does not leak the module namespace', () => {
    const cfg = loadTs('export default null')
    assert.deepEqual(cfg.stores, ['jsonl'])
  })

  test('relative cwd resolves bro.config.ts too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-rel-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(dir, 'bro.config.ts'), 'export default { personality: "sarcastic" }')
    const rel = relative(process.cwd(), dir)
    assert.equal(loadConfig(rel).personality, 'sarcastic')
  })

  test('defineConfig is a pass-through', () => {
    assert.deepEqual(defineConfig({ personality: 'mentor', extra: 1 }), {
      personality: 'mentor',
      extra: 1,
    })
  })
})

describe('loadConfig plugin sections', () => {
  function loadWith(
    raw: unknown,
    sections: Parameters<typeof loadConfig>[1]
  ): ReturnType<typeof loadConfig> {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(raw))
    return loadConfig(dir, sections)
  }

  test('registered schema normalizes its section', () => {
    const cfg = loadWith(
      { myplug: { opt: 'x', junk: true } },
      { myplug: (r) => ({ opt: (r as { opt?: string }).opt ?? 'default' }) }
    )
    assert.equal((cfg.myplug as { opt: string }).opt, 'x')
  })

  test('missing section still gets schema defaults', () => {
    const cfg = loadWith({}, { myplug: () => ({ opt: 'default' }) })
    assert.equal((cfg.myplug as { opt: string }).opt, 'default')
  })

  test('throwing schema warns and falls back to schema(undefined)', () => {
    const cfg = loadWith(
      { myplug: { bad: true } },
      {
        myplug: (r) => {
          if (r !== undefined) throw new Error('bad section')
          return { opt: 'default' }
        },
      }
    )
    assert.equal((cfg.myplug as { opt: string }).opt, 'default')
  })

  test('no config file still resolves registered sections to defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    const cfg = loadConfig(dir, { myplug: () => ({ opt: 'default' }) })
    assert.equal((cfg.myplug as { opt: string }).opt, 'default')
  })

  test('broken config file still resolves registered sections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    writeFileSync(join(dir, 'bro.config.json'), '{not json')
    const cfg = loadConfig(dir, { myplug: () => ({ opt: 'default' }) })
    assert.deepEqual(cfg.stores, ['jsonl'])
    assert.equal((cfg.myplug as { opt: string }).opt, 'default')
  })

  test('a plugin section cannot shadow a core section', () => {
    const cfg = loadWith(
      { fleet: { maxConcurrent: 7 } },
      { fleet: () => ({ maxConcurrent: 99 }) }
    )
    assert.equal(cfg.fleet.maxConcurrent, 7)
  })

  test('non-string debt.dir falls back to the default', () => {
    assert.equal(load({ debt: { dir: 42 } }).debt.dir, DEFAULT_CONFIG.debt.dir)
    assert.equal(load({ debt: { dir: '' } }).debt.dir, DEFAULT_CONFIG.debt.dir)
    assert.equal(load({ debt: { dir: 'custom/dir' } }).debt.dir, 'custom/dir')
  })

  test('debt.sourceConfig keeps only plain-object source bags, verbatim', () => {
    assert.deepEqual(load({}).debt.sourceConfig, {})
    assert.deepEqual(load({ debt: { sourceConfig: 'junk' } }).debt.sourceConfig, {})
    // non-object bags drop; field validation is the collector's job, so
    // a bag's contents — including non-string fields — pass through
    assert.deepEqual(
      load({ debt: { sourceConfig: { sonarcloud: 'junk', other: { any: 1 } } } }).debt.sourceConfig,
      { other: { any: 1 } }
    )
    assert.deepEqual(
      load({ debt: { sourceConfig: { sonarcloud: { project_key: 'pk', host: 'https://sq', extra: 1 } } } })
        .debt.sourceConfig,
      { sonarcloud: { project_key: 'pk', host: 'https://sq', extra: 1 } }
    )
  })

  test('sweep section normalizes fields, falls back on bad values', () => {
    assert.deepEqual(load({}).sweep, DEFAULT_CONFIG.sweep)
    assert.deepEqual(load({ sweep: 'junk' }).sweep, DEFAULT_CONFIG.sweep)
    const cfg = load({ sweep: { olderThanDays: 7, dir: '.agents/vault', flatten: false } })
    assert.equal(cfg.sweep.olderThanDays, 7)
    assert.equal(cfg.sweep.dir, '.agents/vault')
    assert.equal(cfg.sweep.flatten, false)
    // zero/negative/NaN days can never be a safe threshold
    for (const bad of [0, -3, Number.NaN, '30']) {
      assert.equal(
        load({ sweep: { olderThanDays: bad } }).sweep.olderThanDays,
        DEFAULT_CONFIG.sweep.olderThanDays
      )
    }
    assert.equal(
      load({ sweep: { dir: '  ' } }).sweep.dir,
      DEFAULT_CONFIG.sweep.dir
    )
    assert.equal(
      load({ sweep: { flatten: 'yes' } }).sweep.flatten,
      DEFAULT_CONFIG.sweep.flatten
    )
  })
})

describe('loadConfig linked worktree', () => {
  /** Real git repo + linked worktree — git can't be faked for
   *  --git-common-dir, so the fixture uses the real thing. */
  function repoWithWorktree(): { main: string; wt: string } {
    // realpath — git reports the real path for --git-common-dir; on
    // symlinked tmpdirs (macOS /var→/private/var) assertions must match
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'bro-main-')))
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const wt = mkdtempSync(join(tmpdir(), 'bro-wt-'))
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qf', '--detach', wt])
    return { main, wt }
  }

  test('linked worktree inherits the main checkout config', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(
      join(main, 'bro.config.json'),
      JSON.stringify({ act: { ignoreChecks: ['kilo'] }, personality: 'mentor' })
    )
    const cfg = loadConfig(wt)
    assert.equal(cfg.personality, 'mentor')
    assert.deepEqual(cfg.act.ignoreChecks, [
      { name: 'kilo', consecutiveFailures: 3, threadWindowDays: 7 },
    ])
  })

  test('worktree-local config wins over the main checkout', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ personality: 'mentor' }))
    writeFileSync(join(wt, 'bro.config.json'), JSON.stringify({ personality: 'terse' }))
    assert.equal(loadConfig(wt).personality, 'terse')
  })

  test('broken worktree config falls back to the main checkout', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ personality: 'mentor' }))
    writeFileSync(join(wt, 'bro.config.json'), '{oops')
    assert.equal(loadConfig(wt).personality, 'mentor')
  })

  test('broken config everywhere still lands on jsonl-only', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(join(wt, 'bro.config.json'), '{oops')
    writeFileSync(join(main, 'bro.config.json'), '{oops too')
    assert.deepEqual(loadConfig(wt).stores, ['jsonl'])
  })

  test('relative plugin spec anchors at the config dir', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ plugins: ['./my-plugin.ts'] }))
    assert.deepEqual(loadConfig(wt).plugins, [join(main, 'my-plugin.ts')])
  })

  test('a relative plugin spec escaping its config dir is dropped', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(
      join(main, 'bro.config.json'),
      JSON.stringify({ plugins: ['../escape.ts', './ok.ts'] })
    )
    assert.deepEqual(loadConfig(wt).plugins, [join(main, 'ok.ts')])
  })

  test('worktree of a --separate-git-dir repo inherits the main config', () => {
    // the git dir lives outside the checkout — --git-common-dir can't
    // find the main worktree, worktree list can
    const holder = realpathSync(mkdtempSync(join(tmpdir(), 'bro-sep-')))
    const gitdir = join(holder, 'gitdir')
    const main = join(holder, 'checkout')
    execFileSync('git', ['init', '-q', '--separate-git-dir', gitdir, main])
    execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ personality: 'mentor' }))
    const wt = realpathSync(mkdtempSync(join(tmpdir(), 'bro-wt-')))
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qf', '--detach', wt])
    assert.equal(loadConfig(wt).personality, 'mentor')
  })

  test('worktree of a bare repo inherits nothing', () => {
    const main = mkdtempSync(join(tmpdir(), 'bro-main-'))
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const holder = mkdtempSync(join(tmpdir(), 'bro-bare-'))
    const bare = join(holder, 'repo.git')
    execFileSync('git', ['clone', '-q', '--bare', main, bare])
    // a config sitting next to the bare repo (the wrong fallback target)
    // must NOT leak into a worktree of it
    writeFileSync(join(holder, 'bro.config.json'), JSON.stringify({ personality: 'sarcastic' }))
    const wt = mkdtempSync(join(tmpdir(), 'bro-wt-'))
    execFileSync('git', ['-C', bare, 'worktree', 'add', '-qf', '--detach', wt])
    assert.equal(loadConfig(wt).personality, DEFAULT_CONFIG.personality)
  })
})

describe('config layers (spec bro-9vmx)', () => {
  const project = (dir: string, raw: unknown): void => {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(raw))
  }
  const local = (dir: string, raw: unknown): void => {
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify(raw))
  }

  test('local beats project beats global, per key', () => {
    const undo = withGlobalConfig({ personality: 'sarcastic', act: { maxRounds: 9 } })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
      project(dir, { personality: 'mentor' })
      local(dir, { act: { maxRounds: 1 } })
      const cfg = loadConfig(dir)
      assert.equal(cfg.personality, 'mentor') // project wins over global
      assert.equal(cfg.act.maxRounds, 1) // local wins over global
    } finally {
      undo()
    }
  })

  test('objects deep-merge — a layer fills only the keys it sets', () => {
    const undo = withGlobalConfig({ act: { ignoreChecks: ['kilo'], docsMaxRounds: 5 } })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
      project(dir, { act: { docsPaths: ['*.mdx'] } })
      const cfg = loadConfig(dir)
      assert.equal(cfg.act.ignoreChecks[0]!.name, 'kilo')
      assert.equal(cfg.act.docsMaxRounds, 5)
      assert.deepEqual(cfg.act.docsPaths, ['*.mdx'])
    } finally {
      undo()
    }
  })

  test('arrays replace, never concat', () => {
    const undo = withGlobalConfig({ debt: { sources: ['review-threads', 'stale-prs'] } })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
      local(dir, { debt: { sources: ['review-threads'] } })
      assert.deepEqual(loadConfig(dir).debt.sources, ['review-threads'])
    } finally {
      undo()
    }
  })

  test('global layer alone loads — no project file needed', () => {
    const undo = withGlobalConfig({ personality: 'sarcastic', stores: ['jsonl'] })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
      const cfg = loadConfig(dir)
      assert.equal(cfg.personality, 'sarcastic')
      assert.deepEqual(cfg.stores, ['jsonl'])
    } finally {
      undo()
    }
  })

  test('config.ts works as the global file too', () => {
    const undo = withGlobalConfig('export default { personality: "mentor" }', 'config.ts')
    try {
      assert.equal(loadConfig(mkdtempSync(join(tmpdir(), 'bro-config-'))).personality, 'mentor')
    } finally {
      undo()
    }
  })

  test('loadConfigLayers reports hits ascending precedence', () => {
    const undo = withGlobalConfig({ personality: 'sarcastic' })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
      project(dir, { sdd: { mode: 'gate' } })
      local(dir, { fleet: { maxConcurrent: 1 } })
      const { layers, broken } = loadConfigLayers(dir)
      assert.deepEqual(layers.map((l) => l.layer), ['global', 'project', 'local'])
      assert.equal(broken.length, 0)
      assert.ok(layers[1]!.file.endsWith('bro.config.json'))
      assert.ok(layers[2]!.file.endsWith('bro.config.local.json'))
    } finally {
      undo()
    }
  })

  test('a broken layer contributes nothing but a valid layer still loads', () => {
    const undo = withGlobalConfig({ personality: 'sarcastic' })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
      writeFileSync(join(dir, 'bro.config.local.json'), '{oops')
      const { layers, broken } = loadConfigLayers(dir)
      assert.equal(layers.length, 1)
      assert.equal(broken.length, 1)
      assert.equal(loadConfig(dir).personality, 'sarcastic')
    } finally {
      undo()
    }
  })

  test('every layer broken/absent + a broken file → jsonl-only stores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    writeFileSync(join(dir, 'bro.config.local.json'), '{oops')
    assert.deepEqual(loadConfig(dir).stores, ['jsonl'])
  })

  test('project-layer plugin spec anchors at the project dir; local at the local dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-config-'))
    project(dir, { plugins: ['./project-plug.ts'] })
    local(dir, { plugins: ['./local-plug.ts'] })
    // arrays replace — local wins entirely, anchored at ITS layer dir
    assert.deepEqual(loadConfig(dir).plugins, [join(dir, 'local-plug.ts')])
  })

  test('linked worktree inherits main-root local layer', () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'bro-main-')))
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ personality: 'terse' }))
    writeFileSync(join(main, 'bro.config.local.json'), JSON.stringify({ personality: 'sarcastic' }))
    const wt = mkdtempSync(join(tmpdir(), 'bro-wt-'))
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qf', '--detach', wt])
    assert.equal(loadConfig(wt).personality, 'sarcastic')
  })

  test('globalConfigDir follows XDG_CONFIG_HOME', () => {
    assert.equal(globalConfigDir(), join(XDG, 'bro'))
  })
})

describe('repoOptedIn', () => {
  test('any bro.config.* or .beads marks the repo, walking up', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bro-optin-')))
    const sub = join(dir, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    assert.equal(repoOptedIn(sub), false)
    for (const name of [
      'bro.config.json',
      'bro.config.ts',
      'bro.config.local.json',
      'bro.config.local.ts',
      '.beads',
    ]) {
      const marker = join(dir, name)
      if (name === '.beads') mkdirSync(marker)
      else writeFileSync(marker, '{}')
      assert.equal(repoOptedIn(sub), true, name)
      rmSync(marker, { recursive: true, force: true })
    }
  })

  test('a global-layer file alone does not opt the repo in', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bro-optin-')))
    writeFileSync(join(dir, 'config.json'), '{}') // global-layer name in a project dir
    assert.equal(repoOptedIn(dir), false)
  })
})
