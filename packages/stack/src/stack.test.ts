import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  displayBase,
  formatStackBranch,
  isStackName,
  nextIndex,
  parseStackBranch,
  planSync,
  stackMembers,
  stackNames,
  type SyncMemberInput,
} from './stack.ts'

describe('parseStackBranch', () => {
  it('parses the stack/<name>/<n>-<slug> namespace', () => {
    assert.deepEqual(parseStackBranch('stack/pay/1-bro-aa1'), {
      name: 'pay',
      n: 1,
      slug: 'bro-aa1',
      branch: 'stack/pay/1-bro-aa1',
    })
  })

  it('keeps dotted bead ids and dashes in slugs', () => {
    const b = parseStackBranch('stack/x/12-bro-chc5.1')
    assert.equal(b?.n, 12)
    assert.equal(b?.slug, 'bro-chc5.1')
  })

  it('rejects non-stack branches and malformed members', () => {
    for (const b of [
      'main',
      'work/fix-x',
      'stack/x', // no member segment
      'stack/x/abc-bead', // n must be digits
      'stack/x/1', // no slug
      'stack/a/b/1-x', // name can't contain /
    ]) {
      assert.equal(parseStackBranch(b), undefined, b)
    }
  })
})

describe('isStackName', () => {
  it('accepts word-ish names, rejects path separators and traversal', () => {
    assert.equal(isStackName('payments-v2'), true)
    assert.equal(isStackName('a/b'), false)
    assert.equal(isStackName('..'), false)
    assert.equal(isStackName('x..y'), false)
  })
})

describe('stackMembers / stackNames / nextIndex', () => {
  const branches = [
    'main',
    'stack/pay/2-bro-b',
    'stack/pay/1-bro-a',
    'stack/pay/10-bro-j',
    'stack/feed/1-bro-z',
    'work/misc',
  ]

  it('orders members bottom-up and ignores other stacks', () => {
    assert.deepEqual(
      stackMembers(branches, 'pay').map((m) => `${m.n}:${m.slug}`),
      ['1:bro-a', '2:bro-b', '10:bro-j']
    )
  })

  it('lists distinct stack names', () => {
    assert.deepEqual(stackNames(branches), ['feed', 'pay'])
  })

  it('next index is tip+1 — gaps are never refilled', () => {
    assert.equal(nextIndex(stackMembers(branches, 'pay')), 11)
    assert.equal(nextIndex([]), 1)
  })

  it('formatStackBranch round-trips through parse', () => {
    const b = formatStackBranch('pay', 3, 'bro-c')
    assert.deepEqual(parseStackBranch(b)?.n, 3)
  })
})

describe('displayBase', () => {
  const members = [
    { n: 1, branch: 'stack/s/1-a' },
    { n: 2, branch: 'stack/s/2-b' },
  ]

  it('prefers the recorded edge, else previous member, else default', () => {
    assert.equal(displayBase({ n: 1 }, members, 'main'), 'main')
    assert.equal(displayBase({ n: 2 }, members, 'main'), 'stack/s/1-a')
    assert.equal(displayBase({ n: 2, edgeBase: 'other' }, members, 'main'), 'other')
  })
})

const member = (over: Partial<SyncMemberInput> & { n: number; slug: string }): SyncMemberInput => ({
  name: 's',
  branch: `stack/s/${over.n}-${over.slug}`,
  rebaseable: true,
  ...over,
})

describe('planSync', () => {
  it('in-sync stack produces no actions', () => {
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: 'OPEN', prBase: 'main' }),
        member({ n: 2, slug: 'b', edgeBase: 'stack/s/1-a', prState: 'OPEN', prBase: 'stack/s/1-a' }),
      ],
      'main'
    )
    assert.deepEqual(plan.map((p) => [p.rebase, p.retarget]), [
      [false, false],
      [false, false],
    ])
  })

  it('merged bottom member cascades: children retarget + rebase to the new base', () => {
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: 'MERGED', prBase: 'main' }),
        member({ n: 2, slug: 'b', edgeBase: 'stack/s/1-a', prState: 'OPEN', prBase: 'stack/s/1-a' }),
        member({ n: 3, slug: 'c', edgeBase: 'stack/s/2-b', prState: 'OPEN', prBase: 'stack/s/2-b' }),
      ],
      'main'
    )
    // member 1: merged — no actions, leaves the chain
    assert.equal(plan[0]!.rebase, false)
    assert.equal(plan[0]!.retarget, false)
    // member 2: retarget onto main
    assert.equal(plan[1]!.desiredBase, 'main')
    assert.equal(plan[1]!.oldBase, 'stack/s/1-a')
    assert.equal(plan[1]!.rebase, true)
    assert.equal(plan[1]!.retarget, true)
    // member 3 still bases on (rebased) member 2
    assert.equal(plan[2]!.desiredBase, 'stack/s/2-b')
    assert.equal(plan[2]!.rebase, false)
    assert.equal(plan[2]!.retarget, false)
  })

  it('a middle merge lifts grandchildren two levels', () => {
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: 'OPEN', prBase: 'main' }),
        member({ n: 2, slug: 'b', edgeBase: 'stack/s/1-a', prState: 'MERGED', prBase: 'stack/s/1-a' }),
        member({ n: 3, slug: 'c', edgeBase: 'stack/s/2-b', prState: 'OPEN', prBase: 'stack/s/2-b' }),
      ],
      'main'
    )
    assert.equal(plan[2]!.desiredBase, 'stack/s/1-a')
    assert.equal(plan[2]!.rebase, true)
  })

  it('dirty or locked members are skipped — and their PR is not retargeted', () => {
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: 'MERGED' }),
        member({
          n: 2,
          slug: 'b',
          edgeBase: 'stack/s/1-a',
          prState: 'OPEN',
          prBase: 'stack/s/1-a',
          rebaseable: false,
          blocked: 'dirty worktree (3 file(s))',
        }),
        member({ n: 3, slug: 'c', edgeBase: 'stack/s/2-b', prState: 'OPEN', prBase: 'stack/s/2-b' }),
      ],
      'main'
    )
    assert.equal(plan[1]!.skip, 'dirty worktree (3 file(s))')
    // retarget vetoed — the unrebased branch would carry parent commits
    assert.equal(plan[1]!.retarget, false)
    // a skipped member still anchors its children — nothing for member 3
    assert.equal(plan[2]!.desiredBase, 'stack/s/2-b')
    assert.equal(plan[2]!.rebase, false)
  })

  it('member without a PR still rebases and keeps children attached', () => {
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: 'MERGED' }),
        member({ n: 2, slug: 'b', edgeBase: 'stack/s/1-a' }),
      ],
      'main'
    )
    assert.equal(plan[1]!.desiredBase, 'main')
    assert.equal(plan[1]!.rebase, true)
    assert.equal(plan[1]!.retarget, false)
  })

  it('PR base is ground truth when the edge record is missing', () => {
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: 'MERGED' }),
        member({ n: 2, slug: 'b', prState: 'OPEN', prBase: 'stack/s/1-a' }),
      ],
      'main'
    )
    assert.equal(plan[1]!.oldBase, 'stack/s/1-a')
    assert.equal(plan[1]!.rebase, true)
    assert.equal(plan[1]!.retarget, true)
  })

  it('unknown PR state keeps the member live — children still base on it', () => {
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: undefined }),
        member({ n: 2, slug: 'b', edgeBase: 'stack/s/1-a', prState: 'OPEN', prBase: 'stack/s/1-a' }),
      ],
      'main'
    )
    assert.equal(plan[1]!.desiredBase, 'stack/s/1-a')
    assert.equal(plan[1]!.rebase, false)
  })

  it('rebase without retarget for a member already pointing at the right PR base', () => {
    // edge says old base (a re-push undid the PR retarget) — PR is right,
    // branch still needs the move
    const plan = planSync(
      [
        member({ n: 1, slug: 'a', prState: 'MERGED' }),
        member({ n: 2, slug: 'b', edgeBase: 'stack/s/1-a', prState: 'OPEN', prBase: 'main' }),
      ],
      'main'
    )
    assert.equal(plan[1]!.rebase, true)
    assert.equal(plan[1]!.retarget, false)
  })
})
