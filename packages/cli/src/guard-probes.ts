/**
 * Named probes the cli registers into the guard engine — the closed
 * registry's concrete entries (spec: specs/sessions/bro-nkn6.md). A
 * probe is an argv-git/file read bounded to its own work; every failure
 * mode is `{ ok: false, detail }` — a predicate that can't verify
 * doesn't assert (and the detail is what `bro guard test` shows).
 */
import { facade, loadConfig, specStore, type SpecStore, type TaskStore } from '@broject/core'
import type { NamedProbe, ProbeResult } from '@broject/guard'
import { driftEnv, driftRow, localSpecPath, specLinkPath } from './spec-drift.ts'

/** `spec-drift` — the bro-fvhz freshness audit as a guard predicate.
 *
 *  args.spec: drift a repo-relative spec file directly — no bead read;
 *             scope comes from the file's own frontmatter.
 *  args.id:   drift a bead — its `spec:` link wins, else the tree pick;
 *             when the spec lacks frontmatter, `(<id>)` commits scope it.
 *  args.ref:  comparison ref override (default: driftEnv's origin/HEAD
 *             → main → HEAD chain).
 *
 *  ok = STALE. `fresh`, `no-scope`, `unverifiable` all fail closed with
 *  the row's detail — a probe answers truth, and "can't date the spec"
 *  is not "the spec is stale". */
const specDrift: NamedProbe = (args, dir): ProbeResult => {
  const specArg = typeof args?.spec === 'string' ? args.spec : undefined
  const idArg = typeof args?.id === 'string' ? args.id : undefined
  const ref = typeof args?.ref === 'string' ? args.ref : undefined
  if (specArg === undefined && idArg === undefined) {
    return { ok: false, detail: 'args.spec or args.id required' }
  }

  // the specs facade degrades rather than kills the clause — an
  // `args.spec` drift never consults the store (scope reads the file's
  // own frontmatter), and an `args.id` one without a spec: link gets
  // 'no local spec file to date' from an empty tree — unverifiable,
  // not a crash. Mirrors spec.ts's specs() degrade.
  let spec: SpecStore
  try {
    spec = specStore(dir, loadConfig(dir).connectors)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    spec = {
      hasSpec: () => false,
      remedy: () => `fix connectors.specs (${msg})`,
      policy: () => `specs facade unavailable: ${msg}`,
      tree: () => [],
    }
  }

  // args.spec — explicit file wins; validation is specLinkPath's, so a
  // URL/absent/dir arg is a clean `unverifiable`, not a throw
  if (specArg !== undefined) {
    const link = localSpecPath(dir, specArg)
    if (link === undefined) {
      return { ok: false, detail: `no local spec file: ${specArg}` }
    }
    const row = driftRow(dir, idArg ?? specArg, spec, driftEnv(dir, ref), link)
    return { ok: row.state === 'STALE', detail: `${row.state} — ${row.detail}` }
  }

  // args.id — the bead's own spec declaration wins, then the tree pick
  let row0: ReturnType<TaskStore['get']>
  try {
    const tasks = facade('tasks', { dir }, { prefer: loadConfig(dir).connectors })
    row0 = tasks.get(idArg!)
  } catch (err) {
    return { ok: false, detail: `tasks read failed: ${err instanceof Error ? err.message : err}` }
  }
  if (row0 === undefined) {
    return { ok: false, detail: `no bead ${idArg}` }
  }
  const row = driftRow(dir, idArg!, spec, driftEnv(dir, ref), specLinkPath(dir, row0.description))
  return { ok: row.state === 'STALE', detail: `${row.state} — ${row.detail}` }
}

/** The registry — closed on purpose (spec: unknown names fail their
 *  clause, so an engine that doesn't get this map can't silently
 *  approve a spec-drift guard). `guard test` and the hook emit paths
 *  both install it. */
export const GUARD_PROBES: Readonly<Record<string, NamedProbe>> = { 'spec-drift': specDrift }
