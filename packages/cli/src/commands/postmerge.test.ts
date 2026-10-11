/** post-merge freshness unit tests — the install-before-build ordering
 *  is the bead: a dep-manifest move in the merged range must refresh
 *  node_modules BEFORE the build slot runs, and a failed step must
 *  never advance the done-sha (bro-sovl3). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { worktreeGitDir } from '@broject/core'
import {
  DEP_MANIFEST,
  depsChanged,
  emitPostMerge,
  freshnessSection,
  resolveSteps,
  runPostMergeRefresh,
} from './postmerge.ts'
import { git, initRepo, inside } from './testrepo.ts'

/** A bare package.json repo, npm-flavored (no foreign lockfile). */
const nodeRepo = (prefix: string, buildScript = true) =>
  initRepo(prefix, (main) => {
    writeFileSync(
      join(main, 'package.json'),
      JSON.stringify({ name: 'x', ...(buildScript ? { scripts: { build: 'tsc' } } : {}) })
    )
    mkdirSync(join(main, 'node_modules'))
  })

/** Config isolation — loadConfig consults the operator's global layer;
 *  a real ~/.config/bro with a freshness section would leak into the
 *  worker's resolved steps. */
function isolatedConfig<T>(fn: () => T): T {
  const keep = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
  const empty = mkdtempSync(join(tmpdir(), 'bro-pm-cfg-'))
  process.env.XDG_CONFIG_HOME = empty
  process.env.XDG_DATA_HOME = empty
  try {
    return fn()
  } finally {
    process.env.XDG_CONFIG_HOME = keep.XDG_CONFIG_HOME
    process.env.XDG_DATA_HOME = keep.XDG_DATA_HOME
    rmSync(empty, { recursive: true, force: true })
  }
}

describe('freshnessSection', () => {
  test('absent fields stay auto; strings/false are kept, junk dropped', () => {
    assert.deepEqual(freshnessSection(undefined), {
      install: undefined,
      build: undefined,
      patch: undefined,
    })
    assert.deepEqual(
      freshnessSection({ install: ' pnpm i ', build: false, patch: 'x.sh', junk: 1 }),
      { install: 'pnpm i', build: false, patch: 'x.sh' }
    )
    assert.deepEqual(freshnessSection({ install: 42, build: '', patch: null }), {
      install: undefined,
      build: undefined,
      patch: undefined,
    })
  })
})

describe('DEP_MANIFEST', () => {
  test('matches dep manifests at any depth, nothing else', () => {
    for (const hit of [
      'package.json',
      'package-lock.json',
      'packages/cli/package.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
    ]) {
      assert.ok(DEP_MANIFEST.test(hit), hit)
    }
    for (const miss of [
      'src/package.json.ts',
      'my-package.json',
      'docs/packages.md',
      'package.json.bak',
    ]) {
      assert.ok(!DEP_MANIFEST.test(miss), miss)
    }
  })
})

describe('depsChanged', () => {
  test('true when the range touched a manifest, false otherwise', () => {
    const { root, main } = nodeRepo('bro-pm-diff-')
    inside(main, root, () => {
      const a = git(['rev-parse', 'HEAD'], main).trim()
      writeFileSync(join(main, 'src.ts'), 'x')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'src'], main)
      const b = git(['rev-parse', 'HEAD'], main).trim()
      assert.equal(depsChanged(main, a, b), false)
      writeFileSync(join(main, 'package.json'), '{}')
      git(['commit', '-qam', 'dep'], main)
      const c = git(['rev-parse', 'HEAD'], main).trim()
      assert.equal(depsChanged(main, b, c), true)
      assert.equal(depsChanged(main, a, c), true)
    })
  })

  test('an unresolvable base reads as changed (never skips)', () => {
    const { root, main } = nodeRepo('bro-pm-diff-')
    inside(main, root, () => {
      assert.equal(depsChanged(main, 'deadbeef'.repeat(5), 'HEAD'), true)
    })
  })
})

describe('worktreeGitDir', () => {
  test('the main checkout resolves its own .git; a linked worktree its own gitdir', () => {
    const { root, main } = nodeRepo('bro-pm-gd-')
    inside(main, root, () => {
      assert.equal(worktreeGitDir(main), join(main, '.git'))
      git(['worktree', 'add', '-q', join(root, 'wt2'), '-b', 'wt2'], main)
      const gd = worktreeGitDir(join(root, 'wt2'))
      assert.ok(gd !== null && gd.includes('worktrees'), gd ?? 'null gitdir')
    })
  })
})

describe('resolveSteps', () => {
  test('auto: install only when manifests moved, build when scripts.build exists', () => {
    const { root, main } = nodeRepo('bro-pm-steps-')
    inside(main, root, () =>
      isolatedConfig(() => {
        assert.deepEqual(resolveSteps(main, {}, true), [
          'npm install --no-audit --no-fund',
          'npm run build',
        ])
        assert.deepEqual(resolveSteps(main, {}, false), ['npm run build'])
      })
    )
  })

  test('no build script → no build step; config string/false wins', () => {
    const { root, main } = nodeRepo('bro-pm-steps-', false)
    inside(main, root, () =>
      isolatedConfig(() => {
        assert.deepEqual(resolveSteps(main, {}, true), ['npm install --no-audit --no-fund'])
        assert.deepEqual(resolveSteps(main, { install: false, build: 'make dist' }, true), [
          'make dist',
        ])
      })
    )
  })

  test('lockfile picks the package manager', () => {
    const { root, main } = nodeRepo('bro-pm-steps-')
    inside(main, root, () =>
      isolatedConfig(() => {
        writeFileSync(join(main, 'pnpm-lock.yaml'), '')
        assert.deepEqual(resolveSteps(main, {}, true), ['pnpm install', 'pnpm run build'])
      })
    )
  })

  test('the conventional hotpatch must be executable — chmod -x skips it', () => {
    const { root, main } = nodeRepo('bro-pm-steps-')
    inside(main, root, () =>
      isolatedConfig(() => {
        const slot = join(process.env.XDG_DATA_HOME ?? '', 'bro', 'hotpatch.sh')
        mkdirSync(join(slot, '..'), { recursive: true })
        writeFileSync(slot, 'echo hi')
        chmodSync(slot, 0o644) // exists but not executable → no patch step
        assert.deepEqual(resolveSteps(main, {}, false), ['npm run build'])
        chmodSync(slot, 0o755)
        assert.deepEqual(resolveSteps(main, {}, false), ['npm run build', `bash '${slot}'`])
      })
    )
  })
})

describe('emitPostMerge', () => {
  test('spawns the worker only in a node tree with node_modules', () => {
    const { root, main } = nodeRepo('bro-pm-emit-')
    inside(main, root, () => {
      let spawned = 0
      emitPostMerge(main, () => {
        spawned += 1
      })
      assert.equal(spawned, 1)
      assert.ok(existsSync(join(main, '.git', 'bro', 'post-merge.log')))

      rmSync(join(main, 'node_modules'), { recursive: true, force: true })
      emitPostMerge(main, () => {
        spawned += 1
      })
      assert.equal(spawned, 1) // fresh worktrees bootstrap first — skipped

      rmSync(join(main, 'package.json'))
      mkdirSync(join(main, 'node_modules'))
      emitPostMerge(main, () => {
        spawned += 1
      })
      assert.equal(spawned, 1) // non-node tree — skipped
    })
  })
})

describe('runPostMergeRefresh', () => {
  const head = (dir: string): string => git(['rev-parse', 'HEAD'], dir).trim()
  const doneSha = (dir: string): string =>
    readFileSync(join(dir, '.git', 'bro', 'post-merge.done'), 'utf8').trim()

  test('first run installs then builds; done-sha recorded; second run no-ops', () => {
    const { root, main } = nodeRepo('bro-pm-run-')
    inside(main, root, () =>
      isolatedConfig(() => {
        const ran: string[] = []
        runPostMergeRefresh(main, (cmd) => {
          ran.push(cmd)
          return 0
        })
        // install must precede build — the bead's whole point
        assert.deepEqual(ran, ['npm install --no-audit --no-fund', 'npm run build'])
        assert.equal(doneSha(main), head(main))
        ran.length = 0
        runPostMergeRefresh(main, (cmd) => {
          ran.push(cmd)
          return 0
        })
        assert.deepEqual(ran, [])
      })
    )
  })

  test('a merge without dep-manifest changes builds but never installs', () => {
    const { root, main } = nodeRepo('bro-pm-run-')
    inside(main, root, () =>
      isolatedConfig(() => {
        const ran: string[] = []
        const run = (cmd: string) => (ran.push(cmd), 0)
        runPostMergeRefresh(main, run)
        // a src-only commit after the baseline: install is skipped
        writeFileSync(join(main, 'src.ts'), 'x')
        git(['add', '-A'], main)
        git(['commit', '-qm', 'src'], main)
        ran.length = 0
        runPostMergeRefresh(main, run)
        assert.deepEqual(ran, ['npm run build'])
        assert.equal(doneSha(main), head(main))
      })
    )
  })

  test('a refresh that ran steps stamps the build record; a no-step pass does not (bro-fatja)', () => {
    const { root, main } = nodeRepo('bro-pm-run-', false) // no build script
    inside(main, root, () =>
      isolatedConfig(() => {
        runPostMergeRefresh(main, () => 0)
        const stamp = () =>
          JSON.parse(readFileSync(join(main, '.git', 'bro', 'last-build.json'), 'utf8')) as {
            via: string
            head: string
            inputs: string
            session: string
            ts: number
          }
        const first = stamp()
        assert.equal(first.via, 'post-merge')
        assert.equal(first.head, head(main))
        assert.match(first.inputs, /^[0-9a-f]{64}$/)
        assert.notEqual(first.session, '')
        // a pass whose resolveSteps is empty (no manifest move, no
        // build script, no patch) wrote nothing — the record must keep
        // naming the last REAL write, not the no-op
        writeFileSync(join(main, 'src.ts'), 'x')
        git(['add', '-A'], main)
        git(['commit', '-qm', 'src'], main)
        runPostMergeRefresh(main, () => 0)
        assert.equal(doneSha(main), head(main)) // done-sha still advanced
        assert.equal(stamp().head, first.head) // but the stamp did not
      })
    )
  })

  test('a dep-manifest move runs install first; a failed step freezes the done-sha', () => {
    const { root, main } = nodeRepo('bro-pm-run-')
    inside(main, root, () =>
      isolatedConfig(() => {
        const ran: string[] = []
        runPostMergeRefresh(main, (cmd) => (ran.push(cmd), 0))
        const baseline = doneSha(main)
        // simulate the merged dep — package.json moved past done
        writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, deps: { a: '1' } }))
        git(['commit', '-qam', 'dep'], main)
        ran.length = 0
        runPostMergeRefresh(main, (cmd) => {
          ran.push(cmd)
          return cmd.includes('install') ? 1 : 0 // install fails
        })
        assert.deepEqual(ran, ['npm install --no-audit --no-fund'])
        assert.equal(doneSha(main), baseline) // NOT advanced — retry comes whole
        ran.length = 0
        runPostMergeRefresh(main, (cmd) => (ran.push(cmd), 0))
        assert.deepEqual(ran, ['npm install --no-audit --no-fund', 'npm run build'])
        assert.equal(doneSha(main), head(main))
      })
    )
  })
})
