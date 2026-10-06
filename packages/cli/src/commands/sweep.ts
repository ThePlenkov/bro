/**
 * `bro sweep` — gated lifecycle disposal for closed beads
 * (spec: specs/bro-pj2g.1.md). The bead lifecycle's missing outflow
 * stage:
 *
 *   status   read-only report — harvested vs unharvested closed beads,
 *            age vs sweep.olderThanDays, the would-burn set
 *   distill  materialize harvest work — learn-cited beads auto-mark
 *            `sweep=distilled`; the rest pour as an agent molecule
 *   run      the gated pipeline: gate → archive → sync-verify →
 *            prune → flatten. The gate refuses while unharvested
 *            closed beads age past olderThanDays — the refusal is the
 *            feature; --force overrides explicitly, never silently.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  bd,
  bdJson,
  checkBeads,
  dataRefCommit,
  dataRefPush,
  dataRefRoot,
  gitTry,
  taskStore,
  type TaskRow,
} from '@broject/core'
import { beadsDir, inlineFormulaDoc, pourFormula } from '@broject/convoy'
import { listLessons } from '@broject/learn'
import { stringify } from 'smol-toml'
import { positionals } from './args.ts'
import { loadBroConfig } from '../plugins.ts'

const DAY_MS = 86_400_000
const MARK = 'sweep:distilled'

function fail(msg: string, code = 2): never {
  console.error(`error: ${msg}`)
  process.exit(code)
}

interface SweepCfg {
  olderThanDays: number
  dir: string
  flatten: boolean
}

function sweepCfg(dir: string): SweepCfg {
  const c = loadBroConfig(dir).sweep
  // BRO_SWEEP_DIR wins over config, mirroring BRO_DEBT_DIR
  return { ...c, dir: process.env.BRO_SWEEP_DIR ?? c.dir }
}

/** Closed, non-ephemeral beads — prune's own scope, read once per run. */
function closedSet(dir: string): TaskRow[] {
  return taskStore(dir)
    .list({ status: 'closed', all: true, limit: 0 })
    .filter((r) => r.ephemeral !== true)
}

const harvested = (r: TaskRow): boolean => r.labels?.includes(MARK) === true

/** Age in whole days; undefined when closed_at is missing/unparsable —
 *  an undated closed bead can't be proven old, and can't be proven
 *  young either, so the gate treats it as blocking (a human looks). */
function ageDays(r: TaskRow, now: number): number | undefined {
  const t = Date.parse(r.closed_at ?? '')
  if (!Number.isFinite(t)) {
    return undefined
  }
  return Math.floor((now - t) / DAY_MS)
}

/** The gate set: unharvested beads already past the age line, plus
 *  undated ones (can't prove they're safe — they block until marked or
 *  fixed). */
function gateSet(rows: TaskRow[], olderThanDays: number, now: number): TaskRow[] {
  return rows.filter((r) => {
    if (harvested(r)) {
      return false
    }
    const age = ageDays(r, now)
    return age === undefined || age >= olderThanDays
  })
}

/** What `bd prune --older-than Nd` would delete — closed beads past the
 *  line. Harvest is the gate's concern, not prune's: once the gate
 *  passes, everything old is harvested by construction. */
function burnSet(rows: TaskRow[], olderThanDays: number, now: number): TaskRow[] {
  return rows.filter((r) => {
    const age = ageDays(r, now)
    return age !== undefined && age >= olderThanDays
  })
}

/** The sync contract is positional (spec): the archive dir must live
 *  inside the synced set — `.agents/` or the configured debt dir —
 *  or `bro sync` never carries it and `run` would prune without the
 *  archive reaching the data ref. Returns the artifact dir
 *  dataRefCommit should own ('.agents' covers anything under it), or
 *  null when the dir can't sync. */
function syncedArtifactDir(root: string, dir: string, debtDir: string): string | null {
  // resolve() collapses `..`/`.`/symlink-shape segments before the
  // prefix check — `.agents/../x` must not slip through as `.agents/*`
  const rel = relative(root, resolve(root, dir)).replace(/\\/g, '/').replace(/\/+$/, '')
  if (rel === '' || rel === '..' || rel.startsWith('../')) {
    return null
  }
  const debt = debtDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (rel === '.agents' || rel.startsWith('.agents/')) {
    return '.agents'
  }
  if (rel === debt || rel.startsWith(`${debt}/`)) {
    return debt
  }
  return null
}

/** `bro sweep status` — the report. */
function cmdStatus(dir: string, cfg: SweepCfg): void {
  const now = Date.now()
  const rows = closedSet(dir)
  const undated = rows.filter((r) => ageDays(r, now) === undefined)
  const unh = rows.filter((r) => !harvested(r))
  const old = burnSet(rows, cfg.olderThanDays, now)
  const oldUnharvested = old.filter((r) => !harvested(r))
  console.log(
    `closed: ${rows.length}  harvested: ${rows.length - unh.length}  ` +
      `unharvested: ${unh.length}  undated: ${undated.length}`
  )
  console.log(
    `older-than ${cfg.olderThanDays}d: ${old.length} ` +
      `(${oldUnharvested.length} unharvested)`
  )
  console.log(`would-burn now: ${oldUnharvested.length === 0 ? old.length : 0}`)
  if (undated.length > 0) {
    console.log(`undated (gate-blocking): ${undated.map((r) => r.id).join(' ')}`)
  }
  if (oldUnharvested.length > 0) {
    for (const r of oldUnharvested) {
      console.log(`unharvested\t${r.id}\t${r.title ?? ''}`)
    }
  }
  const root = dataRefRoot(dir)
  if (root !== null) {
    const debtDir = process.env.BRO_DEBT_DIR ?? loadBroConfig(root).debt.dir
    if (syncedArtifactDir(root, cfg.dir, debtDir) === null) {
      console.log(
        `warning: sweep.dir ${cfg.dir} is outside the synced set ` +
          `(.agents/, ${debtDir}) — run would refuse before prune`
      )
    }
  }
}

/** Bead ids already cited as learn evidence — distilled by fact
 *  (spec: pre-sweep captures must not wedge the marker-only gate). */
function learnCitedIds(dir: string): Set<string> {
  const ids = new Set<string>()
  try {
    for (const l of listLessons(dir).lessons) {
      for (const e of l.evidence) {
        if (e.kind === 'bead') {
          ids.add(e.ref)
        }
      }
    }
  } catch {
    // an unreadable learn store auto-marks nothing — beads stay
    // unharvested and land in the molecule instead
  }
  return ids
}

/** `bro sweep distill` — auto-mark learn-cited beads; pour the rest as
 *  an agent molecule (one step per bead, ending in set-state). */
function cmdDistill(dir: string, dryRun: boolean): void {
  const unharvested = closedSet(dir).filter((r) => !harvested(r))
  if (unharvested.length === 0) {
    console.log('distill: nothing unharvested')
    return
  }
  const cited = learnCitedIds(dir)
  const automark = unharvested.filter((r) => cited.has(r.id))
  const steps = unharvested.filter((r) => !cited.has(r.id))
  if (dryRun) {
    console.log(`distill --dry-run: ${automark.length} auto-mark, ${steps.length} step(s)`)
    for (const r of automark) {
      console.log(`auto-mark\t${r.id}\t${r.title ?? ''}`)
    }
    for (const r of steps) {
      console.log(`step\t${r.id}\t${r.title ?? ''}`)
    }
    return
  }
  for (const r of automark) {
    bd(['set-state', r.id, 'sweep=distilled'], dir)
    console.log(`marked\t${r.id}`)
  }
  if (steps.length === 0) {
    console.log(`distill: ${automark.length} auto-marked, no steps needed`)
    return
  }
  // same materialization as convoy's inline pour: a generated formula
  // keeps declared `agent` step types through `bd mol pour`
  const name = `bro-sweep-distill-${randomBytes(3).toString('hex')}`
  const formulasDir = join(beadsDir(), 'formulas')
  mkdirSync(formulasDir, { recursive: true })
  const file = join(formulasDir, `${name}.formula.toml`)
  writeFileSync(
    file,
    stringify(
      inlineFormulaDoc(
        {
          title: 'sweep distill — harvest closed beads',
          description:
            'Each step reads one closed bead, captures what is worth keeping ' +
            '(bd remember / a sink bead via bro wtf), then marks it: ' +
            '`bd set-state <id> sweep=distilled`. The marker is the prune ' +
            "gate's only input — a step is done when its bead carries it.",
          steps: steps.map((r) => ({
            id: `d-${r.id}`,
            title: `Distill ${r.id}: ${(r.title ?? '').slice(0, 80)}`,
            type: 'agent',
            description:
              `Bead ${r.id} is closed and unharvested. ` +
              '`bd show ' +
              r.id +
              '` — decide what is worth keeping: durable knowledge → `bd ' +
              'remember`; a prevention/fix item → a bead via the sink: route ' +
              '(bro wtf). Nothing worth keeping is a valid verdict. ' +
              `Then mark it: \`bd set-state ${r.id} sweep=distilled\`.`,
          })),
        },
        name
      )
    )
  )
  try {
    const rootId = pourFormula(name, {})
    console.log(`distill: molecule ${rootId} poured — ${steps.length} step(s), ${automark.length} auto-marked`)
  } finally {
    rmSync(file, { force: true })
  }
}

/** `bro sweep run` — gate → archive → sync-verify → prune → flatten. */
function cmdRun(dir: string, dryRun: boolean, force: boolean, flatten: boolean): void {
  const cfg = sweepCfg(dir)
  const now = Date.now()
  const rows = closedSet(dir)
  const gate = gateSet(rows, cfg.olderThanDays, now)
  const burn = burnSet(rows, cfg.olderThanDays, now)

  if (dryRun) {
    console.log(`sweep --dry-run (olderThanDays=${cfg.olderThanDays}):`)
    console.log(`  gate:    ${gate.length === 0 ? 'PASS' : `REFUSE — ${gate.length} unharvested/undated bead(s)`}`)
    console.log(`  archive: bd export → ${cfg.dir}/<ts>.jsonl + provenance dump`)
    console.log(`  sync:    commit ${cfg.dir} to the data ref, verify present`)
    console.log(`  prune:   bd prune --older-than ${cfg.olderThanDays}d — ${burn.length} bead(s)`)
    console.log(`  flatten: ${flatten ? 'bd flatten' : 'skipped'}`)
    for (const r of gate) {
      console.log(`  gate\t${r.id}\t${r.title ?? ''}`)
    }
    return
  }

  if (gate.length > 0 && !force) {
    console.error(
      `sweep: ${gate.length} unharvested/undated bead(s) older than ${cfg.olderThanDays}d — distill or --force:`
    )
    for (const r of gate) {
      console.error(`  ${r.id}\t${r.title ?? ''}`)
    }
    process.exit(1)
  }

  if (burn.length === 0) {
    console.log(`sweep: nothing older than ${cfg.olderThanDays}d — done`)
    return
  }

  const root = dataRefRoot(dir)
  if (root === null) {
    fail('not inside a git worktree — the archive needs the data ref', 1)
  }
  const cfgAll = loadBroConfig(root)
  const debtDir = process.env.BRO_DEBT_DIR ?? cfgAll.debt.dir
  const syncDir = syncedArtifactDir(root, cfg.dir, debtDir)
  if (syncDir === null) {
    fail(
      `sweep.dir ${cfg.dir} is outside the synced set (.agents/, ${debtDir}) — ` +
        'archiving there would prune without the archive reaching the data ref',
      1
    )
  }

  // archive — issues JSONL + per-bead provenance dump (bd prune drops
  // provenance rows with the bead — verified behavior, so the dump
  // joins the archive)
  const absDir = resolve(root, cfg.dir)
  mkdirSync(absDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const issuesFile = join(absDir, `${ts}.jsonl`)
  const provFile = join(absDir, `${ts}.provenance.jsonl`)
  bd(['export', '-o', issuesFile], root)
  let provRows = 0
  const provLines: string[] = []
  for (const r of burn) {
    try {
      const rows = bdJson<unknown[]>(['provenance', 'log', r.id, '--json'], root)
      for (const row of rows) {
        provLines.push(JSON.stringify(row))
        provRows++
      }
    } catch {
      provLines.push(JSON.stringify({ issue: r.id, error: 'provenance dump failed' }))
    }
  }
  writeFileSync(provFile, provLines.join('\n') + (provLines.length > 0 ? '\n' : ''))
  console.log(`archive: ${cfg.dir}/${ts}.jsonl (+${provRows} provenance rows)`)

  // sync-verify — the archive must reach the data ref before prune
  const head = dataRefCommit(root, syncDir, `bro data: sweep ${ts}`, cfgAll.sync.ref)
  if (head === null) {
    fail('archive did not commit to the data ref — not pruning', 1)
  }
  const relFile = relative(root, issuesFile).replace(/\\/g, '/')
  const inRef = gitTry(['-C', root, 'cat-file', '-e', `${cfgAll.sync.ref}:${relFile}`])
  if (inRef.code !== 0) {
    fail(`archive absent from ${cfgAll.sync.ref}:${relFile} — not pruning`, 1)
  }
  if (!dataRefPush(root, cfgAll.sync.remote, cfgAll.sync.ref)) {
    // local ref holds the archive — push is transport, the next sync
    // carries it (spec: verify reach is against the ref, not the remote)
    console.error('warning: data-ref push failed — archive is local-only until the next sync')
  }

  // prune — bd's own protections apply unchanged (pinned, open,
  // ephemeral, cited-by-open all skip)
  bd(['prune', '--older-than', `${cfg.olderThanDays}d`, '--force'], root)
  console.log(`prune: closed beads older than ${cfg.olderThanDays}d removed`)

  if (flatten) {
    bd(['flatten'], root)
    console.log('flatten: dolt history squashed + gc')
  } else {
    console.log('flatten: skipped')
  }
}

export function runSweepCommand(argv: string[]): void {
  const [sub, ...rest] = positionals(argv, new Set())
  if (rest.length > 0) {
    fail(`unexpected args: ${rest.join(' ')}`)
  }
  const dryRun = argv.includes('--dry-run')
  const dir = process.cwd()
  switch (sub) {
    case 'status':
      cmdStatus(dir, sweepCfg(dir))
      return
    case 'distill':
      checkBeads(dir)
      cmdDistill(dir, dryRun)
      return
    case 'run':
      checkBeads(dir)
      cmdRun(
        dir,
        dryRun,
        argv.includes('--force'),
        !argv.includes('--no-flatten') && sweepCfg(dir).flatten
      )
      return
    default:
      fail(
        'usage: bro sweep status | distill [--dry-run] | run [--dry-run] [--force] [--no-flatten]'
      )
  }
}
