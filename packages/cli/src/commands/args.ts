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

/** Flag parsing stops at `--` — everything after it is positional
 *  text, never an option. */
const flagZone = (argv: string[]): string[] => {
  const end = argv.indexOf('--')
  return end === -1 ? argv : argv.slice(0, end)
}

/** Scalar flags are not repeatable — a second occurrence can hide a
 * missing value that would pass validation. Matches both spellings:
 * `--name value` and `--name=value`; a missed `--name=value` would
 * silently drop the option instead of failing closed. */
export function flag(argv: string[], name: string): string | undefined {
  argv = flagZone(argv)
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
  argv = flagZone(argv)
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

/** What one `--…` token is: 'value' consumes a value (inline via `=`,
 *  else the next token), 'bool' is a known no-value flag, 'drop' is an
 *  unrecognized flag lenient callers swallow, 'positional' isn't a
 *  flag at all. `strict` turns an unrecognized flag into a usage error
 *  instead of a silent drop. */
function flagTokenKind(
  arg: string,
  valueFlags: ReadonlySet<string>,
  opts?: { boolFlags?: ReadonlySet<string>; strict?: boolean }
): 'value' | 'bool' | 'drop' | 'positional' {
  if (!arg.startsWith('--')) {
    return 'positional'
  }
  const name = arg.split('=', 1)[0]!
  if (valueFlags.has(name)) {
    return 'value'
  }
  if (opts?.boolFlags?.has(name) === true) {
    // `--dry-run=true` parses as the bool flag yet downstream
    // `argv.includes('--dry-run')` checks miss it — a silent live run.
    // strict mode refuses the inline value outright
    if (opts?.strict === true && arg !== name) {
      console.error(`error: option ${name} takes no value`)
      process.exit(2)
    }
    return 'bool'
  }
  if (opts?.strict === true) {
    console.error(`error: unknown option ${name}`)
    process.exit(2)
  }
  return 'drop'
}

/** Positional args = everything that isn't a flag or its value.
 *  `--` ends flag parsing — everything after is positional verbatim
 *  (a message containing `--help` survives only behind it). A
 *  `--name=value` token counts as the named flag with its value inline;
 *  `opts.boolFlags` names the no-value flags to swallow, and with
 *  `opts.strict` an unrecognized `--x` is a usage error — silently
 *  dropping a mistyped flag hides both the typo and its value. */
export function positionals(
  argv: string[],
  valueFlags: ReadonlySet<string>,
  opts?: { boolFlags?: ReadonlySet<string>; strict?: boolean }
): string[] {
  const out: string[] = []
  let verbatim = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (verbatim) {
      out.push(arg)
      continue
    }
    if (arg === '--') {
      verbatim = true
      continue
    }
    const kind = flagTokenKind(arg, valueFlags, opts)
    if (kind === 'positional') {
      out.push(arg)
      continue
    }
    // `--name value` — the value is the next token; `--name=value` is
    // self-contained
    if (kind === 'value' && arg === arg.split('=', 1)[0]) {
      const next = argv[i + 1]
      // strict: `--agent --json` must not swallow `--json` as the
      // value — a missing or flag-looking value is a usage error,
      // never a silent misconfig
      if (opts?.strict === true && (next === undefined || next.startsWith('--'))) {
        console.error(`error: option ${arg} requires a value`)
        process.exit(2)
      }
      i += 1
    }
  }
  return out
}
