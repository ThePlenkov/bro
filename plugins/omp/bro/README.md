# bro — omp plugin

Agent's sidekick for omp: the live project board on omp's TUI plus the
same lifecycle mechanics the shell adapters carry, over omp's in-process
extension API. `bro.ts` is generated from
`packages/cli/src/adapter/omp.ts` — the shared adapter core folded into
one self-contained module (node builtins only) by
`npm run gen:plugins`; `check:plugins` fails when it drifts.

## What it wires

- **board widget** — `bro status --json` rendered via
  `ctx.ui.setWidget`/`setStatus`, refreshed on session start, turn
  end, and after a gate.
- **lifecycle** — omp events → `bro hooks <event>`: session-start and
  post-compaction rehydration injected once as a hidden context message,
  pre-compact carried across, prompt-submit nudges, post-tool arming,
  and `session_stop` → the stop gate.
- **the stop gate is native** — omp's `session_stop` accepts
  `{decision:"block", reason}` and re-fires with
  `stop_hook_active: true`. bro's gate maps straight onto it, and
  omp's flag goes straight back into bro's hook payload. No synthetic
  re-prompt, no hand-rolled continuation.
- **`/bro`** — bare opens the interactive board panel (collapsible
  sections, ↑↓/←→ navigation, `r` refresh, `q` close — an overlay over
  the transcript; a plain refresh where no TUI can mount);
  `/bro act|next|fleet|…`
  runs the CLI and drops the output into the transcript. The slash
  dropdown completes arguments: verbs and groups at position 1,
  group members / verb subcommands at position 2
  (`getArgumentCompletions`, table drift-tested against the plugin
  registry).
- **`bro_status` tool** — the board JSON as a model-callable read.

## The mode bridges

omp already has Plan, Goal, Vibe, Prewalk and Advisor. bro does not
reimplement them — it supplies the state they cannot have. See
`modes.ts` for the full mapping; the short version:

| omp mode | what bro adds |
| --- | --- |
| Plan | the bead and spec the plan must answer, plus the claims in flight |
| Goal | the bead the objective belongs to, and the judge that says "met" |
| Vibe | the claims — who owns which bead, so two workers never edit one |
| Prewalk | the provider routing that says which model is fast *here* |
| Advisor | `WATCHDOG.md` — bro's review priorities, plus the debt ledger |

## Install

```sh
omp plugin marketplace add ThePlenkov/bro      # once — the catalog
omp plugin install bro@theplenkov              # user scope: every project
omp plugin install --scope project bro@theplenkov
                                               # project copy shadows the user one
```

Scope is a marketplace concept: a project-scoped install records
`.omp/plugins/installed_plugins.json` in the project and shadows the
user-scoped copy of the same `name@marketplace` — that is how a
checkout diverges from the released plugin without touching the global
one. For a live dev loop the plain local install still wins once:

```sh
omp plugin install ./plugins/omp/bro           # symlinked — edits are live
omp plugin uninstall bro                       # unlink the dev copy
omp plugin install bro@theplenkov              # back to the marketplace copy
```

Or load it ad hoc: `omp --extension ./plugins/omp/bro/bro.ts`.

The module resolves the CLI as local dist (bundled sibling or the
checkout's `packages/cli/dist/index.js` found walking up), then `bro`
on PATH passing the `bro hooks` probe, then `npx -y --prefer-offline
@broject/bro@0.2.5`. Every call is async and fail-open —
a missing CLI or a non-bro directory means no widget and no context,
never an error.
