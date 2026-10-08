/**
 * `bro spec` — spec-driven development policy over claimed tasks.
 *
 * A bead has a spec when the resolved `specs` connector sees one
 * (native: <dir>/<id>.md or a <dir>/<id>/ dir whose spec.md/README.md
 * is the index — nesting IS the spec tree; speckit: a linked
 * specs/<NNN>-<slug>/spec.md; openspec: changes/<id>/proposal.md)
 * or its description carries a `spec:` link. Chores, molecule
 * ship-beads, and `trivial`-/`debt`-labeled beads are exempt — SDD
 * measures design mass, not bookkeeping.
 *
 *   bro spec check [id…]   coverage over in_progress beads (exit 1 on
 *                          missing — CI-able); --all includes open
 *   bro spec drift [id…]   freshness over spec'd beads — STALE when
 *                          landed code moved past the spec; default
 *                          scans closed beads, --all scans all, --json
 *                          for agents, exit 1 on STALE
 *   bro spec new <id>      scaffold a spec (--parent <id> nests inside
 *                          a dir spec, else frontmatter-links — native)
 *   bro spec tree          the spec hierarchy: roots, children, and
 *                          claimed beads still MISSING a spec
 *   bro spec init          bootstrap SDD — detect the project's tool,
 *                          write connectors.specs + sdd.mode, or
 *                          scaffold a native specs/ on a bare repo
 *
 * The same module owns sddConnector: session-start + prompt-submit
 * nudges and the 'task'-aspect stop-gate contribution, all gated on
 * bro.config.json `sdd.mode` (off|remind|gate — default off, so the
 * policy is opt-in per repo and committed, not per machine). Probes
 * delegate to the resolved spec connector — enforcement speaks the
 * project's own tool language.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import {
  facade,
  isOwnClaim,
  loadConfig,
  sessionTaskClaims,
  specStore,
  tasksAsync,
  type Connector,
  type ConnectorCtx,
  type SpecNode,
  type SpecStore,
  type TaskRow,
  type TaskStore,
  type TaskStoreAsync,
} from '@broject/core'
import { specDirAbs, validBeadId } from '../spec-connectors.ts'
import { driftEnv, driftRow, specLinkPath, SPEC_LINK } from '../spec-drift.ts'
import { flag, positionals } from './args.ts'

export type SpecState = 'spec' | 'link' | 'exempt' | 'missing'

/** Issue types that exempt a bead from the spec rule — `chore` is
 *  bookkeeping, `molecule` roots are convoy scaffolding (ship-beads
 *  claimed by `bro convoy run`), not design work. */
const EXEMPT_TYPES = ['chore', 'molecule']

/** Labels that exempt a bead from the spec rule — `trivial` needs no
 *  design mass, `debt` rows are harvested findings that already carry
 *  their own evidence (file/line/severity). */
const EXEMPT_LABELS = ['trivial', 'debt']

export function specState(row: TaskRow, spec: SpecStore): SpecState {
  if (
    EXEMPT_TYPES.includes(row.issue_type ?? '') ||
    (row.labels ?? []).some((l) => EXEMPT_LABELS.includes(l))
  ) {
    return 'exempt'
  }
  if (SPEC_LINK.test(row.description ?? '')) {
    return 'link'
  }
  if (spec.hasSpec(row.id)) {
    return 'spec'
  }
  return 'missing'
}

function tasks(dir: string): TaskStore {
  return facade('tasks', { dir }, { prefer: loadConfig(dir).connectors })
}

/** The project's spec facade — a bad `connectors.specs` name (typo'd or
 *  uninstalled plugin) must never break a hook or a coverage run:
 *  degrade to agent-style policy text instead of throwing. */
function specs(dir: string): SpecStore {
  try {
    return specStore(dir, loadConfig(dir).connectors)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      hasSpec: () => false,
      remedy: () => `fix connectors.specs (${msg}) or add a spec: link`,
      policy: () => `spec before code — specs facade unavailable: ${msg}`,
      tree: () => [],
    }
  }
}

/** Async tasks facade — the probe path awaits instead of serializing
 *  bd spawns behind the event loop. */
function tasksProbe(dir: string): TaskStoreAsync {
  return tasksAsync(dir, loadConfig(dir).connectors)
}

/** This session's claimed beads that lack a spec — the nudge scope is
 *  always own claims; foreign work is never this session's to spec.
 *  Fail-open: a dead task store must not eat the policy line. */
async function ownClaimsMissingSpec(ctx: ConnectorCtx): Promise<TaskRow[]> {
  try {
    const mine = sessionTaskClaims(ctx)
    if (mine.size === 0) {
      return []
    }
    // marker ids are attempted claims — a task held by another actor is
    // foreign work, never this session's to spec. The actor identity is
    // the serving store's: a non-beads backend's assignee lives in that
    // backend's identity space — comparing it to beads/git identity
    // would wrongly disprove every claim; a store that exposes no actor
    // keeps the marker's word (fail-open)
    const store = tasksProbe(ctx.dir)
    const [me, rows] = await Promise.all([
      store.actor?.() ?? Promise.resolve(''),
      store.list({ status: 'in_progress' }),
    ])
    const spec = specs(ctx.dir)
    return rows.filter((r) => isOwnClaim(r, mine, me) && specState(r, spec) === 'missing')
  } catch {
    return []
  }
}

const shortTitle = (t: string | undefined): string => {
  const flat = (t ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

const fmt = (r: TaskRow): string => `${r.id} ${shortTitle(r.title)}`.trim()

export const sddConnector: Connector = {
  name: 'sdd',
  hooks: () => ({
    async sessionStart(ctx) {
      const { mode } = loadConfig(ctx.dir).sdd
      if (mode === 'off') {
        return []
      }
      const spec = specs(ctx.dir)
      const missing = (await ownClaimsMissingSpec(ctx)).map((r) => `  spec missing: ${fmt(r)}`)
      return [`SDD (${mode}): ${spec.policy()}`, ...missing]
    },
    async promptSubmit(ctx) {
      const { mode } = loadConfig(ctx.dir).sdd
      if (mode === 'off') {
        return []
      }
      const missing = await ownClaimsMissingSpec(ctx)
      if (missing.length === 0) {
        return []
      }
      const spec = specs(ctx.dir)
      return [
        `SDD: claimed beads without a spec: ${missing.map(fmt).join(', ')} — ${missing.length === 1 ? spec.remedy(missing[0]!.id) : 'write the spec first'}`,
      ]
    },
    async stopGate(ctx) {
      const { mode } = loadConfig(ctx.dir).sdd
      if (mode === 'off') {
        return []
      }
      const missing = await ownClaimsMissingSpec(ctx)
      if (missing.length === 0) {
        return []
      }
      const spec = specs(ctx.dir)
      const line = `bro: SDD — claimed beads without a spec: ${missing.map(fmt).join(', ')} — ${missing.length === 1 ? spec.remedy(missing[0]!.id) : spec.policy()}`
      return [
        mode === 'gate'
          ? { aspect: 'task', block: line }
          : { aspect: 'task', passive: `${line} (remind mode)` },
      ]
    },
  }),
}

// --- commands -----------------------------------------------------------------

function usage(): never {
  console.error(`Usage: bro spec <command> [args…]

Commands:
  check [id…]   spec coverage for in_progress beads (or the given ids);
                --all also scans open beads. Exit 1 when any MISSING.
  drift [id…]   spec freshness over spec'd beads — STALE when landed
                code moved past the spec. Default scans closed beads;
                --all scans every spec'd bead, --json emits rows as
                objects, --ref overrides the comparison ref. Exit 1 on
                any STALE.
  new <id>      scaffold a spec from the bead title (refuses to
                overwrite). --parent <id> nests inside a dir spec, or
                links a flat parent via frontmatter (native connector).
  tree          spec hierarchy from the serving connector's tree() —
                roots, children, MISSING for claimed beads without one.
  init          bootstrap SDD: detect the project's tool (.specify/,
                openspec/) and write connectors.specs + sdd.mode;
                --tool overrides detection. On a bare repo scaffolds a
                native specs/ root spec-of-specs.`)
  process.exit(2)
}

function cmdNew(dir: string, id: string | undefined, parent: string | undefined): void {
  if (!id) {
    console.error('error: bro spec new needs a bead id — `bro spec new bro-123`')
    process.exit(2)
  }
  if (!validBeadId(id)) {
    console.error(String.raw`error: invalid bead id "${id}" — ids match [\w.-]+ without '..'`)
    process.exit(2)
  }
  if (parent !== undefined && !validBeadId(parent)) {
    console.error(String.raw`error: invalid parent id "${parent}" — ids match [\w.-]+ without '..'`)
    process.exit(2)
  }
  const spec = specs(dir)
  if (!spec.scaffold) {
    console.error(`error: the serving specs connector owns spec files — ${spec.remedy(id)}`)
    process.exit(1)
  }
  let title = ''
  try {
    title = tasks(dir).get(id)?.title ?? ''
  } catch {
    // no task backend readable — scaffold with the bare id
  }
  try {
    console.log(`spec: wrote ${spec.scaffold(id, { parent, title })}`)
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

function cmdCheck(dir: string, ids: string[], all: boolean): void {
  const store = tasks(dir)
  const spec = specs(dir)
  const unknown: string[] = []
  const rows =
    ids.length > 0
      ? ids.flatMap((id) => {
          const r = store.get(id)
          if (!r) {
            unknown.push(id)
          }
          return r ? [r] : []
        })
      // limit 0 — a backend default cap must not silently drop rows
      // from a coverage audit
      : store.list({ status: 'in_progress', limit: 0 }).concat(all ? store.list({ status: 'open', limit: 0 }) : [])
  // an explicit id that doesn't resolve is a usage failure — partial
  // results would report silent success for a bead that doesn't exist
  if (unknown.length > 0) {
    console.error(`error: bead(s) not found: ${unknown.join(', ')}`)
    process.exit(2)
  }
  let missing = 0
  for (const r of rows) {
    const state = specState(r, spec)
    if (state === 'missing') {
      missing += 1
    }
    console.log(`${r.id}\t${state === 'missing' ? 'MISSING' : state}\t${shortTitle(r.title)}`)
  }
  if (missing > 0) {
    console.error(`spec check: ${missing} bead(s) without a spec — ${spec.policy()}`)
    // exitCode, not exit() — process.exit can cut pending piped stdout
    process.exitCode = 1
  }
}

/** `bro spec drift` — the freshness audit (spec: specs/bro-fvhz.md).
 *  Same TSV + exit-code contract as check: a row per spec'd bead,
 *  sorted by id, exit 1 when any STALE. `unverifiable`/`no-scope`
 *  report coverage gaps without failing. */
function cmdDrift(dir: string, ids: string[], opts: { all: boolean; json: boolean; ref?: string }): void {
  const store = tasks(dir)
  const spec = specs(dir)
  const unknown: string[] = []
  const rows =
    ids.length > 0
      ? ids.flatMap((id) => {
          const r = store.get(id)
          if (!r) {
            unknown.push(id)
          }
          return r ? [r] : []
        })
      // closed beads need `all` — the filter's documented switch for
      // including them; a backend may drop closed rows without it.
      // limit 0 — a backend default cap must not silently drop rows
      : store.list(opts.all ? { all: true, limit: 0 } : { status: 'closed', all: true, limit: 0 })
  // an explicit id that doesn't resolve is a usage failure — partial
  // results would report silent success for a bead that doesn't exist
  if (unknown.length > 0) {
    console.error(`error: bead(s) not found: ${unknown.join(', ')}`)
    process.exit(2)
  }
  // the audit set is spec'd beads — spec|link states; exempt (chore /
  // molecule / trivial / debt) and unspec'd beads never enter it. An explicit id
  // always yields a row — dropping it would report a clean pass for an
  // audit that never ran (driftRow answers 'no local spec file')
  const audited = rows.filter((r) => {
    const s = specState(r, spec)
    return s === 'spec' || s === 'link' || ids.length > 0
  })
  const env = driftEnv(dir, opts.ref)
  const drifted = audited
    .map((r) => {
      // a declared `spec:` that resolves to no local file is
      // unverifiable on its own — the tree pick must not silently
      // substitute a spec the bead never declared
      const link = specLinkPath(dir, r.description)
      return SPEC_LINK.test(r.description ?? '') && link === undefined
        ? { id: r.id, state: 'unverifiable' as const, detail: 'no local spec file to date' }
        : driftRow(dir, r.id, spec, env, link)
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  if (opts.json) {
    console.log(JSON.stringify(drifted))
  } else {
    for (const r of drifted) {
      console.log(`${r.id}\t${r.state}\t${r.detail}`)
    }
  }
  const stale = drifted.filter((r) => r.state === 'STALE').length
  if (stale > 0) {
    console.error(`spec drift: ${stale} stale spec(s)`)
    // exitCode, not exit() — process.exit can cut pending piped stdout
    // (`bro spec drift --json | jq` would read a truncated array)
    process.exitCode = 1
  }
}

/** Render the facade's tree: children indent under their parent, nodes
 *  no bead claims are plain rows, and in_progress beads without a spec
 *  report MISSING so the audit sees the gaps the gate would block. */
function cmdTree(dir: string): void {
  const spec = specs(dir)
  const nodes = spec.tree()
  const byId = new Map<string, SpecNode[]>()
  for (const n of nodes) {
    byId.set(n.id, [...(byId.get(n.id) ?? []), n])
  }
  /** A child's parent resolves to a node, not an id — duplicate ids at
   *  different depths (flat `specs/foo.md` beside dir spec
   *  `specs/x/foo/`) share one id. A positional edge belongs to the dir
   *  spec whose tree contains the child's path (only an index-bearing
   *  dir can contain a child — flat files never enclose); an explicit
   *  frontmatter edge resolves deterministically to the path-first
   *  candidate. Self-parent (a hand-authored `parent: <self>`) is
   *  root-level — keying under itself orphans the node. */
  const parentOf = (n: SpecNode): SpecNode | undefined => {
    const p = n.parent
    if (p === undefined || p === n.id) {
      return undefined
    }
    const cands = byId.get(p) ?? []
    if (cands.length <= 1) {
      return cands[0]
    }
    const byPath = cands
      .slice()
      .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''))
    if (n.parentVia === 'frontmatter') {
      return byPath[0]
    }
    const enclosing = cands
      .filter(
        (c) =>
          c.path !== undefined &&
          basename(dirname(c.path)) === c.id &&
          n.path !== undefined &&
          n.path.startsWith(`${dirname(c.path)}${sep}`)
      )
      .sort((a, b) => b.path!.length - a.path!.length)
    return enclosing[0] ?? byPath[0]
  }
  const byParent = new Map<SpecNode | undefined, SpecNode[]>()
  for (const n of nodes) {
    const key = parentOf(n)
    byParent.set(key, [...(byParent.get(key) ?? []), n])
  }
  const rendered = new Set<SpecNode>()
  const walk = (parent: SpecNode | undefined, depth: number): void => {
    for (const n of byParent.get(parent) ?? []) {
      const path = n.path !== undefined ? `  ${n.path}` : ''
      console.log(`${'  '.repeat(depth)}${n.id}${path}`)
      rendered.add(n)
      walk(n, depth + 1)
    }
  }
  walk(undefined, 0)
  // a hand-authored cycle (a↔b) keys every member under a partner the
  // root walk never reaches — name the dropped subtree, don't drop it
  // silently
  const orphaned = nodes.filter((n) => !rendered.has(n))
  if (orphaned.length > 0) {
    console.error(
      `spec tree: cyclic parent edge(s) — not rendered: ${orphaned.map((n) => n.id).join(', ')}`
    )
  }
  let missing: TaskRow[] = []
  try {
    const store = tasks(dir)
    missing = store
      .list({ status: 'in_progress' })
      .filter((r) => specState(r, spec) === 'missing')
  } catch {
    // no task backend — tree alone still renders
  }
  for (const r of missing) {
    console.log(`  ${r.id}  MISSING  ${shortTitle(r.title)}`)
  }
  if (nodes.length === 0 && missing.length === 0) {
    console.log('spec tree: empty — `bro spec init` bootstraps the first spec')
  }
}

/** Object-or-empty for config merges — malformed sections (string where
 *  an object was expected) must not spread chars into the patch. */
function sectionObj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {}
}

/** Config merge — write the detected tool + sdd.mode without clobbering
 *  unrelated sections the repo already set. `native` clears a stale
 *  connectors.specs override — init to native must actually resolve
 *  native, not leave a prior pick in force. */
function writeConfig(dir: string, patch: { sddMode: string; connector?: string }): string {
  const path = join(dir, 'bro.config.json')
  let cfg: Record<string, unknown> = {}
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    // absent or unreadable config — start fresh
  }
  cfg.sdd = { ...sectionObj(cfg.sdd), mode: patch.sddMode }
  const connectors = sectionObj(cfg.connectors)
  if (patch.connector === undefined || patch.connector === 'native') {
    delete connectors.specs
  } else {
    connectors.specs = patch.connector
  }
  if (Object.keys(connectors).length === 0) {
    delete cfg.connectors
  } else {
    cfg.connectors = connectors
  }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`)
  return path
}

/** Project-layout detection for `spec init` — the order is the claim
 *  precedence the connectors use. */
function detectSpecTool(dir: string): string {
  if (existsSync(join(dir, '.specify'))) {
    return 'speckit'
  }
  if (existsSync(join(dir, 'openspec'))) {
    return 'openspec'
  }
  return 'native'
}

const SPEC_TOOLS = ['native', 'speckit', 'openspec', 'agent']

function cmdInit(dir: string, tool: string | undefined): void {
  const detected = tool ?? detectSpecTool(dir)
  if (!SPEC_TOOLS.includes(detected)) {
    console.error(`error: unknown spec tool "${detected}" — one of ${SPEC_TOOLS.join(', ')}`)
    process.exit(2)
  }
  const cfgPath = writeConfig(dir, {
    sddMode: 'remind',
    connector: detected === 'native' ? undefined : detected,
  })
  const specDir = loadConfig(dir).sdd.dir
  if (detected === 'native' && specDirAbs(dir, specDir) !== null && !existsSync(join(dir, specDir))) {
    try {
      const path = specs(dir).scaffold?.('project', { title: 'spec of specs' })
      if (path) {
        console.log(`spec: wrote ${path}`)
      }
    } catch {
      // scaffold failure is non-fatal — config still landed
    }
  }
  const note = detected === 'agent' ? ' (policy-only: link specs via spec:)' : ''
  console.log(`spec init: ${detected} — sdd.mode=remind written to ${cfgPath}${note}`)
}

const VALUE_FLAGS = new Set(['--parent', '--tool'])

/** drift's own value flag — kept out of the shared set so a stray
 *  `--ref` on another subcommand stays an unknown flag, not a swallowed
 *  positional. */
const DRIFT_VALUE_FLAGS = new Set([...VALUE_FLAGS, '--ref'])

/** Per-subcommand option allowlist — a misspelled or misplaced option
 *  must fail loudly. Without it `--jso` runs a TSV audit the caller
 *  expected as JSON, and `--ref HEAD` on `new` leaks HEAD into
 *  positionals as the bead id. `=`-spellings of a known flag pass. */
const KNOWN_FLAGS: Record<string, Set<string>> = {
  new: new Set(['--parent']),
  check: new Set(['--all']),
  drift: new Set([...DRIFT_VALUE_FLAGS, '--all', '--json']),
  tree: new Set(),
  init: new Set(['--tool']),
}

export function runSpecCommand(argv: string[]): void {
  const dir = process.cwd()
  const { mode } = loadConfig(dir).sdd
  const [sub, ...rest] = argv
  // own-key lookup — an inherited key like `toString` is not a
  // subcommand; bare `bro spec` dispatches to check
  const key = sub ?? 'check'
  const known = Object.hasOwn(KNOWN_FLAGS, key) ? KNOWN_FLAGS[key] : undefined
  if (known === undefined) {
    usage()
  }
  for (const a of rest) {
    if (a.startsWith('--') && !known.has(a.split('=', 1)[0]!)) {
      console.error(`error: unknown option "${a}" for spec ${key}`)
      process.exit(2)
    }
  }
  const positional = positionals(rest, VALUE_FLAGS)
  if (sub === 'new') {
    cmdNew(dir, positional[0], flag(rest, '--parent'))
    return
  }
  if (sub === 'check' || sub === undefined) {
    if (mode === 'off') {
      console.error('note: sdd.mode is off — enable it in bro.config.json to make this a policy')
    }
    cmdCheck(dir, positional, rest.includes('--all'))
    return
  }
  if (sub === 'drift') {
    cmdDrift(dir, positionals(rest, DRIFT_VALUE_FLAGS), {
      all: rest.includes('--all'),
      json: rest.includes('--json'),
      ref: flag(rest, '--ref'),
    })
    return
  }
  if (sub === 'tree') {
    cmdTree(dir)
    return
  }
  if (sub === 'init') {
    cmdInit(dir, flag(rest, '--tool'))
    return
  }
  usage()
}
