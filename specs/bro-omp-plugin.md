# bro on omp — the plugin, and the unplugin framework

## Problem

bro already ships adapters for four agent hosts — pi, opencode, kilo and
the shell-hook hosts. Each adapter is a **standalone single file**: pi's
jiti loads the raw `.ts`, opencode's loader reads a package export, the
kilo plugin is copied into a config directory. None of them can import a
shared module, because the file has to load with no `node_modules` to
resolve against.

That constraint shaped the code into duplication. Three of the four
adapters carried a near-verbatim copy of the same ~120 lines — the CLI
resolution ladder, the `bro hooks` spawn-and-parse protocol, the board
read. The copies were free to drift, and they did:

- pi had no `options.command` tier in its ladder; opencode did.
- kilo's file header documented an npx fallback tier its code never
  implemented.
- the opencode adapter duplicated a `repoOptedIn` gate that already
  existed in `@broject/core`.

Meanwhile **omp** — the successor to the `pi` CLI — had no adapter at
all, and bro's concepts (advisor, goal, loop, plan, vibe) overlap
omp's native modes almost name for name. Shipping bro's versions next to
omp's would mean two competing implementations of "review the approach
first", and the user would have to guess which one the session was
using.

## Design

### The framework: core + binding, bundled at build time

Split each adapter in two:

- **core** (`packages/cli/src/adapter/core.ts`) — the shared, host-agnostic
  half: where the bro CLI is, how to ask it something, what it said.
  No host types, no `@broject/*` imports (a bundle would drag a package's
  worth of unrelated code into a two-hundred-line artifact).
- **binding** (`packages/cli/src/adapter/<host>.ts`) — the host's own
  shape: its event names, its UI calls, how it spells "refuse to stop".
  This is the *difference* between hosts and nothing else.

A third piece, the **driver** (`packages/cli/src/adapter/host.ts`), owns
the lifecycle — when to probe, what to cache, when to inject — so it is
written once. `createBroDriver(binding, api)` registers every event the
host exposes and hands the client back a `run()` and the last board.

The standalone-file constraint is then solved at **build time** rather
than by hand-copying: `scripts/bundle-adapter.ts` folds the core into
the binding with rolldown (tsdown's own bundler), and `gen-plugins.ts`
emits the result as `plugins/<client>/bro/bro.ts`. The copies still
exist; what is gone is the chance for them to disagree.

The build is also where the ownership sentinel is re-asserted: rolldown
drops a module's leading comment, so the bundler re-emits the
`bro-adapter` sentinel as a banner. `bro plugins install` uses that
sentinel to refuse overwriting a foreign file, so it has to survive the
bundle.

### The omp binding

omp is not pi. The extension *shape* is the same (`pi.on`,
`registerCommand`, `registerTool`), but the vocabulary is not:

| concern | pi | omp |
| --- | --- | --- |
| stop gate | `agent_before_settle` → `{continue, entries[]}` — a hand-rolled continuation | `session_stop` → `{decision:"block", reason}` — **native** |
| one-shot gate | a local `gated` flag | the host's own `stop_hook_active` |
| widget slot | `setWidget(key, lines[], {placement})` | `setWidget(key, lines[])` |
| board refresh | turn end + agent settle | turn end |

The stop gate is the interesting one. omp's `session_stop` accepts
`{decision:"block", reason}` **and re-fires with `stop_hook_active:
true`** — verified against omp 18.12.6. That is exactly bro's one-shot
gate contract, with the host enforcing it. bro's `decision:"block"` maps
straight onto the host's own slot, and the host's flag goes straight
back into bro's hook payload. pi had to fake this with a synthetic
re-prompt; opencode had to re-prompt as a whole extra turn. omp needs
neither.

The binding is therefore mostly a table:

```ts
events: {
  sessionStart: 'session_start',
  sessionBeforeCompact: 'session_before_compact',
  sessionCompact: 'session_compact',
  beforeAgentStart: 'before_agent_start',
  toolResult: 'tool_result',
  stop: 'session_stop',
  turnEnd: 'turn_end',
  sessionShutdown: 'session_shutdown',
}
```

### The mode bridges: state, not a second implementation

omp already has Plan, Goal, Vibe, Prewalk and Advisor. bro does **not**
reimplement them. bro contributes what omp's modes cannot have: a
**durable state plane** that survives the session.

| omp mode | what omp owns | what bro adds |
| --- | --- | --- |
| Plan | the draft and the review | the bead and spec the plan must answer, and the claims in flight |
| Goal | the objective and the budget | the bead the objective belongs to, and the judge that says "met" |
| Vibe | the worker choreography | the *claims* — who owns which bead, so two workers never edit one |
| Prewalk | the model handoff | the provider routing that says which model is fast *here* |
| Advisor | the reviewing model | `WATCHDOG.md` — bro's review priorities, plus the review-debt ledger |

Each bridge is one probe into bro's state and one translation into
omp's vocabulary (`packages/cli/src/adapter/omp-modes.ts`). They are
advisory: omp's Plan Review and Goal continuation are the user's
decisions, and bro's contribution is the missing context, not a veto.
The one exception is the stop gate, which is bro's exit gate as code
and belongs to the `session_stop` handler.

### The plugin surfaces

omp's plugin format is richer than a single module — a package can
carry skills, hooks, commands, rules and subagents beside the
extension. bro uses that:

- `bro.ts` — the extension (the bundle).
- `hooks/pre/permission.ts` — the guard plane. bro's *permission* plane
  answers approve/ask, and omp has no slot for "auto-approve"
  (`tool_approval_requested` ignores handler returns), so that plane is
  deliberately absent; the *guard* plane answers block, which maps
  exactly onto omp's `{block:true, reason}`. The one rule it carries is
  the force-push guard — a force push rewrites the branch history
  bro's occupancy plane depends on.
- `WATCHDOG.md` — the advisor's review priorities. This is where bro's
  policy reaches the reviewer: what the exit gate will check, which
  findings are infrastructure noise rather than defects, and what a
  finding has to look like to be worth the reviewer's tokens.
- `skills/` — bro's existing skills tree, symlinked like the other
  adapters. They are already in Agent Skills format, so omp loads them
  unchanged.
- `modes.ts` — the bridge source, shipped so the mode mapping is
  readable next to the plugin that uses it.

## What bro is for, given omp already has all five modes

omp's modes are **session-local**. A plan review, a goal, a vibe
squad and an advisor all die with the session. bro's state does not:

- **beads claims** — who owns which unit of work, across sessions and
  across rigs. This is what makes omp's Vibe mode safe: two workers
  editing one bead is the failure mode Vibe's prose cannot prevent.
- **the exit gate as code** — `bro review act status` exits non-zero
  while a PR is blocked. omp's advisor *advises*; bro's gate *refuses*.
- **review debt** — findings that recurred across merged PRs, with a
  ledger rather than a scrollback.
- **the judge** — a calibrated verdict (`met` / `impossible` /
  `not_met`) instead of the model reporting its own success.
- **the drill frame** — a scoped descent with a mandatory result and
  prevention memo.
- **mesh** — a finding in another repo becomes a request there, not a
  patch you do not own.

So bro's value to an omp user is not "a second set of modes". It is
**the part of the rig that outlives the session**: the ledger, the
ownership, the gate, and the memory of what this repo's reviewers keep
finding.

## Install

Two paths, because omp's plugin manager is package-shaped and bro's
adapters are module-shaped:

- `omp plugin install ./plugins/omp/bro` — the full plugin: extension,
  skills, hooks, commands, WATCHDOG.
- `bro plugins install omp` — the adapter module alone, into
  `~/.omp/agent/extensions/bro.ts` (global) or `<repo>/.omp/extensions/`
  (local), the same loose-extension shape pi uses.

## Alternatives rejected

- **Ship the adapter unbundled, with a relative import into a shared
  directory.** omp resolves relative `.ts` imports inside a plugin
  package (verified), but pi's jiti loads a *file*, and the opencode
  loader reads a package export — neither has a sibling to resolve
  against. The bundle satisfies all three.
- **Keep hand-copied cores per adapter.** That is the status quo, and
  it is how the ladder tiers drifted.
- **Rewrite omp's modes in bro's terms.** Two implementations of "review
  the approach first" is worse than one implementation plus the state it
  was missing.
- **Block on bro's permission plane.** omp's approval flow ignores
  handler returns; there is no slot for "auto-approve". Shipping a rule
  that cannot be enforced would be a lie in the config.
