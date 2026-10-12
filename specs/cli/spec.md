---
parent: project
---

# cli — command-surface structure: groups, aliases, naming contract

## Problem

36 top-level commands (39 plugin entries incl. aliases) grew past what a
flat namespace can communicate — `bro --help` is a wall, and the name
alone no longer says which capability owns a command. Three names also
exist for one capability (`retrospect`/`wtf`/`retro`), top-level entries
are really aliases (`unwind` → `drill up`, `telemetry` → `hooks perf`,
`wtf` → `retrospect capture`), and the docs can't answer "what is what"
without reading source.

The fix is structural, not a rename wave: the CLI gains **groups** —
a second level between `bro` and the plugin — so the surface reads as
~14 entries instead of ~36.

## Command plane — target taxonomy

`bro <group> <member> [args…]` where group is a capability namespace
and member is the plugin that already exists today:

```text
bro review   act | debt | drive | watch | cleanup
bro flow     next | loop | convoy | stack
bro fleet    agents | fleet | serve | status | telemetry*
bro work     work | drill | goal | sweep | sync
bro self     retrospect | learn | judge | guard
bro comms    bus | notify
bro mesh     me | peers | pull | inbox | request | claim | done |
             accept | reject | wait | list            (already grouped)
bro plan     list | validate | run | query
bro spec     check | drift | init | new | tree        (already grouped)
top-level    status? check setup doctor plugins
hidden       hooks acp-worker docs
             *telemetry stays an alias — see alias model
```

Groups mirror the capability specs — the spec tree IS the grouping;
a command belongs to exactly one group, claimed by that capability's
`Owns:` list.

## Naming contract

- **Group and member names are nouns**, one short lowercase word;
  verbs live below members as subcommands (`bro review debt collect`).
- **Alias = data, not a peer.** `wtf`, `unwind`, `telemetry` gain an
  `aliasOf` pointer to their target and never render as independent
  rows — help shows `wtf → retrospect capture`.
- **Two planes stay distinct**: `bro <group> <member>` (capability
  plane) vs `bro <verb> <noun>` (doc plane — `task`/`store` and plugin
  `docs:` types). Dispatch order: plugin name → group → doc verb.
- Canonical layer names: `BroPlugin.name` = `commands/<name>.ts` =
  `skills/<name>/` (where a skill exists); `configKey`/spec dir may
  differ but must appear in `specs/project.md`'s ownership matrix.
  Known drift to retire: `retrospect`/`wtf`/`retro` triple-name,
  `work` owning `configKey: 'stack'`, `skills/sdd` vs command `spec`.

## Dispatch model

`index.ts` resolves in order:

1. `PLUGINS[name === argv[0]]` → run (flat spelling — compat path)
2. `GROUPS[argv[0]]` → member dispatch:
   `members[argv[1]] ? member.run(argv[1:]) : groupHelp(argv[0])`
3. `runDocVerb` → verb-noun docs
4. unknown → usage

`bro --help` renders grouped tables (group → member → summary);
`bro <group>` prints that group's members. Flat spellings are
**permanent aliases** — every existing script, hook, and skill keeps
working; docs and skills migrate to group form at their own pace.

## Migration (phases, each independently shippable)

1. `BroPlugin.group` + registry grouping + group dispatch + grouped
   `--help` (~50 lines of dispatch, metadata elsewhere).
2. `aliasOf` field; `wtf`/`unwind`/`telemetry` demoted to aliases.
3. Docs/skills/site wording moved to group spelling.
4. Optional later: retire flat spellings per-name via `deprecated:` —
   decided per command, never bulk.

## Owns

```text
packages/cli/src/plugins.ts        registry: name/summary/skill/configKey/group
packages/core/src/plugin.ts        BroPlugin contract (+ group, + aliasOf)
packages/cli/src/index.ts          dispatch order + --help grouping
packages/cli/src/commands/*.ts     member implementations
```

## Invariants

- Every visible plugin belongs to exactly one group — `bro spec check`
  or a check script fails on an ungrouped member.
- Aliases carry `aliasOf` and are excluded from command counts and
  ownership checks.
- Group names never collide with plugin names (dispatch order makes
  plugin win — a collision would silently shadow the group).
- The capability map in `specs/project.md` lists `cli` and every
  group→members cell matches plugins.ts — CI-checked, not prose.
