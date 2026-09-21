import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parse } from 'smol-toml'
import { parseActPlan } from './plan.ts'

const parsePlan = (toml: string) => parseActPlan(parse(toml))

describe('parseActPlan', () => {
  test('parses a full batch', () => {
    const plan = parsePlan(`
kind = "act"
pr = 66

[[threads]]
thread_id = "T1"
action = "resolve"
comment = "fixed"

[[threads]]
thread_id = "T2"
action = "defer"
title = "follow-up bead"
`)
    assert.equal(plan.pr, 66)
    assert.equal(plan.threads.length, 2)
    assert.equal(plan.threads[1]!.action, 'defer')
    assert.equal(plan.threads[1]!.title, 'follow-up bead')
  })

  test('reply requires comment, defer requires title', () => {
    try {
      parsePlan(`
[[threads]]
thread_id = "T1"
action = "reply"

[[threads]]
thread_id = "T2"
action = "defer"
`)
      assert.fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      assert.match(msg, /threads\[0\]: reply requires a comment/)
      assert.match(msg, /threads\[1\]: defer requires a title/)
    }
  })

  test('rejects foreign kind, bad action, duplicate id, bad pr', () => {
    assert.throws(
      () => parsePlan('kind="debt"\n[[threads]]\nthread_id="T"\naction="resolve"'),
      /kind: expected "act"/
    )
    assert.throws(
      () => parsePlan('[[threads]]\nthread_id="T"\naction="yeet"'),
      /action must be one of/
    )
    assert.throws(
      () =>
        parsePlan(
          '[[threads]]\nthread_id="T"\naction="resolve"\n[[threads]]\nthread_id="T"\naction="reply"\ncomment="x"'
        ),
      /duplicate thread_id "T"/
    )
    assert.throws(
      () => parsePlan('pr = -1\n[[threads]]\nthread_id="T"\naction="resolve"'),
      /pr: must be a positive integer/
    )
  })

  test('flags unknown keys', () => {
    assert.throws(
      () => parsePlan('[[threads]]\nthread_id="T"\naction="resolve"\nfoo=1'),
      /threads\[0\]: unknown key "foo"/
    )
  })

  test('requires threads', () => {
    assert.throws(() => parsePlan('kind = "act"'), /threads: must be an array/)
  })
})
