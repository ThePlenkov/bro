/** Ref-guard end-to-end: a real repo with the installed shim, a fake
 *  `bro` on PATH that fronts the built CLI, and real git invocations.
 *  The bead's evidence: `reset --hard` to a non-descendant dies with the
 *  branch ref intact; amend/rebase/merge land; forced refspecs and
 *  update-ref die; the env escape hatch passes. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installRefGuardHook, uninstallRefGuardHook } from './githooks.ts'
import { REFGUARD_HOOK_MARK } from './refguard.ts'
import { CLI_DIST, e2eEnv, git, initRepo, inside } from './testrepo.ts'

/** A fake `bro` binary routing to the built CLI — the installed shim
 *  resolves it via PATH like the real thing. */
function fakeBroBin(root: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const bro = join(bin, 'bro')
  writeFileSync(bro, `#!/bin/sh\nexec "${process.execPath}" "${CLI_DIST}" "$@"\n`)
  chmodSync(bro, 0o755)
  return bin
}

/** git with the fake-bro PATH — spawnSync so a veto's nonzero exit is
 *  observable instead of throwing. */
function gitTry(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() }
}

const HOOK_PATH = (main: string) => join(main, '.git', 'hooks', 'reference-transaction')

describe('refguard e2e', () => {
  test('reset/update-ref/forced-fetch/branch -f veto; commit/amend/rebase/merge land', () => {
    const { root, main } = initRepo('bro-refguard-')
    inside(main, root, () => {
      const bin = fakeBroBin(root)
      const env = e2eEnv({ PATH: `${bin}:${process.env.PATH}` })
      const r = installRefGuardHook(main, '9.9.9')
      assert.equal(r.state, 'installed')
      assert.ok(readFileSync(HOOK_PATH(main), 'utf8').includes(REFGUARD_HOOK_MARK))

      // commit + amend — produced-content verbs move the branch freely
      execFileSync('git', ['commit', '-qm', 'c2', '--allow-empty'], { cwd: main, env })
      execFileSync('git', ['commit', '-qm', 'c2a', '--allow-empty', '--amend'], {
        cwd: main,
        env,
      })
      const amended = git(['rev-parse', 'HEAD'], main).trim()
      const before = git(['rev-parse', 'HEAD~1'], main).trim()

      // the clobber itself — `git reset --hard` to a non-descendant —
      // dies, and the branch ref stands exactly where it was
      const rs = gitTry(['reset', '--hard', before], main, env)
      assert.notEqual(rs.code, 0, rs.out + rs.err)
      assert.match(rs.err, /refguard/)
      assert.equal(git(['rev-parse', 'main'], main).trim(), amended)

      // update-ref plumbing meets the same fence
      const ur = gitTry(['update-ref', 'refs/heads/main', before], main, env)
      assert.notEqual(ur.code, 0)
      assert.equal(git(['rev-parse', 'main'], main).trim(), amended)

      // a divergent branch for the fetch/branch -f matrix — created via
      // switch -c + commit, both legal under the guard
      git(['switch', '-c', 'diverge', before], main)
      execFileSync('git', ['commit', '-qm', 'd1', '--allow-empty'], { cwd: main, env })
      git(['switch', 'main'], main)

      // forced fetch refspec: a create passes; a forced non-ff move dies
      const create = gitTry(
        ['fetch', `file://${main}`, '+diverge:refs/heads/forged'],
        main,
        env
      )
      assert.equal(create.code, 0, create.err)
      const forced = gitTry(['fetch', `file://${main}`, '+main:refs/heads/forged'], main, env)
      assert.notEqual(forced.code, 0)
      assert.equal(
        git(['rev-parse', 'forged'], main).trim(),
        git(['rev-parse', 'diverge'], main).trim()
      )

      // `git branch -f` on an unchecked-out branch — the foreign-ref move
      const bf = gitTry(['branch', '-f', 'forged', before], main, env)
      assert.notEqual(bf.code, 0)

      // rebase — a content-producing rewrite — lands
      git(['switch', '-c', 'topic', before], main)
      execFileSync('git', ['commit', '-qm', 't1', '--allow-empty'], { cwd: main, env })
      execFileSync('git', ['rebase', 'main'], { cwd: main, env })
      assert.equal(
        git(['rev-parse', 'topic'], main).trim(),
        git(['rev-parse', 'HEAD'], main).trim()
      )

      // merge — same class
      git(['switch', 'main'], main)
      execFileSync('git', ['merge', '--no-ff', '-m', 'merge', 'topic'], { cwd: main, env })

      // the deliberate-rewrite escape hatch
      const off = gitTry(['reset', '--hard', before], main, {
        ...env,
        BRO_REF_GUARD: 'off',
      })
      assert.equal(off.code, 0, off.err)
      assert.equal(git(['rev-parse', 'main'], main).trim(), before)
    })
  })

  test('install chains a pre-existing hook; uninstall restores it', () => {
    const { root, main } = initRepo('bro-refguard-')
    inside(main, root, () => {
      const hp = HOOK_PATH(main)
      writeFileSync(hp, '#!/bin/sh\ncat >/dev/null\nexit 0\n')
      chmodSync(hp, 0o755)
      assert.equal(installRefGuardHook(main, '9.9.9').state, 'chained')
      assert.equal(
        readFileSync(join(main, '.git', 'hooks', 'reference-transaction.local'), 'utf8'),
        '#!/bin/sh\ncat >/dev/null\nexit 0\n'
      )
      assert.equal(uninstallRefGuardHook(main).state, 'restored')
      assert.equal(readFileSync(hp, 'utf8'), '#!/bin/sh\ncat >/dev/null\nexit 0\n')
      // the restored hook is foreign again — uninstall refuses to touch it
      assert.equal(uninstallRefGuardHook(main).state, 'error')
    })
  })

  test('uninstall removes a bro shim, refuses a foreign hook', () => {
    const { root, main } = initRepo('bro-refguard-')
    inside(main, root, () => {
      installRefGuardHook(main, '9.9.9')
      assert.equal(uninstallRefGuardHook(main).state, 'removed')
      writeFileSync(HOOK_PATH(main), '#!/bin/sh\nexit 0\n')
      assert.equal(uninstallRefGuardHook(main).state, 'error')
    })
  })
})
