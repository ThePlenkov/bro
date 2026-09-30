import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { BroPlugin } from '@broject/core'
import { resolvePlanDoc, runPlanCommand } from './plan.ts'

/** A minimal plan plugin — enough shape for routing, no real payload. */
function planPlugin(over: Partial<BroPlugin> = {}): BroPlugin {
  return {
    name: 'testkind',
    summary: 't',
    run: () => {},
    planSchema: (doc: unknown) => {
      const d = doc as Record<string, unknown>
      if (d.need === undefined) {
        throw new Error('plan:\n  need is required')
      }
      return { need: d.need }
    },
    planVersion: 1,
    runPlan: () => {},
    ...over,
  }
}

function planFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-plan-cmd-'))
  const file = join(dir, 'plan.toml')
  writeFileSync(file, body)
  return file
}

function captured<T>(fn: (lines: string[]) => T): { lines: string[]; result: T } {
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  try {
    return { lines, result: fn(lines) }
  } finally {
    console.log = orig
  }
}

describe('bro plan — contract listing', () => {
  test('lists kinds with their schema versions', () => {
    const plugins = [
      planPlugin({ name: 'aaa' }),
      planPlugin({ name: 'bbb', planVersion: 3 }),
      { name: 'noplans', summary: 'x', run: () => {} } as BroPlugin,
    ]
    const { lines } = captured(() => runPlanCommand([], plugins))
    assert.deepEqual(lines, ['aaa          v1', 'bbb          v3'])
  })

  test('external plugins are marked and default to v1', () => {
    const ext = planPlugin({ name: 'extkind', external: true })
    delete ext.planVersion
    const { lines } = captured(() => runPlanCommand(['list'], [ext]))
    assert.deepEqual(lines, ['extkind      v1 (external)'])
  })
})

describe('bro plan validate', () => {
  test('a valid file prints the kind + schema version and runs nothing', () => {
    let ran = false
    const plugins = [planPlugin({ runPlan: () => { ran = true } })]
    const file = planFile('kind = "testkind"\nversion = 1\nneed = "x"')
    const { lines } = captured(() => runPlanCommand(['validate', file], plugins))
    assert.deepEqual(lines, [`${file}: ok — testkind plan, schema v1`])
    assert.equal(ran, false)
  })

  test('schema errors surface the aggregate — the same failure bro run reports', () => {
    const file = planFile('kind = "testkind"')
    assert.throws(
      () => runPlanCommand(['validate', file], [planPlugin()]),
      /need is required/
    )
  })

  test('a version pin above the plugin fails before the schema runs', () => {
    let schemaRan = false
    const plugin = planPlugin({
      planSchema: () => {
        schemaRan = true
        return {}
      },
    })
    const file = planFile('kind = "testkind"\nversion = 2\nneed = "x"')
    assert.throws(
      () => runPlanCommand(['validate', file], [plugin]),
      /version: testkind schema v2 is newer than this bro understands \(latest v1\)/
    )
    assert.equal(schemaRan, false)
  })

  test('unknown kinds name the known ones', () => {
    const file = planFile('kind = "nope"')
    assert.throws(
      () => runPlanCommand(['validate', file], [planPlugin()]),
      /kind "nope" is unknown.*testkind/
    )
  })
})

describe('resolvePlanDoc', () => {
  test('kind-less files and plan-less plugins error distinctly', () => {
    assert.throws(
      () => resolvePlanDoc(planFile('need = "x"'), [planPlugin()]),
      /no kind field/
    )
    const docless = { name: 'docless', summary: 'x', run: () => {} } as BroPlugin
    assert.throws(
      () => resolvePlanDoc(planFile('kind = "docless"'), [docless]),
      /plugin "docless" does not accept plans/
    )
  })

  test('plugins without planVersion gate at v1', () => {
    const p = planPlugin()
    delete p.planVersion
    assert.throws(
      () => resolvePlanDoc(planFile('kind = "testkind"\nversion = 2\nneed="x"'), [p]),
      /latest v1/
    )
    assert.deepEqual(
      resolvePlanDoc(planFile('kind = "testkind"\nversion = 1\nneed="x"'), [p]).plan,
      { need: 'x' }
    )
  })
})
