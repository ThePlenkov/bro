import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nextStep, stepKind, stepsOf } from './molecule.ts'
import type { Molecule, MolIssue } from './types.ts'

const issue = (id: string, over: Partial<MolIssue> = {}): MolIssue => ({
  id,
  title: id,
  status: 'open',
  issue_type: 'task',
  ...over,
})

const mol = (issues: MolIssue[], deps: { from: string; to: string }[]): Molecule => ({
  root: issues[0]!,
  issues,
  dependencies: [
    // every step is a child of the root
    ...issues.slice(1).map((i) => ({ issue_id: i.id, depends_on_id: issues[0]!.id, type: 'parent-child' })),
    // `from` blocks `to` → bd edge {issue_id: to, depends_on_id: from}
    ...deps.map((d) => ({ issue_id: d.to, depends_on_id: d.from, type: 'blocks' })),
  ],
})

describe('stepsOf', () => {
  it('marks a step with an open blocker as blocked', () => {
    const m = mol([issue('root', { issue_type: 'molecule' }), issue('a'), issue('b')], [{ from: 'a', to: 'b' }])
    const steps = stepsOf(m)
    assert.equal(steps.find((s) => s.id === 'a')!.state, 'ready')
    assert.equal(steps.find((s) => s.id === 'b')!.state, 'blocked')
    assert.deepEqual(steps.find((s) => s.id === 'b')!.blockedBy, ['a'])
  })

  it('unblocks a step once its blocker is closed', () => {
    const m = mol(
      [issue('root', { issue_type: 'molecule' }), issue('a', { status: 'closed' }), issue('b')],
      [{ from: 'a', to: 'b' }],
    )
    assert.equal(stepsOf(m).find((s) => s.id === 'b')!.state, 'ready')
  })

  it('excludes the molecule root from steps', () => {
    const m = mol([issue('root', { issue_type: 'molecule' }), issue('a')], [])
    assert.deepEqual(stepsOf(m).map((s) => s.id), ['a'])
  })
})

describe('stepKind', () => {
  it('honors declared types', () => {
    assert.equal(stepKind(issue('x', { issue_type: 'human' })), 'human')
    assert.equal(stepKind(issue('x', { issue_type: 'gate' })), 'human')
    assert.equal(stepKind(issue('x', { issue_type: 'agent' })), 'agent')
  })

  it('treats the title as display-only — gate-titled tasks are agent work', () => {
    assert.equal(stepKind(issue('x', { title: 'HUMAN GATE — approve plan' })), 'agent')
    assert.equal(stepKind(issue('x', { title: 'GATE — bro act status' })), 'agent')
    assert.equal(stepKind(issue('x', { title: 'Merge — bro act merge' })), 'agent')
  })
})

describe('nextStep', () => {
  const chain = (statuses: string[]): Molecule =>
    mol(
      [
        issue('root', { issue_type: 'molecule' }),
        issue('a', { status: statuses[0] }),
        issue('b', { status: statuses[1] }),
        issue('g', { status: statuses[2], issue_type: 'human', title: 'Approve the release' }),
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'g' },
      ],
    )

  it('emits the first ready step', () => {
    const n = nextStep(chain(['open', 'open', 'open']))
    assert.equal(n.state, 'step')
    assert.equal(n.step!.id, 'a')
    assert.deepEqual(n.blocked, ['b', 'g'])
  })

  it('advances after the blocker closes', () => {
    const n = nextStep(chain(['closed', 'open', 'open']))
    assert.equal(n.step!.id, 'b')
  })

  it('reports a human gate as gate state', () => {
    const n = nextStep(chain(['closed', 'closed', 'open']))
    assert.equal(n.state, 'gate')
    assert.equal(n.step!.id, 'g')
  })

  it('reports complete when every step is done', () => {
    const n = nextStep(chain(['closed', 'closed', 'closed']))
    assert.equal(n.state, 'complete')
  })

  it('reports blocked on a dependency cycle', () => {
    const m = mol(
      [issue('root', { issue_type: 'molecule' }), issue('a'), issue('b')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    )
    const n = nextStep(m)
    assert.equal(n.state, 'blocked')
    assert.deepEqual(n.blocked.sort(), ['a', 'b'])
    assert.deepEqual(n.stuck.sort(), ['a', 'b'])
  })

  it('marks a chain ending in a cycle stuck — nothing upstream can release it', () => {
    const m = mol(
      [issue('root', { issue_type: 'molecule' }), issue('a'), issue('b'), issue('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'b', to: 'c' },
      ],
    )
    const n = nextStep(m)
    assert.deepEqual(n.stuck.sort(), ['a', 'b', 'c'])
  })

  it('a step waiting on an in-progress claim is transiently blocked, not stuck', () => {
    const m = mol(
      [
        issue('root', { issue_type: 'molecule' }),
        issue('a', { status: 'in_progress' }),
        issue('b'),
      ],
      [{ from: 'a', to: 'b' }],
    )
    const n = nextStep(m)
    assert.equal(n.state, 'blocked')
    assert.deepEqual(n.stuck, [])
  })

  it('a blocked step waiting on open work outside the mol is not stuck', () => {
    const m = mol([issue('root', { issue_type: 'molecule' }), issue('a')], [
      { from: 'external-issue', to: 'a' },
    ])
    const n = nextStep(m)
    assert.equal(n.state, 'blocked')
    assert.deepEqual(n.stuck, [])
  })

  it('exposes independent ready steps for parallelism', () => {
    const m = mol([issue('root', { issue_type: 'molecule' }), issue('a'), issue('b')], [])
    const n = nextStep(m)
    assert.equal(n.state, 'step')
    assert.equal(n.ready.length, 2)
    assert.equal(n.step!.id, 'a')
  })
})
