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
export function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/** Is this token an environment assignment (`FOO=bar`)? */
export function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
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
