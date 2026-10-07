/** Ref-guard unit tests — the contract is the bead's: a non-fast-forward
 *  move of a local branch is vetoed only when a ref-mover verb invoked it
 *  (reset/fetch/update-ref/branch/checkout/switch — the clobber shape);
 *  content producers (commit/amend/rebase/merge), ff moves, non-heads
 *  refs, and "no invoker data" always pass. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gitSubcommand,
  parseRefUpdates,
  refGuardShim,
  refGuardVerdict,
  REFGUARD_HOOK_MARK,
  type RefUpdate,
} from './refguard.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const ZERO = '0'.repeat(40)

const head = (ref: string, oldSha: string, newSha: string): RefUpdate => ({
  oldSha,
  newSha,
  ref: `refs/heads/${ref}`,
})

/** Non-ff by construction — the tests that exercise the veto matrix. */
const nonff = () => false
const base = (argv?: string[]) => ({
  env: {} as NodeJS.ProcessEnv,
  cwd: '/tmp',
  argv,
  isAncestor: nonff,
  resolveRef: () => null,
})

describe('parseRefUpdates', () => {
  test('parses old/new/ref triples, skips malformed and blank lines', () => {
    const updates = parseRefUpdates(
      `${A} ${B} refs/heads/main\n` +
        `${ZERO} ${A} refs/heads/new-branch\n` +
        `${A} ref:refs/heads/main HEAD\n` +
        'garbage\n\n' +
        `${B} ${ZERO} refs/heads/gone\n`
    )
    assert.deepEqual(updates, [
      { oldSha: A, newSha: B, ref: 'refs/heads/main' },
      { oldSha: ZERO, newSha: A, ref: 'refs/heads/new-branch' },
      { oldSha: A, newSha: 'ref:refs/heads/main', ref: 'HEAD' },
      { oldSha: B, newSha: ZERO, ref: 'refs/heads/gone' },
    ])
  })

  test('empty stdin → no updates', () => {
    assert.deepEqual(parseRefUpdates(''), [])
    assert.deepEqual(parseRefUpdates('\n'), [])
  })
})

describe('gitSubcommand', () => {
  test('plain verbs resolve', () => {
    assert.equal(gitSubcommand(['git', 'reset', '--hard', 'origin/x']), 'reset')
    assert.equal(
      gitSubcommand(['/usr/lib/git-core/git', 'merge', '-q', '--ff-only', 'FETCH_HEAD']),
      'merge'
    )
    assert.equal(gitSubcommand(['git', 'update-ref', 'refs/heads/m', 'x']), 'update-ref')
  })

  test('global options are skipped to the subcommand', () => {
    assert.equal(gitSubcommand(['git', '-C', '/wt', 'reset', '--hard', 'x']), 'reset')
    assert.equal(gitSubcommand(['git', '-c', 'a=b', 'commit', '-m', 'x']), 'commit')
    assert.equal(
      gitSubcommand(['git', '--git-dir=/x', '--work-tree=/y', 'fetch', 'o']),
      'fetch'
    )
    assert.equal(
      gitSubcommand(['git', '-C', '/d', '-c', 'k=v', '--namespace', 'ns', 'rebase']),
      'rebase'
    )
  })

  test('dashed builtins resolve by prefix — git-fetch → fetch', () => {
    assert.equal(gitSubcommand(['git-fetch', '--update-head-ok', '-q']), 'fetch')
    assert.equal(gitSubcommand(['git-rebase', '--onto', 'a', 'b']), 'rebase')
  })

  test('non-git argv0 and flag-only argv yield no verb', () => {
    assert.equal(gitSubcommand(['sh', '-c', 'git reset --hard x']), undefined)
    assert.equal(gitSubcommand(['git', '--version']), undefined)
    assert.equal(gitSubcommand([]), undefined)
  })
})

describe('refGuardVerdict — the veto matrix', () => {
  const move = head('main', A, B)

  test('non-ff moves by ref-mover verbs veto', () => {
    for (const argv of [
      ['git', 'reset', '--hard', 'origin/main'],
      ['git', 'reset', '--hard', 'HEAD~1'],
      ['git', '-C', '/other/worktree', 'reset', '--hard', 'origin/x'],
      ['git', 'update-ref', 'refs/heads/main', B],
      ['git', 'fetch', 'origin', '+x:refs/heads/main'],
      ['git', 'checkout', '-B', 'main', B],
      ['git', 'switch', '-C', 'main'],
      ['git', 'branch', '-f', 'main', B],
    ]) {
      const v = refGuardVerdict([move], base(argv))
      assert.equal(v.verdict, 'veto', argv.join(' '))
      if (v.verdict === 'veto') {
        assert.equal(v.ref, 'refs/heads/main')
      }
    }
  })

  test('non-ff moves by content verbs pass — amend and rebase are legit rewrites', () => {
    for (const argv of [
      ['git', 'commit', '--amend', '-m', 'x'],
      ['/usr/lib/git-core/git', 'rebase', 'origin/main'],
      ['git', 'merge', 'feature'],
      ['git', 'pull', '--rebase'],
      ['git', 'cherry-pick', B],
      ['git', 'revert', B],
      ['git', 'stash'],
    ]) {
      assert.equal(refGuardVerdict([move], base(argv)).verdict, 'allow', argv.join(' '))
    }
  })

  test('unknown verbs veto — fail-closed on anything unlisted', () => {
    const v = refGuardVerdict([move], base(['git', 'frobnicate']))
    assert.equal(v.verdict, 'veto')
    if (v.verdict === 'veto') {
      assert.equal(v.verb, 'frobnicate')
    }
  })

  test('ff moves pass whatever the verb — a reset that advances is a pull in shape', () => {
    const v = refGuardVerdict([move], {
      env: {},
      cwd: '/tmp',
      argv: ['git', 'reset', '--hard', 'origin/main'],
      isAncestor: () => true,
      resolveRef: () => null,
    })
    assert.equal(v.verdict, 'allow')
  })

  test('unverified writes (old=0) resolve the on-disk old — the clobber shape that hides as a create', () => {
    // `update-ref`/`branch -f`/`switch -C`/forced fetch report old = 0
    // even for existing refs — ground truth comes from resolveRef
    const hidden = head('main', ZERO, B)
    const resolved = { ...base(['git', 'update-ref', 'refs/heads/main', B]), resolveRef: () => A }
    const v = refGuardVerdict([hidden], resolved)
    assert.equal(v.verdict, 'veto')
    if (v.verdict === 'veto') {
      assert.equal(v.oldSha, A)
      assert.equal(v.verb, 'update-ref')
    }
    // resolves to the same oid → no-op write, not a move
    assert.equal(
      refGuardVerdict([head('main', ZERO, B)], {
        ...resolved,
        resolveRef: () => B,
      }).verdict,
      'allow'
    )
    // resolves to an ancestor of the target → ff by truth, not a clobber
    assert.equal(
      refGuardVerdict([hidden], {
        ...base(['git', 'branch', '-f', 'main', B]),
        isAncestor: () => true,
        resolveRef: () => A,
      }).verdict,
      'allow'
    )
    // no ref on disk → a genuine create
    assert.equal(
      refGuardVerdict([hidden], base(['git', 'update-ref', 'refs/heads/new', B])).verdict,
      'allow'
    )
  })

  test('creates, deletes, same-oid, and non-heads refs are not moves', () => {
    const reset = ['git', 'reset', '--hard', 'x']
    for (const u of [
      head('new', ZERO, A),
      head('gone', A, ZERO),
      head('main', A, A),
      { oldSha: A, newSha: B, ref: 'refs/remotes/origin/main' },
      { oldSha: A, newSha: B, ref: 'ORIG_HEAD' },
      { oldSha: A, newSha: B, ref: 'refs/bro/data' },
      { oldSha: A, newSha: B, ref: 'refs/tags/v1' },
      { oldSha: ZERO, newSha: 'ref:refs/heads/x', ref: 'HEAD' },
    ]) {
      assert.equal(refGuardVerdict([u], base(reset)).verdict, 'allow', JSON.stringify(u))
    }
  })

  test('unverifiable ancestry and missing cmdline data allow — never a wedge', () => {
    assert.equal(
      refGuardVerdict([move], { env: {}, cwd: '/tmp', argv: ['git', 'reset', 'x'], isAncestor: () => null })
        .verdict,
      'allow'
    )
    assert.equal(
      refGuardVerdict([move], { env: {}, cwd: '/tmp', isAncestor: nonff }).verdict,
      'allow'
    )
  })

  test('BRO_REF_GUARD=off is the deliberate-rewrite escape hatch', () => {
    for (const off of ['off', '0', 'false']) {
      const v = refGuardVerdict([move], {
        env: { BRO_REF_GUARD: off },
        cwd: '/tmp',
        argv: ['git', 'reset', '--hard', 'x'],
        isAncestor: nonff,
      })
      assert.equal(v.verdict, 'allow', off)
    }
  })

  test('a vetoed update among passing ones still vetoes', () => {
    const v = refGuardVerdict(
      [
        { oldSha: A, newSha: B, ref: 'refs/remotes/origin/x' },
        head('feature', A, C),
      ],
      base(['git', 'update-ref'])
    )
    assert.equal(v.verdict, 'veto')
    if (v.verdict === 'veto') {
      assert.equal(v.ref, 'refs/heads/feature')
    }
  })
})

describe('refGuardShim', () => {
  test('carries the mark, chains .local, pins the version, passes the git pid', () => {
    const shim = refGuardShim('1.2.3')
    assert.ok(shim.includes(REFGUARD_HOOK_MARK))
    assert.match(shim, /reference-transaction\.local/)
    assert.match(shim, /@broject\/bro@1\.2\.3/)
    assert.match(shim, /bro hooks reference-transaction "\$1" "\$PPID"/)
  })

  test('fast-paths: non-prepared and non-heads transactions exit before bro', () => {
    const shim = refGuardShim('0')
    assert.match(shim, /\[ "\$1" = "prepared" \] \|\| exit 0/)
    assert.match(shim, /\*" refs\/heads\/"\*/)
  })

  test('the veto is the stdout marker, never the exit code — infra failures pass', () => {
    const shim = refGuardShim('0')
    assert.match(shim, /\*"BRO_REF_GUARD_VETO"\*\) exit 1 ;;/)
    // the marker check is the LAST word — a dead bro/npx/node exits 0
    assert.match(shim, /esac\nexit 0\n$/)
  })
})
