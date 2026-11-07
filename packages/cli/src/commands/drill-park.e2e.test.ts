/** `bro drill park|wake|waiting` e2e — the interrupter state
 *  (bro-oy3k1.3): a parked frame leaves the active leaf set, the wait
 *  stack is LIFO, and all of it is beads-only state that a fresh
 *  process sees. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bead, initRepo, installFakeBd, readBeads, runCli } from './testrepo.ts'

const env = (binDir: string, db: string) => ({
  PATH: `${binDir}:${process.env.PATH ?? ''}`,
  FAKE_BD_DB: db,
})

function fixture() {
  const { root, main } = initRepo('bro-park-e2e-')
  const { binDir, db } = installFakeBd(root)
  return { main, binDir, db, env: env(binDir, db) }
}

const cli = (main: string, e: ReturnType<typeof env>, args: string[]) =>
  runCli(['drill', ...args], { cwd: main, env: e })

describe('bro drill park/wake — the interrupter', () => {
  test('park removes the leaf from current; wake restores it', () => {
    const { main, env: e } = fixture()
    assert.equal(cli(main, e, ['down', 'outer']).code, 0)
    assert.equal(cli(main, e, ['down', 'inner']).code, 0)
    const cur = cli(main, e, ['current'])
    const innerId = /^\S+/.exec(cur.stdout)![0]

    const parked = cli(main, e, ['park', '--wake', 'gate settles'])
    assert.equal(parked.code, 0, parked.stderr)
    assert.match(parked.stdout, new RegExp(`parked ${innerId}`))

    // the suspended frame is no longer the active leaf — parent is
    const now = cli(main, e, ['current'])
    assert.doesNotMatch(now.stdout, new RegExp(`^${innerId}`))

    const woken = cli(main, e, ['wake'])
    assert.equal(woken.code, 0, woken.stderr)
    assert.match(woken.stdout, new RegExp(`woken ${innerId}`))
    assert.match(cli(main, e, ['current']).stdout, new RegExp(`^${innerId}`))
  })

  test('waiting lists the stack newest-first; bare wake pops LIFO', () => {
    const { main, env: e } = fixture()
    cli(main, e, ['down', 'first'])
    const a = /^\S+/.exec(cli(main, e, ['current']).stdout)![0]
    cli(main, e, ['park', '--wake', 'a gate'])
    cli(main, e, ['down', 'second'])
    const b = /^\S+/.exec(cli(main, e, ['current']).stdout)![0]
    cli(main, e, ['park', '--wake', 'b gate'])

    const list = cli(main, e, ['waiting'])
    assert.equal(list.code, 0, list.stderr)
    const lines = list.stdout.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, new RegExp(`^${b}\tb gate`))
    assert.match(lines[1]!, new RegExp(`^${a}\ta gate`))

    // LIFO pop: b wakes first, then a
    assert.match(cli(main, e, ['wake']).stdout, new RegExp(`woken ${b}`))
    assert.match(cli(main, e, ['wake']).stdout, new RegExp(`woken ${a}`))
    assert.equal(cli(main, e, ['wake']).code, 1)
  })

  test('wake on an active frame refuses; park is idempotent', () => {
    const { main, env: e } = fixture()
    cli(main, e, ['down', 'solo'])
    const id = /^\S+/.exec(cli(main, e, ['current']).stdout)![0]
    assert.equal(cli(main, e, ['wake', id]).code, 1)
    assert.match(cli(main, e, ['wake', id]).stderr, /not waiting/)

    assert.equal(cli(main, e, ['park', '--wake', 'x']).code, 0)
    // re-park by id is a no-op, not an error — a bare park after the
    // leaf suspended correctly reports nothing left to park
    const again = cli(main, e, ['park', '--id', id, '--wake', 'x'])
    assert.equal(again.code, 0, again.stderr)
    const bare = cli(main, e, ['park', '--wake', 'x'])
    assert.equal(bare.code, 1)
    assert.match(bare.stderr, /nothing to park/)
  })

  test('bare up never targets a waiting frame', () => {
    const { main, env: e } = fixture()
    cli(main, e, ['down', 'only'])
    cli(main, e, ['park', '--wake', 'later'])
    const up = cli(main, e, ['up', '--result', 'done anyway'])
    assert.equal(up.code, 1)
    assert.match(up.stderr, /no open drill frame|nothing to ascend/)
  })

  test('parked frame shows waiting in list and tree', () => {
    const { main, env: e, db } = fixture()
    cli(main, e, ['down', 'marked'])
    cli(main, e, ['park', '--wake', 'ci'])
    assert.match(cli(main, e, ['list']).stdout, /\bwaiting\b/)
    assert.match(cli(main, e, ['tree']).stdout, /◌.*\[waiting\]/)
    // beads-only state — a fresh process sees the same verdict
    const row = readBeads(db).find((r) => r.title === 'marked')
    assert.ok((row?.labels as string[] | undefined)?.includes('waiting'))
  })
})
