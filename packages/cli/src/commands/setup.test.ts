import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_SCHEMA_URL } from '@broject/core'
import { readPackTree, resolvePackDir, writeConfig } from './setup.ts'
import { git, initRepo, inside, tmpDir } from './testrepo.ts'

const tmp = (p: string) => tmpDir(p)

// writeConfig resolves layers + writes under process.cwd() — each test
// chdirs into its fixture and restores, and the global layer is pinned
// at an empty XDG dir so the dev machine's config can't leak in
const prevXdg = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = tmp('bro-setup-xdg-')
process.on('exit', () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
})

function inDir(dir: string, fn: () => void): void {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    fn()
  } finally {
    process.chdir(prev)
  }
}

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
  /** The exclusion guard's verdict travels on console.error — capture it
   *  per call instead of asserting on process stderr. */
  function capturingWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = []
    const orig = console.error
    console.error = (msg: unknown) => {
      warnings.push(String(msg))
    }
    try {
      return { result: fn(), warnings }
    } finally {
      console.error = orig
    }
  }

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

  test('a root-anchored .gitignore rule does not cover a subdir write location', () => {
    // coverage is judged where the file lands — checking at the toplevel
    // would see /bro.config.local.* as covered while the subdir write
    // escapes every rule
    const { root, main } = initRepo('bro-setup-wc-', (m) =>
      writeFileSync(join(m, '.gitignore'), '/bro.config.local.*\n')
    )
    const sub = join(main, 'sub')
    mkdirSync(sub, { recursive: true })
    inside(sub, root, () =>
      withPinnedXdg(main, () => {
        writeConfig({ beads: false })
        const exclude = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')
        assert.ok(
          exclude.split('\n').includes('bro.config.local.*'),
          `root-anchored coverage must not skip the pattern: ${exclude}`
        )
        git(['check-ignore', '-q', 'sub/bro.config.local.json'], main)
      })
    )
  })

  test('an ignored-but-tracked local config still warns — rules never cover the index', () => {
    // the file is committed in the fixture seed; adding the ignore rule
    // afterwards is exactly the ignored-but-tracked mix the early-return
    // used to skip past without warning
    const { root, main } = initRepo('bro-setup-wc-', (m) =>
      writeFileSync(join(m, 'bro.config.local.json'), '{}\n')
    )
    inside(main, root, () =>
      withPinnedXdg(main, () => {
        writeFileSync(join(main, '.gitignore'), 'bro.config.local.*\n')
        const { warnings } = capturingWarnings(() => writeConfig({ beads: false }))
        assert.ok(
          warnings.some((w) => w.includes('tracked files')),
          `tracked-but-ignored must warn: ${warnings.join(' | ')}`
        )
      })
    )
  })

  test('a .gitignore negation outranking info/exclude warns instead of claiming gitignored', () => {
    const { root, main } = initRepo('bro-setup-wc-', (m) =>
      writeFileSync(join(m, '.gitignore'), 'bro.config.local.*\n!bro.config.local.json\n')
    )
    inside(main, root, () =>
      withPinnedXdg(main, () => {
        const { warnings } = capturingWarnings(() => writeConfig({ beads: false }))
        // the negation keeps the .json trackable — info/exclude can't
        // fix precedence, so the guard re-checks and says so
        assert.ok(
          warnings.some((w) => w.includes('still trackable')),
          `a negation override must warn: ${warnings.join(' | ')}`
        )
      })
    )
  })

  test('a created config carries the canonical $schema URL first', () => {
    const dir = tmp('bro-setup-')
    inDir(dir, () => {
      writeConfig({ beads: false })
      const written = readFileSync(join(dir, 'bro.config.local.json'), 'utf8')
      const parsed = JSON.parse(written) as Record<string, unknown>
      assert.equal(parsed.$schema, CONFIG_SCHEMA_URL)
      assert.equal(Object.keys(parsed)[0], '$schema')
    })
  })

  test('existing keys survive; a pinned $schema is never clobbered', () => {
    const dir = tmp('bro-setup-')
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ $schema: 'https://example.com/custom.json', stores: ['jsonl'], personality: 'terse' })
    )
    inDir(dir, () => {
      writeConfig({ beads: false })
      const parsed = JSON.parse(
        readFileSync(join(dir, 'bro.config.local.json'), 'utf8')
      ) as Record<string, unknown>
      assert.equal(parsed.$schema, 'https://example.com/custom.json')
      assert.deepEqual(parsed.stores, ['jsonl'])
      assert.equal(parsed.personality, 'terse')
    })
  })

  test('an existing file without $schema gains it on the next setup run', () => {
    const dir = tmp('bro-setup-')
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify({ stores: ['jsonl'] }))
    inDir(dir, () => {
      writeConfig({ beads: false })
      const parsed = JSON.parse(
        readFileSync(join(dir, 'bro.config.local.json'), 'utf8')
      ) as Record<string, unknown>
      assert.equal(parsed.$schema, CONFIG_SCHEMA_URL)
      assert.deepEqual(parsed.stores, ['jsonl'])
    })
  })
})
