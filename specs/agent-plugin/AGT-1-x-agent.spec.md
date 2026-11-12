---
template: brotocol/spec@2
id: AGT-1
title: One bro, any agent X — the host-neutral agent-plugin contract
status: draft
area: agents
owns:
  - packages/cli/src/host-matrix.ts
  - hooks/
  - hooks.json
  - plugin.json
  - skills/
  - packages/agent-plugins/
  - plugins/
  - scripts/gen-plugins.ts
  - packages/cli/src/commands/plugins.ts
  - packages/cli/src/commands/hooks.ts
aliases:
  - agent-plugin
  - x-agent
---

# AGT-1 — One bro, any agent X: the host-neutral agent-plugin contract

## Problem

bro reaches agent hosts through nine different plugin shapes — hook
manifests (Claude/Codex/Devin/Cursor), generated manifests (Cursor),
in-process extensions (pi/omp), catalog plugin directories
(opencode/kilo), and a herdr plugin that is not an agent host. The
agent-facing surface — what bro *adds* to a session — is real but
scattered: `hooks/run.sh`, `host-matrix.ts`, `adapter-core`,
`gen-plugins.ts`, nine `plugins/` dirs, 49 skills, marketplace
manifests. No spec states what "bro inside agent X" means, what the
plugin *adds* (commands, tools, skills, UX), or how it correlates
with the host's native commands. The contract exists de facto —
`HOOK_MATRIX` + `host-matrix.test.ts` + `integrations.md` — but as a
test fixture, not a declared spec.

## Design

### The four planes (unchanged framing, now with the surface inventory)

**1. Lifecycle plane — `bro hooks <event>`.** Eight events, one
protocol (stdin payload → JSON control out). Per-hook logic, stated
once for every host:

| event | what bro does | host-visible effect |
| ----- | ------------- | ------------------- |
| `session-start` / `post-compaction` / `pre-compact` | rehydrate: beads ready, drill frame, PR gate, debt, merge slot, work nudges, matched lessons, SDD policy | context injection (never enforced) |
| `prompt-submit` | drill-frame reminder; review host parses its own PR URLs → act snapshot; SDD nudge on own claims; matched lessons | context injection |
| `pre-tool` | guard plane: connector verdicts — first `block` vetoes the call, `tool_input` overrides merge | block/rewrite where host allows |
| `post-tool` | exec nudges (`gh pr create` → act gate + trace stamp; merge → debt sweep; first mutating bro subcommand → cites governing skill); **arms the stop gate** via per-session `.git` markers (act/drill/work/task aspects); drains session mailbox; connector postTool probes | context/observe; arming is invisible state |
| `stop` | connector GateContributions — each system reports unfinished work; blocks only aspects this session armed; one-shot per aspect | block / reprompt / notify per host cell |
| `permission` | auto-approve `bro`/`bd`/`npx @broject/bro` self-tools — scoped opt-in, never the host's security plane | approve / mandatory-answer (Cursor) / absent |

Plus non-event ops: `install`/`uninstall` write git-hook shims
(`prepare-commit-msg` provenance trailers, `reference-transaction`
shared-branch ref guard, `post-merge` dep-graph refresh) — repo
hooks, host-independent.

**2. State plane — the repo is the session.** Claims, `.work`/`.task`/
`.act`/`.drill` markers in the git common dir, mailbox drops, spec
tree, guard/lesson caches — durable state lives on disk, host-blind
by construction. The stop gate's arming markers are written by
`post-tool` and read by `stop` — both sides of the gate are bro
state, the host only carries the event.

**3. Surface plane — what the plugin ADDS.** Four asset classes,
delivered per host capability:

- **`/bro` command** — the unified dispatcher, with one declared
  variant. Canonical (shared driver, pi/omp): bare `/bro` refreshes
  the board widget; `/bro <args>` runs `bro <args>` and drops output
  into the transcript without a turn. OpenCode's command palette is
  prompt-submission by design, so its `/bro [args]` runs the verb and
  submits the output *as the next prompt* (bare defaults to `status`)
  — the model sees the result immediately; `/act` is the `act`
  shortcut. On manifest hosts there is no command surface — bro
  reaches the model through hook context + skills instead.
- **`bro_*` model tools** — read-verbs pinned to fixed argv so the
  model gets reads, never arbitrary bro: `bro_status` (board JSON),
  `bro_convoy_status`, `bro_act_status`, `bro_fleet`, `bro_next`,
  `bro_drill_status`, `bro_review_threads`, `bro_worktree_status`
  (opencode); `bro_status` (pi/omp); kilo's `bro` tool is the one
  *write-capable* variant (`sub` + `args` → any bro subcommand).
- **Skills** — the portable 49-skill tree (`skills/*/SKILL.md`,
  Agent Skills format). Delivery per host: plugin `skills/` dir
  (manifest hosts), host skill registry (opencode),
  `~/.agents/skills/` via `bro skills sync` (directory installs).
  Skills are how the model *invokes* bro workflows (`/act`,
  `/drill`, `/loop`… as skill names, not host commands).
- **UX surfaces** — board widgets (pi/omp `setWidget`, opencode
  TUI sidebar+panel), toasts/sound (opencode `attention` event,
  pi/omp `notify`), keymap commands (`bro.status`/`bro.board`),
  warn logs (kilo), follow-up messages (Cursor `loop_limit`,
  manifest context lines). Cosmetic by contract — never enforcement.

**4. Delivery plane — four surfaces.** `manifest` (host hooks.json →
run.sh), `generated` (gen-plugins.ts output), `extension` (in-process
TS on pi/omp API), `plugin` (catalog module on opencode/kilo bus).
All terminate in `bro hooks`; surface decides transport/timing, never
semantics. `HOOK_MATRIX` is the machine form — per host, per event:
native names, matchers, effects, outcome source, stop refusal,
sync/async.

**One implementation of the shared mechanics.** Every in-process
adapter (pi, omp, opencode, kilo) is generated by the same
`bundleAdapter` build: `adapter-core`'s CLI ladder (pin → sibling →
checkout → PATH → npx, each tier probed with `bro hooks`), hook
protocol (`callHook`/`parseControl`/`contextOf`), spawn-and-capture
(`runCommand`), board rendering, and the lazy retrying resolver
(`createCommandResolver`) live in `adapter-core/src/core.ts` exactly
once. A host file carries only its own shape — event names, UI calls,
stop-refusal spelling, tool/command registration. Host halves may
differ (opencode's bus vs pi/omp's extension API vs kilo's transform);
the mechanics may not.

### Native correlation — extend, never shadow

The plugin's first law: **bro supplies what the host lacks; the
host's own commands/modes keep their semantics.** The correlation
matrix per host names native features bro rides:

- omp Plan/Goal/Vibe/Prewalk/Advisor → `modes.ts` injects claims,
  specs, judge, debt — omp keeps the mode UX.
- Codex `/goal` `/plan` `/agent` `/fork` → `INSTRUCTIONS.md`
  ownership table routes durable-plane work to bro, session work
  stays Codex.
- opencode native commands/tools → bro adds `bro_*` namespace +
  `/bro`/`/act`, never redefines host verbs.
- Where a host has NO native equivalent (most do not), bro's skills
  are the interface — the model invokes `act`, `drill`, `loop` by
  skill name.

A host-native feature that overlaps a bro concept gets a **bridge**
(state injection), never a competing implementation — two "review
the approach first" buttons is the failure mode `bro-omp-plugin.md`
already named.

### What a host X must supply (contract checklist)

1. **Cells** — `HOOK_MATRIX` entry: native events → bro events,
   honest `—` gaps (declared gap = contract; silent absence = bug).
2. **Transport** — surface artifact to `bro hooks` + install path.
3. **Opt-in** — `bro.config.json`/`.beads/` gates everything;
   fail-open everywhere except the host's own permission-answer
   shape (Cursor's empty-reply-is-deny).
4. **Surface assets** — at minimum skills delivery; commands/tools/
   UX only where the host has the slots (declared per child spec).

### Boundaries (canonized)

- Advisory ≠ enforcement — only host `block`/`rewrite`/`approve`
  slots enforce; reprompt/notify/context are UX.
- bro policy ≠ host permissions — bro answers permission events for
  self-tools only; the host's approval plane stays the user's.
- Fail-open, bounded — every probe deadline-bound; stop gate is the
  single blocking surface, one-shot per armed aspect.
- Sync vs async declared per host in the matrix.

## Requirements

- **R1** — The four planes, eight events + per-hook logic, four
  asset classes, five boundaries are the declared contract;
  `HOOK_MATRIX` remains machine form, `host-matrix.test.ts` its
  enforcement.
- **R2** — Every shipped host has a child spec (AGT-2…AGT-10)
  inventorying: hook cells, `/bro`+command surface, `bro_*` tools,
  skills delivery, UX surfaces, native-command correlation, gaps.
- **R3** — New-host checklist covers assets too: which of
  command/tools/UX the host can carry, declared not assumed.
- **R4** — Evolution is spec-governed: cell/asset changes bump
  `HOOK_MATRIX_VERSION` + Changelog; `integrations.md` renders the
  matrix, never paraphrases.
- **R5** — Honest gaps are contract; silent absence is a defect.
- **R6** — Degenerate contract: no hook surface → skills + CLI
  only, advisory, explicitly declared.

## Verify

- `bro spec tree` shows AGT-1 root of the family.
- `host-matrix.test.ts` + `hooks.e2e.test.ts` green.
- `integrations.md` matrix == `HOOK_MATRIX`.
- Per-child Verify names live evidence (commands/tools/UX exercised).
- New-host dry run against the checklist before contract is stable.

## Changelog

- 2026-11-12 — v1 draft: four planes, event vocabulary, boundaries.
- 2026-11-12 — v2 rewrite after review: added the surface inventory —
  per-hook logic table, `/bro` dispatcher contract, `bro_*` tool
  taxonomy, skills delivery matrix, UX tiers, native-correlation
  rule. Specs are engineering docs, not architecture prose.
- 2026-11-12 — v3: uniform-implementation clause — all four
  in-process adapters ship through `bundleAdapter` over
  `adapter-core/core.ts`; opencode + kilo migrated off their
  verbatim-copy helper blocks (kilo gains the full CLI ladder incl.
  npx, opencode's pinned `command` is now probed like every tier).
