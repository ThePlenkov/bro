import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PR_MANAGED_LABEL,
  PR_REVIEW_LABEL,
  prOwnership,
  stampPrOwnership,
} from './ownership.ts'
import type { PrTarget, ReviewFacade } from './review.ts'

const T: PrTarget = { repo: 'o/r', pr: 7 }

/** A facade double carrying just the stamp's reads/writes — calls land
 *  in `log`, labels/body in the mutable state. */
function fakeRev(
  init: { labels?: string[]; body?: string; bodyless?: boolean } = {},
  fail: Partial<Record<'labels' | 'create' | 'add' | 'remove' | 'body' | 'putBody', string>> = {}
): { rev: ReviewFacade; labels: string[]; body: string | undefined; warns: string[] } {
  const state = { labels: [...(init.labels ?? [])], body: init.body }
  const warns: string[] = []
  const rev = {
    prLink: (_r: string, p: number) => `[#${p}](https://x/${p})`,
    labels: () => {
      if (fail.labels) throw new Error(fail.labels)
      return [...state.labels]
    },
    createLabel: () => {
      if (fail.create) throw new Error(fail.create)
    },
    addLabel: (_t: PrTarget, l: string) => {
      if (fail.add) throw new Error(fail.add)
      state.labels.push(l)
    },
    removeLabel: (_t: PrTarget, l: string) => {
      if (fail.remove) throw new Error(fail.remove)
      state.labels = state.labels.filter((x) => x !== l)
    },
    ...(init.bodyless
      ? {}
      : {
          prBody: () => {
            if (fail.body) throw new Error(fail.body)
            return state.body ?? ''
          },
          updatePrBody: (_t: PrTarget, b: string) => {
            if (fail.putBody) throw new Error(fail.putBody)
            state.body = b
          },
        }),
  } as unknown as ReviewFacade
  const warn = (m: string) => warns.push(m)
  return {
    rev,
    warns,
    get labels() {
      return state.labels
    },
    get body() {
      return state.body
    },
  }
}

describe('prOwnership', () => {
  test('labels → verdict; absence is human', () => {
    assert.equal(prOwnership([PR_MANAGED_LABEL, 'size:m']), 'managed')
    assert.equal(prOwnership([PR_REVIEW_LABEL]), 'review')
    assert.equal(prOwnership(['size:m']), 'human')
    assert.equal(prOwnership([]), 'human')
  })

  test('both labels → managed wins (should never coexist, but the stamp removes the loser)', () => {
    assert.equal(prOwnership([PR_REVIEW_LABEL, PR_MANAGED_LABEL]), 'managed')
  })
})

describe('stampPrOwnership', () => {
  test('managed: label + trailer land on a fresh PR', () => {
    const f = fakeRev({ body: 'human prose' })
    stampPrOwnership(f.rev, T, {
      ownership: 'managed',
      meta: { managed: true, bead: 'bro-x', mode: 'loop', run: 'loop/bro-x' },
    }, (m) => f.warns.push(m))
    assert.deepEqual(f.labels, [PR_MANAGED_LABEL])
    assert.equal(
      f.body,
      'human prose\n\n<!-- bro: {"managed":true,"bead":"bro-x","mode":"loop","run":"loop/bro-x"} -->'
    )
    assert.deepEqual(f.warns, [])
  })

  test('review: stamps the review label', () => {
    const f = fakeRev()
    stampPrOwnership(f.rev, T, {
      ownership: 'review',
      meta: { managed: false, mode: 'drive', run: 'work/x' },
    }, (m) => f.warns.push(m))
    assert.deepEqual(f.labels, [PR_REVIEW_LABEL])
    assert.match(f.body ?? '', /<!-- bro: {"managed":false,"mode":"drive","run":"work\/x"} -->/)
  })

  test('labels are exclusive — stamping managed removes a review label', () => {
    const f = fakeRev({ labels: [PR_REVIEW_LABEL, 'size:m'] })
    stampPrOwnership(f.rev, T, { ownership: 'managed', meta: {} }, (m) => f.warns.push(m))
    assert.deepEqual(f.labels.sort(), ['size:m', PR_MANAGED_LABEL].sort())
  })

  test('already-labeled PR: no duplicate label, trailer still refreshes', () => {
    const f = fakeRev({
      labels: [PR_MANAGED_LABEL],
      body: 'x\n\n<!-- bro: {"managed":true,"bead":"bro-a"} -->',
    })
    stampPrOwnership(f.rev, T, {
      ownership: 'managed',
      meta: { managed: true, mode: 'drive' },
    }, (m) => f.warns.push(m))
    assert.deepEqual(f.labels, [PR_MANAGED_LABEL])
    // bead survives — merge, not replace
    assert.match(f.body ?? '', /"bead":"bro-a"/)
    assert.match(f.body ?? '', /"mode":"drive"/)
  })

  test('unchanged trailer → no body write (steady-state pass writes nothing)', () => {
    const body = 'x\n\n<!-- bro: {"managed":true,"mode":"drive"} -->'
    const f = fakeRev({ labels: [PR_MANAGED_LABEL], body })
    stampPrOwnership(f.rev, T, {
      ownership: 'managed',
      meta: { managed: true, mode: 'drive' },
    }, (m) => f.warns.push(m))
    assert.equal(f.body, body)
  })

  test('a host without body access still labels, silently', () => {
    const f = fakeRev({ bodyless: true })
    stampPrOwnership(f.rev, T, { ownership: 'managed', meta: {} }, (m) => f.warns.push(m))
    assert.deepEqual(f.labels, [PR_MANAGED_LABEL])
    assert.deepEqual(f.warns, [])
  })

  test('every half is independently best-effort — label failure still lands the trailer', () => {
    const f = fakeRev({ body: '' }, { labels: 'host down' })
    stampPrOwnership(f.rev, T, { ownership: 'managed', meta: { managed: true } }, (m) =>
      f.warns.push(m)
    )
    assert.deepEqual(f.labels, [])
    assert.match(f.body ?? '', /"managed":true/)
    assert.equal(f.warns.length, 1)
    assert.match(f.warns[0]!, /ownership label/)
  })

  test('trailer failure still lands the label', () => {
    const f = fakeRev({}, { putBody: 'read-only' })
    stampPrOwnership(f.rev, T, { ownership: 'managed', meta: { managed: true } }, (m) =>
      f.warns.push(m)
    )
    assert.deepEqual(f.labels, [PR_MANAGED_LABEL])
    assert.equal(f.warns.length, 1)
    assert.match(f.warns[0]!, /provenance trailer/)
  })

  test('a mid-stamp failure (addLabel throws) warns without killing the trailer half', () => {
    const f = fakeRev({ body: '' }, { add: 'no permission' })
    stampPrOwnership(f.rev, T, { ownership: 'managed', meta: { managed: true } }, (m) =>
      f.warns.push(m)
    )
    assert.deepEqual(f.labels, [])
    assert.match(f.body ?? '', /"managed":true/)
  })
})
