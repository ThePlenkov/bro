/**
 * Named probes the cli registers into the guard engine — the closed
 * registry's concrete entries (spec: specs/sessions/bro-nkn6.md). A
 * probe is an argv-git/file read bounded to its own work; every failure
 * mode is `{ ok: false, detail }` — a predicate that can't verify
 * doesn't assert (and the detail is what `bro guard test` shows).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  loadConfig,
  specStore,
  tasksAsync,
  type SpecStore,
  type TaskRow,
  type TaskStoreAsync,
} from '@broject/core'
import type { NamedProbe, ProbeResult } from '@broject/guard'
import {
  driftEnv,
  driftRow,
  localSpecPath,
  specLinkPath,
  SPEC_LINK,
  type DriftEnv,
} from './spec-drift.ts'

/** Per-process memos — hook invocations and `guard test` are one-shot
 *  runs, so the sweep's N probes share one connector resolution, one
 *  tasks facade, and one drift env instead of re-paying the resolution
 *  spawns (remote-url probe, matchDir walks, ref/shallow checks) per
 *  clause. Same lifetime assumption spec-drift's logRecordsCache makes. */
const specStoreMemo = new Map<string, SpecStore>()
const tasksStoreMemo = new Map<string, TaskStoreAsync>()
const driftEnvMemo = new Map<string, DriftEnv>()

/** The specs facade degrades rather than kills the clause — an
 *  `args.spec` drift never consults the store (scope reads the file's
 *  own frontmatter), and an `args.id` one without a spec: link gets
 *  'no local spec file to date' from an empty tree — unverifiable,
 *  not a crash. Mirrors spec.ts's specs() degrade. */
function specsOrDegraded(dir: string): SpecStore {
  let spec = specStoreMemo.get(dir)
  if (spec !== undefined) {
    return spec
  }
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
  specStoreMemo.set(dir, spec)
  return spec
}

/** The tasks facade a probe's bead read goes through — async, so the
 *  sweep's `bd show` calls overlap rather than serialize ~1s each, and
 *  resolved once per dir (facade resolution itself shells git). */
function tasksStore(dir: string): TaskStoreAsync {
  let store = tasksStoreMemo.get(dir)
  if (store === undefined) {
    store = tasksAsync(dir, loadConfig(dir).connectors)
    tasksStoreMemo.set(dir, store)
  }
  return store
}

/** driftEnv keyed by (dir, ref) — the comparison ref and shallow check
 *  are repo facts, invariant inside one run. */
function driftEnvFor(dir: string, ref?: string): DriftEnv {
  const key = `${dir}\0${ref ?? ''}`
  let env = driftEnvMemo.get(key)
  if (env === undefined) {
    env = driftEnv(dir, ref)
    driftEnvMemo.set(key, env)
  }
  return env
}

/** args.spec — explicit file wins; validation is localSpecPath's, so a
 *  URL/absent/dir arg is a clean `unverifiable`, not a throw. */
function probeSpecArg(
  dir: string,
  specArg: string,
  label: string,
  ref: string | undefined,
  spec: SpecStore
): ProbeResult {
  const link = localSpecPath(dir, specArg)
  if (link === undefined) {
    return { ok: false, detail: `no local spec file: ${specArg}` }
  }
  const row = driftRow(dir, label, spec, driftEnvFor(dir, ref), link)
  return { ok: row.state === 'STALE', detail: `${row.state} — ${row.detail}` }
}

/** args.id — the bead's own spec declaration wins, then the tree pick.
 *  Async: the bead read is a `bd show` (~1s of dolt startup) — through
 *  tasksAsync the whole sweep's reads overlap instead of serializing. */
async function probeIdArg(
  dir: string,
  idArg: string,
  ref: string | undefined,
  spec: SpecStore
): Promise<ProbeResult> {
  let row0: TaskRow | undefined
  try {
    row0 = await tasksStore(dir).get(idArg)
  } catch (err) {
    return { ok: false, detail: `tasks read failed: ${err instanceof Error ? err.message : err}` }
  }
  if (row0 === undefined) {
    return { ok: false, detail: `no bead ${idArg}` }
  }
  // a declared `spec:` that resolves to no local file is unverifiable
  // on its own — the tree pick must not silently substitute a spec the
  // bead never declared (same contract as `bro spec drift`)
  const link = specLinkPath(dir, row0.description)
  if (SPEC_LINK.test(row0.description ?? '') && link === undefined) {
    return { ok: false, detail: 'unverifiable — no local spec file to date' }
  }
  const row = driftRow(dir, idArg, spec, driftEnvFor(dir, ref), link)
  return { ok: row.state === 'STALE', detail: `${row.state} — ${row.detail}` }
}

/** `spec-drift` — the bro-fvhz freshness audit as a guard predicate.
 *
 *  args.spec: drift a repo-relative spec file directly — no bead read;
 *             scope comes from the file's own frontmatter.
 *  args.id:   drift a bead — its `spec:` link wins, else the tree pick;
 *             when the spec lacks frontmatter, `(<id>)` commits scope it.
 *             A declared `spec:` resolving to no local file fails closed
 *             (unverifiable) — the tree pick must not substitute a spec
 *             the bead never declared, same as `bro spec drift`.
 *  args.ref:  comparison ref override (default: driftEnv's origin/HEAD
 *             → main → HEAD chain).
 *
 *  ok = STALE. `fresh`, `no-scope`, `unverifiable` all fail closed with
 *  the row's detail — a probe answers truth, and "can't date the spec"
 *  is not "the spec is stale". */
const specDrift: NamedProbe = async (args, dir): Promise<ProbeResult> => {
  const specArg = typeof args?.spec === 'string' ? args.spec : undefined
  const idArg = typeof args?.id === 'string' ? args.id : undefined
  const ref = typeof args?.ref === 'string' ? args.ref : undefined
  if (specArg === undefined && idArg === undefined) {
    return { ok: false, detail: 'args.spec or args.id required' }
  }
  const spec = specsOrDegraded(dir)
  if (specArg !== undefined) {
    return probeSpecArg(dir, specArg, idArg ?? specArg, ref, spec)
  }
  return probeIdArg(dir, idArg!, ref, spec)
}

/** `core-vendor` — the REVIEW.md layering rule as a guard predicate:
 *  `args.terms` (string[]) are vendor identifiers that must not appear
 *  as word tokens in `args.path` (default `packages/core/src`), `*.ts`
 *  only; `*.test.*` files are skipped — a fixture naming a vendor as
 *  data is not coupling, the boundary lives in shipped source. ok = a
 *  violation exists (the guard fires). Any fs error is
 *  `{ ok: false, detail }` — a probe that can't scan doesn't assert. */
const coreVendor: NamedProbe = (args, dir): ProbeResult => {
  const terms = Array.isArray(args?.terms)
    ? args.terms.filter((t): t is string => typeof t === 'string' && t !== '')
    : []
  if (terms.length === 0) {
    return { ok: false, detail: 'args.terms (string[]) required' }
  }
  const root = typeof args?.path === 'string' && args.path !== '' ? args.path : 'packages/core/src'
  // the scan root must stay inside the repo — a config-supplied `..`
  // or absolute escape is a config bug, not a verdict
  if (isAbsolute(root) || root.split('/').includes('..')) {
    return { ok: false, detail: `path escapes the repo: ${root}` }
  }
  const base = join(dir, root)
  const hits: string[] = []
  const re = new RegExp(
    `\\b(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'i'
  )
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
        const lines = readFileSync(p, 'utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          const m = re.exec(lines[i]!)
          if (m !== null) {
            hits.push(`${p.slice(dir.length + 1)}:${i + 1} ${m[1]}`)
            break // one hit per file-line suffices for the say
          }
        }
      }
    }
  }
  try {
    walk(base)
  } catch (err) {
    return { ok: false, detail: `scan failed: ${err instanceof Error ? err.message : err}` }
  }
  return hits.length === 0
    ? { ok: false, detail: `${root} clean of ${terms.length} terms` }
    : { ok: true, detail: hits.slice(0, 8).join('; ') + (hits.length > 8 ? `; +${hits.length - 8} more` : '') }
}

/** The registry — closed on purpose (spec: unknown names fail their
 *  clause, so an engine that doesn't get this map can't silently
 *  approve a spec-drift guard). `guard test` and the hook emit paths
 *  both install it. */
export const GUARD_PROBES: Readonly<Record<string, NamedProbe>> = {
  'spec-drift': specDrift,
  'core-vendor': coreVendor,
}
