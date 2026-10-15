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
