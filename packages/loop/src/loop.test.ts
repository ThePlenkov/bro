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

  test('string values are trimmed — padded keys still hit exact lookups', () => {
    const cfg = loopSection({ provider: '  kilo-cli  ', model: ' m-1 ' })
    assert.equal(cfg.provider, 'kilo-cli')
    assert.equal(cfg.model, 'm-1')
  })

  test('valid values pass through', () => {
    const cfg = loopSection({
      agent: 'devin -p',
      provider: 'kilo-cli',
      profile: 'cheap',
      model: 'm-1',
      bootstrap: 'npm ci',
      agentTimeoutMin: 30,
      crashExitMs: 5_000,
      mergeTimeoutMin: 60,
      fixRounds: 2,
      maxItems: 5,
      maxOpen: 2,
    })
    assert.deepEqual(cfg, {
      agent: 'devin -p',
      provider: 'kilo-cli',
      profile: 'cheap',
      model: 'm-1',
      bootstrap: 'npm ci',
      agentTimeoutMin: 30,
      crashExitMs: 5_000,
      mergeTimeoutMin: 60,
      fixRounds: 2,
      maxItems: 5,
      maxOpen: 2,
    })
  })

  test('crashExitMs: 0 is valid (legacy reopen), negatives/junk fall back', () => {
    assert.equal(loopSection({ crashExitMs: 0 }).crashExitMs, 0)
    assert.equal(
      loopSection({ crashExitMs: -1 }).crashExitMs,
      DEFAULT_LOOP_CONFIG.crashExitMs
    )
    assert.equal(
      loopSection({ crashExitMs: 'fast' }).crashExitMs,
      DEFAULT_LOOP_CONFIG.crashExitMs
    )
  })

  test('maxOpen has a floor of 1 — 0 would cap the stack at nothing', () => {
    assert.equal(loopSection({ maxOpen: 0 }).maxOpen, DEFAULT_LOOP_CONFIG.maxOpen)
    assert.equal(loopSection({ maxOpen: -2 }).maxOpen, DEFAULT_LOOP_CONFIG.maxOpen)
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
    // the verdict channel: an agent close reaches the shared store
    assert.match(p, /bd close "\$BRO_BEAD_ID"/)
    assert.match(p, /BEADS_DIR/)
  })

  test('work prompt orders the commit+push checkpoint before deep verification', () => {
    // bro-rbqgf: a worker killed mid-verify left commits unpushed in the
    // worktree — the checkpoint rule must precede the expensive step
    const p = buildWorkPrompt(bead, 'loop/bro-x1')
    const checkpoint = p.indexOf('Checkpoint BEFORE deep verification')
    const verify = p.indexOf('Verify like CI')
    assert.ok(checkpoint !== -1, 'checkpoint rule present')
    assert.ok(verify !== -1, 'verify rule present')
    assert.ok(checkpoint < verify)
    // fresh loop/<id> branches have no upstream — the checkpoint names
    // the explicit first-push form so `git push` can't no-op under
    // push.default=simple (codeant-ai review on #392)
    assert.match(p, /git push -u origin HEAD/)
    // the PR step keeps its own push so post-verify fixes reach the branch
    assert.match(p, /- Push, then `gh pr create`/)
  })

  test("work prompt uses the backend's own close verb", () => {
    // a github-tasks rig may have no bd at all — the verdict must ride
    // the transport the connector guarantees
    const p = buildWorkPrompt(bead, 'loop/bro-x1', undefined, undefined, 'github')
    assert.match(p, /gh issue close "\$BRO_BEAD_ID"/)
    assert.doesNotMatch(p, /bd close/)
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
