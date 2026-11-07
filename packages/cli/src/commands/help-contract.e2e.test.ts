import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initRepo, inside, runCli, tmpDir } from './testrepo.ts'

/** The stream+code contract (spec bro-1znlu): the exit code picks the
 *  stream — explicit help exits 0 so its text lands on stdout; usage
 *  errors exit non-zero and their text stays on stderr. Shipped
 *  watcher verdicts (bro wait) keep their frozen meanings. */
const dir = tmpDir('bro-help-contract-')

function cli(args: string[]) {
  return runCli(args, { cwd: dir })
}

describe('help → stdout + 0', () => {
  for (const args of [
    ['--help'],
    ['-h'],
    ['help'],
    ['help', 'act'],
    ['review', '--help'],
    ['review'],
    ['act', '--help'],
    ['convoy', '--help'],
    ['drill', '-h'],
    ['work', '--help'],
    ['spec', '--help'],
    ['stack', '--help'],
    ['mesh', '--help'],
    ['wait', '--help'],
    ['guard', '--help'],
    ['sweep', '--help'],
    ['judge', '--help'],
    ['serve', '--help'],
    ['rig', '--help'],
    ['queue', '--help'],
    ['plan', '--help'],
    ['sinks', '--help'],
    ['debt', '--help'],
    ['learn', '--help'],
    ['mcp', '--help'],
    ['agents', '--help'],
    ['bus', '--help'],
    ['loop', '--help'],
    ['drive', '--help'],
    ['next', '--help'],
    ['retrospect', '--help'],
    ['resume', '--help'],
    ['provider', '--help'],
    ['providers', '--help'],
    ['check', '--help'],
    ['convoy', 'wait', '--help'],
    ['doctor', '--help'],
    // nested help — the flag after a subcommand shows help, it never
    // runs the command (worktree creation, sync cascade, span export,
    // request delivery are all side effects, not usage text)
    ['help', 'convoy', 'wait'],
    ['help', 'review', 'act'],
    ['help', 'doctor'],
    ['work', 'enter', 'slug', '--help'],
    ['stack', 'sync', '--help'],
    ['trace', 'export', '--help'],
    ['request', 'rig', 'title', '--help'],
    ['act', 'wait', '--help'],
    ['spec', 'check', '--help'],
    ['plan', 'validate', '--help'],
    ['mesh', 'peers', '--help'],
    ['providers', 'models', '--help'],
    ['drill', 'down', '--help'],
    ['retrospect', 'list', '--help'],
    // nested help ahead of side effects — spawning, ledger labels, the
    // judge provider, client (un)install, sink probes, and a scheduler
    // disarm must never run on a help request
    ['agents', 'up', 'fx-abc', '--help'],
    ['debt', 'mark', '123', 'collected', '--help'],
    ['guard', 'test', 'some-guard', '--help'],
    ['judge', 'decide', '--state', 's.json', '--help'],
    ['plugins', 'uninstall', 'kilo', '--help'],
    ['help', 'plugins', 'uninstall', 'kilo'],
    ['sinks', 'test', '--help'],
    ['watch', 'uninstall', '--help'],
    // a `--` payload after `help <cmd>` is not help — drop it, show help
    ['help', 'act', '--', 'payload'],
  ]) {
    test(`bro ${args.join(' ')}`, () => {
      const r = cli(args)
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.length > 0, 'help text must land on stdout')
      assert.equal(r.stderr, '', 'no stderr noise on the help path')
    })
  }
})

describe('usage errors → stderr + non-zero', () => {
  for (const [args, code] of [
    [['bogus'], 2],
    [['review', 'bogus'], 2],
    [['act', 'bogus'], 2],
    [['spec', 'bogus'], 2],
    [['work'], 2],
    [['stack'], 2],
  ] as const) {
    test(`bro ${args.join(' ')} → ${code}`, () => {
      const r = cli([...args])
      assert.equal(r.code, code, `stdout: ${r.stdout} stderr: ${r.stderr}`)
      assert.equal(r.stdout, '', 'usage errors never write stdout')
      assert.ok(r.stderr.length > 0, 'usage text lands on stderr')
    })
  }
})

describe('watch sched dispatch', () => {
  test('bro watch uninstall never falls through to install', () => {
    const { root, main } = initRepo('bro-watch-uninstall-')
    inside(main, root, () => {
      const r = runCli(['watch', 'uninstall'], { cwd: main })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      // the buggy dispatch fed runWatchSched an empty argv — installWatch
      // armed the pulse instead of reporting the disarm path
      assert.match(r.stdout, /no pulse marker|pulse disarmed/)
      assert.ok(
        !existsSync(join(main, '.git', 'bro', 'pulse.json')),
        'uninstall must not write the pulse marker'
      )
    })
  })
})

describe('frozen verdict meanings', () => {
  test('bro wait with no refs → usage error on stderr', () => {
    const r = cli(['wait'])
    assert.equal(r.code, 2)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /Usage: bro wait/)
  })

  test('bare bro → generic error 1, usage on stderr', () => {
    const r = cli([])
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.length > 0)
  })
})
