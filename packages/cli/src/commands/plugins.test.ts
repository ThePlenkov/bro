import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
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

  test('install on a differing file reports updated; list shows stale first', () => {
    const f = fixture()
    mkdirSync(join(f.opts.env.XDG_CONFIG_HOME!, 'opencode', 'plugins'), { recursive: true })
    writeFileSync(f.globalPath, '// garbage')
    mkdirSync(join(f.cwd, '.opencode', 'plugins'), { recursive: true })
    writeFileSync(f.localPath, '// garbage')

    const rows = pluginRows(f.cwd, f.opts.env)
    assert.deepEqual(
      rows.map((r) => `${r.scope}:${r.state}`),
      ['global:stale', 'local:stale']
    )

    const out = installClient('opencode', ['global'], f.opts)
    assert.equal(out[0]!.action, 'updated')
    assert.equal(
      pluginRows(f.cwd, f.opts.env).map((r) => `${r.scope}:${r.state}`).join(','),
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

  test('list reflects install state per scope', () => {
    const f = fixture()
    assert.deepEqual(
      pluginRows(f.cwd, f.opts.env).map((r) => `${r.client}:${r.scope}:${r.state}`),
      ['opencode:global:absent', 'opencode:local:absent']
    )
    installClient('opencode', ['local'], f.opts)
    assert.deepEqual(
      pluginRows(f.cwd, f.opts.env).map((r) => `${r.client}:${r.scope}:${r.state}`),
      ['opencode:global:absent', 'opencode:local:installed']
    )
  })
})
