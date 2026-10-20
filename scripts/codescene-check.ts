/**
 * The local twin of the CodeScene App's review — same analysis, same
 * verdict, before the push instead of after it.
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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gateReport, renderGate } from './codescene-gate.ts'

/** The CLI's install target, or wherever the shell would find it. */
function csBinary(): string | undefined {
  const local = join(homedir(), '.local', 'bin', 'cs')
  if (existsSync(local)) return local
  try {
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
    dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  } catch {
    return // no git context — the delta below will report it
  }
  if (dirty === '') return
  const files = dirty.split('\n').map((l) => l.slice(3).trim())
  console.log(
    `codescene-check: ${files.length} uncommitted file(s) — the delta covers COMMITTED changes only:`
  )
  for (const f of files) console.log(`  ${f}`)
}

/** Run the delta analysis, tolerating a non-zero exit that still carried
 *  a report (the CLI exits 1 when it found findings). */
function deltaReport(cs: string, base: string): string {
  try {
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

function main(argv: string[]): void {
  const strict = argv.includes('--strict')
  const base = argv.find((a) => !a.startsWith('--')) ?? 'origin/main'
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
