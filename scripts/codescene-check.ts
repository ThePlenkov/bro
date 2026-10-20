/**
 * The same delta analysis as the CodeScene App's review, before the push
 * instead of after it. The verdict can differ because the App applies
 * branch-specific gates and PR finding suppressions.
 *
 *   node scripts/codescene-check.ts [base-ref] [--strict]
 *
 * Runs `cs delta <base> HEAD --output-format json` and hands the report to
 * the gate. Defaults to `origin/main`. Without the `cs` CLI on PATH the
 * check SKIPS (exit 0): a machine without CodeScene must not be blocked.
 *
 * The App is the gate on the PR itself (it authenticates itself and reads
 * .codescene/custom-quality-gates.json from the branch); this is the same
 * delta analysis, run locally, so a push does not have to be the first
 * time you see what it did to the code health.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { gateReport } from './codescene-gate'

function findCs(): string | null {
  for (const candidate of ['cs', '/usr/local/bin/cs', `${process.env.HOME}/.local/bin/cs`]) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}

function main(argv: string[]): void {
  const args = argv.slice(2)
  const strict = args.includes('--strict')
  const base = args.find((a) => !a.startsWith('-')) ?? 'origin/main'
  const cs = findCs()
  if (!cs) {
    console.log('codescene-check: skipped — the `cs` CLI is not installed (see the codescene skill)')
    return
  }
  // The delta covers a COMMIT RANGE (what the App analyzes for a PR) —
  // the CLI's uncommitted mode comes back empty. Say so when the tree is
  // dirty, or the check silently covers less than the user thinks.
  try {
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    if (dirty !== '') {
      const files = dirty.split('\n').map((l) => l.slice(3).trim())
      console.log(
        `codescene-check: ${files.length} uncommitted file(s) — the delta covers COMMITTED changes only:`
      )
      for (const f of files) console.log(`  ${f}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`codescene-check: could not determine git status (${message})`)
  }
  let report: string
  try {
    report = execFileSync(cs, ['delta', base, 'HEAD', '--output-format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    if (err.stdout && typeof err.stdout === 'string' && err.stdout.trim() !== '') {
      report = err.stdout
    } else {
      console.error(err.stderr?.toString?.() ?? err.message)
      process.exit(err.status ?? 2)
    }
  }
  const result = gateReport(report, strict)
  if (result.ok) {
    console.log(`codescene-check: OK (${result.summary})`)
    process.exit(0)
  }
  console.log(`codescene-check: BLOCKED (${result.summary})`)
  for (const v of result.violations) {
    console.log(`  ${v.file}:${v.line} ${v.function} [${v.changeType}] ${v.rule}`)
  }
  process.exit(1)
}

main(process.argv)
