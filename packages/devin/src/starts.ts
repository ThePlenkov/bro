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

/** The wrappers that take a bare operand before the command
 *  (`timeout 30 devin`). */
const WRAPPER_OPERANDS = new Set(['chrt', 'stdbuf', 'taskset', 'timeout'])

/** The options that take a value (`sudo -u root`, `nice -n 5`) — the
 *  value is not the command. */
const VALUE_OPTIONS = new Set(['-U', '-c', '-m', '-n', '-o', '-u'])

/** The index of the segment's command — the assignments and the
 *  wrappers (with their options, their values and the operand some of
 *  them take) are skipped; what is left is the command. */
function commandIndex(toks: Token[]): number {
  let i = 0
  while (i < toks.length) {
    const text = toks[i]!.text
    if (isAssignment(text)) {
      i++
      continue
    }
    const name = base(text)
    if (!WRAPPERS.has(name)) {
      return i
    }
    i++
    let operands = WRAPPER_OPERANDS.has(name) ? 1 : 0
    while (i < toks.length) {
      const next = toks[i]!.text
      if (next.startsWith('-')) {
        i++
        if (VALUE_OPTIONS.has(next) && i < toks.length && !toks[i]!.text.startsWith('-')) {
          i++
        }
        continue
      }
      if (operands > 0) {
        operands--
        i++
        continue
      }
      break
    }
  }
  return i
}

/** Is the token at this position a command (not an argument)? */
function atCommandPosition(toks: Token[], at: number): boolean {
  return at === commandIndex(toks)
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
  const at = commandIndex(toks)
  const shell = toks[at]
  if (shell === undefined || !SHELLS.has(base(shell.text))) {
    return undefined
  }
  if (!isShellCommandFlag(toks[at + 1]?.text)) {
    return undefined
  }
  const script = toks[at + 2]
  return script !== undefined && script.quoted ? script.text : undefined
}

/** Is this the shell's command flag? `-c` alone, or a combined short
 *  flag that carries it (`-lc`, `-ic`). */
function isShellCommandFlag(flag: string | undefined): boolean {
  if (flag === undefined) {
    return false
  }
  return flag === '-c' || /^-[a-z]*c[a-z]*$/.test(flag)
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
