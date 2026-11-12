# bro-3juoh — hooks.json: thin run.sh contract, no manifest `bro hooks` fallback

## Problem

The generated hook manifests carry a fallback that bypasses the shared
launcher. Two shapes exist today:

- `hooks.json` + `plugins/devin/bro/hooks.json` (both emitted by
  `devinHooksJson()`): `P="${DEVIN_PLUGIN_ROOT}"`, run.sh when executable,
  else a `bro hooks <event>` wrapped in an inline sleep/kill watcher.
- `plugins/cursor/bro/hooks/hooks.json` (emitted by `cursorHooksJson()`):
  `if [ -f "${CURSOR_PLUGIN_ROOT}/hooks/run.sh" ] … elif command -v bro …
  bro hooks <event> || true` — **no watchdog at all**.

The `bro hooks` fallback re-implements what `hooks/run.sh` already owns —
plugin-root resolution (run.sh:1128), the `run_bounded` watchdog (8s,
run.sh:136), the Tier-0 mode fast-paths and spool pairing (#1024) — while
skipping every one of them. When the root var is unset/empty the fallback
takes over on every event: Cursor's is literally unbounded (host kills at
the hook timeout → user-visible "Hook failed"), and Devin's bounded copy
still pays full Node cost per event with none of run.sh's fast paths and
sits marginally inside the 10s hook budget (TERM 8s → KILL 9s + spawn
overhead). The preamble is also duplicated logic that can drift from the
launcher it shadows.

## Contract

The established thin contract — already shipped by the Claude and Codex
hand-written manifests — is one client var, one direct `run.sh` call,
fail-fast:

```sh
"${<CLIENT>_PLUGIN_ROOT}/hooks/run.sh" <event> || true
```

`run.sh` resolves the plugin root itself from whichever `*_PLUGIN_ROOT`
var the host exported, walks up for a built CLI, then falls back to `bro`
on PATH — every binary path inside `run_bounded`. A missing root var or a
missing script exits nonzero into `|| true`: fast, silent, never a hang.

Per-event deviations that are part of the contract, not the bug:

- **Detached post-tool (devin).** #801 made devin's PostToolUse
  fire-and-forget: stdin is captured to a tempfile, then run.sh runs in a
  subshell detached off the hook pipes (`</dev/null >/dev/null 2>&1 &`).
  That stays — it is host-latency policy, not fallback duplication. Only
  the `bro hooks` elif is dropped; the run.sh branch is unchanged.
- **Cursor permission.** Cursor treats empty `beforeShellExecution`
  stdout as a *deny*, so the no-opinion must be printed when run.sh cannot
  exec: `… || printf '%s\n' '{"permission":"ask"}'`. Every other event
  keeps `|| true`.

## Changes (all in `scripts/gen-plugins.ts` — the manifests are generated)

- `cursorHookCommand(event)` → thin command; `permission` keeps the
  `ask` no-opinion via `|| printf`.
- `devinHooksJson()` → `cmd(event)` becomes the thin call; `cmdDetached`
  keeps the mktemp/detached shape for `post-tool` with the run.sh branch
  only. The `P=…`/`[ -x … ]` preamble and the entire `elif command -v bro`
  watchdog-fallback block are deleted.
- Regenerate: `node scripts/gen-plugins.ts` rewrites `hooks.json`,
  `plugins/devin/bro/hooks.json`, `plugins/cursor/bro/hooks/hooks.json`.
  `plugins/claude/bro/hooks/hooks.json` and
  `plugins/codex/bro/hooks/hooks.json` are hand-written and already thin —
  untouched.

## Non-goals

- No `run.sh` changes — the thin call delegates everything to it; the
  observe-mode fast paths (#1024) are exercised through the same entry.
- No timeout/matcher/event-map changes.
- No fallback revival: if the root var is unset the hook is a no-op. That
  is the fail-fast contract the Claude/Codex manifests already ship; a
  host that does not export the var has a broken install, and `bro hooks`
  on PATH is not a trustworthy substitute (wrong version, no mode/spool
  state, unbounded).

## Verification

- `npm run build` (runs gen-plugins), `npm run typecheck`.
- `npm run check:plugins` clean after regen; `check:embedded`,
  `check:published`, `check:command-docs` as applicable.
- `host-matrix.test.ts` still proves every declared native event reaches
  `run.sh <event>`; the e2e `Cursor no-CLI permission` test executes the
  generated `beforeShellExecution` command and must still print
  `{"permission":"ask"}`.
- Live smoke: unset root var → hook command exits ~instantly (no 10s
  hang); root set → run.sh path works; observe-mode session → Tier-0
  fast path still exits early.
