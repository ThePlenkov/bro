/** Commit-provenance unit tests — the resolver's contracts are the
 *  bead's: env pins first, unambiguous fallbacks only, and NO trailers
 *  without an agent identity (human commits stay clean). The /proc
 *  ancestor verdict is injected — a test process can't shape it. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  branchBead,
  BRO_HOOK_MARK,
  commitTrailers,
  envProvenance,
  gitHooksDir,
  hookShim,
  installCommitHook,
  installPostMergeHook,
  liveSessionClaims,
  POSTMERGE_HOOK_MARK,
  postMergeShim,
  uninstallCommitHook,
  uninstallPostMergeHook,
} from './githooks.ts'
import { git, initRepo, inside } from './testrepo.ts'

describe('envProvenance', () => {
  test('BRO_* pins map straight to trailers', () => {
    assert.deepEqual(
      envProvenance({
        BRO_AGENT: 'devin',
        BRO_AGENT_MODEL: 'swe-2',
        BRO_SESSION_ID: 'native-abc',
        BRO_BEAD_ID: 'bro-fzot',
        BRO_MOL_ID: 'bro-mol-fdhh',
      }),
      {
        agent: 'devin',
        model: 'swe-2',
        session: 'native-abc',
        bead: 'bro-fzot',
        molecule: 'bro-mol-fdhh',
      }
    )
  })

  test('AI_AGENT is normalized to the cli name', () => {
    assert.equal(envProvenance({ AI_AGENT: 'devin_3000-11-3_agent' }).agent, 'devin')
    assert.equal(envProvenance({ AI_AGENT: 'claude-code' }).agent, 'claude-code')
  })

  test('BRO_AGENT wins over AI_AGENT; BRO_* model/session win over runtime vars', () => {
    const p = envProvenance({
      BRO_AGENT: 'codex',
      AI_AGENT: 'devin_1',
      BRO_AGENT_MODEL: 'm1',
      DEVIN_MODEL: 'm2',
      BRO_SESSION_ID: 's1',
      DEVIN_SESSION_ID: 's2',
    })
    assert.equal(p.agent, 'codex')
    assert.equal(p.model, 'm1')
    assert.equal(p.session, 's1')
  })

  test('runtime model/session vars are picked up when BRO_* is absent', () => {
    const p = envProvenance({ DEVIN_MODEL: 'swe', CLAUDE_SESSION_ID: 'cls-1' })
    assert.equal(p.model, 'swe')
    assert.equal(p.session, 'cls-1')
  })
})

describe('branchBead', () => {
  test('work/ and loop/ tails that look like beads resolve', () => {
    assert.equal(branchBead('work/bro-fzot'), 'bro-fzot')
    assert.equal(branchBead('loop/fx-9'), 'fx-9')
  })
  test('non-bro namespaces never fabricate a bead', () => {
    assert.equal(branchBead('main'), undefined)
    assert.equal(branchBead('feature/some-words-here'), undefined)
    assert.equal(branchBead('feat/bus-broker'), undefined)
    assert.equal(branchBead('stack/s/1-bro-fzot'), undefined)
  })
})

describe('liveSessionClaims', () => {
  const mkDir = (): string => mkdtempSync(join(tmpdir(), 'bro-githooks-'))
  const arm = (dir: string, name: string, lines: string[]): void => {
    writeFileSync(join(dir, name), lines.join('\n'))
  }

  test('a live .task marker yields its session and bead details', () => {
    const dir = mkDir()
    arm(dir, 's1.task', [`${Date.now()}`, 'bro-fzot'])
    const claims = liveSessionClaims(dir)
    assert.deepEqual([...claims.entries()], [['s1', ['bro-fzot']]])
  })

  test('stale markers and non-task aspects are ignored; beads dedup', () => {
    const dir = mkDir()
    arm(dir, 's1.task', [`${Date.now()}`, 'bro-a', 'bro-a', 'not a bead'])
    arm(dir, 's1.work', [`${Date.now()}`, 'some-slug'])
    const old = join(dir, 's2.task')
    writeFileSync(old, `${Date.now() - 8 * 24 * 3600e3}\nbro-z\n`)
    const stale = new Date(Date.now() - 8 * 24 * 3600e3)
    utimesSync(old, stale, stale)
    const claims = liveSessionClaims(dir)
    assert.deepEqual([...claims.entries()], [['s1', ['bro-a']]])
  })

  test('missing dir → empty map', () => {
    assert.equal(liveSessionClaims(join(tmpdir(), 'definitely-not-here')).size, 0)
  })
})

describe('commitTrailers', () => {
  const base = { cwd: '/tmp', hooksDir: null, agentProc: false } as const

  test('no agent identity → no trailers (human commit stays clean)', () => {
    assert.deepEqual(commitTrailers({ ...base, env: {} }), [])
  })

  test('env pins produce the full trailer set', () => {
    const trailers = commitTrailers({
      ...base,
      env: {
        BRO_AGENT: 'devin',
        BRO_SESSION_ID: 'native-abc',
        BRO_BEAD_ID: 'bro-fzot',
        BRO_MOL_ID: 'bro-mol-fdhh',
      },
    })
    assert.deepEqual(trailers, [
      ['Agent', 'devin'],
      ['Session', 'native-abc'],
      ['Bead', 'bro-fzot'],
      ['Molecule', 'bro-mol-fdhh'],
    ])
  })

  test('BRO_AGENT_ID badge counts as agent identity', () => {
    const trailers = commitTrailers({ ...base, env: { BRO_AGENT_ID: 'native-x' } })
    assert.deepEqual(trailers, [['Agent', 'agent']])
  })

  test('agent-process verdict fills Session/Bead from the single live session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-githooks-'))
    writeFileSync(join(dir, 'ses-9.task'), `${Date.now()}\nbro-fzot\n`)
    const trailers = commitTrailers({
      cwd: '/tmp',
      hooksDir: dir,
      agentProc: true,
      env: {},
      moleculeOf: () => 'bro-mol-fdhh',
    })
    assert.deepEqual(trailers, [
      ['Agent', 'agent'],
      ['Session', 'ses-9'],
      ['Bead', 'bro-fzot'],
      ['Molecule', 'bro-mol-fdhh'],
    ])
  })

  test('two live sessions → no marker-derived fields (never a coin flip)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-githooks-'))
    writeFileSync(join(dir, 's1.task'), `${Date.now()}\nbro-a\n`)
    writeFileSync(join(dir, 's2.task'), `${Date.now()}\nbro-b\n`)
    const trailers = commitTrailers({
      cwd: '/tmp',
      hooksDir: dir,
      agentProc: true,
      env: {},
      moleculeOf: () => undefined,
    })
    assert.deepEqual(trailers, [['Agent', 'agent']])
  })

  test('branch fallback supplies Bead; env still wins', () => {
    const trailers = commitTrailers({
      ...base,
      env: { AI_AGENT: 'devin_1' },
      branch: 'work/bro-fzot',
      moleculeOf: () => undefined,
    })
    assert.deepEqual(trailers, [
      ['Agent', 'devin'],
      ['Bead', 'bro-fzot'],
    ])
  })

  test('multi-bead .task marker resolves no Bead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-githooks-'))
    writeFileSync(join(dir, 's1.task'), `${Date.now()}\nbro-a\nbro-b\n`)
    const trailers = commitTrailers({
      cwd: '/tmp',
      hooksDir: dir,
      agentProc: true,
      env: {},
      moleculeOf: () => undefined,
    })
    assert.deepEqual(trailers, [
      ['Agent', 'agent'],
      ['Session', 's1'],
    ])
  })
})

describe('hookShim', () => {
  test('carries the bro mark, chains a .local hook, pins the version', () => {
    const shim = hookShim('1.2.3')
    assert.match(shim, /prepare-commit-msg\.local/)
    assert.match(shim, /@broject\/bro@1\.2\.3/)
    assert.ok(shim.includes(BRO_HOOK_MARK))
  })

  test("a chained hook's nonzero exit propagates — its veto survives chaining", () => {
    const shim = hookShim('1.2.3')
    assert.match(shim, /"\$chain" "\$@" \|\| exit \$\?/)
    // bro's own half still fails open — only the chain keeps its veto
    assert.match(shim, /bro hooks prepare-commit-msg "\$@" \|\| true/)
  })
})

describe('install/uninstall', () => {
  const hookPath = (main: string): string => join(main, '.git', 'hooks', 'prepare-commit-msg')

  test('fresh repo → installed, executable, marked; second install is already', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      const r = installCommitHook(main, '9.9.9')
      assert.equal(r.state, 'installed')
      const shim = readFileSync(hookPath(main), 'utf8')
      assert.ok(shim.includes(BRO_HOOK_MARK))
      assert.match(shim, /@broject\/bro@9\.9\.9/)
      assert.equal((statSync(hookPath(main)).mode & 0o111) !== 0, true)
      assert.equal(installCommitHook(main, '9.9.9').state, 'already')
    })
  })

  test('a pre-existing hook is chained, never clobbered — and restored on uninstall', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      const hp = hookPath(main)
      writeFileSync(hp, '#!/bin/sh\nexit 0\n')
      const r = installCommitHook(main, '9.9.9')
      assert.equal(r.state, 'chained')
      assert.equal(
        readFileSync(join(main, '.git', 'hooks', 'prepare-commit-msg.local'), 'utf8'),
        '#!/bin/sh\nexit 0\n'
      )
      const u = uninstallCommitHook(main)
      assert.equal(u.state, 'restored')
      assert.equal(readFileSync(hp, 'utf8'), '#!/bin/sh\nexit 0\n')
    })
  })

  test('uninstall removes a bro shim and reports absent on a clean repo', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      installCommitHook(main, '9.9.9')
      assert.equal(uninstallCommitHook(main).state, 'removed')
      assert.equal(uninstallCommitHook(main).state, 'absent')
    })
  })

  test('uninstall refuses a foreign hook', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      const hp = hookPath(main)
      writeFileSync(hp, '#!/bin/sh\nexit 0\n')
      const r = uninstallCommitHook(main)
      assert.equal(r.state, 'error')
      assert.equal(readFileSync(hp, 'utf8'), '#!/bin/sh\nexit 0\n')
    })
  })

  test('non-git dir → error, nothing written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-githooks-'))
    assert.equal(installCommitHook(dir, '9.9.9').state, 'error')
  })

  test('a relative core.hooksPath resolves against the worktree root, not the install cwd', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      git(['config', 'core.hooksPath', '.githooks'], main)
      mkdirSync(join(main, 'sub', 'deep'), { recursive: true })
      assert.equal(gitHooksDir(join(main, 'sub', 'deep')), join(main, '.githooks'))
      // and installing from there lands the hook where git runs it
      const r = installCommitHook(join(main, 'sub', 'deep'), '9.9.9')
      assert.equal(r.state, 'installed')
      assert.equal(readFileSync(join(main, '.githooks', 'prepare-commit-msg'), 'utf8').includes(BRO_HOOK_MARK), true)
    })
  })

  test('a failed chain-install leaves the original hook in place', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      const hp = hookPath(main)
      writeFileSync(hp, '#!/bin/sh\nexit 0\n')
      // read-only hooks dir: the rename can't complete — and nothing may
      // strand the user's hook as .local-only
      chmodSync(join(main, '.git', 'hooks'), 0o555)
      try {
        const r = installCommitHook(main, '9.9.9')
        assert.equal(r.state, 'error')
        assert.equal(readFileSync(hp, 'utf8'), '#!/bin/sh\nexit 0\n')
      } finally {
        chmodSync(join(main, '.git', 'hooks'), 0o755)
      }
    })
  })
})

describe('post-merge shim (bro-sovl3)', () => {
  const hookPath = (main: string): string => join(main, '.git', 'hooks', 'post-merge')

  test('shim chains .local, dispatches `bro hooks post-merge`, fails open', () => {
    const shim = postMergeShim('1.2.3')
    assert.match(shim, /post-merge\.local/)
    // a bro that errors (older releases lack the event) falls through
    // to the pinned npx fallback — detached, so git pull never waits
    assert.match(shim, /command -v bro.*&& bro hooks post-merge "\$@" <\/dev\/null/)
    assert.match(shim, /nohup npx -y --prefer-offline "@broject\/bro@1\.2\.3" hooks post-merge/)
    assert.ok(shim.includes(POSTMERGE_HOOK_MARK))
    // the chain keeps its veto; bro's tail always exits 0
    assert.match(shim, /"\$chain" "\$@" \|\| exit \$\?/)
    assert.match(shim, /exit 0\n$/)
  })

  test('install chains a pre-existing hook, uninstall restores it', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      writeFileSync(hookPath(main), '#!/bin/sh\nexit 0\n')
      const r = installPostMergeHook(main, '9.9.9')
      assert.equal(r.state, 'chained')
      assert.equal(
        readFileSync(join(main, '.git', 'hooks', 'post-merge.local'), 'utf8'),
        '#!/bin/sh\nexit 0\n'
      )
      assert.ok(readFileSync(hookPath(main), 'utf8').includes(POSTMERGE_HOOK_MARK))
      assert.equal(uninstallPostMergeHook(main).state, 'restored')
      assert.equal(readFileSync(hookPath(main), 'utf8'), '#!/bin/sh\nexit 0\n')
      // the restored hook is foreign again — uninstall must refuse it
      assert.equal(uninstallPostMergeHook(main).state, 'error')
    })
  })

  test('uninstall refuses a foreign post-merge hook', () => {
    const { root, main } = initRepo('bro-githooks-')
    inside(main, root, () => {
      writeFileSync(hookPath(main), '#!/bin/sh\nexit 0\n')
      assert.equal(uninstallPostMergeHook(main).state, 'error')
      assert.equal(readFileSync(hookPath(main), 'utf8'), '#!/bin/sh\nexit 0\n')
    })
  })
})

