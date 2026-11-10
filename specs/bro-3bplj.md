---
parent: bro-olfvd
scope:
- packages/command/
- packages/cli/src/index.ts
- packages/cli/src/plugins.ts
- packages/cli/src/commands/router.ts
- packages/brouter/src/cli.ts
- packages/brouter/src/plugins.ts
---

# bro-3bplj — @broject/command: a bootstrap for ANY cli

## Problem

bro's dispatch lives INSIDE bro's CLI package: the plugin registry, the
group dispatch, the help tables, the argv rules — all of it in
`packages/cli/src/index.ts` and `plugins.ts`. brouter, a second CLI in
the same repo, therefore had to grow its own dispatch — a second
hand-written switch, the same duplication the arg parser just shed
(spec bro-6knxt).

Two CLIs, one base. The base is the part that is not bro: the registry
mechanics and the dispatch. bro adds its plugin set, its doc-verb layer
(`bro task list`) and its telemetry; brouter adds its own plugin set.
Neither owns the other's.

The stronger requirement came later: the base must be usable by a CLI
that has NOTHING to do with bro — not a rig, not beads, not a bus. So
the package is a **bootstrap for any cli**, with zero dependencies. The
primitive it ships is the one the repo's own plugin shape already
implies:

> **a command IS a cli.** A command holds PLUGINS (leaf commands) and
> COMMANDS (nested commands). The BIN decides what is executable — and
> because a command is self-contained, ANY command can be mounted as a
> bin of its own.

That is the repo's own plugin principle (one definition → CLI + skill +
config section) taken one level down: the definition is a command, and
the surfaces over it are mounts.

## Design

### The package

`packages/command` → `@broject/command`. **Zero dependencies** — it is
the bottom of the stack, and every CLI above it may differ in
everything but the dispatch. Four modules:

**`plugin.ts`** — the leaf declaration:

```ts
export interface CommandPlugin {
  name: string;
  summary: string;
  run: (argv: string[]) => void | Promise<void>;
  argvPrefix?: string[];
  group?: string;
  hidden?: boolean;
  deprecated?: string;
  flatDeprecated?: string;
  aliasOf?: string;
}
export function definePlugin<P extends CommandPlugin>(plugin: P): P;
```

Generic on purpose: the bootstrap knows a plugin's name, its one-liner
and how to run it. A host's own extras (a skill directory, a doc type, a
connector, a plan schema) ride on the declaration as extra fields — the
bootstrap neither reads nor forbids them.

**`command.ts`** — the tree and the dispatch:

```ts
export interface CommandSpec {
  name: string;
  summary?: string;
  plugins?: CommandPlugin[];
  commands?: CommandSpec[];
  usageLines?: string[];
  examples?: string[];
  version?: string;
  /** the host's own setup — telemetry, sinks, external plugins */
  prepare?: (argv: string[]) => Promise<void>;
  /** the last-resort resolver — the host's own noun/verb layer */
  fallback?: (cmd: string, rest: string[]) => Promise<boolean>;
}
export function defineCommand(spec: CommandSpec, parentPath?: string, rootPath?: string): Command;
export function runCommand(command: Command, argv: string[], opts?: { mounted?: boolean }): Promise<void>;
```

The dispatch rules move VERBATIM from bro: a plugin wins over a
command of the same name (the host case), a command's own members win
over the host when argv names one, the flat-spelling retirement warning
fires only for a truly flat invocation, a command with members prints
its member table (exit 0 for `--help`, exit 2 for an unknown member),
the bare CLI is a failure (exit 1) rather than a usage error (exit 2),
and `bro help <cmd>` is `bro <cmd> --help`.

**`registry.ts`** — the registry mechanics:

- `pluginGroups(plugins)` — group name → members, derived over the live
  list (an external plugin joins a group too);
- `registerExternal(plugins, entry, spec, reserved)` — the acceptance
  rules for a config-loaded plugin: a reserved doc noun/verb, a taken
  name, or a non-plugin entry is refused with a reason; a taken name is
  never silently shadowed;
- `isPlugin(entry)` — a runnable declaration with a name and a summary.

**`exits.ts`** — the exit taxonomy every bro-family CLI shares
(`0` ok / `1` failure / `2` usage), the usage writer (injectable, so a
test captures it) and the deprecation warning.

### The two instances

**bro** — the bootstrap plus:

- its plugin set (`PLUGINS`) and group blurbs (`GROUP_META`);
- the external plugin loader (config `plugins` — bro's feature);
- the doc-verb fallback (`bro list`, `bro show <id>`);
- the telemetry spine (the otel span + the command journal) — the
  `prepare` hook;
- the doc usage lines in the help text.

**brouter** — the bootstrap plus its own plugin set: `connectors`,
`clients`, `providers`, `models`, `client`, `ask`, `acp` — each a
`definePlugin` declaration, so the unplugin-shaped surface applies (a
declaration is the command; a skill is a directory; a config section is
a schema). No groups, no doc layer, no telemetry.

### The wrapper is a MOUNT, not a second switch

`bro router` is the same surface under bro's spelling. It mounts
**brouter's own plugins** (`routerPlugins()`) with bro's POLICY
injected — where the endpoint comes from (bro's LIVE gateway state: a
dead listener is an error, not a read that never answers) and which
settings file a client gets (`serve.client.<id>.settingsPath`). The
commands themselves are ONE implementation; the wrapper adds no branch.

### What the bootstrap does NOT own

- the plugin TYPE with a host's extras (`BroPlugin` stays in core
  beside the config sections it reads);
- the arg parser — core's (`cli-args.ts`), one parser for both CLIs;
- the hosts' own surfaces (bro's beads/bus/fleet, brouter's ACP
  binding).

## Plan

- [x] `packages/command` — package.json (zero deps), tsconfig, tsdown
- [x] `src/plugin.ts` — the leaf declaration + `definePlugin`
- [x] `src/command.ts` — the tree, the dispatch, the help tables
- [x] `src/registry.ts` — the group derivation + the external
      registration rules
- [x] `src/exits.ts` — the exit taxonomy + the usage writer
- [x] `src/index.ts` — the exports
- [x] tests — the dispatch (flat, host case, member table, unknown,
      help, bare), the registry (groups, the acceptance rules); the
      fixture CLI runs as a REAL process, so the exit codes are real
- [x] bro rewired — `index.ts` becomes the mount; the groups become
      nested commands; the telemetry and the doc verbs are the hooks
- [x] brouter rewired — its commands become plugins; the bin mounts
      them
- [x] `bro router` — a mount over brouter's plugins with bro's policy

## Verify

- `npx tsx --test packages/command/src/*.test.ts`
- `npx tsx --test packages/brouter/src/*.test.ts`
- `npx tsc --noEmit -p packages/{command,brouter,cli}/tsconfig.json`
- `npx nx run @broject/{command,brouter}:build`
- Behavioral identity: the old and the new `bro --help`, `bro review`,
  `bro help review`, `bro plan`, `bro nope` print the same text and
  exit the same code.
- Live: `bro router models` answers the live gateway with the served
  catalog; `brouter models` answers the same.

## Non-negotiables

- **Behavior-identical for bro.** The dispatch moves verbatim; the
  registry tests and the CLI suite are the guard, not a rewrite.
- **Zero dependencies.** The bootstrap knows nothing about beads, the
  bus or the fleet. It reads a command tree and runs it. A second CLI
  must not inherit the rig's dependencies.
- **One registry, one truth.** The command table, the member list and
  the help text derive from the SAME plugin list the dispatch runs —
  never a second copy that can drift.
- **A reserved name is refused loudly.** An external plugin may not
  shadow a doc noun/verb, a builtin, or a config section.
- **A wrapper is a mount.** `bro router` runs brouter's commands; it
  does not re-implement them.

## Risks named up front

- **The dispatch is load-bearing.** `bro` is used by hooks, by CI and
  by agents; a subtle change in the help text or the exit code is a
  real breakage. The move is a cut-and-paste with the tests green, not
  a rewrite.
- **Two plugins, two registries.** bro's set and brouter's set are
  separate lists; a capability both want (the router's surfaces) is
  bro's `bro router` wrapper until M4 moves the gateway — the wrapper
  is the deliberate bridge, not an accident.
- **A published package.** `@broject/command` ships to npm like every
  other `@broject/*`; the version boundary moves with it.
