/**
 * The /bro completion contract — position semantics plus the drift
 * pin: the static table is only safe because CI fails when the plugin
 * registry moves without it.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { BRO_COMPLETION_TABLE, broArgumentCompletions } from './completions.ts'
import { GROUP_META, PLUGINS, pluginGroups } from '../plugins.ts'

const { GROUPS, VERBS, GROUP_MEMBERS, VERB_SUBS } = BRO_COMPLETION_TABLE

// --- position semantics ------------------------------------------------

test('position 1: an empty token stays null so bare /bro submits', () => {
  assert.equal(broArgumentCompletions(''), null)
})

test('position 1: verbs and groups filter by prefix', () => {
  const items = broArgumentCompletions('a')
  assert.ok(items !== null)
  const labels = items.map((i) => i.label)
  assert.ok(labels.includes('act'), 'act completes')
  assert.ok(labels.includes('agents'), 'agents completes')
  assert.ok(labels.every((l) => l.startsWith('a')), 'prefix-filtered')
  // value is the bare word at position 1
  assert.equal(items.find((i) => i.label === 'act')?.value, 'act')
})

test('position 1: a group shows its blurb', () => {
  const items = broArgumentCompletions('review')
  const group = items?.find((i) => i.label === 'review')
  assert.equal(group?.value, 'review')
  assert.equal(group?.description, 'PR review loop — gates, threads, debt')
})

test('position 2 after a group: members, head carried into value', () => {
  const items = broArgumentCompletions('review ')
  assert.ok(items !== null)
  assert.deepEqual(
    items.map((i) => i.label),
    ['debt', 'act', 'watch', 'drive', 'cleanup']
  )
  assert.equal(items[0]?.value, 'review debt')
})

test('position 2 after a verb: subcommands, filtered', () => {
  const items = broArgumentCompletions('act st')
  assert.ok(items !== null)
  assert.deepEqual(items.map((i) => i.label), ['status'])
  assert.equal(items[0]?.value, 'act status')
})

test('position 2 after a verb: empty token opens the full sub list', () => {
  const items = broArgumentCompletions('drill ')
  assert.ok(items !== null)
  assert.deepEqual(
    items.map((i) => i.label),
    ['down', 'up', 'current', 'tree', 'list', 'report', 'distill']
  )
})

test('position 3+ is never guessed', () => {
  assert.equal(broArgumentCompletions('act status '), null)
  assert.equal(broArgumentCompletions('review debt --json'), null)
})

test('flags are not completion material', () => {
  assert.equal(broArgumentCompletions('-'), null)
  assert.equal(broArgumentCompletions('--js'), null)
  assert.equal(broArgumentCompletions('fleet --'), null)
})

test('quotes are the handler business, never shredded', () => {
  assert.equal(broArgumentCompletions('"a'), null)
  assert.equal(broArgumentCompletions("learn capture 'a"), null)
})

test('an unknown head yields nothing, not a guess', () => {
  assert.equal(broArgumentCompletions('bogus '), null)
  assert.deepEqual(broArgumentCompletions('bogus'), [])
})

// --- drift pin: the table tracks the live plugin registry --------------

test('drift: every group is a GROUP_META group and vice versa', () => {
  const meta = new Set(GROUP_META.map(([g]) => g))
  const table = new Set(GROUPS.map((g) => g.name))
  assert.deepEqual(
    [...table].filter((g) => !meta.has(g)),
    [],
    'table group missing from GROUP_META'
  )
  assert.deepEqual(
    [...meta].filter((g) => !table.has(g)),
    [],
    'GROUP_META group missing from the table'
  )
})

test('drift: verbs are exactly the visible plugins', () => {
  const visible = PLUGINS.filter((p) => !p.hidden).map((p) => p.name)
  assert.deepEqual(
    [...VERBS.map((v) => v.name)].sort(),
    [...visible].sort(),
    'VERBS drifted from the plugin registry'
  )
})

test('drift: group members match the registry (aliases included)', () => {
  const groups = pluginGroups()
  for (const [group, members] of groups) {
    const registry = members
      .filter((p) => !p.hidden)
      .map((p) => p.name)
      .sort()
    const table = (GROUP_MEMBERS[group] ?? []).map((m) => m.name).sort()
    assert.deepEqual(table, registry, `members of group ${group} drifted`)
  }
  assert.deepEqual(
    Object.keys(GROUP_MEMBERS).filter((g) => !groups.has(g)),
    [],
    'table carries a group the registry does not'
  )
})

test('drift: every listed subcommand is advertised in its verb summary', () => {
  for (const [verb, subs] of Object.entries(VERB_SUBS)) {
    const plugin = PLUGINS.find((p) => p.name === verb)
    assert.ok(plugin !== undefined, `${verb} is not a plugin`)
    const summary = plugin.summary
    for (const sub of subs) {
      assert.ok(
        new RegExp(`(^|[^\\w-])${sub}([^\\w-]|$)`).test(summary),
        `'${verb} ${sub}' — '${sub}' is not advertised in the summary: ${summary}`
      )
    }
  }
})
