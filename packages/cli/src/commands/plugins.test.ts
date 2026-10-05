import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  installClient,
  isBroAdapter,
  pluginRows,
  scopesOf,
  uninstallClient,
  type MutateOpts,
} from './plugins.ts'

/** tmp cwd (non-repo → local target lands under it) + tmp XDG home. */
function fixture(): { cwd: string; opts: MutateOpts; globalPath: string; localPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'bro-plugins-cwd-'))
  const xdg = mkdtempSync(join(tmpdir(), 'bro-plugins-xdg-'))
  const opts: MutateOpts = {
    dryRun: false,
    force: false,
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  }
  return {
    cwd,
    opts,
    globalPath: join(xdg, 'opencode', 'plugins', 'bro.ts'),
    localPath: join(cwd, '.opencode', 'plugins', 'bro.ts'),
  }
}

describe('scopesOf', () => {
  test('no scope flag means both', () => {
    assert.deepEqual(scopesOf(['opencode']), ['global', 'local'])
    assert.deepEqual(scopesOf(['opencode', '--global', '--local']), ['global', 'local'])
  })

  test('a single flag narrows', () => {
    assert.deepEqual(scopesOf(['opencode', '--global']), ['global'])
    assert.deepEqual(scopesOf(['--local', 'opencode']), ['local'])
  })
})

describe('isBroAdapter', () => {
  test('recognizes the shipped module (source and bundle shape)', () => {
    const src = new URL('../opencode.ts', import.meta.url)
    assert.ok(isBroAdapter(readFileSync(src, 'utf8')))
    // tsdown output: quotes collapse, identifiers survive
    assert.ok(isBroAdapter('export default {id:"bro",server:BroPlugin}\n'))
    assert.ok(!isBroAdapter('export default {id:"other",server:x}\n'))
    assert.ok(!isBroAdapter('// hand-written empty plugin\n'))
  })

  test('recognizes the kilo module', () => {
    assert.ok(isBroAdapter(readFileSync(new URL('../kilo.ts', import.meta.url), 'utf8')))
  })
})

describe('plugins install/uninstall/list', () => {
  test('install writes both scopes; a second run reports current', () => {
    const f = fixture()
    const out = installClient('opencode', ['global', 'local'], f.opts)
    assert.deepEqual(
      out.map((o) => o.action),
      ['installed', 'installed']
    )
    assert.ok(existsSync(f.globalPath))
    assert.ok(existsSync(f.localPath))
    // materialized content is the shipped adapter source verbatim
    const shipped = readFileSync(new URL('../opencode.ts', import.meta.url), 'utf8')
    assert.equal(readFileSync(f.globalPath, 'utf8'), shipped)

    const again = installClient('opencode', ['global', 'local'], f.opts)
    assert.deepEqual(
      again.map((o) => o.action),
      ['current', 'current']
    )
  })

  /** sentinel-bearing but differing content — a stale/edited adapter */
  const staleAdapter = '// older bro build\nexport default {id:"bro",server:BroPlugin}\n'

  test('install on a stale adapter reports updated; list shows stale first', () => {
    const f = fixture()
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'opencode', 'plugins'), { recursive: true })
    writeFileSync(f.globalPath, staleAdapter)
    mkdirSync(join(f.cwd, '.opencode', 'plugins'), { recursive: true })
    writeFileSync(f.localPath, staleAdapter)

    const rows = pluginRows(f.cwd, f.opts.env).filter((r) => r.client === 'opencode')
    assert.deepEqual(
      rows.map((r) => `${r.scope}:${r.state}`),
      ['global:stale', 'local:stale']
    )

    const out = installClient('opencode', ['global'], f.opts)
    assert.equal(out[0]!.action, 'updated')
    assert.equal(
      pluginRows(f.cwd, f.opts.env)
        .filter((r) => r.client === 'opencode')
        .map((r) => `${r.scope}:${r.state}`)
        .join(','),
      'global:installed,local:stale'
    )
  })

  test('--dry-run writes nothing', () => {
    const f = fixture()
    const out = installClient('opencode', ['global', 'local'], { ...f.opts, dryRun: true })
    assert.deepEqual(
      out.map((o) => o.action),
      ['would-install', 'would-install']
    )
    assert.ok(!existsSync(f.globalPath))
    assert.ok(!existsSync(f.localPath))
  })

  test('install refuses a foreign file at our slot without --force', () => {
    const f = fixture()
    mkdirSync(join(f.cwd, '.opencode', 'plugins'), { recursive: true })
    writeFileSync(f.localPath, '// user-written plugin, no bro sentinel')
    const out = installClient('opencode', ['local'], f.opts)
    assert.equal(out[0]!.action, 'refused')
    assert.equal(readFileSync(f.localPath, 'utf8'), '// user-written plugin, no bro sentinel')
    const forced = installClient('opencode', ['local'], { ...f.opts, force: true })
    assert.equal(forced[0]!.action, 'updated')
  })

  test('uninstall removes ours, skips absent, refuses foreign without --force', () => {
    const f = fixture()
    installClient('opencode', ['global'], f.opts)
    mkdirSync(join(f.cwd, '.opencode', 'plugins'), { recursive: true })
    writeFileSync(f.localPath, '// foreign plugin')
    const refused = uninstallClient('opencode', ['global', 'local'], f.opts)
    assert.deepEqual(
      refused.map((o) => o.action),
      ['removed', 'refused']
    )
    assert.ok(!existsSync(f.globalPath))
    assert.ok(existsSync(f.localPath))

    const forced = uninstallClient('opencode', ['local'], { ...f.opts, force: true })
    assert.equal(forced[0]!.action, 'removed')
    assert.ok(!existsSync(f.localPath))

    const gone = uninstallClient('opencode', ['global', 'local'], f.opts)
    assert.deepEqual(
      gone.map((o) => o.action),
      ['absent', 'absent']
    )
  })

  test('uninstall refuses a stale/edited adapter without --force', () => {
    const f = fixture()
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'opencode', 'plugins'), { recursive: true })
    writeFileSync(f.globalPath, staleAdapter)
    const out = uninstallClient('opencode', ['global'], f.opts)
    assert.equal(out[0]!.action, 'refused')
    assert.match(out[0]!.note ?? '', /stale or edited/)
    const forced = uninstallClient('opencode', ['global'], { ...f.opts, force: true })
    assert.equal(forced[0]!.action, 'removed')
  })

  test('list reflects install state per scope', () => {
    const f = fixture()
    const opencodeRows = () =>
      pluginRows(f.cwd, f.opts.env)
        .filter((r) => r.client === 'opencode')
        .map((r) => `${r.client}:${r.scope}:${r.state}`)
    assert.deepEqual(opencodeRows(), [
      'opencode:global:absent',
      'opencode:local:absent',
    ])
    installClient('opencode', ['local'], f.opts)
    assert.deepEqual(opencodeRows(), [
      'opencode:global:absent',
      'opencode:local:installed',
    ])
  })
})

/** kilo adds a manifest step on global: a file:/// entry in
 *  <XDG>/kilo/kilo.json's plugin[] next to the materialized module. */
function kiloFixture(): {
  cwd: string
  opts: MutateOpts
  globalPath: string
  localPath: string
  manifestPath: string
  manifest(): Record<string, unknown>
  entry: string
} {
  const cwd = mkdtempSync(join(tmpdir(), 'bro-plugins-kilo-cwd-'))
  const xdg = mkdtempSync(join(tmpdir(), 'bro-plugins-kilo-xdg-'))
  const opts: MutateOpts = {
    dryRun: false,
    force: false,
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  }
  const globalPath = join(xdg, 'kilo', 'bro', 'bro.ts')
  const manifestPath = join(xdg, 'kilo', 'kilo.json')
  return {
    cwd,
    opts,
    globalPath,
    localPath: join(cwd, '.kilo', 'plugin', 'bro.ts'),
    manifestPath,
    manifest: () => JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>,
    entry: pathToFileURL(globalPath).href,
  }
}

describe('plugins install/uninstall/list — kilo', () => {
  test('global install materializes the module and registers file:/// in kilo.json', () => {
    const f = kiloFixture()
    const out = installClient('kilo', ['global'], f.opts)
    assert.equal(out[0]!.action, 'installed')
    assert.match(out[0]!.note ?? '', /registered/)
    // materialized content is the shipped adapter source verbatim
    const shipped = readFileSync(new URL('../kilo.ts', import.meta.url), 'utf8')
    assert.equal(readFileSync(f.globalPath, 'utf8'), shipped)
    // a fresh manifest is created with kilo's own $schema line
    const m = f.manifest()
    assert.deepEqual(m.plugin, [f.entry])
    assert.equal(m.$schema, 'https://app.kilo.ai/config.json')
  })

  test('local install writes .kilo/plugin and touches no manifest', () => {
    const f = kiloFixture()
    const out = installClient('kilo', ['local'], f.opts)
    assert.equal(out[0]!.action, 'installed')
    assert.equal(readFileSync(f.localPath, 'utf8'), readFileSync(new URL('../kilo.ts', import.meta.url), 'utf8'))
    assert.ok(!existsSync(f.manifestPath))
  })

  test('re-install reports current once registered; dedupes the entry', () => {
    const f = kiloFixture()
    installClient('kilo', ['global'], f.opts)
    const again = installClient('kilo', ['global'], f.opts)
    assert.equal(again[0]!.action, 'current')
    assert.deepEqual(f.manifest().plugin, [f.entry])
  })

  test('a current-but-unregistered file registers and reports updated', () => {
    const f = kiloFixture()
    installClient('kilo', ['global'], f.opts)
    writeFileSync(f.manifestPath, '{}\n') // drop the registration
    const out = installClient('kilo', ['global'], f.opts)
    assert.equal(out[0]!.action, 'updated')
    assert.match(out[0]!.note ?? '', /registered/)
    assert.deepEqual(f.manifest().plugin, [f.entry])
  })

  test('registration preserves existing kilo.json fields and entries', () => {
    const f = kiloFixture()
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo'), { recursive: true })
    writeFileSync(
      f.manifestPath,
      `${JSON.stringify({ plugin: ['file:///other/plugin.ts'], permission: { bash: 'allow' } }, null, 2)}\n`
    )
    installClient('kilo', ['global'], f.opts)
    const m = f.manifest()
    assert.deepEqual(m.plugin, ['file:///other/plugin.ts', f.entry])
    assert.deepEqual(m.permission, { bash: 'allow' })
  })

  test('rewriting kilo.json preserves a restrictive file mode', () => {
    const f = kiloFixture()
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo'), { recursive: true })
    writeFileSync(f.manifestPath, '{}\n')
    chmodSync(f.manifestPath, 0o600)
    installClient('kilo', ['global'], f.opts)
    assert.equal(statSync(f.manifestPath).mode & 0o777, 0o600)
    assert.deepEqual(f.manifest().plugin, [f.entry])
  })

  test('list reports an unregistered global module as stale', () => {
    const f = kiloFixture()
    installClient('kilo', ['global'], f.opts)
    writeFileSync(f.manifestPath, '{}\n')
    const row = pluginRows(f.cwd, f.opts.env).find(
      (r) => r.client === 'kilo' && r.scope === 'global'
    )
    assert.equal(row!.state, 'stale')
    installClient('kilo', ['global'], f.opts)
    assert.equal(
      pluginRows(f.cwd, f.opts.env).find((r) => r.client === 'kilo' && r.scope === 'global')!
        .state,
      'installed'
    )
  })

  test('uninstall removes the module and the kilo.json entry', () => {
    const f = kiloFixture()
    installClient('kilo', ['global'], f.opts)
    const out = uninstallClient('kilo', ['global'], f.opts)
    assert.equal(out[0]!.action, 'removed')
    assert.ok(!existsSync(f.globalPath))
    assert.deepEqual(f.manifest().plugin, [])
  })

  test('uninstall cleans a dangling kilo.json entry when the file is absent', () => {
    const f = kiloFixture()
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'kilo'), { recursive: true })
    writeFileSync(f.manifestPath, `${JSON.stringify({ plugin: [f.entry] })}\n`)
    const out = uninstallClient('kilo', ['global'], f.opts)
    assert.equal(out[0]!.action, 'absent')
    assert.match(out[0]!.note ?? '', /dangling/)
    assert.deepEqual(f.manifest().plugin, [])
  })

  test('a refused file keeps its registration', () => {
    const f = kiloFixture()
    installClient('kilo', ['global'], f.opts)
    // a hand edit makes the adapter "stale or edited" — refuses without --force
    writeFileSync(f.globalPath, `// touched\n${readFileSync(f.globalPath, 'utf8')}`)
    const out = uninstallClient('kilo', ['global'], f.opts)
    assert.equal(out[0]!.action, 'refused')
    assert.deepEqual(f.manifest().plugin, [f.entry])
  })

  test('--dry-run writes neither module nor manifest', () => {
    const f = kiloFixture()
    const out = installClient('kilo', ['global', 'local'], { ...f.opts, dryRun: true })
    assert.deepEqual(
      out.map((o) => o.action),
      ['would-install', 'would-install']
    )
    assert.ok(!existsSync(f.globalPath))
    assert.ok(!existsSync(f.localPath))
    assert.ok(!existsSync(f.manifestPath))
  })
})
