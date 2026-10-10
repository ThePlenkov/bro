import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { MirrorPolicy, PublishResult, TaskRow, TaskStore } from '@broject/core'
import { mirrorable, projectBeads } from './mirror.ts'

const POLICY: MirrorPolicy = {
  labels: [],
  excludeLabels: [],
  types: ['feature', 'bug'],
  specLinked: true,
}

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 'bro-x1',
  title: 'do the thing',
  ...over,
})

/** The minimal store fake — rows by id, every write-back recorded. */
function fakeStore(rows: TaskRow[], publish?: TaskStore['publish']): TaskStore & {
  updates: [string, Record<string, string | number>][]
} {
  const updates: [string, Record<string, string | number>][] = []
  const store: TaskStore & { updates: [string, Record<string, string | number>][] } = {
    updates,
    list: () => rows as never,
    ready: () => rows as never,
    get: (id) => rows.find((r) => r.id === id) as never,
    create: () => {
      throw new Error('unused')
    },
    update: (id, patch) => {
      updates.push([id, patch])
      const r = rows.find((x) => x.id === id)
      if (r !== undefined && 'external-ref' in patch) {
        r.external_ref = String(patch['external-ref'])
      }
    },
    claim: () => {},
    reopen: () => {},
    close: () => {},
    remove: () => {},
    note: () => {},
    children: () => [],
    deps: () => [],
    neighbors: () => [],
    link: () => {},
    prefix: () => 'bro',
    publish,
  }
  return store
}

const deps = (
  tasks: TaskStore,
  over: Partial<Parameters<typeof projectBeads>[0]> = {}
): Parameters<typeof projectBeads>[0] => ({
  tasks,
  mirror: tasks,
  hasSpec: () => false,
  policy: POLICY,
  ...over,
})

const published = (id: string, epicRef?: string): PublishResult => ({
  item: { id, external_ref: `https://github.com/acme/widgets/issues/${id}` },
  ...(epicRef !== undefined ? { epicRef } : {}),
})

describe('mirrorable', () => {
  const noSpec = () => false

  test('a board type admits outright', () => {
    assert.equal(mirrorable(row({ issue_type: 'feature' }), POLICY, noSpec), true)
    assert.equal(mirrorable(row({ issue_type: 'bug' }), POLICY, noSpec), true)
  })

  test('ephemeral and sink labels veto regardless of type', () => {
    assert.equal(mirrorable(row({ ephemeral: true, issue_type: 'feature' }), POLICY, noSpec), false)
    for (const l of ['debt', 'fixer', 'wtf', 'retro', 'drill', 'mesh:org/repo']) {
      assert.equal(mirrorable(row({ labels: [l], issue_type: 'feature' }), POLICY, noSpec), false, l)
    }
  })

  test('a configured force-label admits a plain task', () => {
    const p = { ...POLICY, labels: ['board'] }
    assert.equal(mirrorable(row({ issue_type: 'task', labels: ['board'] }), p, noSpec), true)
  })

  test('a configured exclude-label vetoes even a feature', () => {
    const p = { ...POLICY, excludeLabels: ['internal'] }
    assert.equal(mirrorable(row({ issue_type: 'feature', labels: ['internal'] }), p, noSpec), false)
    // the veto also beats a force-label — exclusions read first
    const p2 = { ...p, labels: ['internal'] }
    assert.equal(mirrorable(row({ labels: ['internal'] }), p2, noSpec), false)
  })

  test('a plain task with no spec link stays internal', () => {
    assert.equal(mirrorable(row({ issue_type: 'task' }), POLICY, noSpec), false)
  })

  test('specLinked admits via the facade probe or a spec: description link', () => {
    assert.equal(mirrorable(row({ issue_type: 'task' }), POLICY, (id) => id === 'bro-x1'), true)
    assert.equal(
      mirrorable(row({ issue_type: 'task', description: 'see spec: specs/x.md' }), POLICY, noSpec),
      true
    )
    // probe failure fails open onto the description link
    assert.equal(
      mirrorable(
        row({ issue_type: 'task', description: 'spec: specs/x.md' }),
        POLICY,
        () => {
          throw new Error('wedged')
        }
      ),
      true
    )
  })

  test('specLinked: false narrows to types/labels only', () => {
    const p = { ...POLICY, specLinked: false }
    assert.equal(mirrorable(row({ issue_type: 'task' }), p, () => true), false)
    assert.equal(mirrorable(row({ issue_type: 'feature' }), p, () => false), true)
  })
})

describe('projectBeads', () => {
  test('no publish port → nothing projects, nothing written', () => {
    const tasks = fakeStore([row({ issue_type: 'feature' })])
    const refs = projectBeads(deps(tasks, { mirror: fakeStore([]) }), ['bro-x1'])
    assert.deepEqual(refs, [])
    assert.equal((tasks as { updates: unknown[] }).updates.length, 0)
  })

  test('a projected bead writes its external_ref back and returns the tracker id', () => {
    const beadRow = row({ issue_type: 'feature' })
    const tasks = fakeStore([beadRow], () => published('42'))
    const refs = projectBeads(deps(tasks), ['bro-x1'])
    assert.deepEqual(refs, ['42'])
    assert.deepEqual(
      (tasks as { updates: [string, Record<string, string | number>][] }).updates,
      [['bro-x1', { 'external-ref': 'https://github.com/acme/widgets/issues/42' }]]
    )
  })

  test('a declined publish (foreign map) touches nothing', () => {
    const tasks = fakeStore(
      [row({ issue_type: 'feature', external_ref: 'jira:ACME-7' })],
      () => undefined
    )
    assert.deepEqual(projectBeads(deps(tasks), ['bro-x1']), [])
    assert.equal((tasks as { updates: unknown[] }).updates.length, 0)
  })

  test('an existing external_ref is never clobbered by a later publish', () => {
    // publish still ran (idempotent dedup is the connector's job) — the
    // write-back gate is on persistRef, which must see the ref occupied
    const tasks = fakeStore(
      [row({ issue_type: 'feature', external_ref: 'debt://thread-9' })],
      () => published('42')
    )
    assert.deepEqual(projectBeads(deps(tasks), ['bro-x1']), ['42'])
    assert.equal((tasks as { updates: unknown[] }).updates.length, 0)
  })

  test('an epic parent passes through and its ref writes back on the epic row', () => {
    const epic = row({ id: 'bro-e1', issue_type: 'epic', title: 'the epic' })
    const child = row({ id: 'bro-c1', issue_type: 'feature', parent: 'bro-e1' })
    let seenEpic: TaskRow | undefined
    const tasks = fakeStore([epic, child], (_t, opts) => {
      seenEpic = opts?.epic
      return published('42', 'https://github.com/acme/widgets/milestone/3')
    })
    const refs = projectBeads(deps(tasks), ['bro-c1'])
    assert.deepEqual(refs, ['42'])
    assert.equal(seenEpic?.id, 'bro-e1')
    const updates = (tasks as { updates: [string, Record<string, string | number>][] }).updates
    assert.deepEqual(updates, [
      ['bro-c1', { 'external-ref': 'https://github.com/acme/widgets/issues/42' }],
      ['bro-e1', { 'external-ref': 'https://github.com/acme/widgets/milestone/3' }],
    ])
  })

  test('a non-epic parent is not offered as the container', () => {
    const parent = row({ id: 'bro-m1', issue_type: 'task', title: 'mol step' })
    const child = row({ id: 'bro-c1', issue_type: 'feature', parent: 'bro-m1' })
    let seenEpic: TaskRow | undefined | null = null
    const tasks = fakeStore([parent, child], (_t, opts) => {
      seenEpic = opts?.epic
      return published('42')
    })
    projectBeads(deps(tasks), ['bro-c1'])
    assert.equal(seenEpic, undefined)
  })

  test('unmirrorable beads and publish failures never block the rest', () => {
    const sink = row({ id: 'bro-s1', issue_type: 'task', labels: ['debt'] })
    const boom = row({ id: 'bro-b1', issue_type: 'feature' })
    const good = row({ id: 'bro-g1', issue_type: 'feature' })
    const tasks = fakeStore([sink, boom, good], (t) => {
      if (t.id === 'bro-b1') {
        throw new Error('tracker down')
      }
      return published('99')
    })
    const refs = projectBeads(deps(tasks), ['bro-s1', 'bro-b1', 'bro-g1'])
    assert.deepEqual(refs, ['99'])
    // only the good bead got its write-back
    const updates = (tasks as { updates: [string, unknown][] }).updates
    assert.equal(updates.length, 1)
  })

  test('an unreadable bead skips quietly', () => {
    const tasks = fakeStore([], () => published('42'))
    assert.deepEqual(projectBeads(deps(tasks), ['bro-ghost']), [])
  })
})
