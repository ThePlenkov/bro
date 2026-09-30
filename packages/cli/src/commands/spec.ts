/**
 * `bro spec` — spec-driven development policy over claimed tasks.
 *
 * A bead has a spec when <dir>/<id>.md exists non-empty in the checkout
 * (the spec rides the feature branch, so it is reviewed with the code)
 * or its description carries a `spec:` link. Chores and `trivial`-
 * labeled beads are exempt — SDD measures design mass, not bookkeeping.
 *
 *   bro spec check [id…]   coverage over in_progress beads (exit 1 on
 *                          missing — CI-able); --all includes open
 *   bro spec new <id>      scaffold <dir>/<id>.md from the bead title
 *
 * The same module owns sddConnector: session-start + prompt-submit
 * nudges and the 'task'-aspect stop-gate contribution, all gated on
 * bro.config.json `sdd.mode` (off|remind|gate — default off, so the
 * policy is opt-in per repo and committed, not per machine).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  bdActor,
  facade,
  gitTry,
  isOwnClaim,
  loadConfig,
  sessionTaskClaims,
  type Connector,
  type ConnectorCtx,
  type TaskRow,
  type TaskStore,
} from '@broject/core'

export type SpecState = 'spec' | 'link' | 'exempt' | 'missing'

/** Repo root for ctx.dir — worktree-aware, so a spec committed on the
 *  feature branch is found from a linked worktree, not the main one. */
function repoRoot(dir: string): string {
  const r = gitTry(['-C', dir, 'rev-parse', '--show-toplevel'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : dir
}

const SPEC_LINK = /\bspec:\s*\S+/i

/** Bead ids are word-ish (`bro-svk.5`); separators and dot-segments
 *  would let `spec new ../../x` write outside the spec dir. */
function validBeadId(id: string): boolean {
  return /^[\w.-]+$/.test(id) && !id.includes('..')
}

/** The configured spec dir must stay inside the checkout — an absolute
 *  or escaping `sdd.dir` returns null (probes fail open; commands
 *  report it as a config error). */
function specDirAbs(dir: string, specDir: string): string | null {
  const root = resolve(repoRoot(dir))
  const abs = resolve(root, specDir)
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

function specFilePath(dir: string, specDir: string, id: string): string | null {
  const base = specDirAbs(dir, specDir)
  return base === null ? null : join(base, `${id}.md`)
}

/** A non-empty spec file counts; a zero-byte scaffold does not. */
function hasSpecFile(dir: string, specDir: string, id: string): boolean {
  if (!validBeadId(id)) {
    return false
  }
  try {
    const p = specFilePath(dir, specDir, id)
    return p !== null && statSync(p).isFile() && readFileSync(p, 'utf8').trim() !== ''
  } catch {
    return false
  }
}

/** Labels that exempt a bead from the spec rule — `trivial` needs no
 *  design mass, `debt` rows are harvested findings that already carry
 *  their own evidence (file/line/severity). */
const EXEMPT_LABELS = ['trivial', 'debt']

export function specState(row: TaskRow, dir: string, specDir: string): SpecState {
  if (
    row.issue_type === 'chore' ||
    (row.labels ?? []).some((l) => EXEMPT_LABELS.includes(l))
  ) {
    return 'exempt'
  }
  if (hasSpecFile(dir, specDir, row.id)) {
    return 'spec'
  }
  if (SPEC_LINK.test(row.description ?? '')) {
    return 'link'
  }
  return 'missing'
}

function tasks(dir: string): TaskStore {
  return facade('tasks', { dir }, { prefer: loadConfig(dir).connectors })
}

/** This session's claimed beads that lack a spec — the nudge scope is
 *  always own claims; foreign work is never this session's to spec.
 *  Fail-open: a dead task store must not eat the policy line. */
function ownClaimsMissingSpec(ctx: ConnectorCtx, specDir: string): TaskRow[] {
  try {
    const mine = sessionTaskClaims(ctx)
    if (mine.size === 0) {
      return []
    }
    // marker ids are attempted claims — a bead held by another actor is
    // foreign work, never this session's to spec
    const me = bdActor(ctx.dir)
    return tasks(ctx.dir)
      .list({ status: 'in_progress' })
      .filter((r) => isOwnClaim(r, mine, me) && specState(r, ctx.dir, specDir) === 'missing')
  } catch {
    return []
  }
}

const shortTitle = (t: string | undefined): string => {
  const flat = (t ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

const fmt = (r: TaskRow): string => `${r.id} ${shortTitle(r.title)}`.trim()

const remedy = (dir: string): string =>
  `write ${dir}/<id>.md (\`bro spec new <id>\`), add a spec: link, or label 'trivial'`

export const sddConnector: Connector = {
  name: 'sdd',
  hooks: () => ({
    sessionStart(ctx) {
      const { mode, dir } = loadConfig(ctx.dir).sdd
      if (mode === 'off') {
        return []
      }
      const missing = ownClaimsMissingSpec(ctx, dir).map((r) => `  spec missing: ${fmt(r)}`)
      return [
        `SDD (${mode}): spec before code — ${dir}/<id>.md or a spec: link ` +
          `in the bead (exempt: chore / 'trivial' / 'debt')`,
        ...missing,
      ]
    },
    promptSubmit(ctx) {
      const { mode, dir } = loadConfig(ctx.dir).sdd
      if (mode === 'off') {
        return []
      }
      const missing = ownClaimsMissingSpec(ctx, dir)
      if (missing.length === 0) {
        return []
      }
      return [
        `SDD: claimed beads without a spec: ${missing.map(fmt).join(', ')} — ${remedy(dir)}`,
      ]
    },
    stopGate(ctx) {
      const { mode, dir } = loadConfig(ctx.dir).sdd
      if (mode === 'off') {
        return []
      }
      const missing = ownClaimsMissingSpec(ctx, dir)
      if (missing.length === 0) {
        return []
      }
      const line = `bro: SDD — claimed beads without a spec: ${missing.map(fmt).join(', ')} — ${remedy(dir)}`
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
  new <id>      scaffold specs/<id>.md from the bead title (refuses to
                overwrite an existing file)`)
  process.exit(2)
}

function cmdNew(dir: string, specDir: string, id: string | undefined): void {
  if (!id) {
    console.error('error: bro spec new needs a bead id — `bro spec new bro-123`')
    process.exit(2)
  }
  if (!validBeadId(id)) {
    console.error(`error: invalid bead id "${id}" — ids match [\\w.-]+ without '..'`)
    process.exit(2)
  }
  const path = specFilePath(dir, specDir, id)
  if (path === null) {
    console.error(`error: sdd.dir "${specDir}" escapes the repo root — fix bro.config.json`)
    process.exit(2)
  }
  if (existsSync(path)) {
    console.error(`error: ${path} already exists — refusing to overwrite`)
    process.exit(1)
  }
  let title = ''
  try {
    title = tasks(dir).get(id)?.title ?? ''
  } catch {
    // no task backend readable — scaffold with the bare id
  }
  mkdirSync(specDirAbs(dir, specDir)!, { recursive: true })
  writeFileSync(
    path,
    `# ${id} — ${title || 'spec'}\n\n## Problem\n\n## Design\n\n## Plan\n\n- [ ] …\n`
  )
  console.log(`spec: wrote ${path}`)
}

function cmdCheck(dir: string, specDir: string, ids: string[], all: boolean): void {
  const store = tasks(dir)
  const unknown: string[] = []
  const rows =
    ids.length > 0
      ? ids.flatMap((id) => {
          try {
            const r = store.get(id)
            if (!r) {
              unknown.push(id)
            }
            return r ? [r] : []
          } catch {
            unknown.push(id)
            return []
          }
        })
      : store.list({ status: 'in_progress' }).concat(all ? store.list({ status: 'open' }) : [])
  // an explicit id that doesn't resolve is a usage failure — partial
  // results would report silent success for a bead that doesn't exist
  if (unknown.length > 0) {
    console.error(`error: bead(s) not found: ${unknown.join(', ')}`)
    process.exit(2)
  }
  let missing = 0
  for (const r of rows) {
    const state = specState(r, dir, specDir)
    if (state === 'missing') {
      missing += 1
    }
    console.log(`${r.id}\t${state === 'missing' ? 'MISSING' : state}\t${shortTitle(r.title)}`)
  }
  if (missing > 0) {
    console.error(`spec check: ${missing} bead(s) without a spec — ${remedy(specDir)}`)
    process.exit(1)
  }
}

export function runSpecCommand(argv: string[]): void {
  const dir = process.cwd()
  const { dir: specDir, mode } = loadConfig(dir).sdd
  const [sub, ...rest] = argv
  const positional = rest.filter((a) => !a.startsWith('-'))
  if (sub === 'new') {
    cmdNew(dir, specDir, positional[0])
    return
  }
  if (sub === 'check' || sub === undefined) {
    if (mode === 'off') {
      console.error('note: sdd.mode is off — enable it in bro.config.json to make this a policy')
    }
    cmdCheck(dir, specDir, positional, rest.includes('--all'))
    return
  }
  usage()
}
