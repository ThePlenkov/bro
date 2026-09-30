import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sddConnector, specState } from './spec.ts'
import { registerConnector } from '@broject/core'
import type { ConnectorCtx, TaskRow, TaskStore } from '@broject/core'

/** Scripted bd — `list` cats $FAKE_BD_LIST_FILE (written by withRepo),
 *  `show`/`config` keep taskStore happy. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  list) cat "$FAKE_BD_LIST_FILE" ;;
  show) echo '[{"id":"b1","status":"in_progress","title":"thing"}]' ;;
  config) echo 'issue_prefix = bro' ;;
  *) : ;;
esac
`

/** Tmp git repo + fake bd on PATH + bro.config.json; fn gets the dir.
 *  Claim markers are written into .git/bro/hooks/<session>.task. */
function withRepo(
  opts: { config?: object; claims?: string[]; list?: string },
  fn: (dir: string) => void | Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-spec-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(dir, 'list.json'),
    opts.list ??
      '[{"id":"b1","status":"in_progress","title":"thing","issue_type":"task"}]'
  )
  writeFileSync(join(bin, 'bd'), FAKE_BD)
  chmodSync(join(bin, 'bd'), 0o755)
  const prevPath = process.env.PATH
  const prevList = process.env.FAKE_BD_LIST_FILE
  const prevActor = process.env.BEADS_ACTOR
  const run = async (): Promise<void> => {
    execFileSync('git', ['init', '-q', dir])
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify(opts.config ?? { sdd: { mode: 'gate' } })
    )
    if (opts.claims !== undefined) {
      const hooks = join(dir, '.git', 'bro', 'hooks')
      mkdirSync(hooks, { recursive: true })
      writeFileSync(
        join(hooks, 's1.task'),
        ['2026-01-01T00:00:00Z', ...opts.claims].join('\n')
      )
    }
    process.env.PATH = `${bin}:${prevPath}`
    process.env.FAKE_BD_LIST_FILE = join(dir, 'list.json')
    // pin the claim-ownership identity — git user.name is not hermetic
    process.env.BEADS_ACTOR = 'test-agent'
    await fn(dir)
  }
  return run().finally(() => {
    process.env.PATH = prevPath
    if (prevList === undefined) delete process.env.FAKE_BD_LIST_FILE
    else process.env.FAKE_BD_LIST_FILE = prevList
    if (prevActor === undefined) delete process.env.BEADS_ACTOR
    else process.env.BEADS_ACTOR = prevActor
    rmSync(dir, { recursive: true, force: true })
  })
}

const ctx = (dir: string): ConnectorCtx => ({ dir, sessionId: 's1' })

describe('specState', () => {
  const row = (over: object = {}) => ({ id: 'b1', title: 't', ...over })

  test('missing by default; file/link/exempt win', async () => {
    await withRepo({ config: {} }, (dir) => {
      assert.equal(specState(row(), dir, 'specs'), 'missing')
      // spec: link in the description counts
      assert.equal(
        specState(row({ description: 'design: spec: docs/x.md' }), dir, 'specs'),
        'link'
      )
      // chores and trivial-labeled beads are exempt
      assert.equal(specState(row({ issue_type: 'chore' }), dir, 'specs'), 'exempt')
      assert.equal(specState(row({ labels: ['trivial'] }), dir, 'specs'), 'exempt')
      // an empty scaffold does not satisfy the rule
      mkdirSync(join(dir, 'specs'))
      writeFileSync(join(dir, 'specs', 'b1.md'), '  \n')
      assert.equal(specState(row(), dir, 'specs'), 'missing')
      writeFileSync(join(dir, 'specs', 'b1.md'), '# spec\n')
      assert.equal(specState(row(), dir, 'specs'), 'spec')
      // path-traversal ids never count as having a spec file
      assert.equal(specState(row({ id: '../outside' }), dir, 'specs'), 'missing')
      assert.equal(specState(row({ id: 'a/../b' }), dir, 'specs'), 'missing')
      // an escaping sdd.dir fails open to 'missing' too
      assert.equal(specState(row(), dir, '../outside'), 'missing')
      assert.equal(specState(row(), dir, '/tmp'), 'missing')
    })
  })
})

describe('sddConnector', () => {
  const probe = (dir: string) => sddConnector.hooks!(ctx(dir))!

  test('mode off emits nothing', async () => {
    await withRepo({ config: { sdd: { mode: 'off' } }, claims: ['b1'] }, async (dir) => {
      const h = probe(dir)
      assert.deepEqual(await h.sessionStart!(ctx(dir)), [])
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })

  test('remind: policy line at session start, no claims → no nudge', async () => {
    await withRepo({ config: { sdd: { mode: 'remind' } } }, async (dir) => {
      const h = probe(dir)
      const start = await h.sessionStart!(ctx(dir))
      assert.equal(start.length, 1)
      assert.match(start[0]!, /SDD \(remind\).*spec before code/)
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })

  test('gate: own claim without spec blocks under aspect task', async () => {
    await withRepo({ claims: ['b1'] }, async (dir) => {
      const h = probe(dir)
      const gate = await h.stopGate!(ctx(dir))
      assert.equal(gate.length, 1)
      assert.equal(gate[0]!.aspect, 'task')
      assert.match(gate[0]!.block ?? '', /b1 thing/)
      assert.match((await h.promptSubmit!(ctx(dir), 'p'))[0] ?? '', /b1 thing/)
      assert.match((await h.sessionStart!(ctx(dir))).join('\n'), /spec missing: b1/)
    })
  })

  test('own claim with a spec file never blocks', async () => {
    await withRepo({ claims: ['b1'] }, async (dir) => {
      mkdirSync(join(dir, 'specs'))
      writeFileSync(join(dir, 'specs', 'b1.md'), '# spec\n')
      const h = probe(dir)
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })

  test('foreign claims never block this session', async () => {
    await withRepo({ claims: ['other-bead'] }, async (dir) => {
      const h = probe(dir)
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
      assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
    })
  })

  test('a marker claim held by another actor is foreign — never nudged', async () => {
    // `bro work enter b1` armed the marker but the claim was refused —
    // the store says other-agent holds it, so it is not ours to spec
    await withRepo(
      {
        claims: ['b1'],
        list: '[{"id":"b1","status":"in_progress","title":"held","issue_type":"task","assignee":"other-agent"}]',
      },
      async (dir) => {
        const h = probe(dir)
        assert.deepEqual(await h.stopGate!(ctx(dir)), [])
        assert.deepEqual(await h.promptSubmit!(ctx(dir), 'p'), [])
        const start = await h.sessionStart!(ctx(dir))
        assert.equal(start.filter((l) => l.includes('spec missing')).length, 0)
      }
    )
  })

  test('a marker claim whose assignee matches still counts as own', async () => {
    await withRepo(
      {
        claims: ['b1'],
        list: '[{"id":"b1","status":"in_progress","title":"thing","issue_type":"task","assignee":"test-agent"}]',
      },
      async (dir) => {
        const gate = await probe(dir).stopGate!(ctx(dir))
        assert.equal(gate.length, 1)
        assert.match(gate[0]!.block ?? '', /b1 thing/)
      }
    )
  })

  test('remind mode reports missing specs as passive, not block', async () => {
    await withRepo({ config: { sdd: { mode: 'remind' } }, claims: ['b1'] }, async (dir) => {
      const gate = await probe(dir).stopGate!(ctx(dir))
      assert.equal(gate.length, 1)
      assert.equal(gate[0]!.block, undefined)
      assert.match(gate[0]!.passive ?? '', /remind mode/)
    })
  })

  test('a dead task store fails open — policy line still emitted', async () => {
    await withRepo({ claims: ['b1'], list: 'not-json' }, async (dir) => {
      const h = probe(dir)
      assert.match((await h.sessionStart!(ctx(dir)))[0] ?? '', /SDD \(gate\)/)
      assert.deepEqual(await h.stopGate!(ctx(dir)), [])
    })
  })
})

describe('sddConnector under a non-beads tasks connector', () => {
  const probe = (dir: string) => sddConnector.hooks!(ctx(dir))!
  const fakeStore = (rows: TaskRow[], actor?: () => string): TaskStore =>
    ({ list: () => rows, actor }) as unknown as TaskStore

  // a foreign backend's assignee lives in its own identity space —
  // comparing it to bdActor marked every own claim foreign and ate the
  // nudge (bro-cwgv)
  test('no actor() → a foreign assignee cannot disprove the marker', async () => {
    registerConnector({
      name: 'spec-fake-tasks',
      tasks: () =>
        fakeStore([
          {
            id: 'b1',
            status: 'in_progress',
            title: 'thing',
            issue_type: 'task',
            assignee: 'linear-user-9',
          },
        ]),
    })
    await withRepo(
      {
        claims: ['b1'],
        config: { connectors: { tasks: 'spec-fake-tasks' }, sdd: { mode: 'gate' } },
      },
      async (dir) => {
        const gate = await probe(dir).stopGate!(ctx(dir))
        assert.equal(gate.length, 1)
        assert.match(gate[0]!.block ?? '', /b1 thing/)
      }
    )
  })

  test('actor() follows the backend\u2019s own claim identity', async () => {
    registerConnector({
      name: 'spec-fake-actor',
      tasks: () =>
        fakeStore(
          [
            { id: 'b1', status: 'in_progress', title: 'mine', issue_type: 'task', assignee: 'jira-me' },
            { id: 'b2', status: 'in_progress', title: 'held', issue_type: 'task', assignee: 'jira-other' },
          ],
          () => 'jira-me'
        ),
    })
    await withRepo(
      {
        claims: ['b1', 'b2'],
        config: { connectors: { tasks: 'spec-fake-actor' }, sdd: { mode: 'gate' } },
      },
      async (dir) => {
        const gate = await probe(dir).stopGate!(ctx(dir))
        assert.equal(gate.length, 1)
        assert.match(gate[0]!.block ?? '', /b1 mine/)
        assert.doesNotMatch(gate[0]!.block ?? '', /b2/)
      }
    )
  })
})
