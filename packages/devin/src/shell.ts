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
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
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
  let inQuote = false
  const push = (): void => {
    if (current !== '') {
      out.push({ text: current, quoted })
    }
    current = ''
    quoted = false
  }
  for (const ch of segment) {
    if (inQuote) {
      if (ch === '"' || ch === "'") {
        inQuote = false
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = true
      quoted = true
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    current += ch
  }
  push()
  return out
}
