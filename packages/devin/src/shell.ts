/**
 * Reading a shell command — the parts of it the cap's grammar needs.
 *
 * The scan reads a command the way a shell would: the split happens
 * OUTSIDE quotes (a prompt may contain `;`), a quoted run is ONE token
 * (`bro --command 'devin acp'` names a command, it does not start one),
 * and an environment assignment in front of a binary does not make the
 * binary an argument.
 */

/** A shell token — its text and whether it was quoted. */
export interface Token {
  text: string
  quoted: boolean
}

/** The basename of a path-like token. */
export function base(token: Token): string {
  return token.text.slice(token.text.lastIndexOf('/') + 1)
}

/** The shell keywords that sit where a command sits (`then devin …`) —
 *  they are not commands themselves. */
const SHELL_KEYWORDS = new Set(['do', 'done', 'else', 'elif', 'fi', 'then', '{', '}'])

/** Is this token an environment assignment (`FOO=bar`)? */
export function isAssignment(token: Token): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)
}

/** The characters that end a shell segment. */
const SEPARATORS = new Set([';', '&', '|', '\n'])

/** The quote characters. */
const QUOTES = new Set(['"', "'"])

/** The shell segments of a command — the split happens OUTSIDE quotes,
 *  the way a shell would. */
export function segments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of command) {
    if (quote !== null) {
      current += ch
      if (ch === quote) {
        quote = null
      }
      continue
    }
    if (QUOTES.has(ch)) {
      quote = ch
      current += ch
      continue
    }
    if (SEPARATORS.has(ch)) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/** The tokens of a shell segment, quotes honoured — a quoted run is ONE
 *  token. */
export function tokens(segment: string): Token[] {
  const out: Token[] = []
  let current = ''
  let quoted = false
  let quote: string | null = null
  for (const ch of segment) {
    if (quote !== null) {
      // only the MATCHING quote closes the run — an apostrophe inside
      // a double-quoted run is text
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (QUOTES.has(ch)) {
      quote = ch
      quoted = true
      continue
    }
    if (/\s/.test(ch)) {
      out.push(...token(current, quoted))
      current = ''
      quoted = false
      continue
    }
    current += ch
  }
  out.push(...token(current, quoted))
  return out
}

/** One token — an empty run is no token at all. */
function token(text: string, quoted: boolean): Token[] {
  return text === '' ? [] : [{ text, quoted }]
}

/** The wrappers that take a bare operand before the command
 *  (`timeout 30 devin`). */
const WRAPPER_OPERANDS = new Set(['chrt', 'stdbuf', 'taskset', 'timeout'])

/** The options that take a value (`sudo -u root`, `nice -n 5`) — the
 *  value is not the command. */
const VALUE_OPTIONS = new Set(['-U', '-c', '-m', '-n', '-o', '-u'])

/** The wrappers a binary may sit behind — the token before the binary
 *  decides whether the binary is a command or an argument. */
const WRAPPERS = new Set([
  'bunx',
  'chrt',
  'command',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'npx',
  'pnpm',
  'setsid',
  'stdbuf',
  'sudo',
  'taskset',
  'time',
  'timeout',
  'xargs',
  'yarn',
])

/** The index of the segment's command — the assignments and the
 *  wrappers (with their options, their values and the operand some of
 *  them take) are skipped; what is left is the command. */
export function commandIndex(toks: Token[]): number {
  let i = 0
  while (i < toks.length) {
    const token = toks.at(i)
    if (token === undefined || isSkipped(token)) {
      i++
      continue
    }
    const name = base(token)
    if (!WRAPPERS.has(name)) {
      return i
    }
    if (isLookup(toks, i)) {
      // `command -v devin` LOOKS the binary up — it does not run it
      return i
    }
    i = skipWrapperArgs(toks, i + 1, token)
  }
  return i
}

/** Is this token skipped on the way to the command? An assignment and
 *  a shell keyword are not commands. */
function isSkipped(token: Token): boolean {
  return isAssignment(token) || SHELL_KEYWORDS.has(token.text)
}

/** Is this wrapper a lookup (`command -v X`) rather than a runner? */
function isLookup(toks: Token[], at: number): boolean {
  if (base(toks.at(at) as Token) !== 'command') {
    return false
  }
  const flag = toks.at(at + 1)?.text
  return flag === '-v' || flag === '-V'
}

/** The index after a wrapper's own arguments — its options (with the
 *  value some of them take) and the operand some of them need. */
function skipWrapperArgs(toks: Token[], from: number, wrapper: Token): number {
  let i = from
  let operands = WRAPPER_OPERANDS.has(base(wrapper)) ? 1 : 0
  while (i < toks.length) {
    const next = toks.at(i)
    if (next === undefined) {
      break
    }
    if (next.text.startsWith('-')) {
      i = skipOption(toks, i, next)
      continue
    }
    if (operands > 0) {
      operands--
      i++
      continue
    }
    break
  }
  return i
}

/** The index after an option — with the value it takes, if any. */
function skipOption(toks: Token[], at: number, option: Token): number {
  const next = at + 1
  return optionTakesNext(toks, next, option) ? next + 1 : next
}

/** Does this option take the next token as its value? */
function optionTakesNext(toks: Token[], at: number, option: Token): boolean {
  if (!VALUE_OPTIONS.has(option.text)) {
    return false
  }
  const next = toks.at(at)
  return next !== undefined && !next.text.startsWith('-')
}

/** Is the token at this position a command (not an argument)? */
export function atCommandPosition(toks: Token[], at: number): boolean {
  return at === commandIndex(toks)
}
