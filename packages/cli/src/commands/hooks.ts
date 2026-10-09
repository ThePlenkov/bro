/**
 * `bro hooks <event>` — agent lifecycle hooks as bro mechanics. Thin
 * `hooks.json` at the plugin root calls this; all policy lives here.
 *
 *   session-start | post-compaction | pre-compact
 *                                       rehydrate: connector probes — beads ready,
 *                                       drill frame, PR gate, debt, merge slot, work nudge
 *   prompt-submit                     connector prompt probes — drill-frame reminder;
 *                                       the review host parses its own PR URLs → act snapshot
 *   pre-tool                          connector preTool verdicts — the guard plane:
 *                                       first block vetoes the call, input overrides merge
 *   post-tool                         exec nudges: gh pr create → act gate; merge → debt sweep;
 *                                       first mutating bro subcommand per session cites its
 *                                       governing skill (skills/<name>/SKILL.md); arms the
 *                                       stop gate for this session (bro act/drill/
 *                                       work, gh pr, git push, worktree add, bd --claim) via a
 *                                       per-session marker in .git; connector postTool probes
 *                                       run on every event — notify drains the session mailbox
 *   stop                              connector GateContributions — each system reports
 *                                       unfinished work; the hook blocks only aspects this
 *                                       session armed, ambient state is passive context
 *   permission                        auto-approve bro/bd invocations
 *   install | uninstall               (git-hook ops, not events) write/remove the
 *                                       git shims: prepare-commit-msg provenance
 *                                       (specs/bro-fzot.md) + reference-transaction
 *                                       shared-branch ref guard (specs/bro-1c78.md)
 *                                       + post-merge dep-graph freshness
 *                                       (specs/bro-sovl3.md)
 *   prepare-commit-msg                git-hook entrypoint — appends Agent/Agent-Model/
 *                                       Session/Bead/Molecule trailers to the message file
 *   reference-transaction             git-hook entrypoint — vetoes non-fast-forward
 *                                       moves of refs/heads/* by ref-mover verbs
 *                                       (reset/fetch/update-ref/branch/checkout/switch)
 *   post-merge                        git-hook entrypoint — dispatches the detached
 *   post-merge-run                      refresh worker: install (dep manifests moved in
 *                                       the merge) → build → machine patch slot
 *
 * Contract: read the event payload on stdin, print hook control JSON on
 * stdout, exit 0. Everything is best-effort — hooks only fire in bro-enabled
 * repos (bro.config.json or .beads/ walking up) and every connector probe is
 * fail-open so a missing bd/gh or a dead network can never stall the session.
 *
 * Cursor's stdin (`cursor_version` / `hook_event_name`) is translated at
 * this edge: `conversation_id` → session id, `loop_count > 0` →
 * `stop_hook_active`, successful `postToolUse` → `tool_response.success`.
 * Stdout becomes `additional_context`, `followup_message`, or `permission`.
 * Cloud agents do not fire sessionStart, so the first Cursor prompt
 * rehydrates once; preCompact clears that mark.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as nodeSetTimeout } from 'node:timers'
import {
  acquireFileLock,
  parallelWorkProbe,
  postToolLines,
  preToolVerdicts,
  promptContextLines,
  repoOptedIn,
  sessionStartProbe,
  stopGateContributions,
  unrefPendingChildren,
  withFileLock,
} from '@broject/core'
import type { ProbeReporter, ProbeResult, ProbeTiming } from '@broject/core'
import { markerLive, ownerTag } from './proc-owner.ts'
import { runGuards, type GuardConfig, type GuardJudgeInput } from '@broject/guard'
import { GUARD_PROBES } from '../guard-probes.ts'
import { appendRow, judgeConfig, judgeFacade } from '@broject/judge'
import {
  hooksDir,
  previousTraceFile,
  readTraceTail,
  relativize,
  sessionContextText,
} from '@broject/learn'
import type { MatchContext } from '@broject/learn'
import type { GuardEvent } from '@broject/core'
import { loadBroConfig } from '../plugins.ts'
import {
  cliVersion,
  emitCommitTrailers,
  installCommitHook,
  installPostMergeHook,
  installRefGuardHook,
  uninstallCommitHook,
  uninstallPostMergeHook,
  uninstallRefGuardHook,
  type InstallResult,
} from './githooks.ts'
import { emitPostMerge, runPostMergeRefresh } from './postmerge.ts'
import { emitRefGuard } from './refguard.ts'
import { goalContextLines, goalStopLines } from './goal.ts'
import {
  CURSOR_HYDRATED_SKILL,
  cursorStopIgnored,
  cursorToHookInput,
  cursorWorkspaceRoots,
  isCursorHookPayload,
  toCursorHookOutput,
} from '../cursor-hook.ts'

interface HookInput {
  tool_name?: unknown
  tool_input?: {
    command?: unknown
    file_path?: unknown
    path?: unknown
    files?: unknown
  }
  tool_response?: { success?: unknown }
  prompt?: unknown
  stop_hook_active?: unknown
  session_id?: unknown
}

/** A repo opts in to bro hooks with any bro.config.* file or a .beads/
 *  dir — the local layer counts too (spec: specs/bro-9vmx.md). Shared
 *  with pi's spawn gate via core's repoOptedIn so the two never drift. */
const broEnabled = repoOptedIn

function readRaw(): unknown {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) as unknown
  } catch {
    return {}
  }
}

function asHookInput(raw: unknown): HookInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }
  return raw as HookInput
}

/** Set for the life of this process when stdin is a Cursor payload.
 * Each hook invocation is its own process. */
let cursorClient = false

/** Codex adds `turn_id` to every hook payload. Devin and Claude do not,
 * so permission and pre-tool answers stay on their legacy shapes unless
 * this is set. */
let codexClient = false

function emit(out: unknown): void {
  const payload = cursorClient ? toCursorHookOutput(out) : out
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function isAbsoluteProject(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

/** Cursor plugin hooks run with cwd = the open folder, which is not
 * always the workspace root. Prefer `CURSOR_PROJECT_DIR`, then cwd,
 * then `workspace_roots` — the first absolute path that walks up to a
 * bro-enabled repo. Non-Cursor hosts keep the Devin/cwd rule. */
function hookProjectDir(raw: unknown): string {
  if (!cursorClient) {
    return process.env.DEVIN_PROJECT_DIR ?? process.cwd()
  }
  const candidates = [
    process.env.CURSOR_PROJECT_DIR,
    process.cwd(),
    ...cursorWorkspaceRoots(raw),
  ]
  for (const c of candidates) {
    if (c && isAbsoluteProject(c) && broEnabled(c)) {
      return c
    }
  }
  return process.env.DEVIN_PROJECT_DIR ?? process.cwd()
}

function context(event: string, text: string): void {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })
}

const CODEX_INSTRUCTIONS = 'plugins/codex/bro/INSTRUCTIONS.md'

/** Codex session steer. The plugin file is the source; a missing root
 *  or an unreadable file stays silent so the hook cannot fail closed. */
export function readCodexInstructions(pluginRoot: string | undefined): string | undefined {
  if (pluginRoot === undefined || !isAbsolute(pluginRoot)) {
    return undefined
  }
  try {
    const text = readFileSync(join(pluginRoot, CODEX_INSTRUCTIONS), 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
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
 * `bd worktree create`), bead claims arm the task gate (`bd … --claim`,
 * `bro work enter` — it claims the bead it enters).
 * Global flags between binary and subcommand are allowed (`gh -R o/r pr`,
 * `git -C path push`); the binary must sit at a command position — string
 * start or after `;`, `&`, `|`, or a newline (leading whitespace is fine).
 * The set is open — connectors may contribute gates under their own
 * aspect names; arming patterns for those live where they're owned. */
export type GateAspect = 'act' | 'drill' | 'work' | 'task'

export function classifyArmCommand(cmd: string): GateAspect | null {
  const c = unquoted(cmd)
  const at = '(^|[;&|\\n])\\s*'
  const bro = '(?:bro|npx\\s+(?:-y\\s+)?@broject/bro(?:@[\\w.:-]+)?)'
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
  // claiming a bead arms 'task' — the session owes the claim a
  // close/release, and the gate binds the claimer, not every work user
  if (new RegExp(`${at}bd\\b[^;&|\\n]*--claim\\b`).test(c)) {
    return 'task'
  }
  return null
}

/** All aspects a command arms — classifyArmCommand's primary plus
 *  side-effects: `bro work enter <bead>` claims that bead, so it arms
 *  'task' on top of 'work'. */
export function classifyArmCommands(cmd: string): GateAspect[] {
  const out = new Set<GateAspect>()
  const primary = classifyArmCommand(cmd)
  if (primary) {
    out.add(primary)
  }
  const c = unquoted(cmd)
  const bro = '(?:bro|npx\\s+(?:-y\\s+)?@broject/bro(?:@[\\w.:-]+)?)'
  if (new RegExp(`(^|[;&|\\n])\\s*${bro}\\s+work\\s+enter\\b`).test(c)) {
    out.add('task')
  }
  return [...out]
}

// --- governing-skill citation ---------------------------------------------------
//
// Skills load on user triggers (/act, bro: pings) — a mid-flow
// `bro act resolve` shell call never reads the document that governs it
// (retro bro-cj0). The first mutating subcommand per session names its
// governing skill so policy reaches the point of use. Reads never cite:
// the hint exists because prose misses mutations, not because bro ran.

/** plugin name → mutating verbs (the verb is the first token after the
 *  subcommand; reads like status/list/threads are absent by design). */
const MUTATION_VERBS: Record<string, ReadonlySet<string>> = {
  act: new Set(['resolve', 'reply', 'merge']),
  drill: new Set(['down', 'up', 'distill']),
  retrospect: new Set(['capture', 'record']),
  debt: new Set(['collect', 'mark', 'set', 'sync']),
  work: new Set(['enter', 'leave', 'prune']),
  convoy: new Set(['pour', 'claim', 'done']),
  spec: new Set(['new']),
}

/** plugin → skill where the cited name differs from argv[0] —
 *  aliases (unwind → drill) and shared skills (retrospect → wtf). */
const PLUGIN_SKILL: Record<string, string> = {
  retrospect: 'wtf',
  wtf: 'wtf',
  unwind: 'drill',
  spec: 'sdd',
}

/** Plugins whose bare invocation mutates — `next` claims the top bead,
 *  `loop` runs claim→agent→gate→close, `sync` writes the data ref,
 *  `unwind` is `drill up`. A listed read flag suppresses the hint. */
const BARE_MUTATIONS = new Set(['next', 'loop', 'sync', 'unwind'])
const BARE_READ_FLAGS: Record<string, RegExp> = {
  next: /--list\b/,
  loop: /--dry-run\b/,
}

/** Verbs that mutate only under a flag — `act wait` reads until
 *  --merge/--cleanup, `debt next` lists until --claim CAS-claims. */
const FLAG_MUTATIONS: Record<string, Record<string, RegExp>> = {
  act: { wait: /--(?:merge|cleanup)\b/ },
  debt: { next: /--claim\b/ },
}

/** One `bro <plugin> <verb>` invocation → the cite it earns, or null for
 *  a read. Per-plugin quirks live here so the matchAll scan stays flat:
 *  `wtf` is bare-status vs arg-capture, flag-verbs read unless their
 *  mutation flag is present, bare mutations read only under a listed flag. */
function mutationCite(
  plugin: string,
  verb: string | undefined,
  rest: string,
  cmd: string
): { plugin: string; skill: string } | null {
  const cite = { plugin, skill: PLUGIN_SKILL[plugin] ?? plugin }
  // `bro wtf <arg>` captures; bare `bro wtf` reports status. Quoted args
  // are stripped from `c`, so an empty rest falls back to spotting the
  // quote in the raw command — the real command position is proven.
  if (plugin === 'wtf') {
    return verb !== undefined || /wtf\s+["']/.test(cmd) ? cite : null
  }
  const verbs = MUTATION_VERBS[plugin]
  if (verbs) {
    const flagRe = FLAG_MUTATIONS[plugin]?.[verb ?? '']
    const hit = flagRe ? flagRe.test(rest) : verb !== undefined && verbs.has(verb)
    return hit ? cite : null
  }
  return BARE_MUTATIONS.has(plugin) && !BARE_READ_FLAGS[plugin]?.test(rest)
    ? cite
    : null
}

/** The mutating `bro <cmd>` in a shell command → { plugin, skill } to
 *  cite, or null for reads/other tools. Command position is proven on
 *  the quote-stripped text; the verb comes from the same text (verbs are
 *  bare words — quoting only ever hides argument values). */
export function classifySkillMutation(
  cmd: string
): { plugin: string; skill: string } | null {
  const c = unquoted(cmd)
  // non-capturing position group — m[1] must stay the plugin name
  const at = String.raw`(?:^|[;&|\n])\s*`
  const bro = String.raw`(?:bro|npx\s+(?:-y\s+)?@broject/bro(?:@[\w.:-]+)?)`
  // chained commands may carry several bro calls — the first mutation wins
  for (const m of c.matchAll(new RegExp(String.raw`${at}${bro}\s+([a-z]+)\b`, 'g'))) {
    // the command segment ends at the next separator — a later segment's
    // flags must not turn this read into a mutation
    const rest = /[^;&|\n]*/.exec(c.slice(m.index + m[0].length))?.[0] ?? ''
    const cite = mutationCite(m[1]!, /\S+/.exec(rest)?.[0], rest, cmd)
    if (cite) {
      return cite
    }
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
    /^\s*npx\s+(-y\s+)?@broject\/bro(@[\w.:-]+)?(\s|$)/.test(cmd)
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
 *  Markers carry `<millis> [<owner-pid> <start>]\n<detail>`; an owned
 *  marker is live while its owner pid is (idle sessions past the
 *  window stay claimed), an ownerless marker falls back to mtime
 *  within LIVE_SESSION_MS, and a 7-day-old marker is always residue. */
export function otherLiveWork(
  dir: string,
  selfId: string,
  now: number = Date.now()
): Array<{ session: string; detail: string; ageMs: number }> {
  const out: Array<{ session: string; detail: string; ageMs: number }> = []
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
      const lines = readFileSync(path, 'utf8').split('\n')
      if (!markerLive(lines[0], st.mtimeMs, LIVE_SESSION_MS, now)) {
        continue
      }
      const detail = lines[1]?.trim() ?? ''
      // leave/list/remove leave detail-less markers — every work-CREATING
      // command carries a detail, so '' reliably means residue, not work
      if (!detail) {
        continue
      }
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
async function parallelLines(sessionId: string, onProbe?: ProbeReporter): Promise<ProbeResult> {
  try {
    const parts: string[] = []
    const dir = hooksStateDir()
    if (dir) {
      parts.push(...liveSessionLines(dir, sessionId))
    }
    const work = await parallelWorkProbe({ dir: process.cwd(), sessionId }, onProbe)
    parts.push(...work.lines)
    if (parts.length === 0) {
      return { lines: [], settled: work.settled }
    }
    return {
      lines: [
        'parallel work detected in this repo:',
        ...parts.map((p) => `  ${p}`),
        '  → for new work prefer `bro work enter <slug>` — a separate worktree, not this checkout',
      ],
      settled: work.settled,
    }
  } catch {
    // detection is passive — a probe failure must not break rehydrate,
    // but the sweep did not settle, so hydration may retry
    return { lines: [], settled: false }
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
  if (aspect === 'task') {
    // the claimed bead id — `bd update bro-x --claim`, `bro work enter bro-x`
    const m = /\b([a-z]+-[\w.]+)\b/i.exec(c)
    return m ? m[1]! : ''
  }
  if (aspect === 'work') {
    const enter = /\bwork\s+enter\s+(\w[\w.-]*)/.exec(c)
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
    // line 2+ are the arming details (slug/branch/PR/bead) — accumulated
    // so a session claiming two beads keeps both
    let rest = ''
    try {
      rest = readFileSync(path, 'utf8').split('\n').slice(1).join('\n')
    } catch {
      // fresh marker — no details yet
    }
    // line 1 re-stamps `<millis> [<owner-pid> <start>]` on every arm —
    // the owner pair lets readers prove the session is alive instead of
    // trusting mtime, and a resumed session must not keep its previous
    // dead owner (the marker would read as residue while it still works)
    let body = `${Date.now()}${ownerTag()}\n${rest}`
    if (detail && !body.split('\n').includes(detail)) {
      body = `${body.replace(/\n?$/, '\n')}${detail}\n`
    }
    // a .work arm writes under the shared occupancy lock — `bro drive`
    // holds it across its occupancy-check→spawn section, so this marker
    // lands before the driver's probe or after the action, never
    // between (bro-qry9). The wait is the standard lock bound — long
    // enough to cover a real driver's hold, so the write-anyway
    // fallback only fires on a pathological holder (the marker is the
    // session record; dropping it loses the arm entirely).
    let release: () => void = () => {}
    if (aspect === 'work') {
      try {
        release = acquireFileLock(
          join(dirname(dirname(path)), 'agents.json.lock'),
          { label: 'occupancy lock' }
        )
      } catch {
        // held past the bound — write anyway; the marker is the record
      }
    }
    try {
      writeFileSync(path, body)
    } finally {
      release()
    }
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

/** Hinted-skill markers live in a `hinted/` subdir of the hooks state
 *  dir — `readArmed` scans `<session>.*` files as gate aspects, so dedup
 *  state must not sit flat beside the arming markers. */
function hintedPath(sessionId: string, skill: string): string | null {
  const dir = hooksStateDir()
  const safe = sessionId.replace(/[^\w.-]/g, '_')
  return dir && safe ? join(dir, 'hinted', `${safe}.${skill}`) : null
}

/** True when this session was already pointed at the skill — a marker
 *  younger than MARKER_TTL_MS counts; older re-hints (a week-old session
 *  is a new session). */
function skillHinted(sessionId: string, skill: string): boolean {
  const path = hintedPath(sessionId, skill)
  if (!path) {
    return false
  }
  try {
    return statSync(path).mtimeMs >= Date.now() - MARKER_TTL_MS
  } catch {
    return false
  }
}

function markSkillHinted(sessionId: string, skill: string): void {
  try {
    const path = hintedPath(sessionId, skill)
    if (!path) {
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    // exclusive create — concurrent post-tool hooks in the same session
    // both see no marker; only the first write wins, the loser's EEXIST
    // skips the prune too
    try {
      writeFileSync(path, `${Date.now()}\n`, { flag: 'wx' })
    } catch {
      return
    }
    // hinted/ sits below the dir armSession prunes, so stale markers
    // need their own sweep — same TTL, same best-effort
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
    // hinting is best-effort — a failed marker must never stall the hook
  }
}

// --- session trace journal ------------------------------------------------------
//
// The learn connector's evidence plane: emitPostTool appends one JSONL
// line per event to `<git-common>/bro/hooks/trace/<session>.jsonl` —
// `{ts, tool, command?, paths?, ok}`. The journal lives in a `trace/`
// SUBDIR, never flat beside the markers: readArmed scans `<session>.*`
// files as gate aspects, so a flat `<session>.trace.jsonl` would arm a
// phantom `trace.jsonl` aspect on every post-tool event (same rule as
// `hinted/`). Fields the payload lacks stay absent from the line.

/** One trace entry from a post-tool payload — the fields each tool
 *  family actually carries (`command` on exec, `file_path`/`path` on
 *  edit/write, `files` where present). */
export function traceEntry(
  input: HookInput,
  ts: number = Date.now()
): Record<string, unknown> {
  const entry: Record<string, unknown> = { ts }
  if (typeof input.tool_name === 'string' && input.tool_name !== '') {
    entry.tool = input.tool_name
  }
  const ti = input.tool_input
  if (typeof ti?.command === 'string') {
    entry.command = ti.command
  }
  const paths = [
    ...(typeof ti?.file_path === 'string' ? [ti.file_path] : []),
    ...(typeof ti?.path === 'string' ? [ti.path] : []),
    ...(Array.isArray(ti?.files)
      ? ti.files.filter((f): f is string => typeof f === 'string')
      : []),
  ]
  if (paths.length > 0) {
    entry.paths = paths
  }
  if (typeof input.tool_response?.success === 'boolean') {
    entry.ok = input.tool_response.success
  }
  return entry
}

/** `<git-common>/bro/hooks/trace/<session>.jsonl` — null without a git
 *  dir or session id (untraceable events degrade to nothing). */
function traceFile(sessionId: string): string | null {
  const dir = hooksStateDir()
  const safe = sessionId.replace(/[^\w.-]/g, '_')
  return dir && safe ? join(dir, 'trace', `${safe}.jsonl`) : null
}

/** Journal bound — a long session must not grow a file every probe
 *  rereads whole. MAX_BYTES is the trim trigger, not a size cap: past
 *  it the oldest lines drop and the keep window (KEEP_LINES) stays well
 *  beyond the connector's tail read (100 lines). Entries carry no size
 *  limit, so the trimmed file can still sit above MAX_BYTES. */
const TRACE_JOURNAL_MAX_BYTES = 256 * 1024
const TRACE_JOURNAL_KEEP_LINES = 500

/** Append the post-tool event to this session's journal, bound it, and
 *  — only on the session's first event — prune trace files past the
 *  marker TTL. The journal shares the arming markers' per-session
 *  lifecycle, but a weekly TTL doesn't need a per-event dir scan: a new
 *  journal is the once-per-session tick that sweeps residue. Best-effort
 *  like arming: a failed append must never stall the hook. */
function journalTrace(input: HookInput, sessionId: string): void {
  try {
    const path = traceFile(sessionId)
    if (!path) {
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    const fresh = !existsSync(path)
    // append + cap-check + trim is one critical section: concurrent
    // post-tool hooks are separate processes, and an append landing
    // between the snapshot read and the rewrite would be silently
    // discarded. Best-effort — a lock timeout degrades to the plain
    // append, never a stalled hook.
    const append = (): void => {
      appendFileSync(path, `${JSON.stringify(traceEntry(input))}\n`)
      if (statSync(path).size > TRACE_JOURNAL_MAX_BYTES) {
        const kept = readFileSync(path, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .slice(-TRACE_JOURNAL_KEEP_LINES)
        writeFileSync(path, `${kept.join('\n')}\n`)
      }
    }
    try {
      withFileLock(`${path}.lock`, append, {
        waitMs: 2_000,
        label: 'trace journal lock',
      })
    } catch {
      append()
    }
    if (!fresh) {
      return
    }
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
    // journaling must never stall a session
  }
}

// --- perf journal --------------------------------------------------------------

/** One perf row — a per-probe timing (`probe` set) or the event total
 *  (`probes` set, no probe). Same journal discipline as trace/: locked
 *  append, bounded file, prune on first write, fail-open. */
interface PerfRow extends ProbeTiming {
  ts: number
  event: string
  probe?: string
  /** Total-row marker: how many probe rows the event produced. */
  probes?: number
}

/** `<git-common>/bro/hooks/perf/<session>.jsonl` — null without a git
 *  dir or session id, same as the trace journal. */
function perfFile(sessionId: string): string | null {
  const dir = hooksStateDir()
  const safe = sessionId.replace(/[^\w.-]/g, '_')
  return dir && safe ? join(dir, 'perf', `${safe}.jsonl`) : null
}

/** Buffer for the current dispatch — rows land here via probeReporter
 *  and flush once at event end: one locked write per hook, not one
 *  per probe. */
let perfBuf: PerfRow[] | null = null

/** Build the collector's callback: stamps probe + event onto each
 *  timing row and buffers it for the event-end flush. */
function probeReporter(event: string, probe: string): ProbeReporter {
  return (rows) => {
    if (!perfBuf) {
      return
    }
    const ts = Date.now()
    for (const r of rows) {
      perfBuf.push({ ts, event, probe, ...r })
    }
  }
}

/** Locked bounded append shared by the trace/perf/commands journals —
 *  append + cap-check + trim is one critical section (concurrent hooks
 *  are separate processes); a lock timeout degrades to the plain
 *  append, never a stall. */
function appendJournal(path: string, line: string, waitMs = 2_000): void {
  mkdirSync(dirname(path), { recursive: true })
  const append = (): void => {
    appendFileSync(path, line)
    if (statSync(path).size > TRACE_JOURNAL_MAX_BYTES) {
      const kept = readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .slice(-TRACE_JOURNAL_KEEP_LINES)
      writeFileSync(path, `${kept.join('\n')}\n`)
    }
  }
  try {
    withFileLock(`${path}.lock`, append, { waitMs, label: 'journal lock' })
  } catch {
    append()
  }
}

/** Journal one CLI invocation — `<git-common>/bro/hooks/perf/
 *  commands.jsonl`, a shared repo-wide file (commands aren't
 *  sessions). Called from `process.on('exit')` in the CLI entry:
 *  synchronous, one git spawn + one locked append (~10–20ms),
 *  fail-open — telemetry must never change an exit code. */
export function journalCommand(cmd: string, ms: number, exitCode: number): void {
  try {
    if (process.env.BRO_TELEMETRY === '0') {
      return
    }
    const dir = hooksStateDir()
    if (dir === null) {
      return
    }
    const row: PerfRow = {
      ts: Date.now(),
      event: 'cmd',
      probe: 'run',
      connector: cmd,
      ms,
      ...(exitCode !== 0 ? { failed: true as const } : {}),
    }
    // waitMs 0: a contended lock must not stall the exit handler —
    // the fallback plain append lands the line without the cap check.
    appendJournal(join(dir, 'perf', 'commands.jsonl'), `${JSON.stringify(row)}\n`, 0)
  } catch {
    // telemetry must never stall or fail the caller
  }
}

/** Flush the buffered rows plus the event total to the session's perf
 *  journal. Called in a finally — a hook that threw still reports the
 *  time it burned. */
function flushPerf(sessionId: string, event: string, t0: number): void {
  try {
    const path = perfFile(sessionId)
    if (!path || !perfBuf) {
      return
    }
    const rows = perfBuf
    perfBuf = null
    rows.push({ ts: Date.now(), event, ms: Date.now() - t0, connector: '', probes: rows.length })
    const fresh = !existsSync(path)
    appendJournal(
      path,
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
    )
    if (fresh) {
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
    }
  } catch {
    // perf must never stall a session
  }
}

// --- event handlers -----------------------------------------------------------

/** Trace tail for this session — the MatchContext's structured half.
 *  No hooks dir or session id means an empty tail, never a throw. */
function sessionTail(sessionId: string): { entries: ReturnType<typeof readTraceTail>['entries']; raw: string } {
  const path = traceFile(sessionId)
  return path === null ? { entries: [], raw: '' } : readTraceTail(path)
}

/** `sessionContextText` costs a cold bd/dolt handshake plus git spawns —
 *  1.5–2s built fresh — but carries only advisory claims/branch state that
 *  barely moves inside a turn. A 30s per-(dir,session) file cache
 *  collapses repeat builds across hook invocations (session-start's guard
 *  mctx → the next stop's goal context read the same answers). Never fed
 *  to gate contributions — the stop gate always probes live. */
const CONTEXT_CACHE_TTL_MS = 30_000

function cachedContextRead(file: string): string | undefined {
  try {
    const row = JSON.parse(readFileSync(file, 'utf8')) as { ts?: number; text?: string }
    if (
      typeof row.ts === 'number' &&
      typeof row.text === 'string' &&
      Date.now() - row.ts < CONTEXT_CACHE_TTL_MS
    ) {
      return row.text
    }
  } catch {
    // torn or absent cache — recompute
  }
  return undefined
}

function cachedContextWrite(file: string, text: string, t0: number): void {
  try {
    const existing = JSON.parse(readFileSync(file, 'utf8')) as { ts?: number }
    if (typeof existing.ts === 'number' && existing.ts >= t0) {
      return
    }
  } catch {
    // absent/torn — proceed to write
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    // tmp+rename — a torn write never poisons a later reader
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ts: Date.now(), text }))
    renameSync(tmp, file)
    // opportunistic sweep — past-TTL entries are garbage anyway
    for (const f of readdirSync(dirname(file))) {
      try {
        if (
          f.startsWith('ctx-') &&
          statSync(join(dirname(file), f)).mtimeMs < Date.now() - CONTEXT_CACHE_TTL_MS
        ) {
          rmSync(join(dirname(file), f))
        }
      } catch {
        // sweep is best-effort
      }
    }
  } catch {
    // caching is best-effort — a failed write degrades to recompute
  }
}

async function sessionContextTextCached(dir: string, sessionId: string): Promise<string> {
  const base = hooksStateDir()
  const file =
    base === null
      ? null
      : join(
          base,
          'cache',
          `ctx-${createHash('sha256').update(`${dir}|${sessionId}`).digest('hex').slice(0, 16)}.json`
        )
  if (file !== null) {
    const hit = cachedContextRead(file)
    if (hit !== undefined) {
      return hit
    }
  }
  // t0 before the build: a concurrent hook that finished first wrote a
  // FRESHER snapshot — never overwrite it with this older one
  const t0 = Date.now()
  const text = await sessionContextText({ dir, sessionId })
  if (file !== null) {
    cachedContextWrite(file, text, t0)
  }
  return text
}

/** Soft-bound an advisory read — the value joins a hook's output budget,
 *  so an unbounded build must degrade to undefined, never stretch the
 *  event past the probe budget it bypasses. */
function boundedMs<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((r) => nodeSetTimeout(() => r(undefined), ms).unref()),
  ])
}

/** One guard-engine call per emit path (spec: bro-nkn6). Declarations
 *  resolve here — connectors only contribute `guards()`, evaluation is
 *  centralized. Fail-open like every probe: a wedged engine emits
 *  nothing rather than stall a hook. */
async function guardLines(
  event: GuardEvent,
  sessionId: string,
  mctx: () => Promise<MatchContext>
): Promise<string[]> {
  try {
    const dir = process.cwd()
    const cfg = (loadBroConfig(dir) as Record<string, unknown>).guard as GuardConfig
    const run = await runGuards({
      dir,
      sessionId,
      event,
      mctx,
      defs: cfg.defs,
      cfg,
      record: true,
      armed: () => readArmed(sessionId),
      probes: GUARD_PROBES,
      // the veto seam — resolved lazily and only when a judge-clause
      // guard's deterministic clauses pass. mode:'off' abstains here;
      // mode:'shadow' decides + journals kind:'guard' verdicts
      judge: () => {
        const jcfg = judgeConfig(dir).judge
        if (jcfg.mode !== 'shadow') {
          return undefined
        }
        const input: GuardJudgeInput = {
          facade: judgeFacade(dir),
          confidence: jcfg.confidence,
          maxDecisions: jcfg.maxDecisionsPerRun,
          journal: (v) => appendRow(dir, v),
        }
        return input
      },
    })
    return run.lines
  } catch {
    return []
  }
}

async function emitSessionContext(
  event: 'SessionStart' | 'PostCompaction' | 'PostCompact' | 'PreCompact',
  sessionId = '',
  cliEvent: string = event
): Promise<boolean> {
  // sessionStart probes collect from every connector — beads reports
  // the ready queue, drill the open frame, act the PR gate + merge slot,
  // debt the open findings; a jira connector would add assigned issues
  // probes and the guard sweep are independent reads — overlapping them
  // keeps the hook total at the slowest single probe, not their sum
  // (spec: specs/bro-wc0i6.md)
  const [start, par, guards] = await Promise.all([
    sessionStartProbe({ dir: process.cwd(), sessionId }, probeReporter(cliEvent, 'sessionStart')),
    parallelLines(sessionId, probeReporter(cliEvent, 'parallelWork')),
    guardLines('session-start', sessionId, async () => {
      const dir = process.cwd()
      const hooks = hooksDir(dir)
      const prev = hooks !== null && sessionId !== '' ? previousTraceFile(hooks, sessionId) : null
      const tail = prev !== null ? readTraceTail(prev) : { entries: [], raw: '' }
      return {
        text: `${await sessionContextTextCached(dir, sessionId)}\n${tail.raw}`,
        trace: relativize(dir, tail.entries),
      }
    }),
  ])
  const parts = [...start.lines, ...par.lines]
  // the session's active goal rehydrates like every other durable state —
  // resume/compaction restores it (spec: specs/goal/bro-6vcll.md)
  parts.push(...goalContextLines(process.cwd(), sessionId))
  // 'session-start' covers all three rehydrate events; the match
  // haystack is the same session-context text + previous-session trace
  // tail the learn connector assembles
  parts.push(...guards)
  if (codexClient && (event === 'SessionStart' || event === 'PostCompact')) {
    const steer = readCodexInstructions(process.env.PLUGIN_ROOT)
    if (steer) {
      parts.push(steer)
    }
  }
  if (parts.length > 0) {
    context(event, `bro state — resume from here:\n${parts.join('\n')}`)
  }
  return start.settled && par.settled
}

async function emitPromptContext(input: HookInput): Promise<void> {
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const parts: string[] = []
  // Cloud agents never fire sessionStart. The first prompt carries that
  // rehydration; a later prompt does not repeat it. preCompact drops the
  // mark so the summary's successor turn loads fresh state. Mark only
  // after the probes return — a throw retries next prompt.
  const hydrate = cursorClient && sessionId && !skillHinted(sessionId, CURSOR_HYDRATED_SKILL)
  let settled = true
  // hydrate probes, prompt probes, and the guard sweep are independent
  // reads — one parallel flight, emission order unchanged below
  const [hydratePair, promptLines, guards] = await Promise.all([
    hydrate
      ? Promise.all([
          sessionStartProbe(
            { dir: process.cwd(), sessionId },
            probeReporter('prompt-submit', 'sessionStart')
          ),
          parallelLines(sessionId, probeReporter('prompt-submit', 'parallelWork')),
        ])
      : undefined,
    promptContextLines(
      { dir: process.cwd(), sessionId },
      prompt,
      probeReporter('prompt-submit', 'promptSubmit')
    ),
    // guards on prompt-submit: match.terms sees the raw prompt, trace
    // keys see this session's tail, state sees the live repo
    guardLines('prompt-submit', sessionId, async () => {
      const dir = process.cwd()
      const tail = sessionTail(sessionId)
      return { text: prompt, trace: relativize(dir, tail.entries) }
    }),
  ])
  if (hydratePair) {
    const [start, par] = hydratePair
    parts.push(...start.lines, ...par.lines)
    // Cursor's session-start runs here (cloud agents never fire
    // SessionStart) — the goal line must hydrate on this path too
    parts.push(...goalContextLines(process.cwd(), sessionId))
    settled = start.settled && par.settled
  }
  const sessionCount = parts.length
  parts.push(...promptLines, ...guards)
  // a timed-out or thrown probe masquerades as "no state" — mark only
  // when every probe answered, else the marker suppresses a retry for
  // the marker's whole TTL
  if (hydrate && settled) {
    markSkillHinted(sessionId, CURSOR_HYDRATED_SKILL)
  }
  if (parts.length === 0) {
    return
  }
  const text =
    sessionCount > 0 ? `bro state — resume from here:\n${parts.join('\n')}` : parts.join('\n')
  context('UserPromptSubmit', text)
}

async function emitPostTool(input: HookInput): Promise<void> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const lines: string[] = []
  // journal before the probes run — a lesson triggered on this exact
  // tool landing must see its own trace line in the same event
  journalTrace(input, sessionId)
  if (input.tool_response?.success === true) {
    const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
    const aspects = classifyArmCommands(cmd)
    if (sessionId) {
      for (const aspect of aspects) {
        armSession(sessionId, aspect, armDetail(cmd, aspect))
      }
    }
    // a mutating bro subcommand cites its governing skill once per session —
    // the SKILL.md never loads on a bare CLI call (bro-d8s)
    const mutation = classifySkillMutation(cmd)
    if (mutation && sessionId && !skillHinted(sessionId, mutation.skill)) {
      markSkillHinted(sessionId, mutation.skill)
      lines.push(
        `bro ${mutation.plugin} mutations are governed by the ${mutation.skill} skill ` +
          `— read skills/${mutation.skill}/SKILL.md before continuing`
      )
    }
    switch (classifyExecCommand(cmd)) {
      case 'pr-merge':
        lines.push('PR merged — sweep review debt with `bro debt collect`; queue: `bro debt prs`')
        break
      case 'pr-create':
        lines.push(
          'PR created — `bro act status` is the review gate; `bro act threads` lists open threads'
        )
        break
      default:
    }
  }
  // connector postTool probes run on every event — a failed exec is
  // still a delivery tick for a drained mailbox (notify). Guards read
  // the same journaled tail — one parallel flight with the probes
  const [postLines, guards] = await Promise.all([
    postToolLines(
      { dir: process.cwd(), sessionId },
      probeReporter('post-tool', 'postTool')
    ),
    // guards on post-tool: match sees the journaled trace tail (this
    // landing included — journalTrace ran first), state sees live repo
    guardLines('post-tool', sessionId, async () => {
      const dir = process.cwd()
      const tail = sessionTail(sessionId)
      return { text: tail.raw, trace: relativize(dir, tail.entries) }
    }),
  ])
  lines.push(...postLines, ...guards)
  if (lines.length > 0) {
    context('PostToolUse', lines.join('\n'))
  }
}

/** The exit gate as a hook: every connector contributes GateContributions;
 * the hook applies the arming policy — `block` fires only when this session
 * armed the contribution's aspect, `armedHint` is shown to armed-but-clean
 * sessions, `passive` to everyone else (ambient state, not an obligation).
 * Contributions evaluate independently — a foreign drill frame must not
 * shadow an armed PR gate. Respects stop_hook_active so a blocked stop
 * can't loop. */
const GATE_PRIORITY = ['drill', 'work', 'act', 'task']

async function emitStopGate(input: HookInput): Promise<void> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  // the goal reminder fires on EVERY stop — it is the keep-going nudge,
  // exempt from the once-per-session block budget (context, never
  // `decision: block`; spec: specs/goal/bro-6vcll.md)
  const goalP = goalStopLines(process.cwd(), sessionId, {
    trace: sessionTail(sessionId).raw,
    // the judge's checkable surface — beads/gate/tree state, not just
    // tool metadata (fail-open inside; a slow probe → undefined)
    context: boundedMs(
      sessionContextTextCached(process.cwd(), sessionId).catch(() => undefined),
      4_000
    ),
  })
  if (input.stop_hook_active === true) {
    const goal = await goalP
    if (goal.length > 0) {
      context('Stop', goal.join('\n'))
    }
    return
  }
  await emitStopGateBody(sessionId, goalP)
}

/** The armed-gate half of the stop event — split from emitStopGate so
 *  the goal preamble's branches don't push the gate over the complexity
 *  budget (SAST counts them together otherwise). */
async function emitStopGateBody(sessionId: string, goalP: Promise<string[]>): Promise<void> {
  const armed = sessionId ? readArmed(sessionId) : new Set<string>()
  // Block priority is aspect order, not registry order — a beads gate
  // (registry-first) must not shadow a dirty-worktree block: abandoning
  // uncommitted work loses code, an open claim loses bookkeeping.
  const rank = (a: string): number => {
    const i = GATE_PRIORITY.indexOf(a)
    return i === -1 ? GATE_PRIORITY.length : i
  }
  // goal context, gate contributions, and the guard sweep are
  // independent reads — overlap them; the total is the slowest probe,
  // not their sum (spec: specs/bro-wc0i6.md). Guards fire eagerly — on
  // a block their lines are dropped but the verdict rows still journal.
  const [goal, contributions, guards] = await Promise.all([
    goalP,
    stopGateContributions({ dir: process.cwd(), sessionId }, probeReporter('stop', 'stopGate')).then(
      (rows) => rows.sort((a, b) => rank(a.aspect) - rank(b.aspect))
    ),
    guardLines('stop', sessionId, async () => {
      const dir = process.cwd()
      const tail = sessionTail(sessionId)
      return { text: tail.raw, trace: relativize(dir, tail.entries) }
    }),
  ])
  const hints: string[] = [...goal]
  for (const c of contributions) {
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
    const hint = c.armedHint ?? c.passive
    if (hint) {
      hints.push(hint)
    }
  }
  // stop guards are passive hints — additionalContext only; a guard is
  // a nudge, never a `decision: block` (spec: bro-nkn6)
  hints.push(...guards)
  if (hints.length > 0) {
    context('Stop', hints.join('\n'))
  }
}

/** Connector pre-tool verdicts — the guard plane. The first `block`
 *  vetoes the call (`decision: block` — the opencode V2 adapter throws
 *  on it); `input` overrides merge in connector order and the adapter
 *  applies them over the original tool_input. No verdicts → silence →
 *  the call runs untouched (fail-open, like every hook). */
async function emitPreTool(input: HookInput): Promise<void> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
  const verdicts = await preToolVerdicts(
    { dir: process.cwd(), sessionId },
    tool,
    (input.tool_input ?? {}) as Record<string, unknown>
  )
  const block = verdicts.find((v) => v.block !== undefined)?.block
  if (block !== undefined) {
    if (codexClient) {
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: block,
        },
      })
    } else {
      emit({ decision: 'block', reason: block })
    }
    return
  }
  const merged: Record<string, unknown> = {}
  for (const v of verdicts) {
    if (v.input !== undefined) {
      Object.assign(merged, v.input)
    }
  }
  if (Object.keys(merged).length > 0) {
    if (codexClient) {
      const base =
        typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...base, ...merged },
        },
      })
    } else {
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', tool_input: merged } })
    }
  }
}

/** True when the command was approved. Cursor's beforeShellExecution
 * blocks on empty or invalid stdout, so a non-match must still answer
 * `ask` — silence is a deny. Chained commands match the plugin matcher
 * and land here; they are not self-tool calls, so they stay a prompt. */
function emitPermission(input: HookInput): boolean {
  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (isSelfToolCommand(cmd)) {
    if (codexClient) {
      emit({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      })
    } else {
      emit({ decision: 'approve' })
    }
    return true
  }
  return false
}

function clearCursorHydrated(sessionId: string): void {
  try {
    const path = hintedPath(sessionId, CURSOR_HYDRATED_SKILL)
    if (path) {
      rmSync(path, { force: true })
    }
  } catch {
    // a stuck mark rehydrates on the next prompt — never a stalled hook
  }
}

/** Cursor blocks a beforeShellExecution hook that prints nothing. Answer
 * even when the repo has not opted in and even when chdir fails. */
function answerCursorPermission(event: string | undefined, input: HookInput): void {
  if (!(cursorClient && event === 'permission')) {
    return
  }
  if (!emitPermission(input)) {
    emit({ permission: 'ask' })
  }
}

function runCommitHookCommand(event: 'install' | 'uninstall'): void {
  // every bro git hook rides the same install — provenance tags the
  // commit message, refguard fences shared branch refs (bro-1c78),
  // post-merge keeps the dep graph and dist inside the just-merged head
  const results: [string, InstallResult][] =
    event === 'install'
      ? [
          ['prepare-commit-msg', installCommitHook(process.cwd(), cliVersion())],
          ['reference-transaction', installRefGuardHook(process.cwd(), cliVersion())],
          ['post-merge', installPostMergeHook(process.cwd(), cliVersion())],
        ]
      : [
          ['prepare-commit-msg', uninstallCommitHook(process.cwd())],
          ['reference-transaction', uninstallRefGuardHook(process.cwd())],
          ['post-merge', uninstallPostMergeHook(process.cwd())],
        ]
  for (const [name, r] of results) {
    if (r.state === 'error') {
      console.error(`bro hooks ${event} ${name}: ${r.err}`)
      process.exitCode = 1
      continue
    }
    console.error(`bro hooks ${event} ${name}: ${r.state} ${r.path}`)
  }
}

function runPrepareCommitMsg(argv: string[]): void {
  try {
    emitCommitTrailers(argv.slice(1))
  } catch {
    // fail-open — provenance must never block a commit
  }
}

/** The ref guard reads its update list from stdin — but only when a
 *  pipe actually fed it. A bare `bro hooks reference-transaction` on a
 *  terminal must not block on readFileSync(0). */
function runRefGuard(argv: string[]): void {
  try {
    const stdinText = process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
    emitRefGuard(argv.slice(1), stdinText)
  } catch {
    // fail-open — the guard must never wedge git
  }
}

/** bd/gh probes inherit cwd — run them in the project the hook fired for. */
function enterHookProject(root: string): boolean {
  if (root === process.cwd()) {
    return true
  }
  try {
    process.chdir(root)
    return true
  } catch {
    return false
  }
}

async function dispatchHook(event: string, raw: unknown, input: HookInput): Promise<void> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  switch (event) {
    case 'session-start': {
      const settled = await emitSessionContext('SessionStart', sessionId, 'session-start')
      if (cursorClient && settled) {
        markSkillHinted(sessionId, CURSOR_HYDRATED_SKILL)
      }
      return
    }
    case 'post-compaction':
      await emitSessionContext(
        codexClient ? 'PostCompact' : 'PostCompaction',
        sessionId,
        'post-compaction'
      )
      return
    case 'pre-compact':
      // Claude Code requires hookEventName to match the firing event.
      // Cursor's preCompact cannot feed the summary; drop the hydration
      // mark so the next prompt reloads state after compaction.
      if (cursorClient) {
        clearCursorHydrated(sessionId)
      }
      await emitSessionContext('PreCompact', sessionId, 'pre-compact')
      return
    case 'prompt-submit':
      await emitPromptContext(input)
      return
    case 'pre-tool':
      await emitPreTool(input)
      return
    case 'post-tool':
      await emitPostTool(input)
      return
    case 'stop':
      if (cursorClient && cursorStopIgnored(raw)) {
        return
      }
      await emitStopGate(input)
      return
    case 'permission':
      if (!emitPermission(input) && cursorClient) {
        emit({ permission: 'ask' })
      }
      return
    default:
      // forward-compat: hooks.json may name events this bro doesn't know
      return
  }
}

// --- perf report --------------------------------------------------------------

interface PerfAgg {
  n: number
  sum: number
  max: number
  bad: number
}

/** One journal line → a row, or undefined for a torn/non-row write.
 *  JSON.parse succeeding doesn't mean a row — `null`, a scalar, or `{}`
 *  would poison the aggregates below: every field the report reads must
 *  be present and typed. */
function parsePerfRow(line: string): PerfRow | undefined {
  try {
    const r: unknown = JSON.parse(line)
    if (typeof r !== 'object' || r === null) {
      return undefined
    }
    const p = r as Partial<PerfRow>
    return typeof p.event === 'string' &&
      typeof p.connector === 'string' &&
      typeof p.ms === 'number' &&
      typeof p.ts === 'number'
      ? (r as PerfRow)
      : undefined
  } catch {
    return undefined
  }
}

/** Read the journal rows under perfDir — a session filter narrows to
 *  that session's file; a torn write skips itself, not the report. */
function readPerfRows(perfDir: string | null, sessionFilter?: string): PerfRow[] {
  const rows: PerfRow[] = []
  if (!perfDir || !existsSync(perfDir)) {
    return rows
  }
  const wanted =
    sessionFilter === undefined
      ? undefined
      : `${sessionFilter.replace(/[^\w.-]/g, '_')}.jsonl`
  for (const f of readdirSync(perfDir)) {
    if (!f.endsWith('.jsonl') || (wanted !== undefined && f !== wanted)) {
      continue
    }
    for (const line of readFileSync(join(perfDir, f), 'utf8').split('\n')) {
      const row = line.trim() === '' ? undefined : parsePerfRow(line)
      if (row !== undefined) {
        rows.push(row)
      }
    }
  }
  return rows
}

/** Count/avg/max per key — probe rows keyed event+probe+connector,
 *  event totals keyed by event alone. */
function perfAggs(rows: PerfRow[]): { probes: Map<string, PerfAgg>; totals: Map<string, PerfAgg> } {
  const probes = new Map<string, PerfAgg>()
  const totals = new Map<string, PerfAgg>()
  for (const r of rows) {
    const isTotal = r.probe === undefined
    const key = isTotal ? `${r.event}` : `${r.event} ${r.probe} ${r.connector}`
    const map = isTotal ? totals : probes
    const a = map.get(key) ?? { n: 0, sum: 0, max: 0, bad: 0 }
    a.n++
    a.sum += r.ms
    a.max = Math.max(a.max, r.ms)
    if (r.timedOut === true || r.failed === true) {
      a.bad++
    }
    map.set(key, a)
  }
  return { probes, totals }
}

const fmtAgg = (a: PerfAgg): string => `${a.n} avg:${Math.round(a.sum / a.n)} max:${a.max}`

/** Worst-max-first report lines — `bad` flags probes that timed out or
 *  threw; totals have no bad dimension. */
function aggLines(map: Map<string, PerfAgg>, showBad: boolean): string[] {
  return [...map.entries()]
    .sort((x, y) => y[1].max - x[1].max)
    .map(([k, a]) => {
      const bad = showBad && a.bad > 0 ? ` bad:${a.bad}` : ''
      return `  ${k.padEnd(58)} ${fmtAgg(a)}${bad}`
    })
}

/** `bro hooks perf [--session <id>] [--json]` — aggregate the perf
 *  journals: per event×probe×connector count/avg/max plus the event
 *  totals. Operator command — reads the journal dir, never stdin. */
function runPerf(argv: string[]): void {
  const args = argv.slice(1)
  const json = args.includes('--json')
  const si = args.indexOf('--session')
  const sessionFilter = si >= 0 ? args[si + 1] : undefined
  const dir = hooksStateDir()
  const rows = readPerfRows(dir ? join(dir, 'perf') : null, sessionFilter)
  if (json) {
    console.log(JSON.stringify({ rows }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('no perf rows yet — hook events journal to bro/hooks/perf/')
    return
  }
  const { probes, totals } = perfAggs(rows)
  const probeLines = aggLines(probes, true)
  console.log('per-probe (event probe connector → n avg max):')
  console.log(probeLines.length > 0 ? probeLines.join('\n') : '  (none)')
  console.log('totals (event → n avg max):')
  console.log(aggLines(totals, false).join('\n'))
}

// --- dispatch -----------------------------------------------------------------

/** post-merge and its detached worker are git-hook events — same
 *  pre-gate, no-stdin placement as the shim events: the dispatcher only
 *  schedules the refresh, the worker does it; both fail open and never
 *  block a merge (the catch covers a throw before the worker's own). */
const POST_MERGE_EVENTS: Record<string, (cwd: string) => void> = {
  'post-merge': emitPostMerge,
  'post-merge-run': runPostMergeRefresh,
}

function runPostMergeEvent(event: string | undefined): boolean {
  const run = POST_MERGE_EVENTS[event ?? '']
  if (run === undefined) {
    return false
  }
  try {
    run(process.cwd())
  } catch {
    // fail-open
  }
  return true
}

export async function runHooksCommand(argv: string[]): Promise<void> {
  cursorClient = false
  codexClient = false
  const event = argv[0]
  // install/uninstall are operator commands, not hook events — they
  // report a verdict on stderr and never read stdin (a git hook's stdin
  // can be a terminal, and reading stdin would block on it forever). They
  // also run before the broEnabled gate: wiring a repo is how it opts in.
  if (event === 'install' || event === 'uninstall') {
    runCommitHookCommand(event)
    return
  }
  // prepare-commit-msg is a git-hook event (argv, not a JSON payload) —
  // same no-stdin rule as the operator commands, and same pre-gate
  // placement: the installed shim IS the opt-in, so gating on
  // .beads/bro.config would silently deaden a hook the repo installed
  if (event === 'prepare-commit-msg') {
    runPrepareCommitMsg(argv)
    return
  }
  // reference-transaction is a git-hook event too — argv for the phase
  // and ppid, stdin for the update list; same pre-gate placement (the
  // installed shim is the opt-in)
  if (event === 'reference-transaction') {
    runRefGuard(argv)
    return
  }
  if (runPostMergeEvent(event)) {
    return
  }
  // `bro hooks perf` is a report over the perf journal — same no-stdin
  // operator placement as install/uninstall: it must not block reading
  // a payload that was never sent.
  if (event === 'perf') {
    runPerf(argv)
    return
  }
  // a bare `bro hooks` is a capability probe — launchers test the
  // subcommand exists before calling it with the real event. Return
  // before readRaw: the probe must not consume a payload still waiting
  // on the caller's stdin for that next invocation.
  if (!event) {
    return
  }
  // stdin before the opt-in check: Cursor's project dir is on the
  // payload / CURSOR_PROJECT_DIR, and cwd may be outside the repo.
  const raw = readRaw()
  cursorClient = isCursorHookPayload(raw)
  codexClient =
    !cursorClient &&
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    typeof (raw as { turn_id?: unknown }).turn_id === 'string'
  const root = hookProjectDir(raw)
  const input = cursorClient ? cursorToHookInput(raw) : asHookInput(raw)
  if (!broEnabled(root) || !enterHookProject(root)) {
    answerCursorPermission(event, input)
    return
  }
  perfBuf = []
  const t0 = Date.now()
  try {
    await dispatchHook(event, raw, input)
  } catch {
    // hooks fail open — a bro bug must never break the session.
    // A permission hook that already answered returned above; this
    // covers a throw before that answer.
    answerCursorPermission(event, input)
  } finally {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
    flushPerf(sessionId, event, t0)
    // A probe that raced past its budget leaves its bd/gh child running —
    // unref the stragglers so the hook exits with the answer it sent,
    // not when the last subprocess closes.
    unrefPendingChildren()
  }
}
