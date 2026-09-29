/**
 * `bro hooks <event>` — agent lifecycle hooks as bro mechanics. Thin
 * `hooks.json` at the plugin root calls this; all policy lives here.
 *
 *   session-start | post-compaction | pre-compact
 *                                       rehydrate: connector probes — beads ready,
 *                                       drill frame, PR gate, debt, merge slot, work nudge
 *   prompt-submit                     connector prompt probes — drill-frame reminder;
 *                                       the review host parses its own PR URLs → act snapshot
 *   post-tool                         exec nudges: gh pr create → act gate; merge → debt sweep;
 *                                       arms the stop gate for this session (bro act/drill/
 *                                       work, gh pr, git push, worktree add, bd --claim) via a
 *                                       per-session marker in .git
 *   stop                              connector GateContributions — each system reports
 *                                       unfinished work; the hook blocks only aspects this
 *                                       session armed, ambient state is passive context
 *   permission                        auto-approve bro/bd invocations
 *
 * Contract: read the event payload on stdin, print hook control JSON on
 * stdout, exit 0. Everything is best-effort — hooks only fire in bro-enabled
 * repos (bro.config.json or .beads/ walking up) and every connector probe is
 * fail-open so a missing bd/gh or a dead network can never stall the session.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  parallelWorkLines,
  promptContextLines,
  sessionStartLines,
  stopGateContributions,
} from '@bro/core'

interface HookInput {
  tool_input?: { command?: unknown }
  tool_response?: { success?: unknown }
  prompt?: unknown
  stop_hook_active?: unknown
  session_id?: unknown
}

/** A repo opts in to bro hooks with bro.config.json or a .beads/ dir. */
function broEnabled(startDir: string): boolean {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, 'bro.config.json')) || existsSync(join(dir, '.beads'))) {
      return true
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return false
    }
    dir = parent
  }
}

function readInput(): HookInput {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) as HookInput
  } catch {
    return {}
  }
}

function emit(out: unknown): void {
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

function context(event: string, text: string): void {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })
}

// --- pure probes (testable without gh/bd) -----------------------------------

/** Which gh lifecycle a shell command belongs to, if any. `gh` must sit at
 * a command position — `echo "gh pr merge"` is text, not a merge. */
export function classifyExecCommand(cmd: string): 'pr-merge' | 'pr-create' | null {
  if (/(^|[;&|]\s*)gh\s+pr\s+merge\b/.test(cmd)) {
    return 'pr-merge'
  }
  if (/(^|[;&|]\s*)gh\s+pr\s+create\b/.test(cmd)) {
    return 'pr-create'
  }
  return null
}

/** Strip single/double-quoted spans so separators inside arguments cannot
 * fake a command position (`echo "x; gh pr merge"` is one echo, not two
 * commands). Escaped characters inside quotes do not close the span —
 * `echo "a\"; gh pr"` is still one echo. */
function unquoted(cmd: string): string {
  return cmd.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ')
}

/** Which gate aspect a shell command arms for this session. The stop gate
 * only hard-blocks sessions that recorded interaction — `bro act`/`gh pr`/
 * `git push` arm the PR gate, `bro drill`/`bro wtf` arm the drill gate,
 * worktree creation and bead claims arm the work gate (`bro work`,
 * `git worktree add`, `bd worktree create`, `bd … --claim`).
 * Global flags between binary and subcommand are allowed (`gh -R o/r pr`,
 * `git -C path push`); the binary must sit at a command position — string
 * start or after `;`, `&`, `|`, or a newline (leading whitespace is fine).
 * The set is open — connectors may contribute gates under their own
 * aspect names; arming patterns for those live where they're owned. */
export type GateAspect = 'act' | 'drill' | 'work'

export function classifyArmCommand(cmd: string): GateAspect | null {
  const c = unquoted(cmd)
  const at = '(^|[;&|\\n])\\s*'
  const bro = '(?:bro|npx\\s+(?:-y\\s+)?@theplenkov/bro(?:@[\\w.:-]+)?)'
  if (new RegExp(`${at}${bro}\\s+act\\b`).test(c)) {
    return 'act'
  }
  if (new RegExp(`${at}${bro}\\s+(?:drill|wtf)\\b`).test(c)) {
    return 'drill'
  }
  if (new RegExp(String.raw`${at}${bro}\s+work\b`).test(c)) {
    return 'work'
  }
  // Flag tokens may carry a separate value (`-C path`, `--repo o/r`), so
  // allow `-\S+` optionally followed by one non-flag token.
  const flags = '(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*'
  if (new RegExp(`${at}gh${flags}\\s+pr\\b`).test(c)) {
    return 'act'
  }
  if (new RegExp(`${at}git${flags}\\s+push\\b`).test(c)) {
    return 'act'
  }
  if (new RegExp(String.raw`${at}git${flags}\s+worktree\s+(?:add|remove)\b`).test(c)) {
    return 'work'
  }
  if (new RegExp(String.raw`${at}bd${flags}\s+worktree\s+(?:create|remove)\b`).test(c)) {
    return 'work'
  }
  // claiming a bead is work — the session owes the claim a close/release
  if (new RegExp(`${at}bd\\b[^;&|\\n]*--claim\\b`).test(c)) {
    return 'work'
  }
  return null
}

/** bro/bd are the plugin's own tools — permission hooks approve them
 * outright. Chained, piped, or redirected commands are NOT self-tool calls:
 * the second stage could be anything, so it falls through to a prompt. */
export function isSelfToolCommand(cmd: string): boolean {
  if (/[;&|`$()<>\n\\]/.test(cmd)) {
    return false
  }
  return (
    /^\s*(bro|bd)(\s|$)/.test(cmd) ||
    /^\s*npx\s+(-y\s+)?@theplenkov\/bro(@[\w.:-]+)?(\s|$)/.test(cmd)
  )
}

// --- session arming -----------------------------------------------------------
//
// The stop gate must never convert ambient repo state into a session
// obligation: a checkout sitting on a branch with an open PR, or a drill
// frame another session left open, is context — not this agent's work.
// post-tool records which gate aspects the session touched in
// <git-dir>/bro/hooks/<session>.<aspect>; stop only hard-blocks armed
// aspects. No session_id or no git dir → unarmed → passive (fail-open).

const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** "Live" for parallel-session detection is tighter than the stop-gate
 *  TTL — a marker older than a day is residue, not a working session. */
const LIVE_SESSION_MS = 24 * 60 * 60 * 1000

/** Markers live under the common git dir — shared across all linked
 *  worktrees of the repo, so a session in one worktree can detect work
 *  armed by a session in another. `--git-dir` would be per-worktree. */
function hooksStateDir(): string | null {
  try {
    const gd = execFileSync('git', ['rev-parse', '--git-common-dir'], { // NOSONAR
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return gd ? join(gd, 'bro', 'hooks') : null
  } catch {
    return null
  }
}

/** One marker file per aspect (<session>.<aspect>) — arming is a pure file
 * create with no read-modify-write, so concurrent post-tool hooks from
 * parallel tool calls cannot lose an aspect to a torn JSON rewrite. */
function markerPath(sessionId: string, aspect: GateAspect): string | null {
  const dir = hooksStateDir()
  const safe = sessionId.replace(/[^\w.-]/g, '_')
  return dir && safe ? join(dir, `${safe}.${aspect}`) : null
}

/** Aspects this session armed, or empty when no marker exists. The
 * marker dir is scanned by the `<session>.` prefix — an aspect is any
 * suffix, so connector-owned aspects (armed by external tooling that
 * writes the same marker shape) are armed without a CLI-side list.
 * Markers older than MARKER_TTL_MS count as unarmed even if on disk. */
export function readArmed(sessionId: string): Set<string> {
  const armed = new Set<string>()
  const dir = hooksStateDir()
  const safe = sessionId.replace(/[^\w.-]/g, '_')
  if (!dir || !safe) {
    return armed
  }
  const cutoff = Date.now() - MARKER_TTL_MS
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${safe}.`)) {
        continue
      }
      try {
        if (statSync(join(dir, f)).mtimeMs >= cutoff) {
          armed.add(f.slice(safe.length + 1))
        }
      } catch {
        // unreadable marker = unarmed aspect
      }
    }
  } catch {
    // unreadable dir = unarmed session
  }
  return armed
}

/** Other sessions' live work-arm markers — the parallel-work signal.
 *  Markers carry `Date.now()\n<detail>`; freshness is mtime within
 *  LIVE_SESSION_MS (a 7-day-old marker is residue, not a session). */
export function otherLiveWork(
  dir: string,
  selfId: string,
  now: number = Date.now()
): Array<{ session: string; detail: string; ageMs: number }> {
  const out: Array<{ session: string; detail: string; ageMs: number }> = []
  const cutoff = now - LIVE_SESSION_MS
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return out // no marker dir yet — nothing armed
  }
  for (const f of files) {
    const m = /^([\w.-]+)\.work$/.exec(f)
    if (!m || m[1] === selfId) {
      continue
    }
    try {
      const path = join(dir, f)
      const st = statSync(path)
      if (st.mtimeMs < cutoff) {
        continue
      }
      const detail = readFileSync(path, 'utf8').split('\n')[1]?.trim() ?? ''
      out.push({ session: m[1]!, detail, ageMs: now - st.mtimeMs })
    } catch {
      // unreadable marker — skip
    }
  }
  return out
}

function formatAge(ageMs: number): string {
  if (ageMs < 60_000) {
    return 'just now'
  }
  if (ageMs < 3_600_000) {
    return `${Math.round(ageMs / 60_000)}m ago`
  }
  return `${Math.round(ageMs / 3_600_000)}h ago`
}

function liveSessionLines(dir: string, selfId: string): string[] {
  return otherLiveWork(dir, selfId).map((w) => {
    const on = w.detail ? ` on ${w.detail}` : ''
    return `session ${w.session.slice(0, 8)} armed work${on} (${formatAge(w.ageMs)})`
  })
}

/** Parallel-session nudge at session start: another live session armed
 *  work here, or a connector reports live work (claimed beads, sibling
 *  worktrees, held slots) — passive context naming what's occupied,
 *  never a block. */
async function parallelLines(sessionId: string): Promise<string[]> {
  try {
    const parts: string[] = []
    const dir = hooksStateDir()
    if (dir) {
      parts.push(...liveSessionLines(dir, sessionId))
    }
    parts.push(...(await parallelWorkLines({ dir: process.cwd() })))
    if (parts.length === 0) {
      return []
    }
    return [
      'parallel work detected in this repo:',
      ...parts.map((p) => `  ${p}`),
      '  → for new work prefer `bro work enter <slug>` — a separate worktree, not this checkout',
    ]
  } catch {
    // detection is passive — a probe failure must not break rehydrate
    return []
  }
}

const WORKTREE_VALUE_FLAGS = new Set(['-b', '--orphan', '--lock-reason'])

/** First positional token after `worktree add|create`, skipping flags
 *  and the values of flags that take one (`-b <branch>`). */
function worktreeTarget(args: string): string {
  const toks = args.split(/\s+/)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (!t.startsWith('-')) {
      return t
    }
    if (WORKTREE_VALUE_FLAGS.has(t)) {
      i++
    }
  }
  return ''
}

/** What a session armed — recorded in the marker so a parallel session
 *  can name the bead/worktree it would collide with. */
export function armDetail(cmd: string, aspect: GateAspect): string {
  const c = unquoted(cmd)
  if (aspect === 'work') {
    const enter = /\bwork\s+enter\s+([a-z0-9][\w.-]*)/.exec(c)
    if (enter) {
      return enter[1]!
    }
    const add = /\bworktree\s+(?:add|create)\s+/.exec(c)
    return add ? worktreeTarget(c.slice(add.index + add[0].length)) : ''
  }
  if (aspect === 'act') {
    const m = /\b(\d{1,7})\b/.exec(c)
    return m ? `#${m[1]}` : ''
  }
  return ''
}

/** Record that this session touched `aspect`. Best-effort; also prunes
 * markers older than a week so stale sessions don't accumulate. */
function armSession(sessionId: string, aspect: GateAspect, detail: string = ''): void {
  try {
    const path = markerPath(sessionId, aspect)
    if (!path) {
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    // line 2 carries the arming detail (slug/branch/PR) for
    // parallel-session detection — readArmed only ever reads mtime
    writeFileSync(path, `${Date.now()}\n${detail}`)
    const cutoff = Date.now() - MARKER_TTL_MS
    for (const f of readdirSync(dirname(path))) {
      try {
        if (statSync(join(dirname(path), f)).mtimeMs < cutoff) {
          rmSync(join(dirname(path), f))
        }
      } catch {
        // prune is best-effort
      }
    }
  } catch {
    // arming must never stall a session — unarmed degrades to passive context
  }
}

// --- event handlers -----------------------------------------------------------

async function emitSessionContext(
  event: 'SessionStart' | 'PostCompaction' | 'PreCompact',
  sessionId = ''
): Promise<void> {
  const parts: string[] = []
  // sessionStart probes collect from every connector — beads reports
  // the ready queue, drill the open frame, act the PR gate + merge slot,
  // debt the open findings; a jira connector would add assigned issues
  parts.push(...(await sessionStartLines({ dir: process.cwd() })))
  parts.push(...(await parallelLines(sessionId)))
  if (parts.length > 0) {
    context(event, `bro state — resume from here:\n${parts.join('\n')}`)
  }
}

async function emitPromptContext(input: HookInput): Promise<void> {
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const parts = await promptContextLines({ dir: process.cwd() }, prompt)
  if (parts.length > 0) {
    context('UserPromptSubmit', parts.join('\n'))
  }
}

function emitPostTool(input: HookInput): void {
  if (input.tool_response?.success !== true) {
    return
  }
  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const aspect = classifyArmCommand(cmd)
  if (sessionId && aspect) {
    armSession(sessionId, aspect, armDetail(cmd, aspect))
  }
  switch (classifyExecCommand(cmd)) {
    case 'pr-merge':
      context(
        'PostToolUse',
        'PR merged — sweep review debt with `bro debt collect`; queue: `bro debt prs`'
      )
      return
    case 'pr-create':
      context(
        'PostToolUse',
        'PR created — `bro act status` is the review gate; `bro act threads` lists open threads'
      )
      return
    default:
  }
}

/** The exit gate as a hook: every connector contributes GateContributions;
 * the hook applies the arming policy — `block` fires only when this session
 * armed the contribution's aspect, `armedHint` is shown to armed-but-clean
 * sessions, `passive` to everyone else (ambient state, not an obligation).
 * Contributions evaluate independently — a foreign drill frame must not
 * shadow an armed PR gate. Respects stop_hook_active so a blocked stop
 * can't loop. */
async function emitStopGate(input: HookInput): Promise<void> {
  if (input.stop_hook_active === true) {
    return
  }
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const armed = sessionId ? readArmed(sessionId) : new Set<string>()
  const hints: string[] = []
  for (const c of await stopGateContributions({ dir: process.cwd() })) {
    if (!armed.has(c.aspect)) {
      if (c.passive) {
        hints.push(c.passive)
      }
      continue
    }
    if (c.block) {
      emit({ decision: 'block', reason: c.block })
      return
    }
    if (c.armedHint) {
      hints.push(c.armedHint)
    }
  }
  if (hints.length > 0) {
    context('Stop', hints.join('\n'))
  }
}

function emitPermission(input: HookInput): void {
  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (isSelfToolCommand(cmd)) {
    emit({ decision: 'approve' })
  }
}

// --- dispatch -----------------------------------------------------------------

export async function runHooksCommand(argv: string[]): Promise<void> {
  const event = argv[0]
  const root = process.env.DEVIN_PROJECT_DIR ?? process.cwd()
  if (!event || !broEnabled(root)) {
    return
  }
  // bd/gh probes inherit cwd — run them in the project the hook fired for,
  // not wherever this process happened to start.
  if (root !== process.cwd()) {
    try {
      process.chdir(root)
    } catch {
      return
    }
  }
  const input = readInput()
  try {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
    switch (event) {
      case 'session-start':
        await emitSessionContext('SessionStart', sessionId)
        return
      case 'post-compaction':
        await emitSessionContext('PostCompaction', sessionId)
        return
      case 'pre-compact':
        // Claude Code requires hookEventName to match the firing event
        await emitSessionContext('PreCompact', sessionId)
        return
      case 'prompt-submit':
        await emitPromptContext(input)
        return
      case 'post-tool':
        emitPostTool(input)
        return
      case 'stop':
        await emitStopGate(input)
        return
      case 'permission':
        emitPermission(input)
        return
      default:
        // forward-compat: hooks.json may name events this bro doesn't know
        return
    }
  } catch {
    // hooks fail open — a bro bug must never break the session
  }
}
