/**
 * `/bro` argument completion — verbs, group members, verb subcommands.
 *
## Why a static table

The host hook (`getArgumentCompletions`) is synchronous — there is no
 *  room to shell out to `bro contract dump`, and a completion dropdown
 *  must answer on every keystroke anyway. So the CLI vocabulary is a
 *  table here, and `completions.test.ts` pins it to the live plugin
 *  registry: a renamed verb or a new group member fails CI before it
 *  can mislead anyone at the prompt.
 *
 * ## Position semantics
 *
 *  The host passes the whole text after `/bro ` (omp's
 *  `getArgumentCompletions(b)` where b is everything past the command
 *  name) and replaces that prefix with the accepted item's `value`.
 *  So:
 *
 *    position 1  `/bro <x`        verbs + groups, filtered by <x
 *    position 2  `/bro review <x` group → members; verb → subcommands
 *    position 3+                   null — flags are not guessed
 *
 *  An empty token at position 1 stays null so bare `/bro ` keeps
 *  submitting (board refresh) instead of accepting the first verb —
 *  the same rule omp's builtin optional subcommands follow. At
 *  position 2 an empty token opens the member list: the discovery
 *  moment is exactly why the dropdown exists.
 */

/** The completion item shape every host in the lineage accepts — the
 *  structural subset of pi-tui's `AutocompleteItem` we actually set. */
export interface BroCompletion {
  value: string
  label: string
  description?: string
}

/** A verb or group with its one-line description. */
interface Entry {
  name: string
  description: string
}

/** Group blurbs — GROUP_META in plugins.ts, mirrored for the bundle. */
const GROUPS: ReadonlyArray<Entry> = [
  { name: 'review', description: 'PR review loop — gates, threads, debt' },
  { name: 'flow', description: 'scheduling & work chains — claims, loops, stacks' },
  { name: 'fleet', description: 'agent plane — workers, serve, the board' },
  { name: 'comms', description: 'events & session mailbox' },
  { name: 'work', description: 'worktree & session mechanics' },
  { name: 'self', description: 'self-correction — retro, lessons, judgment, guards' },
  { name: 'spec', description: 'spec-driven development' },
  { name: 'plan', description: 'versioned plans' },
  { name: 'mesh', description: 'inter-rig federation' },
]

/** Flat verbs — every visible plugin, flat spelling. Aliases carry
 *  their expansion; hidden plugins (docs, hooks, acp-worker, contract)
 *  are internal and stay out of the dropdown. */
const VERBS: ReadonlyArray<Entry> = [
  // review
  { name: 'debt', description: 'Review-debt pipeline: collect|status|prs|list|mark|sync|set' },
  { name: 'act', description: 'Open-PR loop: status|threads|resolve|reply|merge' },
  { name: 'watch', description: 'Orchestrator heartbeat — mols × act gates × fleet snapshot' },
  { name: 'drive', description: 'Post-PR review driver — poll act gates, spawn fixers, merge on green' },
  { name: 'cleanup', description: 'Delete local branches whose PR merged' },
  // flow
  { name: 'convoy', description: 'Molecule DAG execution: status|next|done|pour|list|run' },
  { name: 'next', description: 'Claim + emit the top ready bead — the autonomous backlog loop' },
  { name: 'loop', description: 'Autonomous backlog runner — claim → agent → gate → close → repeat' },
  { name: 'stack', description: 'Stacked bead→worktree→PR chains: push|list|sync|publish|merge' },
  // fleet
  { name: 'fleet', description: 'Fleet view — mols × steps × agents × worktrees × PRs' },
  { name: 'agents', description: 'Agent supervisor: status|up|down over the orchestrator connectors' },
  { name: 'status', description: 'The compact live board — beads + fleet + drill + git' },
  { name: 'daemon', description: 'Project-scoped supervisor: up|status|down|run --every N' },
  { name: 'resume', description: 'Post-restart recovery — rearm watches, revive the daemon' },
  { name: 'serve', description: 'Facade host for thin clients — HTTP/JSON on 127.0.0.1' },
  { name: 'provider', description: 'Claude-facing Messages-API plane — listener + url|token|env wiring' },
  { name: 'mcp', description: 'Stdio MCP server over the read planes' },
  { name: 'pulse', description: 'Session-owned metronome — tick + mailbox beat every S seconds' },
  { name: 'telemetry', description: '→ hooks perf', },
  { name: 'trace', description: 'OTLP export of the session trace journals' },
  { name: 'rig', description: 'Rig freshness: sync|status|watch|install' },
  // comms
  { name: 'notify', description: 'Drop an event into the session mailbox' },
  { name: 'sinks', description: 'Outbound event sinks: list|test' },
  { name: 'bus', description: 'Local event bus — serve/publish/subscribe agent events' },
  // work
  { name: 'drill', description: 'Scoped descent over beads: down|up|current|tree|list|report|distill' },
  { name: 'unwind', description: '→ drill up' },
  { name: 'queue', description: 'Frame-scoped intake queue: ls|drill|bump|rm' },
  { name: 'goal', description: 'Session-scoped completion goal: set|status|pause|resume|clear' },
  { name: 'work', description: 'Parallel-friendly worktrees: enter|leave|list|prune' },
  { name: 'stamp', description: 'Attribute shared-output writes — record/read the last build stamp' },
  { name: 'sync', description: 'Push/pull artifact dirs on refs/bro/data' },
  { name: 'sweep', description: 'Gated disposal for closed beads: status|distill|run' },
  // self
  { name: 'retrospect', description: 'Self-correction: capture|record|status|list|schema' },
  { name: 'wtf', description: '→ retrospect capture' },
  { name: 'learn', description: 'Lessons: add|list|show|forget|capture|probe' },
  { name: 'judge', description: 'Calibrated decision judge' },
  { name: 'dogfood', description: 'Scenario-driven e2e self-test' },
  { name: 'guard', description: 'Declarative prompt guards — list resolved declarations' },
  { name: 'providers', description: 'Provider registry — models catalog as <provider>/<model>' },
  // spec / plan / mesh
  { name: 'spec', description: 'Spec-driven development policy: check|new' },
  { name: 'query', description: 'Cross-provider GraphQL plan' },
  { name: 'run', description: 'Execute a plan file — `kind` routes to the owning plugin' },
  { name: 'plan', description: 'Plan contract: list kinds + schema versions, validate a file' },
  { name: 'mesh', description: 'Inter-rig work federation: me|peers|pull|inbox|request|claim|done|accept|reject|wait' },
  { name: 'request', description: 'Post a request to a repo or peer' },
  // top-level
  { name: 'check', description: 'Run the repo sverka workflow — per-step stats + findings' },
  { name: 'setup', description: 'Wire bro into the current repo' },
  { name: 'doctor', description: 'Environment diagnostics: node, git, gh auth, bd, hooks, config' },
  { name: 'wait', description: 'Dep-plane watcher — verdict = exit code' },
  { name: 'plugins', description: 'Plugin registry + client adapters: install|uninstall|list' },
]

/** Position-2 members per group — registry group membership, aliases
 *  included (they are valid spellings of the same dispatch). */
const GROUP_MEMBERS: Readonly<Record<string, ReadonlyArray<Entry>>> = {
  review: [
    { name: 'debt', description: 'review-debt pipeline' },
    { name: 'act', description: 'open-PR review loop' },
    { name: 'watch', description: 'orchestrator heartbeat' },
    { name: 'drive', description: 'post-PR review driver' },
    { name: 'cleanup', description: 'delete merged branches' },
  ],
  flow: [
    { name: 'convoy', description: 'molecule DAG execution' },
    { name: 'next', description: 'claim the top ready bead' },
    { name: 'loop', description: 'autonomous backlog runner' },
    { name: 'stack', description: 'stacked bead→PR chains' },
  ],
  fleet: [
    { name: 'fleet', description: 'fleet view' },
    { name: 'agents', description: 'agent supervisor' },
    { name: 'status', description: 'the compact live board' },
    { name: 'daemon', description: 'project-scoped supervisor' },
    { name: 'resume', description: 'post-restart recovery' },
    { name: 'serve', description: 'thin-client facade host' },
    { name: 'provider', description: 'Messages-API plane' },
    { name: 'mcp', description: 'stdio MCP server' },
    { name: 'pulse', description: 'session metronome' },
    { name: 'telemetry', description: '→ hooks perf' },
    { name: 'trace', description: 'OTLP trace export' },
    { name: 'rig', description: 'rig freshness' },
  ],
  comms: [
    { name: 'notify', description: 'drop a mailbox event' },
    { name: 'sinks', description: 'outbound event sinks' },
    { name: 'bus', description: 'local event bus' },
  ],
  work: [
    { name: 'drill', description: 'scoped descent over beads' },
    { name: 'unwind', description: '→ drill up' },
    { name: 'queue', description: 'frame-scoped intake queue' },
    { name: 'goal', description: 'session completion goal' },
    { name: 'work', description: 'parallel worktrees' },
    { name: 'stamp', description: 'build stamp attribution' },
    { name: 'sync', description: 'artifact dirs on refs/bro/data' },
    { name: 'sweep', description: 'gated disposal for closed beads' },
  ],
  self: [
    { name: 'retrospect', description: 'self-correction' },
    { name: 'wtf', description: '→ retrospect capture' },
    { name: 'learn', description: 'lesson store' },
    { name: 'judge', description: 'calibrated decision judge' },
    { name: 'dogfood', description: 'e2e self-test' },
    { name: 'guard', description: 'declarative prompt guards' },
    { name: 'providers', description: 'provider registry' },
  ],
  spec: [{ name: 'spec', description: 'spec policy: check|new' }],
  plan: [
    { name: 'query', description: 'cross-provider GraphQL plan' },
    { name: 'run', description: 'execute a plan file' },
    { name: 'plan', description: 'plan contract' },
  ],
  mesh: [
    { name: 'mesh', description: 'inter-rig federation' },
    { name: 'request', description: 'post a request to a repo or peer' },
  ],
}

/** Position-2 subcommands per flat verb — the pipe-lists the plugin
 *  summaries themselves advertise; completions.test.ts pins every
 *  entry to its verb's summary so the table cannot rot. */
const VERB_SUBS: Readonly<Record<string, ReadonlyArray<string>>> = {
  debt: ['collect', 'status', 'prs', 'list', 'mark', 'sync', 'set'],
  act: ['status', 'threads', 'resolve', 'reply', 'merge'],
  convoy: ['status', 'next', 'done', 'pour', 'list', 'run'],
  agents: ['status', 'up', 'down'],
  daemon: ['up', 'status', 'down', 'run'],
  rig: ['sync', 'status', 'watch', 'install'],
  sinks: ['list', 'test'],
  watch: ['install', 'uninstall'],
  drill: ['down', 'up', 'current', 'tree', 'list', 'report', 'distill'],
  queue: ['ls', 'drill', 'bump', 'rm'],
  retrospect: ['capture', 'record', 'status', 'list', 'schema'],
  learn: ['add', 'list', 'show', 'forget', 'capture', 'probe'],
  goal: ['set', 'status', 'pause', 'resume', 'clear'],
  work: ['enter', 'leave', 'list', 'prune'],
  stack: ['push', 'list', 'sync', 'publish', 'merge'],
  spec: ['check', 'new'],
  sweep: ['status', 'distill', 'run'],
  mesh: ['me', 'peers', 'pull', 'inbox', 'request', 'claim', 'done', 'accept', 'reject', 'wait'],
  plugins: ['install', 'uninstall', 'list'],
}

/** The exported tables — the drift test's subject. */
export const BRO_COMPLETION_TABLE = { GROUPS, VERBS, GROUP_MEMBERS, VERB_SUBS } as const

/** Items for one vocabulary filtered by the typed token. `value` is
 *  the full replacement of the argument prefix, so position-2 items
 *  carry the head word. */
function pick(entries: ReadonlyArray<Entry>, token: string, head: string | undefined): BroCompletion[] {
  const out: BroCompletion[] = []
  for (const e of entries) {
    if (!e.name.startsWith(token)) continue
    out.push({
      value: head ? `${head} ${e.name}` : e.name,
      label: e.name,
      description: e.description,
    })
  }
  return out
}

/** Position 1 — groups and flat verbs. An empty token stays null so
 *  bare `/bro ` keeps submitting the board refresh. */
function firstPosition(token: string): BroCompletion[] | null {
  if (token.length === 0) return null
  return [...pick(GROUPS, token, undefined), ...pick(VERBS, token, undefined)]
}

/** Position 2 — the head's group members, else the verb's
 *  subcommands; an unknown head offers nothing. */
function secondPosition(head: string, token: string): BroCompletion[] | null {
  const members = GROUP_MEMBERS[head]
  if (members !== undefined) return pick(members, token, head)
  const subs = VERB_SUBS[head]
  if (subs === undefined) return null
  return subs
    .filter((s) => s.startsWith(token))
    .map((s) => ({ value: `${head} ${s}`, label: s }))
}

/**
 * `/bro` argument completion. Returns the items for the current
 * argument prefix, or null when there is nothing honest to offer:
 * an empty first token (bare submit stays a board refresh), a quoted
 * token (never shred quotes), a flag (flags are not guessed), an
 * unknown head, or anything past position 2.
 */
export function broArgumentCompletions(argumentPrefix: string): BroCompletion[] | null {
  const tokens = argumentPrefix.split(' ')
  const token = tokens[tokens.length - 1] ?? ''
  // quotes are the handler's business, not the dropdown's; flags are
  // never vocabulary
  if (token.startsWith('"') || token.startsWith("'") || token.startsWith('-')) return null
  if (tokens.length < 2) return firstPosition(token)
  // position 3+: no guessing
  if (tokens.length > 2) return null
  return secondPosition(tokens[tokens.length - 2] ?? '', token)
}
