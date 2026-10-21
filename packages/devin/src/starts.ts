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
 * plane, and the plane answers in devin's terms. The shell reading it
 * leans on lives in `shell.ts`.
 */
import { base, isAssignment, segments, tokens, type Token } from './shell.ts'

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

/** The flags that only print — they open nothing. */
const NON_SESSION_FLAGS = new Set(['-h', '--help', '--version', '-V'])

/** The wrappers a vendor binary may sit behind — the token before the
 *  binary decides whether the binary is a command or an argument. */
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

/** The shells whose `-c` argument is a command of its own. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/** Does this devin invocation open a session? The verb after the
 *  binary decides: no verb (the bare CLI) opens an interactive session,
 *  a flag (`-p`, `--print`, `--cloud`, `--prompt-file`) opens a
 *  one-shot, `acp` opens a served session, and the read-only verbs
 *  open none. */
function invocationStartsSession(toks: Token[], at: number): boolean {
  const verb = toks[at + 1]?.text
  if (verb === undefined) {
    return true
  }
  if (verb.startsWith('-')) {
    return !NON_SESSION_FLAGS.has(verb)
  }
  if (verb === 'cloud') {
    const sub = toks[at + 2]?.text
    return sub === undefined || !CLOUD_RESOURCE_COMMANDS.has(sub)
  }
  return !NON_SESSION_COMMANDS.has(verb)
}

/** Is the token at this position a command (not an argument)? An
 *  assignment in front of a binary (`FOO=bar devin`) does not make the
 *  binary an argument. */
function atCommandPosition(toks: Token[], at: number): boolean {
  if (at === 0) {
    return true
  }
  const prev = toks[at - 1]!.text
  return isAssignment(prev) || WRAPPERS.has(base(prev))
}

/** The positions in a segment's tokens where a devin binary sits at a
 *  COMMAND position — a devin mentioned as an argument (`grep devin`)
 *  is not a start. */
function devinCommandPositions(toks: Token[]): number[] {
  const out: number[] = []
  for (let i = 0; i < toks.length; i++) {
    if (base(toks[i]!.text) !== 'devin') {
      continue
    }
    if (atCommandPosition(toks, i)) {
      out.push(i)
    }
  }
  return out
}

/** The command a shell wrapper runs: `sh -c 'devin -p x'` — the string
 *  is a command of its own, so its starts count too. */
function wrappedCommand(toks: Token[]): string | undefined {
  if (toks.length < 3 || toks[1]!.text !== '-c') {
    return undefined
  }
  if (!SHELLS.has(base(toks[0]!.text))) {
    return undefined
  }
  return toks[2]!.quoted ? toks[2]!.text : undefined
}

/** The starts one shell segment opens. */
function countSegmentStarts(segment: string, depth: number): number {
  const toks = tokens(segment)
  let count = 0
  for (const at of devinCommandPositions(toks)) {
    if (invocationStartsSession(toks, at)) {
      count++
    }
  }
  const wrapped = depth < 2 ? wrappedCommand(toks) : undefined
  if (wrapped !== undefined) {
    count += countDevinSessionStarts(wrapped, depth + 1)
  }
  return count
}

/** How many devin sessions would this command open? */
export function countDevinSessionStarts(command: string, depth = 0): number {
  let count = 0
  for (const segment of segments(command)) {
    count += countSegmentStarts(segment, depth)
  }
  return count
}
