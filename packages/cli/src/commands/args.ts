/**
 * Shared hand-rolled arg parsing for bro commands — no parser library.
 */
import { warnDeprecated } from '@broject/core'

/** Warn (once per invocation) that a flag is deprecated — it still
 *  applies; removal lands in a later release. Matches both `--flag`
 *  and `--flag=value` spellings. */
export function deprecatedFlag(argv: string[], name: string, advice?: string): void {
  if (argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`))) {
    warnDeprecated(`flag ${name}`, advice)
  }
}

/** A value flag's argument must exist and not look like another option. */
export function flagValue(argv: string[], i: number, name: string): string {
  const v = argv[i + 1]
  if (v === undefined || v.trim() === '' || v.startsWith('--')) {
    console.error(`error: ${name} requires a value`)
    process.exit(2)
  }
  return v
}

/** Scalar flags are not repeatable — a second occurrence can hide a
 * missing value that would pass validation. Matches both spellings:
 * `--name value` and `--name=value`; a missed `--name=value` would
 * silently drop the option instead of failing closed. */
export function flag(argv: string[], name: string): string | undefined {
  const occurrences = argv.filter((a) => a === name || a.startsWith(`${name}=`))
  if (occurrences.length === 0) {
    return undefined
  }
  if (occurrences.length > 1) {
    console.error(`error: ${name} may be given only once`)
    process.exit(2)
  }
  const eq = occurrences[0]!
  if (eq.startsWith(`${name}=`)) {
    const v = eq.slice(name.length + 1)
    if (v === '') {
      console.error(`error: ${name} requires a value`)
      process.exit(2)
    }
    return v
  }
  return flagValue(argv, argv.indexOf(name), name)
}

/** Repeatable flags collect every occurrence. Matches both spellings,
 * `--name value` and `--name=value`, for parity with `flag` — a missed
 * `=` form would silently drop values instead of failing closed. */
export function flagAll(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === name) {
      out.push(flagValue(argv, i, name))
      i += 1
    } else if (arg.startsWith(`${name}=`)) {
      const v = arg.slice(name.length + 1)
      if (v === '') {
        console.error(`error: ${name} requires a value`)
        process.exit(2)
      }
      out.push(v)
    }
  }
  return out
}

/** Positional args = everything that isn't a known value flag or its value. */
export function positionals(argv: string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg)) {
        i += 1
      }
      continue
    }
    out.push(arg)
  }
  return out
}
