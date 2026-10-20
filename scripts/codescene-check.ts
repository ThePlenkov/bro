/**
 * The same delta analysis as the CodeScene App's review, before the push
 * instead of after it. The verdict CAN differ: the App applies the
 * branch's quality gates and its own PR finding suppressions, this only
 * reads the delta.
 *
 *   node scripts/codescene-check.ts [base-ref] [--strict]
 *
 * Runs `cs delta <base> HEAD --output-format json` and hands the report to
 * the gate. The base defaults to the MERGE-BASE with origin/main — the
 * range a PR is actually diffed against. Without the `cs` CLI on PATH the
 * check SKIPS (exit 0): a machine without CodeScene must not be blocked.
 *
 * The App is the gate on the PR itself (it authenticates itself and reads
 * .codescene/custom-quality-gates.json from the branch); this is the same
 * delta analysis, run locally, so a push does not have to be the first
 * time you see what it did to the code health.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gateReport, renderGate } from './codescene-gate.ts'

/** The CLI's install target, or wherever the shell would find it. */
function csBinary(): string | undefined {
  const local = join(homedir(), '.local', 'bin', 'cs')
  if (existsSync(local)) return local
  try {
    // NOSONAR — PATH lookup is the contract
    return execFileSync('which', ['cs'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

/** The delta covers a COMMIT RANGE (what the App analyzes for a PR) —
 *  the CLI's uncommitted mode comes back empty. Say so when the tree is
 *  dirty, or the check silently covers less than the user thinks. */
function reportDirtyTree(): void {
  let dirty: string
  try {
    dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() // NOSONAR — PATH lookup is the contract
  } catch (err) {
    // the state is UNKNOWN — say so, or the user reads a green check as
    // "the delta covered everything"
    console.log(
      `codescene-check: warning — could not read the working-tree state (${(err as Error).message}); ` +
        'the delta covers committed changes only'
    )
    return
  }
  if (dirty === '') return
  const files = dirty.split('\n').map((l) => {
    const path = l.slice(3).trim()
    // a rename/copy entry reads "old -> new" — the new path is the one that exists
    const arrow = path.indexOf(' -> ')
    return arrow === -1 ? path : path.slice(arrow + 4)
  })
  console.log(
    `codescene-check: ${files.length} uncommitted file(s) — the delta covers COMMITTED changes only:`
  )
  for (const f of files) console.log(`  ${f}`)
}

/** Run the delta analysis, tolerating a non-zero exit that still carried
 *  a report (the CLI exits 1 when it found findings). */
function deltaReport(cs: string, base: string): string {
  try {
    // NOSONAR — the command is the CodeScene CLI; execFileSync never goes through a shell
    return execFileSync(cs, ['delta', base, 'HEAD', '--output-format', 'json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    })
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    if (typeof e.stdout === 'string' && e.stdout.trim() !== '') {
      return e.stdout
    }
    console.error(`codescene-check: the delta analysis failed — ${e.stderr ?? e.message}`)
    process.exit(2)
  }
}

/** The base a PR is diffed against: the MERGE-BASE with origin/main, not
 *  origin/main itself. When main has moved ahead, comparing against it
 *  walks the other direction and reports their commits as regressions of
 *  yours. */
function defaultBase(): string {
  try {
    // NOSONAR — PATH lookup is the contract
    return execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'origin/main'
  }
}

function main(argv: string[]): void {
  const strict = argv.includes('--strict')
  const base = argv.find((a) => !a.startsWith('--')) ?? defaultBase()
  const cs = csBinary()
  if (cs === undefined) {
    console.log('codescene-check: skipped — the `cs` CLI is not installed (see the codescene skill)')
    return
  }
  reportDirtyTree()
  const report = deltaReport(cs, base)
  let result
  try {
    result = gateReport(report, strict)
  } catch (err) {
    console.error(`codescene-check: ${(err as Error).message}`)
    process.exit(2)
  }
  renderGate(result)
  if (!result.ok) process.exit(1)
}

main(process.argv.slice(2))
