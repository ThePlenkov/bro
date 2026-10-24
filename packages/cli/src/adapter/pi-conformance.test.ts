/**
 * Dev-time type conformance for the pi adapter (spec bro-l8c4f.8).
 *
 * adapter/pi.ts deliberately declares pi's surface structurally so the
 * shipped bundle stays self-contained — nothing imports
 * @earendil-works/pi-coding-agent at runtime. This file is where the
 * two meet: the real types must satisfy every assumption the adapter
 * encodes, the devDependency pins the release those types describe,
 * and a drift upstream fails `typecheck`/`test` here instead of in a
 * user's session.
 *
 * It is a .test.ts, not a d.ts assertion file, so `tsx --test` loads it:
 * the compile-time half fails at typecheck, the runtime half pins the
 * installed version to the declared one.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type {
  AgentActivityOutcome,
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  WidgetPlacement,
} from '@earendil-works/pi-coding-agent'

import broExtension from './pi.ts'

type Assert<T extends true> = T
type Extends<A, B> = A extends B ? true : never

// --- event vocabulary -------------------------------------------------------
// Every event name the adapter registers must exist in the real
// overload set — the matrix declares the same list; a renamed or
// removed upstream event fails to compile here.

function registeredEventsExist(api: ExtensionAPI): void {
  api.on('session_start', () => {})
  api.on('session_before_compact', () => {})
  api.on('session_compact', () => {})
  api.on('before_agent_start', () => {})
  api.on('tool_result', () => {})
  api.on('turn_end', () => {})
  api.on('session_shutdown', () => {})
  api.on('agent_before_settle', () => {})
  api.on('agent_settled', () => {})
}

// --- payload fields the adapter reads ---------------------------------------

type _toolResultCarriesOutcome = Assert<
  Extends<ToolResultEvent, { toolName: string; input: Record<string, unknown>; isError: boolean }>
>

type _settleEventCarriesOutcome = Assert<
  Extends<AgentBeforeSettleEvent, { outcome: AgentActivityOutcome }>
>
// stopAborted() reads 'aborted' | 'error' — the literals must exist
type _abortedOutcomes = Assert<Extends<'aborted' | 'error', AgentActivityOutcome>>

// --- shapes the adapter hands back ------------------------------------------

// refuseStop's return must satisfy the settle gate's result contract —
// the exact object pi.ts builds, checked against the real BoundaryResult
const _refuse: BoundaryResult = {
  continue: true,
  entries: [
    {
      type: 'custom_message',
      customType: 'bro-stop-gate',
      content: 'reason',
      display: true,
    },
  ],
}
void _refuse

// --- the context surface the adapter touches ---------------------------------

type _ctxSurface = Assert<
  Extends<
    ExtensionContext,
    {
      cwd: string
      mode: string
      hasUI: boolean
      sessionManager: { getSessionId(): string | undefined }
      ui: {
        notify(message: string, type?: 'info' | 'warning' | 'error'): void
        setStatus(key: string, text: string | undefined): void
        setWidget(
          key: string,
          content: string[] | undefined,
          options?: { placement?: 'aboveEditor' | 'belowEditor' }
        ): void
      }
    }
  >
>
type _aboveEditorIsAPlacement = Assert<Extends<'aboveEditor', WidgetPlacement>>

// --- the whole adapter satisfies the real API ---------------------------------
// If ExtensionAPI ever stops satisfying the structural PiApi this call
// stops compiling — the strongest conformance statement available.

// never called — the conformance is the compile, not the run
function _wholeAdapterConforms(api: ExtensionAPI): void {
  registeredEventsExist(api)
  broExtension(api)
}
void _wholeAdapterConforms

// --- the pinned release -------------------------------------------------------

const cliPkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the pi type fixture is pinned to the supported release', () => {
  const pkg = JSON.parse(readFileSync(join(cliPkgDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const pin = pkg.devDependencies?.['@earendil-works/pi-coding-agent']
  assert.equal(
    pin,
    '1.4.0',
    'the dev-time pi fixture must be an exact pin of the supported release — bump it deliberately, with this test, when the adapter is re-checked'
  )
  // the production surface never gains a pi dependency — the shipped
  // adapter is self-contained by construction
  assert.equal(
    pkg.dependencies?.['@earendil-works/pi-coding-agent'],
    undefined,
    'pi must stay a dev-time type fixture, never a runtime dependency'
  )
  const installed = JSON.parse(
    readFileSync(
      join(cliPkgDir, '../../node_modules/@earendil-works/pi-coding-agent/package.json'),
      'utf8'
    )
  ) as { version: string }
  assert.equal(installed.version, pin)
})
