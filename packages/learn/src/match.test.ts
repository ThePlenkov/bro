import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LessonTrigger } from './lesson.ts'
import {
  matchKeys,
  matchPath,
  parseTraceLine,
  triggerMatches,
  type MatchContext,
  type TraceEntry,
} from './match.ts'

const ctx = (text: string, trace: TraceEntry[] = []): MatchContext => ({ text, trace })
const trigger = (match?: LessonTrigger['match']): LessonTrigger => ({
  on: ['post-tool'],
  ...(match === undefined ? {} : { match }),
})

describe('triggerMatches', () => {
  it('a trigger with no match fires on the event alone', () => {
    assert.equal(triggerMatches(trigger(), ctx('')), true)
    assert.equal(triggerMatches(trigger({}), ctx('')), true)
  })

  it('terms are case-insensitive substrings of the context text', () => {
    const t = trigger({ terms: ['PR merge'] })
    assert.equal(triggerMatches(t, ctx('after a gh pr merge runs')), true)
    assert.equal(triggerMatches(t, ctx('unrelated text')), false)
  })

  it('terms are disjunctive within the list', () => {
    const t = trigger({ terms: ['alpha', 'beta'] })
    assert.equal(triggerMatches(t, ctx('mentions beta here')), true)
    assert.equal(triggerMatches(t, ctx('neither word')), false)
  })

  it('commands match prefixes at command positions across separators', () => {
    const t = trigger({ commands: ['gh pr merge'] })
    assert.equal(
      triggerMatches(t, ctx('', [{ command: 'gh pr merge 42 --squash' }])),
      true
    )
    assert.equal(
      triggerMatches(t, ctx('', [{ command: 'cd x && gh pr merge 42' }])),
      true
    )
    assert.equal(triggerMatches(t, ctx('', [{ command: 'gh pr view 42' }])), false)
    assert.equal(
      triggerMatches(t, ctx('', [{ command: 'echo "gh pr merge"' }])),
      false // 'echo' is the command position — quoted text isn't
    )
    assert.equal(
      triggerMatches(t, ctx('', [{ command: 'echo "x; gh pr merge"' }])),
      false // a separator inside quotes can't fake a command position
    )
    assert.equal(
      triggerMatches(t, ctx('', [{ command: "echo 'x; gh pr merge'" }])),
      false
    )
  })

  it('paths match globs against touched paths — basename without a slash', () => {
    const t = trigger({ paths: ['bro.config.json'] })
    assert.equal(
      triggerMatches(t, ctx('', [{ paths: ['pkg/x/bro.config.json'] }])),
      true
    )
    assert.equal(triggerMatches(t, ctx('', [{ paths: ['pkg/x/other.json'] }])), false)
  })

  it('paths match full-path globs — ** crosses segments', () => {
    const t = trigger({ paths: ['specs/**'] })
    assert.equal(
      triggerMatches(t, ctx('', [{ paths: ['specs/sessions/x.md'] }])),
      true
    )
    assert.equal(triggerMatches(t, ctx('', [{ paths: ['src/specs/x.md'] }])), false)
    const dir = trigger({ paths: ['docs/'] })
    assert.equal(triggerMatches(dir, ctx('', [{ paths: ['a/docs/b.md'] }])), true)
  })

  it('tools match the traced tool name exactly', () => {
    const t = trigger({ tools: ['exec', 'edit'] })
    assert.equal(triggerMatches(t, ctx('', [{ tool: 'edit' }])), true)
    assert.equal(triggerMatches(t, ctx('', [{ tool: 'execute' }])), false)
    assert.equal(triggerMatches(t, ctx('', [{}])), false)
  })

  it('errors matches on ≥1 failed landing — false requires their absence', () => {
    const wantErr = trigger({ errors: true })
    assert.equal(triggerMatches(wantErr, ctx('', [{ ok: false }])), true)
    assert.equal(triggerMatches(wantErr, ctx('', [{ ok: true }, {}])), false)
    const wantClean = trigger({ errors: false })
    assert.equal(triggerMatches(wantClean, ctx('', [{ ok: true }])), true)
    assert.equal(triggerMatches(wantClean, ctx('', [{ ok: false }])), false)
  })

  it('match is conjunctive across keys', () => {
    const t = trigger({ terms: ['fix'], commands: ['git push'] })
    assert.equal(triggerMatches(t, ctx('fix it', [{ command: 'git push' }])), true)
    assert.equal(triggerMatches(t, ctx('fix it', [{ command: 'git pull' }])), false)
    assert.equal(triggerMatches(t, ctx('later', [{ command: 'git push' }])), false)
  })

  it('absent trace fields simply cannot satisfy their key', () => {
    const t = trigger({ tools: ['exec'] })
    assert.equal(triggerMatches(t, ctx('', [{ command: 'x' }])), false)
  })
})

describe('matchPath', () => {
  it('handles the documented pattern shapes', () => {
    assert.equal(matchPath('packages/act/src/x.ts', 'packages/act/**'), true)
    assert.equal(matchPath('packages/act/src/x.ts', 'packages/**/x.ts'), true)
    assert.equal(matchPath('bro.config.json', 'bro.config.json'), true)
    assert.equal(matchPath('a/b/bro.config.json', 'bro.config.json'), true)
    assert.equal(matchPath('a/b/x.md', '*.md'), true)
    assert.equal(matchPath('deep/deeper/docs/f.md', 'docs/'), true)
  })
})

describe('parseTraceLine', () => {
  it('parses a full entry', () => {
    assert.deepEqual(
      parseTraceLine('{"ts":1,"tool":"exec","command":"ls","paths":["a"],"ok":true}'),
      { ts: 1, tool: 'exec', command: 'ls', paths: ['a'], ok: true }
    )
  })

  it('skips malformed and non-object lines', () => {
    assert.equal(parseTraceLine('not json'), null)
    assert.equal(parseTraceLine('[1,2]'), null)
    assert.equal(parseTraceLine('42'), null)
  })

  it('keeps only known fields in their payload types', () => {
    assert.deepEqual(
      parseTraceLine('{"ts":"x","tool":"edit","paths":["a",7],"ok":1,"extra":true}'),
      { tool: 'edit', paths: ['a'] }
    )
    assert.deepEqual(parseTraceLine('{"paths":[]}'), {})
  })
})

describe('matchKeys', () => {
  it('returns one verdict row per present key — the guard-test granularity', () => {
    const m = { terms: ['deploy'], tools: ['exec'], errors: false }
    const rows = matchKeys(m, ctx('deploy it', [{ tool: 'exec', ok: true }]))
    assert.deepEqual(rows, [
      { key: 'terms', ok: true },
      { key: 'tools', ok: true },
      { key: 'errors', ok: true },
    ])
    const miss = matchKeys(m, ctx('nope', [{ tool: 'exec', ok: false }]))
    assert.deepEqual(
      miss.map((r) => [r.key, r.ok]),
      [
        ['terms', false],
        ['tools', true],
        ['errors', false],
      ]
    )
  })

  it('absent keys produce no rows; triggerMatches is their conjunction', () => {
    assert.deepEqual(matchKeys({}, ctx('x')), [])
    const m = { terms: ['a'], commands: ['gh'] }
    const t = { on: ['post-tool' as const], match: m }
    const trace = [{ command: 'gh pr merge' }]
    assert.equal(triggerMatches(t, ctx('a', trace)), matchKeys(m, ctx('a', trace)).every((k) => k.ok))
    assert.equal(triggerMatches(t, ctx('zz', trace)), false)
  })
})
