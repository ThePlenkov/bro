/**
 * The capability matrix is the declared contract — these tests check
 * that every declared cell is actually wired in the shipped artifacts
 * and that nothing is wired that isn't declared. A host bump that adds
 * or removes a surface fails here before it fails in a live session.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  deriveToolSuccess,
  HOOK_MATRIX,
  HOOK_MATRIX_VERSION,
  shellHostOf,
  type BroHookEvent,
  type HostEntry,
} from './host-matrix.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const tmp = mkdtempSync(join(tmpdir(), 'bro-matrix-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

// --- shared helpers -----------------------------------------------------------

interface HookCommand {
  command?: string
  matcher?: string
}

/** The manifest entry is a hook command when it shells out to
 *  `run.sh <broEvent>` — the launcher's argv is the wiring. */
function wiredTo(entry: HookCommand, broEvent: BroHookEvent): boolean {
  return new RegExp(`run\\.sh" ${broEvent}(?:\\s|$)`).test(entry.command ?? '')
}

/** Read a host manifest into { nativeEvent: [{command, matcher}] }.
 *  Claude/Codex wrap the map in `hooks:`; Devin's file is the map. */
function manifestEvents(path: string): Map<string, HookCommand[]> {
  const json = JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as {
    hooks?: Record<string, HookCommand[] | { matcher?: string; hooks?: HookCommand[] }[]>
  } & Record<string, unknown>
  const table = (json.hooks ?? json) as Record<
    string,
    Array<HookCommand | { matcher?: string; hooks?: HookCommand[] }>
  >
  const out = new Map<string, HookCommand[]>()
  for (const [native, groups] of Object.entries(table)) {
    if (typeof groups === 'string' || !Array.isArray(groups)) {
      continue // description / version fields
    }
    // Claude/Codex group entries are {matcher, hooks: [{command}]};
    // Cursor's generated manifest entries ARE the commands
    const commands: HookCommand[] = groups.flatMap((g) =>
      'hooks' in g && Array.isArray(g.hooks)
        ? (g.hooks as HookCommand[]).map((h) => ({ ...h, matcher: g.matcher }))
        : [g as HookCommand]
    )
    out.set(native, commands)
  }
  return out
}

/** Every native name a host entry declares, minus cells routed through
 *  a secondary module (`via`). */
function declaredNatives(host: HostEntry): string[] {
  const names: string[] = []
  for (const cell of Object.values(host.events)) {
    if (cell.via !== undefined) {
      continue
    }
    names.push(...cell.native)
  }
  return names
}

// --- manifest hosts -----------------------------------------------------------

for (const hostName of ['claude', 'codex', 'devin', 'cursor'] as const) {
  describe(`matrix conformance — ${hostName} manifest`, () => {
    const host = HOOK_MATRIX.hosts[hostName]!
    const events = manifestEvents(host.manifest!)

    test('every declared native event is wired to its bro event', () => {
      for (const [broEvent, cell] of Object.entries(host.events) as [BroHookEvent, NonNullable<HostEntry['events'][BroHookEvent]>][]) {
        for (const native of cell.native) {
          const commands = events.get(native)
          assert.ok(commands, `${hostName}: ${native} is declared but absent from ${host.manifest}`)
          const hits = commands.filter((c) => wiredTo(c, broEvent))
          assert.ok(
            hits.length > 0,
            `${hostName}: ${native} never reaches run.sh ${broEvent} — got ${commands.map((c) => c.command).join(' | ')}`
          )
          const wantMatch = cell.match ?? ''
          assert.ok(
            hits.some((c) => (c.matcher ?? '') === wantMatch),
            `${hostName}: ${native} wired to ${broEvent} without matcher "${wantMatch}"`
          )
        }
      }
    })

    test('nothing is wired that the matrix does not declare', () => {
      const declared = new Set(declaredNatives(host))
      for (const native of events.keys()) {
        assert.ok(
          declared.has(native),
          `${hostName}: manifest wires ${native} but the matrix does not declare it — declare it or remove the wiring`
        )
      }
    })
  })
}

describe('matrix conformance — declared gaps stay gaps', () => {
  test('claude does not wire PostCompact or PermissionRequest', () => {
    const events = manifestEvents(HOOK_MATRIX.hosts.claude!.manifest!)
    assert.equal(events.has('PostCompact'), false)
    assert.equal(events.has('PermissionRequest'), false)
    assert.equal(events.has('SubagentStop'), false)
  })

  test('codex does not wire a failure event it does not have', () => {
    const events = manifestEvents(HOOK_MATRIX.hosts.codex!.manifest!)
    assert.equal(events.has('PostToolUseFailure'), false)
  })
})

// --- in-process extension hosts ------------------------------------------------

/** A host stub that records what the adapter registers. */
function hostStub(): { api: unknown; events: string[] } {
  const events: string[] = []
  return {
    events,
    api: {
      on: (name: string) => events.push(name),
      registerCommand: () => {},
      registerTool: () => {},
      exec: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
      sendMessage: () => {},
    },
  }
}

async function loadModule(rel: string): Promise<{ default: (api: unknown) => void }> {
  const path = join(repoRoot, rel)
  assert.ok(existsSync(path), `${rel} is missing — run npm run gen:plugins`)
  return (await import(path)) as { default: (api: unknown) => void }
}

for (const hostName of ['pi', 'omp'] as const) {
  describe(`matrix conformance — ${hostName} extension`, () => {
    const host = HOOK_MATRIX.hosts[hostName]!
    const mod = `plugins/${hostName}/bro/bro.ts`

    test('the adapter registers exactly the declared event set', async () => {
      const { api, events } = hostStub()
      const ext = await loadModule(mod)
      ext.default(api)
      const declared = [...declaredNatives(host), ...(host.nativeOnly ?? [])].sort()
      assert.deepEqual([...new Set(events)].sort(), [...new Set(declared)].sort())
    })
  })
}

test('matrix conformance — omp pre-tool cell ships via its own module', async () => {
  const via = HOOK_MATRIX.hosts.omp!.events['pre-tool']!.via!
  const { api, events } = hostStub()
  const mod = await loadModule(via)
  mod.default(api)
  assert.deepEqual(events, ['tool_call'])
})

// --- in-process plugin hosts ---------------------------------------------------

test('matrix conformance — opencode plugin exposes its declared V1 hooks', async () => {
  const plugin = (await import(join(repoRoot, 'plugins/opencode/bro/bro.ts'))) as {
    default: { server: (input: unknown) => Promise<Record<string, unknown>>; setup: unknown }
  }
  const host = HOOK_MATRIX.hosts.opencode!
  const hooks = await plugin.default.server({ directory: tmp })
  const v1 = new Set(Object.keys(hooks))
  for (const [broEvent, cell] of Object.entries(host.events) as [BroHookEvent, NonNullable<HostEntry['events'][BroHookEvent]>][]) {
    // V1 literal keys are the cell's non-domain-shaped native names
    const expected = cell.native.filter((n) => !n.includes('('))
    const check = cell.v2 === true ? [] : expected
    for (const native of check) {
      assert.ok(v1.has(native), `opencode V1 does not expose ${native} for ${broEvent}`)
    }
  }
  // V2 cells ride setup() — asserted present, exercised by opencode-v2.test.ts
  assert.equal(typeof plugin.default.setup, 'function')
})

test('matrix conformance — kilo plugin exposes its declared hooks', async () => {
  const plugin = (await import(join(repoRoot, 'plugins/kilo/bro/bro.ts'))) as {
    default: { server: (input: unknown) => Promise<Record<string, unknown>> }
  }
  const host = HOOK_MATRIX.hosts.kilo!
  const hooks = await plugin.default.server({
    directory: tmp,
    client: { app: { log: async () => {} } },
  })
  const keys = new Set(Object.keys(hooks))
  for (const [broEvent, cell] of Object.entries(host.events) as [BroHookEvent, NonNullable<HostEntry['events'][BroHookEvent]>][]) {
    for (const native of cell.native) {
      assert.ok(keys.has(native), `kilo does not expose ${native} for ${broEvent}`)
    }
  }
  // the bro tool is a declared native-only surface
  assert.ok(keys.has('tool'), 'kilo lost the bro tool namespace')
})

// --- the matrix itself ----------------------------------------------------------

test('matrix shape — versioned, dated, every host documented', () => {
  assert.equal(HOOK_MATRIX.version, HOOK_MATRIX_VERSION)
  for (const [name, host] of Object.entries(HOOK_MATRIX.hosts)) {
    assert.ok(host.upstream.doc !== '', `${name}: missing upstream doc reference`)
    assert.match(host.upstream.checked, /^\d{4}-\d{2}-\d{2}$/, `${name}: checked must be a date`)
    assert.ok(
      host.stop === 'block' || host.stop === 'reprompt' || host.stop === 'none',
      `${name}: unknown stop refusal ${host.stop}`
    )
  }
})

// --- outcome derivation ----------------------------------------------------------

describe('deriveToolSuccess — native outcome normalization', () => {
  test('an explicit success boolean wins over everything', () => {
    // Devin shape — the field is native, not derived
    assert.equal(
      deriveToolSuccess({ hook_event_name: 'PostToolUse', tool_response: { success: false } }),
      false
    )
    assert.equal(
      deriveToolSuccess({ tool_response: { success: true } }),
      true
    )
    // even on Codex — a field beats the event name
    assert.equal(
      deriveToolSuccess({
        turn_id: 't1',
        hook_event_name: 'PostToolUse',
        tool_response: { success: false },
      }),
      false
    )
  })

  test('claude PostToolUse is the success signal — no success field needed', () => {
    assert.equal(
      deriveToolSuccess({
        session_id: 's',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        tool_response: { filePath: '/x', type: 'create' },
      }),
      true
    )
  })

  test('a documented failure event is failure on any host', () => {
    assert.equal(
      deriveToolSuccess({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }),
      false
    )
    assert.equal(
      deriveToolSuccess({ turn_id: 't', hook_event_name: 'PostToolUseFailure' }),
      false
    )
  })

  test('codex PostToolUse is unobservable — it fires on non-zero exits', () => {
    assert.equal(
      deriveToolSuccess({
        turn_id: 'turn-1',
        session_id: 's',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: 'Exit code 1',
      }),
      undefined
    )
  })

  test('unrelated and absent event names derive nothing', () => {
    assert.equal(deriveToolSuccess({ hook_event_name: 'SessionStart' }), undefined)
    assert.equal(deriveToolSuccess({ tool_name: 'Bash' }), undefined)
    assert.equal(deriveToolSuccess('not an object'), undefined)
    assert.equal(deriveToolSuccess(null), undefined)
  })
})

describe('shellHostOf — the codex fingerprint', () => {
  test('turn_id marks codex; everything else reads the shared vocabulary', () => {
    assert.equal(shellHostOf({ turn_id: 't' }), 'codex')
    assert.equal(shellHostOf({ session_id: 's', hook_event_name: 'PostToolUse' }), 'claude')
    assert.equal(shellHostOf(null), 'claude')
  })
})
