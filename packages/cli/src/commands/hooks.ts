/**
 * `bro hooks <event>` — agent lifecycle hooks as bro mechanics. Thin
 * `hooks.json` at the plugin root calls this; all policy lives here.
 *
 *   session-start | post-compaction | pre-compact
 *                                       rehydrate: beads ready + drill frame + PR gate + debt
 *   prompt-submit                     drill-frame reminder; PR URL → act snapshot
 *   post-tool                         exec nudges: gh pr create → act gate; merge → debt sweep
 *   stop                              block while a drill frame or review threads are open
 *   permission                        auto-approve bro/bd invocations
 *
 * Contract: read the event payload on stdin, print hook control JSON on
 * stdout, exit 0. Everything is best-effort — hooks only fire in bro-enabled
 * repos (bro.config.json or .beads/ walking up) and every probe is wrapped so
 * a missing bd/gh or a dead network can never stall the session.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ghJson, resolveRepo } from '@bro/core'
import { evaluateExitGate, fetchPrActState } from '@bro/act'
import { bdJson, currentFrame } from '@bro/drill'
import { readDebtRecords } from '@bro/debt'

interface HookInput {
  tool_input?: { command?: unknown }
  tool_response?: { success?: unknown }
  prompt?: unknown
  stop_hook_active?: unknown
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
    const state = await fetchPrActState({ owner: o!, repo: r!, pr: n! })
    const gate = evaluateExitGate(state)
    return gate.ok
      ? `pr #${state.pr}: gate OK`
      : `pr #${state.pr}: gate BLOCKED (${gate.blockers.join('; ')}) — \`bro act status\``
  } catch {
    return null
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
 * stay open. Respects stop_hook_active so a blocked stop can't loop. */
async function emitStopGate(input: HookInput): Promise<void> {
  if (input.stop_hook_active === true) {
    return
  }
  const drill = drillLine()
  if (drill) {
    emit({ decision: 'block', reason: `bro: ${drill}` })
    return
  }
  try {
    const view = ghJson<{ number: number; state: string }>(['pr', 'view', '--json', 'number,state'])
    if (view.state !== 'OPEN') {
      return
    }
    const parts = repoParts()
    if (!parts) {
      return
    }
    const [owner, repoName] = parts
    const state = await fetchPrActState({ owner, repo: repoName!, pr: view.number })
    // Open threads OR a still-running AI reviewer — the reviewer can open
    // threads after we stop, so pending counts as unfinished review.
    const blockers: string[] = []
    if (state.openThreads > 0) {
      blockers.push(`${state.openThreads} unresolved review thread(s)`)
    }
    if (state.reviewersPending > 0) {
      blockers.push(`${state.reviewersPending} AI reviewer(s) still running`)
    }
    if (blockers.length > 0) {
      emit({
        decision: 'block',
        reason:
          `bro: PR #${view.number}: ${blockers.join('; ')} — ` +
          'list with `bro act threads`, fix or reply, then resolve; recheck `bro act status`',
      })
    }
  } catch {
    // no repo/PR/auth — nothing to gate on
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
