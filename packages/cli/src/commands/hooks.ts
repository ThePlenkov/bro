/**
 * `bro hooks <event>` — agent lifecycle hooks as bro mechanics. Thin
 * `hooks.json` at the plugin root calls this; all policy lives here.
 *
 *   session-start | post-compaction | pre-compact
 *                                       rehydrate: beads ready + drill frame + PR gate + debt
 *   prompt-submit                     drill-frame reminder; PR URL → act snapshot
 *   post-tool                         exec nudges: gh pr create → act gate; merge → debt sweep;
 *                                       arms the stop gate for this session (bro act/drill/
 *                                       work, gh pr, git push, worktree add) via a
 *                                       per-session marker in .git
 *   stop                              block while a drill frame, review threads, or a dirty
 *                                       linked worktree remain — but only for sessions that
 *                                       armed the gate; ambient repo state is emitted as
 *                                       passive context, never a block
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
import { basename, dirname, join } from 'node:path'
import {
  gitTry,
  parallelWorkLines,
  reviewHost,
  sessionStartLines,
  type PrTarget,
} from '@bro/core'
import { loadBroConfig } from '../plugins.ts'
import { evaluateExitGate, fetchPrActState, mergeSlotHolder } from '@bro/act'
import { gitDirOf, isLinkedGitDir, parseWorktreePorcelain } from './work.ts'
import { currentFrame } from '@bro/drill'
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
 * `git push` arm the PR gate, `bro drill`/`bro wtf` arm the drill gate,
 * worktree creation arms the work gate (`bro work`, `git worktree add`,
 * `bd worktree create`).
 * Global flags between binary and subcommand are allowed (`gh -R o/r pr`,
 * `git -C path push`); the binary must sit at a command position — string
 * start or after `;`, `&`, `|`, or a newline (leading whitespace is fine). */
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

/** Merge-slot holder for context — a session that sees the slot held knows
 *  not to start a merge right now. Fail-open: no beads → no line. */
function mergeSlotLine(): string | null {
  try {
    const holder = mergeSlotHolder()
    return holder ? `merge slot: held by ${holder} — serialize merges via \`bro act merge\`` : null
  } catch {
    return null
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

/** Parallel-friendly nudge: sessions sitting in the PRIMARY checkout get
 *  told to isolate work in a linked worktree. Sessions already inside a
 *  linked worktree (or outside git) get nothing — state, not noise. */
function workNudgeLine(): string | null {
  try {
    const gd = gitDirOf(process.cwd())
    if (!gd || isLinkedGitDir(gd)) {
      return null
    }
    return 'parallel-friendly: run work in a linked worktree — `bro work enter <slug>`; finish with `bro work leave`; `bro work list` shows siblings'
  } catch {
    return null
  }
}

/** Dirty count for the current dir, or 0 when not a git checkout. */
function dirtyHere(): number {
  const res = gitTry(['status', '--porcelain'])
  if (res.code !== 0) {
    return 0
  }
  return res.out.split('\n').filter(Boolean).length
}

/** Current branch's open PR → one-line gate summary. Null when no PR/
 *  no review host resolves. `target` overrides the current-branch
 *  lookup (e.g. a PR URL parsed out of the prompt). */
async function actGateLine(target?: PrTarget): Promise<string | null> {
  try {
    const rev = reviewHost(process.cwd(), loadBroConfig().connectors)
    let t = target
    if (!t) {
      const cur = rev.currentPr()
      if (!cur || cur.state !== 'OPEN') {
        return null
      }
      t = { repo: rev.resolveRepo([]), pr: cur.pr }
    }
    const act = loadBroConfig().act
    const state = await fetchPrActState(rev, t, {
      ignoreChecks: act.ignoreChecks,
      maxRounds: act.maxRounds,
    })
    const gate = evaluateExitGate(state)
    const link = rev.prLink(t.repo, state.pr)
    return gate.ok
      ? `pr ${link}: gate OK`
      : `pr ${link}: gate BLOCKED (${gate.blockers.join('; ')}) — \`bro act status\``
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

/** Aspects this session armed, or empty when no marker exists. Markers
 * older than MARKER_TTL_MS count as unarmed even if still on disk. */
export function readArmed(sessionId: string): Set<GateAspect> {
  const armed = new Set<GateAspect>()
  const cutoff = Date.now() - MARKER_TTL_MS
  for (const aspect of ['act', 'drill', 'work'] as const) {
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

/** Linked worktrees on this repo, minus the current checkout — naming a
 *  session its own worktree would be a false nudge. */
function worktreeLines(): string[] {
  const cur = gitTry(['rev-parse', '--show-toplevel']).out.trim()
  return parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out)
    .slice(1) // porcelain lists the main worktree first
    .filter((w) => !w.prunable && w.path !== cur)
    .slice(0, 5)
    .map((w) => `worktree ${basename(w.path)} [${w.branch ?? 'detached'}]`)
}

/** Beads claimed but not yet closed — another signal of live work the
 *  flat queue already knows about. Collected from every connector's
 *  parallelWork probe (beads reports claimed tasks today). */
function claimedLines(): string[] {
  try {
    return parallelWorkLines({ dir: process.cwd() })
  } catch {
    return []
  }
}

/** Parallel-session nudge at session start: another live session armed
 *  work here, or the repo carries linked worktrees / claimed beads —
 *  passive context naming what's occupied, never a block. */
function parallelLines(sessionId: string): string[] {
  try {
    const parts: string[] = []
    const dir = hooksStateDir()
    if (dir) {
      parts.push(...liveSessionLines(dir, sessionId))
    }
    parts.push(...worktreeLines())
    parts.push(...claimedLines())
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
        if (/\.(act|drill|work)$/.test(f) && statSync(join(dirname(path), f)).mtimeMs < cutoff) {
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
  const drill = drillLine()
  if (drill) {
    parts.push(drill)
  }
  // sessionStart probes collect from every connector — beads reports
  // the ready queue today; a jira connector would add assigned issues
  parts.push(...sessionStartLines({ dir: process.cwd() }))
  const gate = await actGateLine()
  if (gate) {
    parts.push(gate)
  }
  const debt = debtLine()
  if (debt) {
    parts.push(debt)
  }
  const slot = mergeSlotLine()
  if (slot) {
    parts.push(slot)
  }
  const parallel = parallelLines(sessionId)
  parts.push(...parallel)
  const work = workNudgeLine()
  if (work) {
    parts.push(work)
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
    const gate = await actGateLine({ repo: `${ref.owner}/${ref.repo}`, pr: ref.pr })
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
  // work gate: a session that created/used a worktree must not abandon a
  // dirty one — clean worktrees get a leave-hint instead of a block
  if (armed.has('work')) {
    const gate = workGate()
    if (gate.block) {
      emit({ decision: 'block', reason: gate.block })
      return
    }
    if (gate.hint) {
      hints.push(gate.hint)
    }
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

/** Work-gate outcome for an armed session: a block reason when the current
 *  worktree is linked and dirty, a leave-hint when linked and clean. */
function workGate(): { block?: string; hint?: string } {
  const gd = gitDirOf(process.cwd())
  if (!gd || !isLinkedGitDir(gd)) {
    return {}
  }
  const dirty = dirtyHere()
  if (dirty > 0) {
    return {
      block:
        `bro: linked worktree has ${dirty} uncommitted file(s) — ` +
        'commit/push the work or discard deliberately, then `bro work leave`',
    }
  }
  return { hint: 'bro: still inside a linked worktree — `bro work leave` when done' }
}

/** Current-branch open PR → one-line blocker summary, or null when the PR
 * is clean / not OPEN / unreachable. */
async function prBlockersLine(): Promise<string | null> {
  try {
    const rev = reviewHost(process.cwd(), loadBroConfig().connectors)
    const cur = rev.currentPr()
    if (!cur || cur.state !== 'OPEN') {
      return null
    }
    const act = loadBroConfig().act
    const state = await fetchPrActState(
      rev,
      { repo: rev.resolveRepo([]), pr: cur.pr },
      { ignoreChecks: act.ignoreChecks, maxRounds: act.maxRounds }
    )
    // The same gate `bro act status` enforces: open threads, pending/failed
    // CI and AI reviewers, SAST findings, unknown mergeability, BEHIND.
    const gate = evaluateExitGate(state)
    return gate.ok
      ? null
      : `bro: PR [#${cur.pr}](${cur.url}): ${gate.blockers.join('; ')}`
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
