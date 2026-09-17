/**
 * Retrospection over beads. A `wtf` bead captures the user's frustration
 * verbatim — the trigger artifact. `bro retrospect record` stores the
 * agent's analysis as a `retro` bead and fans each planned action out as
 * a `prevention` bead labeled `sink:<sink>`. `status` is the exit gate:
 * an unanswered wtf blocks, so the agent cannot self-declare the apology
 * done. beads IS the memory system — no sidecar files.
 */
import { execFileSync } from 'node:child_process'
import { bd, bdJson } from './beads.ts'
import type { BeadRow, RecordResult, RetroPlan } from './types.ts'

const WTF_LABEL = 'wtf'
const RETRO_LABEL = 'retro'
const PREVENTION_LABEL = 'prevention'

const isOpen = (row: BeadRow): boolean => row.status !== 'closed' && row.status !== 'done'

function listByLabel(label: string): BeadRow[] {
  return bdJson<BeadRow[]>(['list', '-l', label, '--all', '-n', '0'])
}

export function listWtf(): BeadRow[] {
  return listByLabel(WTF_LABEL)
}

export function openWtf(): BeadRow[] {
  return listWtf().filter(isOpen)
}

export function listRetros(): BeadRow[] {
  return listByLabel(RETRO_LABEL)
}

export function openPreventions(): BeadRow[] {
  return listByLabel(PREVENTION_LABEL).filter(isOpen)
}

/** Best-effort provenance for the capture — tolerate non-git directories. */
function gitSnapshot(): string[] {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    return [`git: ${branch}@${sha}`]
  } catch {
    return []
  }
}

/**
 * Capture a wtf moment: the user's complaint verbatim + a context snapshot.
 * The quote is evidence — never paraphrased.
 */
export function captureWtf(complaint: string): BeadRow {
  if (!complaint.trim()) {
    throw new Error('wtf capture requires the complaint — quote the user verbatim')
  }
  // the quote is evidence — the description keeps it byte-for-byte;
  // only the title is normalized
  const description = [
    `> ${complaint}`,
    '',
    `captured: ${new Date().toISOString()}`,
    `cwd: ${process.cwd()}`,
    ...gitSnapshot(),
  ].join('\n')
  const first = complaint.trim().split('\n')[0] ?? ''
  const title = `wtf: ${first.length > 72 ? `${first.slice(0, 71)}…` : first}`
  return bdJson<BeadRow>(['create', title, '-l', WTF_LABEL, '-d', description])
}

export function refKind(ref: string): string {
  if (/\/pull\/|\/merge_requests\//.test(ref)) {
    return 'pr'
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return 'git-sha'
  }
  return 'work-id'
}

function requireOpenWtf(id: string): BeadRow {
  const rows = bdJson<BeadRow[]>(['show', id])
  const row = rows[0]
  if (!row || !(row.labels?.includes(WTF_LABEL) ?? false) || !isOpen(row)) {
    throw new Error(`wtf ${id} is not an open wtf bead`)
  }
  return row
}

/** No explicit wtf? The single open wtf bead is the obvious answer;
 * ambiguity is the caller's problem to resolve. */
function resolveSingleWtf(): BeadRow | undefined {
  const open = openWtf()
  if (open.length > 1) {
    throw new Error(
      `${open.length} open wtf beads — set retro.wtf in the plan or pass --wtf to pick one`
    )
  }
  return open[0]
}

/**
 * Record a validated plan: the retro bead carries the analysis memo and is
 * closed immediately — it is a record, not work. Each action lands as an
 * open prevention bead the executor routes by its `sink:` label.
 */
export function recordRetro(plan: RetroPlan): RecordResult {
  const wtf = plan.wtf ? requireOpenWtf(plan.wtf) : resolveSingleWtf()

  const memo = [
    '## What',
    '',
    plan.what,
    '',
    '## Why',
    '',
    plan.why,
    '',
    `scope: ${plan.scope}`,
  ].join('\n')
  const first = plan.what.split('\n')[0] ?? ''
  const title = `retro: ${first.length > 72 ? `${first.slice(0, 71)}…` : first}`
  const createArgs = ['create', title, '-l', RETRO_LABEL, '-d', memo]
  if (wtf) {
    // discovered-from, not --parent: the wtf is the trigger evidence,
    // and a child would block its close.
    createArgs.push('--deps', `discovered-from:${wtf.id}`, '--no-inherit-labels')
  }
  const retro = bdJson<BeadRow>(createArgs)

  // bd has no transactions — if anything after the create fails, delete
  // what we created so a retry can't duplicate beads.
  const created = [retro.id]
  const actionIds: string[] = []
  try {
    for (const action of plan.actions) {
      const detail = [
        action.detail ?? '',
        '',
        `sink: ${action.sink}`,
        `scope: ${action.scope ?? plan.scope}`,
        `retro: ${retro.id}`,
      ]
        .join('\n')
        .trim()
      const row = bdJson<BeadRow>([
        'create',
        action.title,
        '-l',
        `${PREVENTION_LABEL},sink:${action.sink}`,
        '--no-inherit-labels',
        '--deps',
        `discovered-from:${retro.id}`,
        '-d',
        detail,
      ])
      actionIds.push(row.id)
      created.push(row.id)
    }

    for (const ref of plan.evidence) {
      const kind = refKind(ref)
      bd([
        'provenance',
        'record',
        '--issue',
        retro.id,
        '--kind',
        kind === 'pr' ? 'land' : 'commit',
        '--source',
        'bro retrospect record',
        '--ref',
        ref,
        '--ref-kind',
        kind,
      ])
    }

    if (wtf) {
      bd(['close', wtf.id, '--reason', `answered by retro ${retro.id}`])
    }
    bd(['close', retro.id, '--reason', 'retrospect recorded'])
  } catch (err) {
    for (const id of created) {
      try {
        bd(['delete', id, '--force'])
      } catch {
        // best effort — report the original failure either way
      }
    }
    throw err
  }
  return { retroId: retro.id, actionIds, closedWtf: wtf?.id }
}
