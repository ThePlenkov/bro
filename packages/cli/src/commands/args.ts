/**
 * Shared hand-rolled arg parsing for bro commands — no parser library.
 */

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
 * missing value that would pass validation. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) {
    return undefined
  }
  if (argv.includes(name, i + 1)) {
    console.error(`error: ${name} may be given only once`)
    process.exit(2)
  }
  return flagValue(argv, i, name)
}

export function flagAll(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      out.push(flagValue(argv, i, name))
      i += 1
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
