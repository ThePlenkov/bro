/**
 * `bro hooks <event>` — agent lifecycle hooks as bro mechanics. Thin
 * `hooks.json` at the plugin root calls this; all policy lives here.
 *
 *   session-start | post-compaction | pre-compact
 *                                       rehydrate: beads ready + drill frame + PR gate + debt
 *   prompt-submit                     drill-frame reminder; PR URL → act snapshot
 *   post-tool                         exec nudges: gh pr create → act gate; merge → debt sweep;
 *                                       arms the stop gate for this session (bro act/drill,
 *                                       gh pr, git push) via a per-session marker in .git
 *   stop                              block while a drill frame or review threads are open —
 *                                       but only for sessions that armed the gate; ambient
 *                                       repo state is emitted as passive context, never a block
 *   permission                        auto-approve bro/bd invocations
 *
 * Contract: read the event payload on stdin, print hook control JSON on
 * stdout, exit 0. Everything is best-effort — hooks only fire in bro-enabled
 * repos (bro.config.json or .beads/ walking up) and every probe is wrapped so
 * a missing bd/gh or a dead network can never stall the session.
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
import { ghJson, resolveRepo } from '@bro/core'
import { loadBroConfig } from '../plugins.ts'
import { evaluateExitGate, fetchPrActState } from '@bro/act'
import { bdJson, currentFrame } from '@bro/drill'
import { readDebtRecords } from '@bro/debt'

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
 * `git push` arm the PR gate, `bro drill`/`bro wtf` arm the drill gate.
 * Global flags between binary and subcommand are allowed (`gh -R o/r pr`,
 * `git -C path push`); the binary must sit at a command position — string
 * start or after `;`, `&`, `|`, or a newline (leading whitespace is fine). */
export function classifyArmCommand(cmd: string): 'act' | 'drill' | null {
  const c = unquoted(cmd)
  const at = '(^|[;&|\\n])\\s*'
  const bro = '(?:bro|npx\\s+(?:-y\\s+)?@theplenkov/bro(?:@[\\w.:-]+)?)'
  if (new RegExp(`${at}${bro}\\s+act\\b`).test(c)) {
    return 'act'
  }
  if (new RegExp(`${at}${bro}\\s+(?:drill|wtf)\\b`).test(c)) {
    return 'drill'
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

/** First GitHub PR URL in free text → { owner, repo, pr }. */
export function parsePrUrl(text: string): { owner: string; repo: string; pr: number } | null {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(text)
  if (!m) {
    return null
  }
  return { owner: m[1]!, repo: m[2]!, pr: Number(m[3]) }
}

// --- shared probes ------------------------------------------------------------

interface BeadRow {
  id: string
  title?: string
  status?: string
}

function drillLine(): string | null {
  try {
    const frame = currentFrame()
    if (!frame) {
      return null
    }
    return `drill frame open: ${frame.id} "${frame.title}" [depth=${frame.depth}] — close with \`bro drill up --result "…"\``
  } catch {
    return null
  }
}

function readyLines(limit: number): string[] {
  try {
    const rows = bdJson<BeadRow[]>(['ready']).slice(0, limit)
    return rows.map((r) => `  ${r.id} ${r.title ?? ''}`.trimEnd())
  } catch {
    return []
  }
}

function debtLine(): string | null {
  try {
    const open = readDebtRecords().filter((r) => r.status === 'open').length
    return open > 0 ? `debt: ${open} open finding(s) — \`bro debt next\` picks one` : null
  } catch {
    return null
  }
}

/** `owner/repo` for the current clone — null when the split isn't clean. */
function repoParts(): [string, string] | null {
  const parts = resolveRepo([]).split('/')
  const [owner, name] = parts
  return parts.length === 2 && owner && name ? [owner, name] : null
}

/** Current branch's open PR → one-line gate summary. Null when no PR/no gh. */
async function actGateLine(owner?: string, repo?: string, pr?: number): Promise<string | null> {
  try {
    let o = owner
    let r = repo
    let n = pr
    if (n === undefined) {
      const view = ghJson<{ number: number; state: string }>([
        'pr',
        'view',
        '--json',
        'number,state',
      ])
      if (view.state !== 'OPEN') {
        return null
      }
      n = view.number
      const parts = repoParts()
      if (!parts) {
        return null
      }
      ;[o, r] = parts
    }
    const act = loadBroConfig().act
    const state = await fetchPrActState(
      { owner: o!, repo: r!, pr: n! },
      { ignoreChecks: act.ignoreChecks, maxRounds: act.maxRounds }
    )
    const gate = evaluateExitGate(state)
    return gate.ok
      ? `pr #${state.pr}: gate OK`
      : `pr #${state.pr}: gate BLOCKED (${gate.blockers.join('; ')}) — \`bro act status\``
  } catch {
    return null
  }
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

function hooksStateDir(): string | null {
  try {
    const gd = execFileSync('git', ['rev-parse', '--git-dir'], { // NOSONAR
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
function markerPath(sessionId: string, aspect: 'act' | 'drill'): string | null {
  const dir = hooksStateDir()
  const safe = sessionId.replace(/[^\w.-]/g, '_')
  return dir && safe ? join(dir, `${safe}.${aspect}`) : null
}

/** Aspects this session armed, or empty when no marker exists. Markers
 * older than MARKER_TTL_MS count as unarmed even if still on disk. */
export function readArmed(sessionId: string): Set<'act' | 'drill'> {
  const armed = new Set<'act' | 'drill'>()
  const cutoff = Date.now() - MARKER_TTL_MS
  for (const aspect of ['act', 'drill'] as const) {
    try {
      const path = markerPath(sessionId, aspect)
      if (path && existsSync(path) && statSync(path).mtimeMs >= cutoff) {
        armed.add(aspect)
      }
    } catch {
      // unreadable marker = unarmed aspect
    }
  }
  return armed
}

/** Record that this session touched `aspect`. Best-effort; also prunes
 * markers older than a week so stale sessions don't accumulate. */
function armSession(sessionId: string, aspect: 'act' | 'drill'): void {
  try {
    const path = markerPath(sessionId, aspect)
    if (!path) {
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(Date.now()))
    const cutoff = Date.now() - MARKER_TTL_MS
    for (const f of readdirSync(dirname(path))) {
      try {
        if (/\.(act|drill)$/.test(f) && statSync(join(dirname(path), f)).mtimeMs < cutoff) {
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
  event: 'SessionStart' | 'PostCompaction' | 'PreCompact'
): Promise<void> {
  const parts: string[] = []
  const drill = drillLine()
  if (drill) {
    parts.push(drill)
  }
  const ready = readyLines(8)
  if (ready.length > 0) {
    parts.push(`bd ready:\n${ready.join('\n')}`)
  }
  const gate = await actGateLine()
  if (gate) {
    parts.push(gate)
  }
  const debt = debtLine()
  if (debt) {
    parts.push(debt)
  }
  if (parts.length > 0) {
    context(event, `bro state — resume from here:\n${parts.join('\n')}`)
  }
}

async function emitPromptContext(input: HookInput): Promise<void> {
  const parts: string[] = []
  const drill = drillLine()
  if (drill) {
    parts.push(drill)
  }
  const ref = typeof input.prompt === 'string' ? parsePrUrl(input.prompt) : null
  if (ref) {
    const gate = await actGateLine(ref.owner, ref.repo, ref.pr)
    if (gate) {
      parts.push(gate)
    }
  }
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
    armSession(sessionId, aspect)
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

/** The exit gate as a hook: don't stop while review threads or a drill frame
 * stay open — but only for sessions that armed the matching aspect this
 * session (see session arming above). Unarmed sessions get the same findings
 * as passive context: ambient repo state is not their obligation.
 * Respects stop_hook_active so a blocked stop can't loop. */
async function emitStopGate(input: HookInput): Promise<void> {
  if (input.stop_hook_active === true) {
    return
  }
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const armed = sessionId ? readArmed(sessionId) : new Set<string>()
  const drill = drillLine()
  // Armed blocks are evaluated independently — a foreign drill frame must not
  // shadow an armed PR gate, and vice versa.
  if (drill && armed.has('drill')) {
    emit({ decision: 'block', reason: `bro: ${drill}` })
    return
  }
  const hints: string[] = []
  if (drill) {
    hints.push(`bro: ${drill} (opened outside this session — informational)`)
  }
  const pr = await prBlockersLine()
  if (pr && armed.has('act')) {
    emit({
      decision: 'block',
      reason:
        `${pr} — ` +
        'list with `bro act threads` — fix inline or defer to a debt bead ' +
          '(reply + resolve); when fix_rounds exceeds act.maxRounds only ' +
          'defer counts; recheck `bro act status`',
    })
    return
  }
  if (pr) {
    hints.push(`${pr} (current branch — this session did not touch it)`)
  }
  if (hints.length > 0) {
    context('Stop', hints.join('\n'))
  }
}

/** Current-branch open PR → one-line blocker summary, or null when the PR
 * is clean / not OPEN / unreachable. */
async function prBlockersLine(): Promise<string | null> {
  try {
    const view = ghJson<{ number: number; state: string }>(['pr', 'view', '--json', 'number,state'])
    const parts = view.state === 'OPEN' ? repoParts() : null
    if (!parts) {
      return null
    }
    const [owner, repoName] = parts
    const act = loadBroConfig().act
    const state = await fetchPrActState(
      { owner, repo: repoName!, pr: view.number },
      { ignoreChecks: act.ignoreChecks, maxRounds: act.maxRounds }
    )
    // The same gate `bro act status` enforces: open threads, pending/failed
    // CI and AI reviewers, SAST findings, unknown mergeability, BEHIND.
    const gate = evaluateExitGate(state)
    return gate.ok ? null : `bro: PR #${view.number}: ${gate.blockers.join('; ')}`
  } catch {
    // no repo/PR/auth — nothing to gate on
    return null
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
    switch (event) {
      case 'session-start':
        await emitSessionContext('SessionStart')
        return
      case 'post-compaction':
        await emitSessionContext('PostCompaction')
        return
      case 'pre-compact':
        // Claude Code requires hookEventName to match the firing event
        await emitSessionContext('PreCompact')
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
