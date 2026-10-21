/**
 * The devin CLI's grammar — which commands open a session, and how many.
 *
 * The session cap is judged against `live + starts`, so the plane must
 * answer "how many sessions would this command open?" — not "is this
 * the devin binary?". `devin models` lists the catalogue (no session),
 * `devin acp` serves a session over stdio, `devin` alone opens an
 * interactive one, and a command may open several at once
 * (`devin a & devin b`).
 *
 * This is the devin package's own knowledge — the core policy asks the
 * plane, and the plane answers in devin's terms.
 */

/** The devin CLI's subcommands that never open a session: they read or
 *  manage what already exists. */
const NON_SESSION_COMMANDS = new Set([
  'auth',
  'desktop',
  'doctor',
  'forward',
  'help',
  'list',
  'ls',
  'mcp',
  'migrate',
  'models',
  'plugins',
  'rm',
  'rules',
  'sandbox',
  'setup',
  'skills',
  'ssh',
  'uninstall',
  'update',
  'version',
])

/** `devin cloud` opens a cloud session, but `devin cloud ls` only lists
 *  cloud resources. */
const CLOUD_RESOURCE_COMMANDS = new Set(['list', 'ls', 'rm', 'ssh', 'forward'])

/** The wrappers a vendor binary may sit behind — the token before the
 *  binary decides whether the binary is a command or an argument. */
const WRAPPERS = new Set([
  'command',
  'env',
  'exec',
  'nohup',
  'npx',
  'bunx',
  'pnpm',
  'sudo',
  'time',
  'xargs',
  'yarn',
])

/** The shell segments of a command — `;`, `&&`, `||`, `&`, `|` and
 *  newlines split them, the way a shell would. */
function segments(command: string): string[] {
  return command
    .split(/(\|\||&&|;|\||\n|&)/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !/^(\|\||&&|;|\||&)$/.test(s))
}

/** A shell token — a quoted run or a bare word. */
const TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g

/** The tokens of a shell segment, quotes honoured (a quoted run is ONE
 *  token — `bro --command 'devin acp'` is three tokens, and the quoted
 *  one names a command, it does not start one). */
function tokens(segment: string): string[] {
  const out: string[] = []
  for (const match of segment.matchAll(TOKEN_RE)) {
    const raw = match[0]
    const quoted = raw.startsWith('"') || raw.startsWith("'")
    out.push(quoted ? raw.slice(1, -1) : raw)
  }
  return out
}

/** The basename of a path-like token. */
function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/** Does this devin invocation open a session? The verb after the
 *  binary decides: no verb (the bare CLI) opens an interactive session,
 *  a flag (`-p`, `--print`, `--cloud`, `--prompt-file`) opens a
 *  one-shot, `acp` opens a served session, and the read-only verbs
 *  open none. */
function invocationStartsSession(toks: string[], at: number): boolean {
  const verb = toks[at + 1]
  if (verb === undefined || verb.startsWith('-')) {
    return true
  }
  if (verb === 'cloud') {
    const sub = toks[at + 2]
    return sub === undefined || !CLOUD_RESOURCE_COMMANDS.has(sub)
  }
  return !NON_SESSION_COMMANDS.has(verb)
}

/** The positions in a segment's tokens where a devin binary sits at a
 *  COMMAND position — a devin mentioned as an argument (`grep devin`)
 *  is not a start. */
function devinCommandPositions(toks: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < toks.length; i++) {
    if (base(toks[i]!) !== 'devin') {
      continue
    }
    if (i > 0 && !WRAPPERS.has(base(toks[i - 1]!))) {
      continue
    }
    out.push(i)
  }
  return out
}

/** How many devin sessions would this command open? */
export function countDevinSessionStarts(command: string): number {
  let count = 0
  for (const segment of segments(command)) {
    const toks = tokens(segment)
    for (const at of devinCommandPositions(toks)) {
      if (invocationStartsSession(toks, at)) {
        count++
      }
    }
  }
  return count
}
