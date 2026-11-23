---
parent: bro-l8c4f
scope:
  - packages/cli/src/plugins.ts
  - packages/cli/src/plugins.test.ts
---

# bro-l8c4f.1 — runtime shape check for external Connector/BroPlugin before registration

Child of the principal audit bro-l8c4f (plugin-validation slice). The
shape predicates themselves landed in #782 (`isConnector` now covers
every callback field, `optIn`, `optInFacades`; `isPlugin` covers all
optional fields plus the `configKey`/`configSchema` and
`planSchema`/`runPlan` pairs). This spec closes what the audit's
recommendation still has open against the acceptance criteria.

## Problem

Three verified residuals at the same seam,
`registerExternal`/`isPlugin`/`isConnector` in
`packages/cli/src/plugins.ts`:

1. **The rejection diagnostic names the plugin, not the field.**
   `registerExternal` warns `plugin "<spec>" export is not a BroPlugin —
   skipped` — the author of a 15-field export cannot tell which field
   failed without bisecting. The audit asks for a plugin+field
   diagnostic; the acceptance line ("malformed … отклоняются") is only
   useful if the operator can act on the rejection.
2. **`activeIn` and `external` are unchecked.** `Connector.activeIn` is
   `Partial<Record<keyof ConnectorHooks, readonly Mode[]>>`; nothing
   validates it, and `connectorHookActive` (packages/core/connectors.ts
   `modes.includes(mode)`) throws a delayed TypeError in hook dispatch
   when a present-but-wrong value (e.g. `{ stopGate: 5 }`) reaches it —
   the crash class the bead exists to prevent. `BroPlugin.external` is
   registry-owned but declared on the author-visible type; a malformed
   value is silently overwritten, which is benign, but the field has no
   check row, so the "every declared field has a check" invariant the
   audit asks for is untrue.
3. **No consistency guard between the TS types and the runtime checks.**
   `CONNECTOR_FUNCTION_KEYS` is `ReadonlyArray<string>` — untied to
   `keyof Connector`; `FACADE_KEYS` is a set literal whose completeness
   against `keyof FacadeMap` nothing checks. A `Connector`/`BroPlugin`
   field added later ships unchecked until a malformed contribution
   crashes dispatch. Acceptance requires a test keeping the type and
   the runtime checks in agreement.

## Design

Minimal reshaping of the landed predicates — same seam, same
early-reject-before-registry ordering, no new dependencies.

- **Reason-producers replace boolean shape checks.** Internal
  `pluginExportProblem(entry): string | undefined` and
  `connectorProblem(value, path): string | undefined` return
  `field "<path>" <expectation>` diagnostics (`field
  "connectors[0].matchDir" must be a function`, `field "configSchema"
  is required — configKey and configSchema come in pairs`).
  `registerExternal` prints `plugin "<spec>" <reason> — skipped` and
  still refuses before `PLUGINS.push`/`registerConnector`.
- **`PLUGIN_FIELD_CHECKS` gains an expectation column** so each row
  carries the `must be …` text its rejection prints; `external` gets a
  `must be a boolean` row.
- **Connector validation covers `activeIn`**: a record keyed by
  `keyof ConnectorHooks` whose values are dense arrays of `Mode`
  elements (core already exports `isMode`). Unknown keys and non-mode
  elements reject by name.
- **Drift guard — the TS↔runtime consistency test.** The check tables
  go `as const satisfies` so their keys form literal unions, and
  compile-time assertions
  (`OptionalKeysOf`/`IsNever`) prove every optional `BroPlugin` field,
  every optional `Connector` field, every `keyof FacadeMap`, and every
  `keyof ConnectorHooks` is covered by a runtime check. A type
  extending without a check row fails `npm run typecheck`, which is
  CI. The runtime half: every built-in `PLUGINS` entry and every
  registered `connectors()` entry must produce no problem — typed,
  trusted objects can never trip the contract.

## Verification

- New table-driven cases assert the two verified bad shapes
  (`matchDir: 1`, `optInFacades: 4`) reject **with the field named in
  stderr**; `activeIn` malformed shapes (`{stopGate: 5}`, unknown key,
  non-mode element, sparse list) reject by name; a valid connector
  declaring `optIn`/`optInFacades`/`activeIn` still registers.
- Consistency tests iterate `PLUGINS` and `connectors()` asserting
  `pluginExportProblem`/`connectorProblem` return `undefined`
  (over-rejection guard); the `as const` coverage asserts guard the
  tables under `npm run typecheck`.
- Exact repo CI: `npm run build`, `npm run typecheck`, `npm test`,
  `npm run check:plugins`.
