import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loopSection } from './config.ts'
import { planItem } from './item.ts'
import { buildFixPrompt, buildWorkPrompt, expandAgentCmd } from './prompt.ts'
import { DEFAULT_LOOP_CONFIG, type LoopBead } from './types.ts'

const bead: LoopBead = {
  id: 'bro-x1',
  title: 'add the thing',
  description: 'because reasons\nsecond line',
  priority: 2,
  issue_type: 'task',
}

describe('loopSection', () => {
  test('defaults when absent or garbage', () => {
    assert.deepEqual(loopSection(undefined), DEFAULT_LOOP_CONFIG)
    assert.deepEqual(loopSection('junk'), DEFAULT_LOOP_CONFIG)
    assert.deepEqual(loopSection(42), DEFAULT_LOOP_CONFIG)
  })

  test('blank strings and bad numbers fall back', () => {
    const cfg = loopSection({ agent: '  ', agentTimeoutMin: -5, maxItems: 'two' })
    assert.equal(cfg.agent, '')
    assert.equal(cfg.agentTimeoutMin, DEFAULT_LOOP_CONFIG.agentTimeoutMin)
    assert.equal(cfg.maxItems, 0)
  })

  test('zero timeouts fall back — 0 would park every gate instantly', () => {
    const cfg = loopSection({ agentTimeoutMin: 0, mergeTimeoutMin: 0, maxItems: 0 })
    assert.equal(cfg.agentTimeoutMin, DEFAULT_LOOP_CONFIG.agentTimeoutMin)
    assert.equal(cfg.mergeTimeoutMin, DEFAULT_LOOP_CONFIG.mergeTimeoutMin)
    assert.equal(cfg.maxItems, 0) // 0 is valid for maxItems — means unlimited
  })

  test('valid values pass through', () => {
    const cfg = loopSection({
      agent: 'devin -p',
      bootstrap: 'npm ci',
      agentTimeoutMin: 30,
      mergeTimeoutMin: 60,
      fixRounds: 2,
      maxItems: 5,
    })
    assert.deepEqual(cfg, {
      agent: 'devin -p',
      bootstrap: 'npm ci',
      agentTimeoutMin: 30,
      mergeTimeoutMin: 60,
      fixRounds: 2,
      maxItems: 5,
    })
  })
})

describe('planItem', () => {
  test('sibling dir + loop branch derived from the repo root', () => {
    const item = planItem(bead, '/home/u/projects/bro')
    assert.equal(item.branch, 'loop/bro-x1')
    assert.equal(item.worktreeDir, '/home/u/projects/bro--bro-x1')
    // outside the worktree — `git add -A` must never sweep it into the PR
    assert.equal(item.promptFile, join(tmpdir(), 'bro-loop', 'bro-x1', 'prompt.md'))
  })

  test('ids that sanitize to the same slug get distinct names', () => {
    const a = planItem({ ...bead, id: 'mol/a-b' }, '/repo')
    const b = planItem({ ...bead, id: 'mol-a-b' }, '/repo')
    assert.notEqual(a.branch, b.branch)
    assert.notEqual(a.worktreeDir, b.worktreeDir)
  })
})

describe('prompts', () => {
  test('work prompt carries the bead and the rules', () => {
    const p = buildWorkPrompt(bead, 'loop/bro-x1')
    assert.match(p, /bro-x1/)
    assert.match(p, /add the thing/)
    assert.match(p, /because reasons/)
    assert.match(p, /`loop\/bro-x1`/)
    assert.match(p, /gh pr create/)
    assert.match(p, /Do NOT merge/)
  })

  test('fix prompt carries the threads verbatim', () => {
    const p = buildFixPrompt(bead, 42, 'tid-1\t reviewer says fix foo')
    assert.match(p, /#42/)
    assert.match(p, /reviewer says fix foo/)
    assert.match(p, /Do NOT merge/)
  })
})

describe('expandAgentCmd', () => {
  test('placeholder is replaced with the quoted path', () => {
    assert.equal(
      expandAgentCmd('devin --prompt-file {promptFile} -p', '/tmp/wt/p.md'),
      "devin --prompt-file '/tmp/wt/p.md' -p"
    )
  })

  test('no placeholder → path appended as the last arg', () => {
    assert.equal(expandAgentCmd('myagent run', '/tmp/p.md'), "myagent run '/tmp/p.md'")
  })

  test('paths with quotes are escaped', () => {
    assert.equal(
      expandAgentCmd('a {promptFile}', "/tmp/o'brien/p.md"),
      "a '/tmp/o'\\''brien/p.md'"
    )
  })
})
