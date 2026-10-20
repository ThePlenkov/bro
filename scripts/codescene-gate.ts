/**
 * CodeScene delta gate — fails when a diff made code health worse.
 *
 * The CodeScene App is the gate on a PR; this is the same rule offline,
 * so a push never has to be the first time you see what it did.
 *
 * `cs delta --output-format json` reports every finding in the touched
 * files with a `change-type`:
 *
 *   fixed       the diff resolved it
 *   improved    the diff made it milder
 *   unchanged   pre-existing, untouched — legacy debt, not this PR's doing
 *   introduced  the diff added it          ← this PR's doing
 *   degraded    the diff made it worse     ← this PR's doing
 *
 * The gate fails on `introduced` + `degraded`: a PR may not add technical
 * debt, whatever the backlog looks like. That is the wave-1 bar — it holds
 * while the legacy backlog is still large, and it is the same promise the
 * CodeScene PR integration's "new code health" gate makes.
 *
 * `--strict` also fails on `unchanged`: the bar a graduated file carries
 * (see .codescene/custom-quality-gates.json). It is the wave-N bar, used
 * once the file's own findings are gone.
 *
 * Usage:  node scripts/codescene-gate.ts <delta.json> [--strict]
 *         cs delta main HEAD --output-format json | node scripts/codescene-gate.ts -
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

interface DeltaFinding {
  category?: string
  'change-type'?: string
  'old-pp'?: number
  'new-pp'?: number
  threshold?: number
}

interface DeltaResult {
  name?: string
  findings?: DeltaFinding[]
}

export interface GateViolation {
  file: string
  category: string
  changeType: string
  from?: number
  to?: number
}

export interface GateResult {
  ok: boolean
  summary: string
  files: number
  violations: GateViolation[]
}

/** The two report shapes the CLI emits: a bare list, or an object
 *  carrying the list under `results` (--include-metadata). Anything else
 *  is `undefined` — a gate that cannot read the report must not pass it. */
function resultsOf(raw: unknown): DeltaResult[] | undefined {
  if (Array.isArray(raw)) return raw as DeltaResult[]
  if (typeof raw === 'object' && raw !== null) {
    const results = (raw as { results?: unknown }).results
    if (Array.isArray(results)) return results as DeltaResult[]
  }
  return undefined
}

/** Walk the report once: count every finding by change-type, and collect
 *  the ones the diff caused. 'fixed' and 'improved' are the diff doing its
 *  job; 'unchanged' is legacy debt the diff did not touch. */
function collect(
  results: DeltaResult[],
  strict: boolean
): { violations: GateViolation[]; tally: Map<string, number> } {
  const tolerated = new Set(strict ? ['fixed', 'improved'] : ['fixed', 'improved', 'unchanged'])
  const violations: GateViolation[] = []
  const tally = new Map<string, number>()
  for (const result of results) {
    for (const finding of result.findings ?? []) {
      const type = finding['change-type'] ?? 'unknown'
      tally.set(type, (tally.get(type) ?? 0) + 1)
      if (!tolerated.has(type)) {
        violations.push({
          file: result.name ?? '?',
          category: finding.category ?? 'finding',
          changeType: type,
          from: finding['old-pp'],
          to: finding['new-pp'],
        })
      }
    }
  }
  return { violations, tally }
}

/** Evaluate a delta report. `strict` also fails on pre-existing
 *  (`unchanged`) findings — the bar a graduated file carries. */
export function gateReport(raw: string, strict: boolean): GateResult {
  // No diff — the CLI writes nothing. Nothing was introduced, so nothing
  // is violated. (An empty report is an evaluated verdict; an UNREADABLE
  // one is not, and stays an error below.)
  if (raw.trim() === '') {
    return { ok: true, files: 0, summary: 'no changes', violations: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`unreadable delta report — ${(err as Error).message}`)
  }
  const results = resultsOf(parsed)
  if (results === undefined) {
    throw new Error(
      'unsupported delta report shape — expected a list of results, or an object with a results list'
    )
  }
  const { violations, tally } = collect(results, strict)
  const summary = [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return {
    ok: violations.length === 0,
    files: results.length,
    summary: summary.map(([t, n]) => `${t}=${n}`).join(' ') || 'no findings',
    violations,
  }
}

/** Render a gate verdict the way a CI log wants it. */
export function renderGate(result: GateResult): void {
  console.log(
    `codescene-gate: ${result.files} file(s) checked — ${result.summary}`
  )
  if (result.ok) {
    console.log('codescene-gate: green — the diff adds no technical debt')
    return
  }
  console.error(`codescene-gate: BLOCKED — ${result.violations.length} finding(s) the diff caused:`)
  for (const v of result.violations) {
    const delta = v.from !== undefined && v.to !== undefined ? ` (${v.from} → ${v.to})` : ''
    console.error(`  ${v.file}: ${v.category} — ${v.changeType}${delta}`)
  }
  console.error(
    'codescene-gate: fix the finding, or defer it with a debt bead and a suppression ' +
      '(codescene.io → the PR result page → Suppress).'
  )
}

function main(argv: string[]): void {
  const strict = argv.includes('--strict')
  const path = argv.find((a) => !a.startsWith('--'))
  if (path === undefined) {
    console.error('usage: node scripts/codescene-gate.ts <delta.json> [--strict]')
    process.exit(2)
  }
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  let result: GateResult
  try {
    result = gateReport(raw, strict)
  } catch (err) {
    console.error(`codescene-gate: ${(err as Error).message}`)
    process.exit(2)
  }
  renderGate(result)
  if (!result.ok) process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
