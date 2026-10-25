# Review policy — bro

## Skip these paths — do not review

Generated or vendored content; reviewing them burns the review budget on
code nobody edits by hand.

- `plugins/**` — generated client adapters (`scripts/gen-plugins.ts`);
  review the canonical sources (`skills/`, `hooks/`, `plugin.json`) and the
  generator itself instead. Two exceptions stay in scope:
  `plugins/claude/bro/hooks/hooks.json` and
  `plugins/codex/bro/hooks/hooks.json` (hand-written event names), and
  any `skills` entry under `plugins/<client>/bro`. A directory or a
  symlink there is a second package — **major**, even though the rest
  of `plugins/**` is skipped. Skills are reviewed at `skills/` next to
  root `plugin.json` ([Agent Plugins](https://agent-plugins.org/),
  [Agent Skills](https://agentskills.io/)). Host files in scope are the
  extras only: hook event maps and client manifests.
- `vendor/**` — upstream submodule, not ours
- `package-lock.json`, `**/dist/**`, `**/*.generated.ts`
- `.agents/skills/`, `.agents/review-debt/` — local runtime state

## Severity calibration

- Hooks and launchers must fail open: a missing binary, empty env var, or
  network error must never stall or fail the client session. Any path that
  can `exit 1`, hang, or block on a hook event is a **critical** finding.
- `packages/cli/dist` and PATH fallbacks are the production path for
  installed plugins — treat breakage there as **major**, not minor.
- `scripts/gen-plugins.ts` drift between canonical sources and generated
  adapters is **major** — a stale manifest ships to users verbatim.
- A second skills package is **major**: `plugins/<client>/bro/skills`
  as a directory or a symlink, a duplicated `SKILL.md` outside
  `skills/`, or a generator mode that copies or links the tree into a
  host adapter. The portable tree is `skills/` beside root `plugin.json`.
  Host adapters add hooks and client manifests only.
- Two writers on one tree, branch or PR is a **major** finding — the
  interactive session and bro's batch lane must not execute the same
  unit of work. bro's occupancy plane already skips session-owned
  worktrees; a review bot pushing into an occupied branch is the same
  conflict from a third lane.
- `packages/core` is vendor-neutral: it holds contracts, registries, and
  generic mechanics only (`agents.<kind>` knob bags, `sessionPlanes`,
  `connectors.*` seam). An import, path, identifier, or hard-coded state
  layout that names a concrete agent backend or provider (devin, tmux,
  gascity, opencode, …) in `packages/core` is a **major** finding —
  vendor knowledge lives in the plugin layer (`packages/cli`, connector
  packages), which registers with the core registry. Low-level shell
  helpers for tools bro itself invokes (`gh.ts`, `git.ts`) are plumbing,
  not facades, and stay in scope as their own modules.
- `packages/rig` is the lifecycle engine — usable by planes/ACP without
  a CLI spawn. An import of `plugins.ts` or `commands/*`, or a
  `process.exit`/`console.log` call in `packages/rig` is a **major**
  finding — argv, stdout, and exit codes are the adapter's job and live
  in `packages/cli`. Connector resolution goes through core's
  `facade` + `loadConfig` only.

## Verification expectations

- `hooks/run.sh` changes: must terminate for relative, nonexistent, and
  unset plugin roots (fixed-point break + absolute-path validation).
- Shell fallbacks: a failed candidate must fall through to the next —
  never swallow an error that masks a working fallback.
