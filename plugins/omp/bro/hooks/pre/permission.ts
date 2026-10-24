// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro's pre-tool guard for omp.
 *
 * ## Why this hook is narrow
 *
 * bro has two pre-tool planes and only one of them maps onto omp:
 *
 *   - The **permission plane** answers *approve / ask* for bro's own
 *     commands. omp's `tool_call` hook can only *block*, and omp's
 *     approval flow (`tool_approval_requested`) ignores handler
 *     returns — there is no slot for "auto-approve". So that plane is
 *     deliberately absent here: bro's machinery (`bro`, `bd`, `gh`)
 *     runs under omp's normal approval policy, and the session can
 *     approve it the same way it approves anything else.
 *
 *   - The **guard plane** answers *block* for a command that must not
 *     run. That maps exactly onto omp's `{ block: true, reason }`, and
 *     it is what this hook carries.
 *
 * ## The one rule
 *
 * A force push rewrites shared history. bro's occupancy plane — the
 * rule that one session owns one unit of work — is built on branches
 * staying stable, and other sessions and workers hold references to
 * them. A force push breaks references the rig cannot repair, so bro
 * blocks it here rather than discovering the damage at merge time.
 *
 * `--force-with-lease` is the safe form: it refuses when the remote has
 * moved, which is exactly the race a plain force push ignores.
 */
import type { OmpApi } from './omp-api.ts'

/** A force push rewrites shared history — never allowed. The command
 *  is tokenized shell-wise before judgment: flags live in words, not
 *  raw text — a quoted example inside `echo` is not a push, while a
 *  grouped short cluster (`git push -fu`) still is one. Segments split
 *  on shell separators first, so a flag-looking word in another
 *  command never trips the guard and a real force never hides behind
 *  one. */
const SHELL_SPLIT = /&&|[;&|\n]/

/** git global options that take a separate value word — they sit
 *  between `git` and `push` and must not eat the `push` word. */
const GLOBAL_VALUE_OPTS: Record<string, true> = {
  '-C': true,
  '-c': true,
  '--git-dir': true,
  '--work-tree': true,
  '--exec-path': true,
  '--namespace': true,
  '--config-env': true,
}

/** Shells that re-parse their arguments: a force push can hide inside *  their command string (`bash -c 'git push -f'`, `eval git push -f`). */
const NESTED_SHELLS: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ksh: true,
  fish: true,
  eval: true,
  source: true,
  '.': true,
}

/** Wrappers that still run their argument as a command. */
const WRAPPERS: Record<string, true> = {
  command: true,
  nohup: true,
  nice: true,
  stdbuf: true,
  env: true,
}

/** `NAME=value` leading assignments — `A=b git push -f` runs git. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/

/** Shell words: whitespace separates, quotes group (`"-f"` → `-f`,
 *  `"git push"` → one word), a backslash escapes the next character.
 *  An unterminated quote swallows the rest — a longer word, no crash. */
const QUOTES: Record<string, true> = { '"': true, "'": true }
const SEPARATORS: Record<string, true> = { ' ': true, '\t': true }

/** The text of a quoted run starting at `i` (data[i] is the quote) and
 *  the index after its closing quote; an unterminated quote swallows
 *  the rest. Backslash stays literal inside quotes — the guard needs
 *  words, not full shell semantics. */
function quotedWord(segment: string, i: number): { text: string; end: number } {
  const quote = segment[i]
  let text = ''
  let j = i + 1
  while (j < segment.length && segment[j] !== quote) {
    text += segment[j]
    j++
  }
  return { text, end: j < segment.length ? j + 1 : j }
}

function words(segment: string): string[] {
  const out: string[] = []
  let cur = ''
  let started = false
  let i = 0
  while (i < segment.length) {
    const ch = segment[i]
    if (ch in QUOTES) {
      const quoted = quotedWord(segment, i)
      cur += quoted.text
      started = true
      i = quoted.end
      continue
    }
    const escaped = segment[i + 1]
    if (ch === '\\' && escaped !== undefined) {
      cur += escaped
      started = true
      i += 2
      continue
    }
    if (ch in SEPARATORS) {
      if (started) {
        out.push(cur)
        cur = ''
        started = false
      }
      i++
      continue
    }
    cur += ch
    started = true
    i++
  }
  if (started) {
    out.push(cur)
  }
  return out
}

/** One push-argument word forces history: `--force` (never
 *  `--force-with-lease` — the safe form the block reason points to), a
 *  short-flag cluster carrying `f` (`-f`, `-fu`, `-uf`), or a
 *  leading-`+` refspec. */
function isForceWord(word: string): boolean {
  if (word === '--force' || word.startsWith('+')) {
    return true
  }
  return word.startsWith('-') && !word.startsWith('--') && word.slice(1).includes('f')
}

/** Does `git [wrappers/global opts] push <args>` in this word list
 *  force? */
function gitPushForces(toks: string[]): boolean {
  let i = 0
  while (i < toks.length && (ASSIGNMENT.test(toks[i]) || toks[i] in WRAPPERS)) {
    i++
  }
  if (toks[i] !== 'git') {
    return false
  }
  i++
  while (i < toks.length && toks[i].startsWith('-')) {
    const opt = toks[i]
    i++
    if (opt in GLOBAL_VALUE_OPTS && i < toks.length && !toks[i].startsWith('-')) {
      i++
    }
  }
  if (toks[i] !== 'push') {
    return false
  }
  return toks.slice(i + 1).some(isForceWord)
}

/** The command string a shell receives: skip its flags, join the rest. */
function nestedCommand(toks: string[]): string {
  let i = 0
  while (i < toks.length && toks[i].startsWith('-')) {
    i++
  }
  return toks.slice(i).join(' ')
}

/** Segment judgment: a shell re-parses (recurse into its string),
 *  anything else must be `git … push … force` itself. */
function segmentForces(toks: string[], depth: number): boolean {
  const head = (toks[0] ?? '').split('/').pop() ?? ''
  if (head in NESTED_SHELLS) {
    return pushesForce(nestedCommand(toks.slice(1)), depth - 1)
  }
  return gitPushForces(toks)
}

/** Does any shell segment of this command force-push? Command
 *  substitutions (`$(…)`, backticks) execute too — unpack them before
 *  splitting. `depth` bounds nesting (`sh -c 'sh -c "…"'`). */
function pushesForce(command: string, depth: number): boolean {
  if (depth <= 0) {
    return false
  }
  const unpacked = command.replace(/\$\(([^)]*)\)/g, ' $1 ').replace(/`([^`]*)`/g, ' $1 ')
  return unpacked.split(SHELL_SPLIT).some((segment) => {
    const toks = words(segment)
    return toks.length > 0 && segmentForces(toks, depth)
  })
}

/** Does any shell segment of this command force-push? */
export function isForcePush(command: string): boolean {
  return pushesForce(command, 3)
}

export default function broGuard(pi: OmpApi): void {
  pi.on('tool_call', (event: unknown) => {
    const call = event as { toolName?: string; input?: unknown }
    if (call.toolName !== 'bash') {
      return undefined
    }
    const input = call.input
    // a non-string command is not a command — String() on an object would
    // produce '[object Object]' and match nothing, but it would also hide
    // the real shape behind a truthy string
    let command = ''
    if (typeof input === 'object' && input !== null && 'command' in input) {
      const raw = input.command
      command = typeof raw === 'string' ? raw : ''
    }
    if (command === '' || !isForcePush(command)) {
      return undefined
    }
    return {
      block: true,
      reason:
        "bro blocks force pushes: other sessions and bro's occupancy plane rely on stable branch history. Use --force-with-lease.",
    }
  })
}
