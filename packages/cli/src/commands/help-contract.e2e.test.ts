import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, tmpDir } from './testrepo.ts'

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
