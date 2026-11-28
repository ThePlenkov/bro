# bro-j1kk2.11 — docs/skills coverage audit (2026-10-15)

Axes: `PLUGINS` registry (`packages/cli/src/plugins.ts`, 50 entries) ×
`skills/` (36 dirs) × `site/content/docs` (19 command pages + prose).

## Verdicts

### Covered — docs page or dedicated section exists

act, debt, watch, drive, cleanup, convoy, next, loop, stack, fleet,
agents, status, daemon, serve, pulse, rig, resume, notify, sinks, bus,
drill (+unwind alias), retrospect (+wtf alias), learn, judge,
docs (task/store verbs), work, stamp, spec (sdd), hooks, providers,
check, sync, sweep, query, plan/run, plugins, setup, doctor — 40
surfaces land under `commands/*.md` or `utility.md`.

### Internal by design — no user docs wanted

| Surface | Marker |
| ------- | ------ |
| `acp-worker`, `hooks`, `docs` verbs, `telemetry` alias | `hidden: true` in registry |
| `dogfood` | e2e self-test harness — operator-internal; marker: this audit |
| `guard` skill | stub pending bro-nkn6.3 (registry comment) |
| `typesafe-ai` skill | vendored external skill, not a bro capability |

### Gaps — user-facing surface, no docs page

| Surface | Why it needs a page |
| ------- | ------------------- |
| `bro mesh` | federation protocol — a whole product surface, spec exists at `specs/mesh/spec.md` |
| `bro fleet mcp` | MCP server for client hosts — an *adoption* surface |
| `bro fleet provider` / `provider serve` | "Claude Code runs on bro" host story — deserves the narrative |
| `bro work goal` | session goal primitive — referenced by hooks, undocumented |
| `bro trace` | OTLP export — operator observability, a selling point |

### Registry drift found

- `mesh` ships `skills/mesh/SKILL.md` but the registry entry carries no
  `skill:` field — client adapters never emit it. Either wire
  `skill: 'mesh'` or move the file out of the shipped tree.

## Disposition

- Gaps above → bead `bro-j1kk2.13` (hand-written narrative pages;
  `.8`'s generated command reference covers flag-level truth, these
  carry the why).
- `mesh` skill wiring → fold into `.13` (page + registry field land in
  the same PR).
- Internal markers: `hidden: true` is the existing convention for
  plumbing; `dogfood` keeps a visible command with this audit as the
  marker record. No code change needed for `.11` scope.

## Delta re-audit — 2026-11-28 (`bro-j1kk2.16`)

The three axes were re-run from the current `origin/main`: the 50
directories in `skills/`, the `skill:` fields in
`packages/cli/src/plugins.ts`, and the generated/reference pages under
`site/content/docs`. `npm run gen:plugins` was also run after the registry
change; the generated adapters all resolve the canonical root `skills/`
tree.

The re-audit found eight canonical skill directories without a registry
reference (rather than silently treating every one as a CLI gap):

| `skills/` directory | Verdict | Evidence / disposition |
| --- | --- | --- |
| `acp` | wired | `acp` plugin |
| `act` | wired | `act` and merge plugins |
| `agents` | wired | `agents` plugin |
| `bro` | intentional internal | `/bro` is the agent-plugin dispatcher; it is emitted by the root and generated client plugin manifests, not by a CLI registry entry (`scripts/gen-plugins.ts`) |
| `bro-herdr` | intentional internal | Herdr plugin playbook; present in the generated client plugin skill trees, not a typed CLI command |
| `brouter` | wired | `router` plugin |
| `check` | wired | `check` plugin |
| `client-adapters` | intentional auxiliary | Package/client adapter policy skill; the owning CLI surface is `router`/`brouter`, while this names the package boundary rather than a separate command |
| `clients` | wired | `clients` plugin |
| `convoy` | wired | `convoy` plugin |
| `daemon` | wired | `daemon` plugin |
| `debt` | wired | `debt` plugin |
| `delegate` | wired | `delegate` plugin |
| `docs` | wired | hidden `docs` dispatch plugin |
| `dogfood` | wired | `dogfood` and `benchmark` plugins |
| `drill` | wired | `drill` plugin |
| `drive` | wired | `drive` plugin |
| `exec` | wired | Added `skill: 'exec'` to the `exec` plugin; reference page already exists |
| `goal` | wired | `goal` plugin |
| `guard` | intentional internal | Stub pending `bro-nkn6.3`; existing registry comment is the marker |
| `herdr-orchestrate` | intentional internal | Herdr orchestration playbook; emitted by generated client plugin skill trees, not a typed CLI command |
| `judge` | wired | `judge` plugin |
| `learn` | wired | `learn` plugin |
| `loop` | wired | `loop` plugin |
| `mcp` | wired | `mcp` plugin |
| `mesh` | wired | `mesh` plugin |
| `mode` | wired | Added `skill: 'mode'` to the `mode` plugin; reference page already exists |
| `msg` | wired | `msg` plugin |
| `next` | wired | `next` plugin |
| `notify` | wired | `notify` plugin |
| `otel` | wired | `otel` plugin |
| `provider` | wired | `provider` plugin |
| `providers` | wired | `providers` plugin |
| `pulse` | wired | `pulse` plugin |
| `query` | wired | `query` plugin |
| `resume` | wired | `resume` plugin |
| `retro` | intentional internal | Session-end checklist invoked by the retro-on-stop guard and learn closeout; it is not a CLI command (the user-facing command is `retrospect`, already shared with `wtf`) |
| `rig` | wired | `rig` plugin |
| `sdd` | wired | `spec` plugin |
| `serve` | wired | `serve` plugin |
| `skills` | wired | `skills` plugin |
| `stack` | wired | `stack` plugin |
| `status` | wired | `status` plugin |
| `sweep` | wired | `sweep` plugin |
| `sync` | wired | `sync` plugin |
| `trace` | wired | `trace` plugin |
| `watch` | wired | `watch` plugin |
| `watchdog` | wired | `watchdog` plugin |
| `work` | wired | `work` plugin |
| `wtf` | wired | `retrospect` plugin's shared skill |
| `typesafe-ai` | not present | No canonical `skills/typesafe-ai/` directory exists on this revision; stale generated references are the previously recorded vendored-external boundary |

The only genuine registry wiring gaps found in the delta were `exec` and
`mode`; both are small field additions and are fixed in this change.
`bro`, `bro-herdr`, and `herdr-orchestrate` were checked in the generated
plugin manifests before being classified as internal/auxiliary. No new
docs page was needed because the `exec` and `mode` reference pages already
cover the command surfaces.
