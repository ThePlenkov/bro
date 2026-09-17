/**
 * Drill frames as beads. A frame is an issue labeled `drill`; nesting uses
 * bd's native `--parent` hierarchy. bd owns storage — bro owns the
 * invariants: strictly-narrower descent on the way down, a mandatory
 * RESULT + PREVENTION memo on the way up, and lifecycle provenance
 * (`claim` on down, `handoff` on up). No claim.json, no .drills/ tree —
 * beads IS the memory system.
 */
import { bd, bdJson, evidenceKind, refKind } from '@bro/core'
import type { DownOptions, DrillFrame, DrillRow, UpOptions, UpResult } from './types.ts'

const DRILL_LABEL = 'drill'
const PREVENTION_LABEL = 'prevention'

function isDrill(row: DrillRow): boolean {
  return row.labels?.includes(DRILL_LABEL) ?? false
}

function isOpen(row: DrillRow): boolean {
  return row.status !== 'closed' && row.status !== 'done'
}

export function listDrills(): DrillRow[] {
  const persistent = bdJson<DrillRow[]>(['list', '-l', DRILL_LABEL, '--all', '-n', '0'])
  // ephemeral frames live in the wisp namespace, outside `bd list`
  let wisps: DrillRow[] = []
  try {
    const out = bdJson<{ wisps?: DrillRow[] }>(['mol', 'wisp', 'list', '--all'])
    wisps = (out.wisps ?? []).filter(isDrill)
  } catch (err) {
    // tolerate only an explicitly unsupported command (older bd) — a
    // failed or malformed listing must not silently hide live wisps
    const msg = err instanceof Error ? err.message : String(err)
    if (!/unknown command|unrecognized command/i.test(msg)) {
      throw err
    }
  }
  return [...persistent, ...wisps]
}

export function childrenOf(id: string): DrillRow[] {
  return bdJson<DrillRow[]>(['children', id])
}

/** One `bd children` sweep: parent→kids and kid→parent in a single pass.
 * Kids are NOT label-filtered — drillUp's close check needs every child,
 * and drillTree renders them. Callers pick which predicate applies. */
function drillRelations(rows: DrillRow[]): {
  kids: Map<string, DrillRow[]>
  parents: Map<string, string>
} {
  const kids = new Map<string, DrillRow[]>()
  const parents = new Map<string, string>()
  for (const row of rows) {
    const children = childrenOf(row.id)
    if (children.length === 0) {
      continue
    }
    kids.set(row.id, children)
    for (const kid of children) {
      if (isDrill(kid)) {
        parents.set(kid.id, row.id)
      }
    }
  }
  return { kids, parents }
}

/**
 * The active frame: an open drill leaf (no open drill children) on the
 * deepest path. Ties break on most-recently-updated — the frame the agent
 * touched last is almost always the live one.
 */
export function currentFrame(): DrillFrame | undefined {
  const rows = listDrills().filter(isOpen)
  if (rows.length === 0) {
    return undefined
  }
  const { kids, parents } = drillRelations(rows)
  const depthOf = (id: string): number => {
    let d = 0
    let cur: string | undefined = id
    while ((cur = parents.get(cur)) !== undefined) {
      d += 1
    }
    return d
  }
  // leaf = no open DRILL child. A drill frame with an open non-drill child
  // is still the active frame — close eligibility (any open child) is
  // enforced separately in drillUp.
  const leaves = rows.filter(
    (r) => !(kids.get(r.id) ?? []).some((k) => isOpen(k) && isDrill(k))
  )
  leaves.sort((a, b) => {
    const d = depthOf(b.id) - depthOf(a.id)
    return d !== 0 ? d : (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
  })
  const leaf = leaves[0]
  if (!leaf) {
    return undefined
  }
  return { ...leaf, parentId: parents.get(leaf.id), depth: depthOf(leaf.id) }
}

/** The bead must be an open drill frame, or an explicit selector is wrong. */
function requireOpenDrill(id: string, flag: string): DrillRow {
  const row = bdJson<DrillRow[]>(['show', id])[0]
  if (!row || !isDrill(row) || !isOpen(row)) {
    throw new Error(`${flag} ${id} is not an open drill frame`)
  }
  return row
}

/** Record the claim provenance; on failure, delete the frame — an
 * unclaimed frame violates the claim-on-down invariant, and a retry would
 * create a duplicate. A failed cleanup must not swallow the claim error. */
function claimFrame(id: string): void {
  try {
    bd([
      'provenance',
      'record',
      '--issue',
      id,
      '--kind',
      'claim',
      '--source',
      'bro drill down',
      '--at',
      new Date().toISOString(),
    ])
  } catch (err) {
    try {
      bd(['delete', id, '--force'])
    } catch (cleanupErr) {
      throw new Error(
        `claim failed: ${err instanceof Error ? err.message : err}; ` +
          `cleanup of ${id} also failed (frame left unclaimed): ` +
          `${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`
      )
    }
    throw err
  }
}

/** Descend: create a child frame under `opts.under` or the current leaf. */
export function drillDown(title: string, opts: DownOptions = {}): DrillRow {
  const parent = opts.under
    ? requireOpenDrill(opts.under, '--under').id
    : currentFrame()?.id
  const args = ['create', title, '-l', DRILL_LABEL]
  if (parent) {
    args.push('--parent', parent)
  }
  if (opts.ephemeral) {
    args.push('--ephemeral')
  }
  if (opts.type) {
    args.push('-t', opts.type)
  }
  if (opts.priority !== undefined) {
    args.push('-p', String(opts.priority))
  }
  if (opts.description) {
    args.push('-d', opts.description)
  }
  const row = bdJson<DrillRow>(args)
  if (!opts.ephemeral) {
    // wisp semantics: ephemeral frames get no audit trail
    claimFrame(row.id)
  }
  return row
}

export { refKind }

/** Open prevention beads already discovered-from this frame — the
 * dedupe set that makes prevention creation retry-safe. */
function priorPreventionRows(frameId: string): DrillRow[] {
  return bdJson<DrillRow[]>([
    'dep',
    'list',
    frameId,
    '--direction=up',
    '--type',
    'discovered-from',
    '--json',
  ])
}

export interface PreventionPlan {
  /** Item text → existing bead id, for items already recorded. */
  reuse: Map<string, string>
  /** Item texts needing a new bead, in order, deduped. */
  create: string[]
}

/** Fold `--prevent` items against what the frame already recorded: an
 * open prevention bead with the same title is reused, not recreated;
 * repeated items within the list collapse to one bead. Pure — the
 * retry-safety core of drillUp: a mid-flight failure followed by a
 * retry converges instead of duplicating. */
export function planPreventions(items: string[], prior: DrillRow[]): PreventionPlan {
  const reuse = new Map<string, string>()
  for (const row of prior) {
    if (isOpen(row) && row.labels?.includes(PREVENTION_LABEL) && !reuse.has(row.title)) {
      reuse.set(row.title, row.id)
    }
  }
  const create = new Set<string>()
  for (const item of items) {
    if (!reuse.has(item)) {
      create.add(item)
    }
  }
  return { create: [...create], reuse }
}

/** One prevention bead per item — discovered-from, not --parent:
 * prevention is follow-up work found by the frame, and a child would
 * block the parent's own close. `--title` keeps a `--`-leading item as
 * data, not a flag. `created` holds only beads this call made — the
 * compensation set; `ids` is the full per-item result (reused + new). */
function createPreventions(
  frameId: string,
  items: string[],
): { created: string[]; ids: string[] } {
  const { create, reuse } = planPreventions(items, priorPreventionRows(frameId))
  const created: string[] = []
  const newIds = new Map<string, string>()
  for (const item of create) {
    const row = bdJson<DrillRow>([
      'create',
      '--title',
      item,
      '-l',
      PREVENTION_LABEL,
      '--no-inherit-labels',
      '--deps',
      `discovered-from:${frameId}`,
    ])
    created.push(row.id)
    newIds.set(item, row.id)
  }
  const ids = items.map((item) => {
    const id = reuse.get(item) ?? newIds.get(item)
    if (!id) {
      throw new Error(`internal error: no bead id for prevention item "${item}"`)
    }
    return id
  })
  return { created, ids }
}

/** `bd note` appends — check the stored notes first so a retry after a
 * later failure can't duplicate the memo. */
function noteOnce(frameId: string, memo: string): void {
  const current = bdJson<DrillRow[]>(['show', frameId])[0]
  if (current?.notes?.includes(memo)) {
    return
  }
  bd(['note', frameId, memo])
}

/** Evidence refs + handoff event — skipped for wisps (no audit trail).
 * Ref'd events are idempotent in bd (deterministic id); the ref-less
 * handoff gets a fresh `--at` each run, so skip it when already logged. */
function recordHandoff(frame: DrillRow, evidence: string[]): void {
  for (const ref of evidence) {
    const kind = refKind(ref)
    bd([
      'provenance',
      'record',
      '--issue',
      frame.id,
      '--kind',
      evidenceKind(ref),
      '--source',
      'bro drill up',
      '--ref',
      ref,
      '--ref-kind',
      kind,
    ])
  }
  const logged = bdJson<Array<{ kind?: string; source?: string }>>([
    'provenance',
    'log',
    frame.id,
  ])
  if (logged.some((e) => e.kind === 'handoff' && e.source === 'bro drill up')) {
    return
  }
  bd([
    'provenance',
    'record',
    '--issue',
    frame.id,
    '--kind',
    'handoff',
    '--source',
    'bro drill up',
    '--at',
    new Date().toISOString(),
  ])
}

/**
 * Ascend: close the frame with a structured memo. `--result` is mandatory —
 * a drill that returns nothing teaches nothing. Each `--prevent` item lands
 * as a task on the parent frame so prevention work lives in the scope that
 * spawned it.
 */
export function drillUp(opts: UpOptions): UpResult {
  if (!opts.result.trim()) {
    throw new Error('drill up requires --result — a frame must return a curated finding')
  }
  // `bd list` doesn't carry `ephemeral`; `bd show` gives the full row
  const frame = opts.id
    ? requireOpenDrill(opts.id, '--id')
    : ((): DrillRow => {
        const leaf = currentFrame()
        if (!leaf) {
          throw new Error('no open drill frame — nothing to ascend from')
        }
        return requireOpenDrill(leaf.id, '--id')
      })()
  // bd refuses to close a parent with ANY open children — check before
  // writing the memo so a later failure can't leave partial state.
  const openKids = childrenOf(frame.id).filter(isOpen)
  if (openKids.length > 0) {
    throw new Error(
      `frame ${frame.id} has open child issue(s): ${openKids.map((k) => k.id).join(', ')} — close them first`
    )
  }

  const memo = [
    '## Result',
    '',
    opts.result,
    ...(opts.prevent?.length
      ? ['', '## Prevention', '', ...opts.prevent.map((p) => `- ${p}`)]
      : []),
  ].join('\n')

  // bd has no transactions — the ordering + idempotency contract is the
  // mitigation: children-check first (fail fast), noteOnce dedupes the
  // memo, prevention creation reuses open same-title beads, handoff
  // events are idempotent, close lands last. On any failure mid-flight,
  // delete only the prevention beads THIS call created — reused ones
  // predate the call and are never compensation — so a retry converges
  // instead of duplicating.
  let created: string[] = []
  let preventionIds: string[] = []
  try {
    noteOnce(frame.id, memo)
    const prev = createPreventions(frame.id, opts.prevent ?? [])
    created = prev.created
    preventionIds = prev.ids
    if (!frame.ephemeral) {
      recordHandoff(frame, opts.evidence ?? [])
    }
    bd(['close', frame.id, '--reason', 'drill up — result handed to parent'])
  } catch (err) {
    const orphans: string[] = []
    for (const id of created) {
      try {
        bd(['delete', id, '--force'])
      } catch {
        orphans.push(id)
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      orphans.length > 0
        ? `${msg} — cleanup incomplete: prevention bead(s) left behind: ${orphans.join(', ')}`
        : msg,
    )
  }
  return { closed: frame.id, preventionIds }
}

/** Root frames + rendered tree (indented, roots first). */
export function drillTree(): string {
  const rows = listDrills()
  if (rows.length === 0) {
    return 'no drill frames'
  }
  const { kids, parents } = drillRelations(rows)
  const roots = rows.filter((r) => !parents.has(r.id))
  const lines: string[] = []
  const walk = (row: DrillRow, depth: number): void => {
    const mark = isOpen(row) ? '●' : '○'
    lines.push(`${'  '.repeat(depth)}${mark} ${row.id} ${row.title} [${row.status}]`)
    for (const kid of (kids.get(row.id) ?? []).filter(isDrill)) {
      walk(kid, depth + 1)
    }
  }
  for (const root of roots) {
    walk(root, 0)
  }
  return lines.join('\n')
}
