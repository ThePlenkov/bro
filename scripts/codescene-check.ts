/**
 * The local twin of the CodeScene CI job — same code path, same verdict.
 *
 *   node scripts/codescene-check.ts [base-ref] [--strict]
 *
 * Runs `cs delta <base> HEAD --output-format json` and hands the report to
 * the gate. Defaults to `origin/main`. Without the `cs` CLI on PATH the
 * check SKIPS (exit 0): a machine without CodeScene must not be blocked.
 * The CLI is installed by the codescene skill (or the CI workflow's own
 * install step).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gateReport, renderGate } from './codescene-gate.ts'

/** The CLI's install target, plus whatever the PATH already carries. */
function csBinary(): string | undefined {
  const local = join(homedir(), '.local', 'bin', 'cs')
  if (existsSync(local)) return local
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const candidate = join(dir, 'cs')
    if (dir !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

function main(argv: string[]): void {
  const strict = argv.includes('--strict')
  const base = argv.find((a) => !a.startsWith('--')) ?? 'origin/main'
  const cs = csBinary()
  if (cs === undefined) {
    console.log('codescene-check: skipped — the `cs` CLI is not installed (see the codescene skill)')
    return
  }
  let report: string
  try {
    report = execFileSync(cs, ['delta', base, 'HEAD', '--output-format', 'json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    })
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    if (typeof e.stdout === 'string' && e.stdout.trim() !== '') {
      report = e.stdout
    } else {
      console.error(`codescene-check: the delta analysis failed — ${e.stderr ?? e.message}`)
      process.exit(2)
    }
  }
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
