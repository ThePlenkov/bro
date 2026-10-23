/**
 * The CLI exit-code contract (spec bro-1znlu) — one taxonomy every
 * bro command shares, plus the stream rule that pairs with it.
 *
 * Stream contract: **the exit code picks the stream.** exit 0 writes
 * usage/help text to stdout; non-zero writes it to stderr. Explicit
 * help (`--help`, `-h`, `help`) exits 0, so `bro … --help | grep`
 * works at every level of the dispatch.
 *
 * The shipped numbers are frozen — a watcher command's exit IS its
 * verdict (`convoy wait`, `bro wait`), and callers branch on it.
 * Codes 3 and 4 are reserved for that shape: a command may only give
 * them a verdict meaning, never a generic one. Verdict overloads on
 * 1 and 2 (see {@link EXIT_CODES}) are documented exceptions, not a
 * license for new ones.
 */
import { writeSync } from 'node:fs'

/** The taxonomy as constants — new code reads names, never digits. */
export const EXIT = {
  /** success — including explicit `--help`. */
  ok: 0,
  /** failure / negative verdict. */
  error: 1,
  /** usage error — bad flag, missing arg, unknown command. */
  usage: 2,
  /** the wait settled on work only the caller can do (human gate,
   *  reject, closed-unshipped) — watcher-verdict code. */
  actionable: 3,
  /** a bounded wait hit its deadline — watcher-verdict code. */
  timeout: 4,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export interface ExitCodeRow {
  code: number
  name: keyof typeof EXIT
  /** the generic meaning a caller may rely on sight-unseen. */
  meaning: string
  /** shipped verdict overloads — frozen meanings on specific commands. */
  verdicts?: string
}

/** The contract as a table — `bro contract dump` (bro-k9ces)
 *  serializes this; the docs page renders it. */
export const EXIT_CODES: readonly ExitCodeRow[] = [
  {
    code: EXIT.ok,
    name: 'ok',
    meaning: 'success — including explicit --help',
    verdicts: 'act wait gate OK · convoy wait complete · wait free',
  },
  {
    code: EXIT.error,
    name: 'error',
    meaning: 'failure / negative verdict',
    verdicts: 'act wait blocked|timeout · wait unreadable',
  },
  {
    code: EXIT.usage,
    name: 'usage',
    meaning: 'usage error — bad flag, missing arg, unknown command',
    verdicts: 'convoy wait stuck / unknown mol · wait unresolved (bad ref)',
  },
  {
    code: EXIT.actionable,
    name: 'actionable',
    meaning: 'wait settled on work only the caller can do',
    verdicts: 'convoy wait human gate ready · wait reject / closed-unshipped',
  },
  {
    code: EXIT.timeout,
    name: 'timeout',
    meaning: 'bounded wait hit its deadline',
    verdicts: 'convoy wait · wait — same meaning',
  },
]

/** Is this argv asking for help? `--help`/`-h` count only before a
 *  `--` separator — everything after it is verbatim payload (notify
 *  text, pulse commands, goal conditions), never a flag. */
export function hasHelpFlag(argv: readonly string[]): boolean {
  const sep = argv.indexOf('--')
  const head = sep === -1 ? argv : argv.slice(0, sep)
  return head.includes('--help') || head.includes('-h')
}

/** The fd write behind printUsage — a mutable holder so in-process
 *  command tests can capture usage text (hooking console.* cannot see
 *  writeSync). Production never reassigns it. */
export const usageWriter = {
  write(fd: 1 | 2, text: string): void {
    writeSync(fd, text)
  },
}

/** Print usage/help text on the stream its exit code owns — 0 stdout,
 *  non-zero stderr — then exit. Every `usage()`/USAGE site routes
 *  through here so the stream contract holds mechanically instead of
 *  by per-site convention. writeSync, not console.*: a buffered pipe
 *  write must be flushed before process.exit, never pending behind it.
 *  The code is typed ExitCode — only the documented taxonomy may exit. */
export function printUsage(text: string, code: ExitCode): never {
  usageWriter.write(code === EXIT.ok ? 1 : 2, text.endsWith('\n') ? text : `${text}\n`)
  process.exit(code)
}
