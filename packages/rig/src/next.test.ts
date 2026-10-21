/** `rigNext` unit tests — the verdict ladder over durable state with no
 *  CLI in the loop (bro-jamp7's boundary rule): a scripted `bd` on PATH
 *  answers show/ready/list/dep, a tmpdir git repo holds the registry and
 *  linked worktrees, a `registerConnector`'d reviews host fakes the
 *  forge. No plugin registry, no `process.exit`, no spawned `bro`. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerConnector, type ReviewFacade } from '@broject/core'
import { rigFocus, rigNext } from './next.ts'

/** `show <id>` answers `$FAKE_BD_DIR/show-<id>.json` when the fixture
 *  wrote one — the miss is bd's real contract (`Issue <id> not found`
 *  on stderr + exit 1) so `store.get` reads undefined, not an error. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version) echo 'bd 0.0' ;;
  info) echo '{"schema_version":1}' ;;
  show)
    f="$FAKE_BD_DIR/show-$2.json"
    if [ -f "$f" ]; then cat "$f"; else echo "Issue $2 not found" >&2; exit 1; fi ;;
  ready) cat "$FAKE_BD_READY" ;;
  dep) echo '[]' ;;
  undefer) echo '[]' ;;
  list)
    case "$*" in
      *deferred*) echo '[]' ;;
      *drill*) cat "$FAKE_BD_DRILL" ;;
      *queue:*) cat "$FAKE_BD_QUEUE" ;;
      *) echo '[]' ;;
    esac ;;
  *) echo '[]' ;;
esac
`

interface Fixture {
  dir: string
  /** stage a `bd show` row for id */
  row: (id: string, row: Record<string, unknown>) => void
  /** what `bd ready` answers */
  ready: (rows: unknown[]) => void
  /** what `bd list -l queue:*` / `-l drill` answer */
  listed: (rows: unknown[], label?: 'queue' | 'drill') => void
  /** `<git-common>/bro/agents.json` entries */
  agents: (entries: Record<string, unknown>) => void
  restore: () => void
}

const git = (dir: string, args: string[]): void => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
}

/** A real git repo + a scripted `bd` on PATH. The store, the registry
 *  dir, and the worktree plane are all real reads — only the backend
 *  binaries are canned. */
function fixture(prefix = 'bro-rig-'): Fixture {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
  const fakeDir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'))
  writeFileSync(join(fakeDir, 'bd'), FAKE_BD)
  chmodSync(join(fakeDir, 'bd'), 0o755)
  const readyFile = join(fakeDir, 'ready.json')
  const queueFile = join(fakeDir, 'queue.json')
  const drillFile = join(fakeDir, 'drill.json')
  writeFileSync(readyFile, '[]')
  writeFileSync(queueFile, '[]')
  writeFileSync(drillFile, '[]')
  const prev: Record<string, string | undefined> = {}
  const set = (k: string, v: string | undefined): void => {
    if (!(k in prev)) prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  set('PATH', `${fakeDir}:${process.env.PATH}`)
  set('FAKE_BD_DIR', fakeDir)
  set('FAKE_BD_READY', readyFile)
  set('FAKE_BD_QUEUE', queueFile)
  set('FAKE_BD_DRILL', drillFile)
  set('BEADS_ACTOR', 'tester')
  // an inherited pin would route a real bd somewhere else — the fake
  // ignores env, but the store's own probes read it
  set('BEADS_DIR', undefined)
  set('BD_ACTOR', undefined)
  return {
    dir,
    row: (id, row) =>
      writeFileSync(join(fakeDir, `show-${id}.json`), JSON.stringify([row])),
    ready: (rows) => writeFileSync(readyFile, JSON.stringify(rows)),
    listed: (rows, label = 'queue') =>
      writeFileSync(label === 'queue' ? queueFile : drillFile, JSON.stringify(rows)),
    agents: (entries) => {
      const bro = join(dir, '.git', 'bro')
      mkdirSync(bro, { recursive: true })
      writeFileSync(join(bro, 'agents.json'), JSON.stringify(entries))
    },
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
  }
}

const bead = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

describe('rigNext — the verdict ladder', () => {
  test('empty store reports done; an unknown id reports blocked', () => {
    const f = fixture()
    try {
      assert.deepEqual(rigNext(f.dir), { verdict: 'done' })
      assert.deepEqual(rigNext(f.dir, 'nope'), {
        verdict: 'blocked',
        id: 'nope',
        detail: 'unknown id',
      })
    } finally {
      f.restore()
    }
  })

  test('closed row is done; waiting label is wait with its WAKE predicate', () => {
    const f = fixture()
    try {
      f.row('c-1', bead('c-1', { status: 'closed' }))
      f.row('w-1', bead('w-1', {
        labels: ['drill', 'waiting'],
        notes: 'context\nWAKE: gate green on #7',
      }))
      assert.deepEqual(rigNext(f.dir, 'c-1'), { verdict: 'done', id: 'c-1' })
      assert.deepEqual(rigNext(f.dir, 'w-1'), {
        verdict: 'wait',
        id: 'w-1',
        detail: 'gate green on #7',
      })
    } finally {
      f.restore()
    }
  })

  test('a live registry agent is wait; a remote one is wait too; a recorded exit falls through', () => {
    const f = fixture()
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    assert.ok(sleeper.pid !== undefined)
    try {
      f.row('a-1', bead('a-1', { status: 'in_progress', assignee: 'tester' }))
      f.row('r-1', bead('r-1', { status: 'in_progress', assignee: 'tester' }))
      f.row('x-1', bead('x-1'))
      f.ready([bead('x-1')])
      f.agents({
        'a-1': { agentId: 'native-zz', backend: 'native', pid: sleeper.pid },
        'r-1': { agentId: 'devin-zz', backend: 'devin', sessionId: 'sess-1' },
        'x-1': { agentId: 'native-yy', backend: 'native', exitStatus: 0 },
      })
      assert.equal(rigNext(f.dir, 'a-1').verdict, 'wait')
      assert.match(rigNext(f.dir, 'a-1').detail ?? '', /agent native-zz in flight/)
      assert.equal(rigNext(f.dir, 'r-1').verdict, 'wait')
      // the recorded death drops the wait — the open+ready row steps
      assert.equal(rigNext(f.dir, 'x-1').verdict, 'step')
    } finally {
      sleeper.kill('SIGKILL')
      f.restore()
    }
  })

  test('stopped marker on a live pid still waits — SIGTERM has not landed', () => {
    const f = fixture()
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    assert.ok(sleeper.pid !== undefined)
    try {
      f.row('s-1', bead('s-1', { status: 'in_progress', assignee: 'tester' }))
      f.agents({ 's-1': { agentId: 'native-zz', backend: 'native', pid: sleeper.pid, stopped: true } })
      assert.equal(rigNext(f.dir, 's-1').verdict, 'wait')
    } finally {
      sleeper.kill('SIGKILL')
      f.restore()
    }
  })

  test('foreign claim is blocked; own claim is step; dep-gated open is blocked', () => {
    const f = fixture()
    try {
      f.row('c-1', bead('c-1', { status: 'in_progress', assignee: 'other-actor' }))
      f.row('c-2', bead('c-2', { status: 'in_progress', assignee: 'tester' }))
      f.row('g-1', bead('g-1')) // open, but absent from the ready list
      assert.equal(rigNext(f.dir, 'c-1').verdict, 'blocked')
      assert.match(rigNext(f.dir, 'c-1').detail ?? '', /claimed by other-actor/)
      assert.deepEqual(rigNext(f.dir, 'c-2'), {
        verdict: 'step',
        id: 'c-2',
        detail: 'own claim — resume',
      })
      assert.equal(rigNext(f.dir, 'g-1').verdict, 'blocked')
      assert.match(rigNext(f.dir, 'g-1').detail ?? '', /dep-gated/)
    } finally {
      f.restore()
    }
  })

  test('open + ready is step; a queued row reports its rank', () => {
    const f = fixture()
    try {
      f.row('r-1', bead('r-1'))
      f.row('q-1', bead('q-1', { labels: ['queue:root', 'qrank:1'] }))
      f.ready([bead('r-1'), bead('q-1', { labels: ['queue:root', 'qrank:1'] })])
      f.listed([bead('q-1', { labels: ['queue:root', 'qrank:1'] })])
      assert.deepEqual(rigNext(f.dir, 'r-1'), { verdict: 'step', id: 'r-1', detail: undefined })
      assert.deepEqual(rigNext(f.dir, 'q-1'), {
        verdict: 'step',
        id: 'q-1',
        detail: 'queue rank 1',
      })
    } finally {
      f.restore()
    }
  })
})

describe('rigFocus — the no-arg item resolution', () => {
  test('the frame queue top beats the ready list', () => {
    const f = fixture()
    try {
      f.listed([bead('q-1', { labels: ['queue:root', 'qrank:1'] })])
      f.ready([bead('r-1')])
      assert.equal(rigFocus(f.dir), 'q-1')
      // and the no-arg verdict walks the same pick
      assert.equal(rigNext(f.dir).id, 'q-1')
    } finally {
      f.restore()
    }
  })

  test('the drill leaf is the fallback when the queue is empty', () => {
    const f = fixture()
    try {
      f.listed([
        {
          ...bead('d-1', { labels: ['drill'] }),
          updated_at: '2026-01-02T00:00:00Z',
        },
      ], 'drill')
      f.ready([bead('r-1')])
      assert.equal(rigFocus(f.dir), 'd-1')
    } finally {
      f.restore()
    }
  })

  test('the ready list is the last resort; epics are not work items', () => {
    const f = fixture()
    try {
      f.ready([bead('e-1', { issue_type: 'epic' }), bead('r-1')])
      assert.equal(rigFocus(f.dir), 'r-1')
    } finally {
      f.restore()
    }
  })
})

describe('rigNext — the gate probe', () => {
  const reviews = (open: number[], all: number[]): ReviewFacade =>
    ({ prsForBranch: (_b, state) => (state === 'all' ? all : open) }) as ReviewFacade

  test('an open PR on the item worktree branch is gate; settled is the cleanup step', () => {
    const f = fixture()
    try {
      writeFileSync(
        join(f.dir, 'bro.config.json'),
        JSON.stringify({ connectors: { reviews: 'fakegate' } })
      )
      registerConnector({
        name: 'fakegate',
        reviews: () => reviews([7], [7]),
      })
      f.row('g-1', bead('g-1'))
      const wt = join(f.dir, '..', `${f.dir.split('/').pop()}--g-1`)
      git(f.dir, ['worktree', 'add', '-b', 'work/g-1', wt])
      assert.deepEqual(rigNext(f.dir, 'g-1'), {
        verdict: 'gate',
        id: 'g-1',
        detail: 'pr=#7',
      })
      // gate:false skips the forge probe entirely — the open row's
      // own status decides (blocked: not on the ready list)
      assert.equal(rigNext(f.dir, 'g-1', { gate: false }).verdict, 'blocked')
      git(f.dir, ['worktree', 'remove', '--force', wt])
    } finally {
      f.restore()
    }
  })

  test('a settled PR + open bead is the finalize step', () => {
    const f = fixture()
    try {
      writeFileSync(
        join(f.dir, 'bro.config.json'),
        JSON.stringify({ connectors: { reviews: 'fakesettled' } })
      )
      registerConnector({
        name: 'fakesettled',
        reviews: () => reviews([], [7]),
      })
      f.row('g-2', bead('g-2'))
      const wt = join(f.dir, '..', `${f.dir.split('/').pop()}--g-2`)
      git(f.dir, ['worktree', 'add', '-b', 'work/g-2', wt])
      assert.equal(rigNext(f.dir, 'g-2').verdict, 'step')
      assert.match(rigNext(f.dir, 'g-2').detail ?? '', /pr settled/)
      git(f.dir, ['worktree', 'remove', '--force', wt])
    } finally {
      f.restore()
    }
  })

  test('an unreachable host is the honest wait, never a double-work step', () => {
    const f = fixture()
    try {
      writeFileSync(
        join(f.dir, 'bro.config.json'),
        JSON.stringify({ connectors: { reviews: 'fakedown' } })
      )
      registerConnector({
        name: 'fakedown',
        reviews: () => {
          throw new Error('host down')
        },
      })
      f.row('g-3', bead('g-3'))
      const wt = join(f.dir, '..', `${f.dir.split('/').pop()}--g-3`)
      git(f.dir, ['worktree', 'add', '-b', 'work/g-3', wt])
      assert.deepEqual(rigNext(f.dir, 'g-3'), {
        verdict: 'wait',
        id: 'g-3',
        detail: 'review host unreachable',
      })
      git(f.dir, ['worktree', 'remove', '--force', wt])
    } finally {
      f.restore()
    }
  })
})
