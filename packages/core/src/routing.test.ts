import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SpawnError } from './agents.ts'
import type { AgentRegistryEntry, ProviderEntry } from './index.ts'
import {
  deriveProviderWalls,
  fleetRouter,
  fleetRouting,
  resolveStepClass,
  routeStepClass,
  wallText,
  type RoutingTable,
} from './routing.ts'

const entry = (over: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry => ({
  agentId: 'native-aa11',
  backend: 'native',
  spawnedAt: '2026-01-01T00:00:00Z',
  ...over,
})

const providers: Record<string, ProviderEntry> = {
  devin: { type: 'cli', command: 'devin -p {promptFile}' },
  'kilo-free': { type: 'cli', command: 'kilo run {promptFile}', model: 'auto/free' },
  api: { type: 'api', baseUrl: 'https://x', models: { m: 'openai-compat' }, apiKeyEnv: 'K' },
}

describe('fleetRouting', () => {
  test('absent/non-object → {}', () => {
    assert.deepEqual(fleetRouting(undefined), {})
    assert.deepEqual(fleetRouting('x'), {})
    assert.deepEqual(fleetRouting([1]), {})
  })

  test('class → ordered chain; strings and {provider, model} both parse', () => {
    const t = fleetRouting({
      default: { chain: ['devin', { provider: 'kilo-free', model: 'auto/free' }] },
      sweep: { chain: ['kilo-free'] },
    })
    assert.deepEqual(t['default'], {
      chain: [{ provider: 'devin' }, { provider: 'kilo-free', model: 'auto/free' }],
    })
    assert.deepEqual(t['sweep'], { chain: [{ provider: 'kilo-free' }] })
  })

  test('a class with no usable chain drops; bad fields drop field-level', () => {
    const t = fleetRouting({
      empty: { chain: [] },
      noch: { onWall: 'park' },
      badentry: { chain: [42, '', 'kilo-free'] },
      wall: { chain: ['devin'], onWall: 'bogus' },
    })
    assert.equal(t['empty'], undefined)
    assert.equal(t['noch'], undefined)
    assert.deepEqual(t['badentry'], { chain: [{ provider: 'kilo-free' }] })
    assert.deepEqual(t['wall'], { chain: [{ provider: 'devin' }] })
    const t2 = fleetRouting({ c: { chain: ['devin'], onWall: 'park' } })
    assert.deepEqual(t2['c'], { chain: [{ provider: 'devin' }], onWall: 'park' })
  })

  test('a "__proto__" class name lands as an own key, never a prototype write', () => {
    // JSON.parse, not an object literal — `{__proto__: x}` is syntax
    // for a prototype set, not an own key; config arrives parsed
    const t = fleetRouting(JSON.parse('{"__proto__":{"chain":["devin"]}}'))
    assert.deepEqual(Object.getOwnPropertyDescriptor(t, '__proto__')?.value, {
      chain: [{ provider: 'devin' }],
    })
  })
})

describe('fleetRouter', () => {
  test('absent → undefined; valid {provider, mode} parses incl. off', () => {
    assert.equal(fleetRouter(undefined), undefined)
    assert.deepEqual(fleetRouter({ provider: 'typesafe', mode: 'shadow' }), {
      provider: 'typesafe',
      mode: 'shadow',
    })
    assert.deepEqual(fleetRouter({ provider: 'p', mode: 'off' }), { provider: 'p', mode: 'off' })
  })

  test('missing provider or bad mode drops the section', () => {
    assert.equal(fleetRouter({ mode: 'shadow' }), undefined)
    assert.equal(fleetRouter({ provider: 'p', mode: 'yolo' }), undefined)
    assert.equal(fleetRouter('x'), undefined)
  })
})

const routing: RoutingTable = {
  default: { chain: [{ provider: 'devin' }, { provider: 'kilo-free' }] },
  sweep: { chain: [{ provider: 'kilo-free', model: 'auto/free' }] },
  critical: { chain: [{ provider: 'devin' }], onWall: 'park' },
}

describe('resolveStepClass', () => {
  test('precedence: explicit class > bead label > default', () => {
    assert.equal(resolveStepClass(routing, providers, { class: 'sweep', label: 'default' }).class, 'sweep')
    assert.equal(resolveStepClass(routing, providers, { label: 'sweep' }).class, 'sweep')
    assert.equal(resolveStepClass(routing, providers, {}).class, 'default')
  })

  test('the spawn lands on chain[0] — provider + inline model pin', () => {
    const r = resolveStepClass(routing, providers, { class: 'sweep' })
    assert.equal(r.provider, 'kilo-free')
    assert.equal(r.model, 'auto/free')
    const d = resolveStepClass(routing, providers, {})
    assert.equal(d.provider, 'devin')
    assert.equal(d.model, undefined)
  })

  test('a resolved class with no routing entry is a config error naming the class', () => {
    assert.throws(
      () => resolveStepClass(routing, providers, { class: 'bogus' }),
      (e) =>
        e instanceof SpawnError &&
        e.kind === 'config' &&
        /fleet\.routing has no class "bogus"/.test(e.message)
    )
  })

  test('a chain entry naming an unknown or non-spawn provider errors with class + key', () => {
    const bad: RoutingTable = {
      default: { chain: [{ provider: 'ghost' }, { provider: 'devin' }] },
    }
    assert.throws(
      () => resolveStepClass(bad, providers, {}),
      (e) =>
        e instanceof SpawnError &&
        e.kind === 'config' &&
        /fleet\.routing\.default\.chain\[0\].*providers\.ghost is not configured/.test(e.message)
    )
    const noSpawn: RoutingTable = { default: { chain: [{ provider: 'api' }] } }
    assert.throws(
      () => resolveStepClass(noSpawn, providers, {}),
      /chain\[0\].*providers\.api \(type 'api'\) has no spawn surface/
    )
  })

  test('onWall: declared wins; default by priority (P0/P1 park, P2+ fallthrough)', () => {
    assert.equal(resolveStepClass(routing, providers, { class: 'critical', priority: 0 }).onWall, 'park')
    assert.equal(resolveStepClass(routing, providers, { priority: 1 }).onWall, 'park')
    assert.equal(resolveStepClass(routing, providers, { priority: 2 }).onWall, 'fallthrough')
    assert.equal(resolveStepClass(routing, providers, {}).onWall, 'fallthrough')
  })
})

describe('routeStepClass', () => {
  test('no routing table → undefined — the unrouted lane stays untouched', () => {
    assert.equal(routeStepClass(undefined, providers, undefined, 'fx-1'), undefined)
    assert.equal(routeStepClass({ routing: {} }, providers, undefined, 'fx-1'), undefined)
  })

  test('pre-read info answers label + priority without a beads store', () => {
    // the loop hands its `bd ready` row in — class + onWall come from
    // the row itself, no `bd show` runs
    const r = routeStepClass({ routing }, providers, undefined, 'fx-1', undefined, {
      label: 'sweep',
      priority: 1,
    })
    assert.equal(r?.class, 'sweep')
    assert.equal(r?.provider, 'kilo-free')
    assert.equal(r?.onWall, 'park')
    // priority rides the row's onWall default even on the default class
    const d = routeStepClass({ routing }, providers, undefined, 'fx-1', undefined, {
      priority: 1,
    })
    assert.equal(d?.class, 'default')
    assert.equal(d?.onWall, 'park')
  })

  test('the explicit class wins over a pre-read label', () => {
    const r = routeStepClass({ routing }, providers, undefined, 'fx-1', 'critical', {
      label: 'sweep',
    })
    assert.equal(r?.class, 'critical')
  })

  test('an unknown explicit class is a config error even without a store', () => {
    assert.throws(
      () => routeStepClass({ routing }, providers, undefined, 'fx-1', 'bogus', {}),
      /fleet\.routing has no class "bogus"/
    )
  })
})

describe('deriveProviderWalls', () => {
  const now = Date.parse('2026-01-02T00:00:00Z')

  test('rate_limited walls until resetAt — indefinitely without one', () => {
    const w = deriveProviderWalls(
      {
        a: entry({ provider: 'kilo', cause: 'rate_limited', resetAt: '2026-01-03T00:00:00Z' }),
        b: entry({ provider: 'devin', cause: 'rate_limited' }),
      },
      now
    )
    assert.deepEqual(w, [
      { provider: 'devin', cause: 'rate_limited' },
      { provider: 'kilo', cause: 'rate_limited', until: '2026-01-03T00:00:00Z' },
    ])
  })

  test('a passed resetAt is the proof of lift', () => {
    const w = deriveProviderWalls(
      { a: entry({ provider: 'kilo', cause: 'rate_limited', resetAt: '2026-01-01T12:00:00Z' }) },
      now
    )
    assert.deepEqual(w, [])
  })

  test('quota walls until EVERY quota-caused entry is stopped — it dominates', () => {
    const w = deriveProviderWalls(
      {
        a: entry({ provider: 'p', cause: 'quota', spawnedAt: '2026-01-01T00:00:00Z' }),
        b: entry({ provider: 'p', cause: 'rate_limited', spawnedAt: '2026-01-02T00:00:00Z' }),
        c: entry({ provider: 'p', cause: 'quota', stopped: true }),
      },
      now
    )
    assert.deepEqual(w, [{ provider: 'p', cause: 'quota' }])
  })

  test('stopping the only quota entry lifts the wall', () => {
    const w = deriveProviderWalls(
      {
        a: entry({ provider: 'p', cause: 'quota', stopped: true }),
        b: entry({ provider: 'p', cause: 'rate_limited', resetAt: '2026-01-01T12:00:00Z' }),
      },
      now
    )
    assert.deepEqual(w, [])
  })

  test('crash/auth/ok never wall a provider; unrouted entries are skipped', () => {
    const w = deriveProviderWalls(
      {
        a: entry({ provider: 'p', cause: 'crash' }),
        b: entry({ provider: 'p', cause: 'auth' }),
        c: entry({ cause: 'quota' }), // legacy spawn — no provider provenance
        d: entry({ provider: 'q', cause: 'ok' }),
      },
      now
    )
    assert.deepEqual(w, [])
  })

  test('retained attempts join the scan — a superseded death still walls its provider', () => {
    const w = deriveProviderWalls(
      {
        // post-fallthrough state: the live entry respawned onto devin,
        // the rate_limited death it superseded rides in attempts
        a: entry({
          provider: 'devin',
          attempts: [
            { provider: 'kilo', cause: 'rate_limited', spawnedAt: '2026-01-01T00:00:00Z' },
          ],
        }),
      },
      now
    )
    assert.deepEqual(w, [{ provider: 'kilo', cause: 'rate_limited' }])
  })

  test('a stopped attempt clears with its entry; a live quota attempt dominates', () => {
    const w = deriveProviderWalls(
      {
        cleared: entry({
          attempts: [{ provider: 'p', cause: 'quota', spawnedAt: 't', stopped: true }],
        }),
        live: entry({
          provider: 'devin',
          attempts: [{ provider: 'p', cause: 'quota', spawnedAt: 't' }],
        }),
      },
      now
    )
    assert.deepEqual(w, [{ provider: 'p', cause: 'quota' }])
  })

  test('the newest rate_limited death owns the wall horizon', () => {
    const w = deriveProviderWalls(
      {
        old: entry({
          provider: 'p',
          cause: 'rate_limited',
          spawnedAt: '2026-01-01T00:00:00Z',
          resetAt: '2026-01-05T00:00:00Z',
        }),
        fresh: entry({
          provider: 'p',
          cause: 'rate_limited',
          spawnedAt: '2026-01-01T12:00:00Z',
          resetAt: '2026-01-01T13:00:00Z', // already passed
        }),
      },
      now
    )
    assert.deepEqual(w, [])
  })
})

describe('wallText', () => {
  test('spec render: <provider> walled — <cause>[ til <resetAt>]', () => {
    assert.equal(
      wallText({ provider: 'kilo', cause: 'rate_limited', until: '2026-01-03T00:00:00Z' }),
      'kilo walled — rate_limited til 2026-01-03T00:00:00Z'
    )
    assert.equal(wallText({ provider: 'devin', cause: 'quota' }), 'devin walled — quota')
  })
})
