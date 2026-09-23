import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parse } from 'smol-toml'
import { inlineFormulaDoc, parseConvoyPlan } from './plan.ts'

const parsePlan = (toml: string) => parseConvoyPlan(parse(toml))

describe('parseConvoyPlan', () => {
  test('parses formula pours with vars and a plan-wide gate policy', () => {
    const plan = parsePlan(`
kind = "convoy"
gates = "forbid"

[[molecules]]
formula = "debt-pipeline"
[molecules.vars]
scope = "--last 20"

[[molecules]]
formula = "mol-review"
gates = "allow"
`)
    assert.equal(plan.gates, 'forbid')
    assert.deepEqual(plan.molecules[0], {
      formula: 'debt-pipeline',
      vars: { scope: '--last 20' },
      gates: undefined,
    })
    assert.deepEqual(plan.molecules[1], {
      formula: 'mol-review',
      vars: {},
      gates: 'allow',
    })
  })

  test('parses an inline molecule with a step DAG', () => {
    const plan = parsePlan(`
kind = "convoy"

[[molecules]]
title = "ship v0.1"
description = "release convoy"

[[molecules.steps]]
id = "tag"
title = "cut the tag"
type = "agent"
priority = 1

[[molecules.steps]]
id = "publish"
title = "HUMAN GATE — npm publish"
type = "human"
needs = ["tag"]
`)
    const m = plan.molecules[0]!
    assert.ok('steps' in m)
    assert.equal(m.title, 'ship v0.1')
    assert.deepEqual(m.steps.map((s) => s.id), ['tag', 'publish'])
    assert.deepEqual(m.steps[1]!.needs, ['tag'])
  })

  test('molecules is required and non-empty', () => {
    assert.throws(() => parsePlan('kind = "convoy"'), /at least one \[\[molecules\]\]/)
    assert.throws(() => parsePlan('kind = "convoy"\nmolecules = []'), /at least one \[\[molecules\]\]/)
  })

  test('a molecule is either formula or title+steps — never both, never neither', () => {
    assert.throws(
      () => parsePlan('[[molecules]]\nformula = "f"\ntitle = "t"'),
      /title only applies to inline molecules/
    )
    assert.throws(() => parsePlan('[[molecules]]\ngates = "allow"'), /either formula/)
    assert.throws(
      () => parsePlan('[[molecules]]\ntitle = "t"'),
      /at least one \[\[molecules\.steps\]\]/
    )
    assert.throws(
      () => parsePlan('[[molecules]]\ntitle = "t"\n[molecules.vars]\nk = "v"'),
      /vars only apply to formula pours/
    )
  })

  test('gates must be a known policy', () => {
    assert.throws(() => parsePlan('gates = "later"\n[[molecules]]\nformula="f"'), /gates must be one of allow\|forbid/)
    assert.throws(
      () => parsePlan('[[molecules]]\nformula = "f"\ngates = "maybe"'),
      /molecules\[0\]: gates must be one of/
    )
  })

  test('gates = "forbid" rejects inline human gates at parse time', () => {
    assert.throws(
      () =>
        parsePlan(`
[[molecules]]
title = "unattended"
gates = "forbid"
[[molecules.steps]]
id = "g"
title = "approve"
type = "human"
`),
      /step "g" is a human gate but gates = "forbid"/
    )
    // a gate-titled step counts even without a declared type
    assert.throws(
      () =>
        parsePlan(`
gates = "forbid"
[[molecules]]
title = "unattended"
[[molecules.steps]]
id = "g"
title = "HUMAN GATE — approve"
`),
      /gates = "forbid"/
    )
  })

  test('needs must reference declared siblings — no self-refs, no unknowns, no cycles', () => {
    assert.throws(
      () =>
        parsePlan('[[molecules]]\ntitle="t"\n[[molecules.steps]]\nid="a"\ntitle="a"\nneeds=["b"]'),
      /needs undeclared step "b"/
    )
    assert.throws(
      () =>
        parsePlan('[[molecules]]\ntitle="t"\n[[molecules.steps]]\nid="a"\ntitle="a"\nneeds=["a"]'),
      /cannot need itself/
    )
    assert.throws(
      () =>
        parsePlan(`
[[molecules]]
title = "t"
[[molecules.steps]]
id = "a"
title = "a"
needs = ["b"]
[[molecules.steps]]
id = "b"
title = "b"
needs = ["a"]
`),
      /needs cycle a -> b -> a/
    )
  })

  test('step ids are unique within a molecule', () => {
    assert.throws(
      () =>
        parsePlan(
          '[[molecules]]\ntitle="t"\n[[molecules.steps]]\nid="a"\ntitle="x"\n[[molecules.steps]]\nid="a"\ntitle="y"'
        ),
      /duplicate id "a"/
    )
  })

  test('rejects foreign kind and unknown keys', () => {
    assert.throws(() => parsePlan('kind="debt"\n[[molecules]]\nformula="f"'), /kind: expected "convoy"/)
    assert.throws(() => parsePlan('bogus=1\n[[molecules]]\nformula="f"'), /unknown top-level key "bogus"/)
    assert.throws(
      () => parsePlan('[[molecules]]\nformula="f"\nspeed="fast"'),
      /molecules\[0\]: unknown key "speed"/
    )
    assert.throws(
      () => parsePlan('[[molecules]]\ntitle="t"\n[[molecules.steps]]\nid="a"\ntitle="a"\nfoo=1'),
      /molecules\[0\]\.steps\[0\]: unknown key "foo"/
    )
  })

  test('aggregates step field errors', () => {
    try {
      parsePlan(
        '[[molecules]]\ntitle="t"\n[[molecules.steps]]\ntitle="a"\npriority=9\nneeds="x"'
      )
      assert.fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      assert.match(msg, /id is required/)
      assert.match(msg, /priority must be an integer 0-4/)
      assert.match(msg, /needs must be a list of step ids/)
    }
  })

  test('vars values must be strings', () => {
    assert.throws(
      () => parsePlan('[[molecules]]\nformula="f"\n[molecules.vars]\nn=3'),
      /vars\.n must be a string/
    )
  })
})

describe('inlineFormulaDoc', () => {
  test('emits a pourable formula document', () => {
    const doc = inlineFormulaDoc(
      {
        title: 'ship v0.1',
        steps: [
          { id: 'tag', title: 'cut the tag', type: 'agent' },
          { id: 'ship', title: 'HUMAN GATE — ship', type: 'human', needs: ['tag'], priority: 1 },
        ],
      },
      'bro-plan-test'
    )
    assert.equal(doc.formula, 'bro-plan-test')
    assert.equal(doc.type, 'workflow')
    const steps = doc.steps as Record<string, unknown>[]
    assert.deepEqual(steps[1], {
      id: 'ship',
      title: 'HUMAN GATE — ship',
      type: 'human',
      needs: ['tag'],
      priority: 1,
    })
    // the emitted doc must round-trip through TOML
    const back = parseConvoyPlan({
      kind: 'convoy',
      molecules: [{ title: 'ship v0.1', steps }],
    })
    assert.ok('steps' in back.molecules[0]!)
  })
})
