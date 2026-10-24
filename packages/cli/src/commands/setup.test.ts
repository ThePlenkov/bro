import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPackTree, resolvePackDir, writeConfig } from './setup.ts'
import { git, initRepo, inside, tmpDir } from './testrepo.ts'

const tmp = (p: string) => tmpDir(p)

/** A fake pack under <root>/node_modules/<spec>: package.json + trees. */
function fakePack(root: string, spec: string, withSkills = true): string {
  const dir = join(root, 'node_modules', spec)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: spec }))
  if (withSkills) {
    mkdirSync(join(dir, 'skills/demo'), { recursive: true })
    writeFileSync(join(dir, 'skills/demo/SKILL.md'), '# demo')
  }
  mkdirSync(join(dir, 'formulas'), { recursive: true })
  writeFileSync(join(dir, 'formulas/f.toml'), 'formula = "f"')
  return dir
}

describe('resolvePackDir', () => {
  test('a project-local pack wins — resolved from cwd node_modules', () => {
    const cwd = tmp('bro-pack-cwd-')
    const dir = fakePack(cwd, '@scope/my-pack')
    assert.equal(resolvePackDir('@scope/my-pack', cwd), dir)
  })

  test('unresolvable spec returns null, not a throw', () => {
    assert.equal(resolvePackDir('@broject/no-such-pack', tmp('bro-pack-x-')), null)
  })

  test('falls back to the CLI tree — the workspace default pack resolves', () => {
    // the workspace pack is always present where these tests run — a
    // null here is a real regression in fallback resolution, not a skip
    const dir = resolvePackDir('@broject/bro-pack', tmp('bro-pack-self-'))
    assert.ok(dir?.endsWith(join('packages', 'pack')), `resolved ${dir}`)
  })
})

describe('readPackTree', () => {
  test('reads nested files into a flat relpath map', () => {
    const root = tmp('bro-pack-tree-')
    mkdirSync(join(root, 'a/b'), { recursive: true })
    writeFileSync(join(root, 'a/b/x.md'), 'x')
    writeFileSync(join(root, 'y.md'), 'y')
    assert.deepEqual(readPackTree(root), { 'a/b/x.md': 'x', 'y.md': 'y' })
  })
})

describe('writeConfig', () => {
  /** The global layer must not leak the dev machine's real user config
   *  into the fixture — pin XDG to a dir that stays empty. */
  function withPinnedXdg<T>(dir: string, fn: () => T): T {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg')
    try {
      return fn()
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = prev
      }
    }
  }

  test('writes bro.config.local.json — git-excluded, never the committed file', () => {
    const { root, main } = initRepo('bro-setup-wc-')
    inside(main, root, () =>
      withPinnedXdg(main, () => {
        const msg = writeConfig({ beads: false })
        assert.match(msg, /wrote bro\.config\.local\.json/)
        assert.ok(
          existsSync(join(main, 'bro.config.local.json')),
          'the local-layer file is what lands'
        )
        assert.ok(
          !existsSync(join(main, 'bro.config.json')),
          'the committed project file is never created'
        )
        // exclusion: the written name is check-ignore clean and the cover
        // is .git/info/exclude — machine-local, never a repo diff
        git(['check-ignore', '-q', 'bro.config.local.json'], main)
        const exclude = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')
        assert.ok(
          exclude.split('\n').includes('bro.config.local.*'),
          `info/exclude missing the pattern: ${exclude}`
        )
      })
    )
  })

  test('a committed bro.config.json survives byte-for-byte; only local keys land locally', () => {
    const policy = `${JSON.stringify({ stores: ['jsonl'], sdd: { mode: 'gate' } }, null, 2)}\n`
    const { root, main } = initRepo('bro-setup-wc-', (m) =>
      writeFileSync(join(m, 'bro.config.json'), policy)
    )
    inside(main, root, () =>
      withPinnedXdg(main, () => {
        writeConfig({ beads: true })
        assert.equal(readFileSync(join(main, 'bro.config.json'), 'utf8'), policy)
        const local = JSON.parse(readFileSync(join(main, 'bro.config.local.json'), 'utf8')) as Record<
          string,
          unknown
        >
        assert.deepEqual(local.stores, ['jsonl', 'beads'])
        assert.equal(local.sdd, undefined, 'project policy must not be pinned into the local layer')
      })
    )
  })

  test('a .gitignore already covering the pattern gets no duplicate info/exclude entry', () => {
    const { root, main } = initRepo('bro-setup-wc-', (m) =>
      writeFileSync(join(m, '.gitignore'), 'bro.config.local.*\n')
    )
    inside(main, root, () =>
      withPinnedXdg(main, () => {
        writeConfig({ beads: false })
        const path = join(main, '.git', 'info', 'exclude')
        const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
        assert.ok(
          !content.split('\n').includes('bro.config.local.*'),
          `already-covered pattern must not be re-appended: ${content}`
        )
      })
    )
  })

  test('a pre-existing info/exclude survives — the lock never eats repo data', () => {
    const { root, main } = initRepo('bro-setup-wc-')
    inside(main, root, () =>
      withPinnedXdg(main, () => {
        const path = join(main, '.git', 'info', 'exclude')
        writeFileSync(path, '.env.local\n*.pem\n')
        writeConfig({ beads: false })
        const after = readFileSync(path, 'utf8')
        assert.ok(
          after.includes('.env.local') && after.includes('*.pem'),
          `existing exclude rules must survive the append: ${after}`
        )
        assert.ok(after.split('\n').includes('bro.config.local.*'))
        // the lock is a sibling file — the exclude must never carry a
        // lock token, and no capture/staging leftovers may linger
        assert.ok(
          !/\d+:[0-9a-f]{16}/.test(after),
          `lock token leaked into the exclude file: ${after}`
        )
        assert.ok(!existsSync(`${path}.lock`))
      })
    )
  })

  test('run from a subdir — the exclude lands on the repo gitdir, nothing escapes', () => {
    const { root, main } = initRepo('bro-setup-wc-')
    const sub = join(main, 'sub')
    mkdirSync(sub, { recursive: true })
    inside(sub, root, () =>
      withPinnedXdg(main, () => {
        writeConfig({ beads: false })
        const exclude = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')
        assert.ok(
          exclude.split('\n').includes('bro.config.local.*'),
          `exclude entry must land on the repo gitdir: ${exclude}`
        )
        // --git-path answers relative to its -C dir — the pre-fix code
        // ran it from cwd and joined to the toplevel, so a ../ answer
        // wrote an exclude file outside the repository
        assert.ok(
          !existsSync(join(root, '.git', 'info', 'exclude')),
          'a stray exclude must not be created outside the repo'
        )
        git(['check-ignore', '-q', 'sub/bro.config.local.json'], main)
      })
    )
  })

  test('a repo ignoring only the .json still gains the pattern for the .ts override', () => {
    const { root, main } = initRepo('bro-setup-wc-', (m) =>
      writeFileSync(join(m, '.gitignore'), 'bro.config.local.json\n')
    )
    inside(main, root, () =>
      withPinnedXdg(main, () => {
        writeConfig({ beads: false })
        const exclude = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')
        assert.ok(
          exclude.split('\n').includes('bro.config.local.*'),
          `partial coverage must not skip the pattern: ${exclude}`
        )
      })
    )
  })
})
