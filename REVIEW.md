# Review policy — bro

<!-- BEGIN bro:sdd -->
id: BRO-4
title: Review policy — bro
area: policy
status: active
core: [BRO-1]
<!-- END bro:sdd -->

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
- A conflict resolution that picks a whole side —
  `git checkout --ours/--theirs <file>` or pasting one side's file
  over the conflicted one — is **major**: it silently reverts whatever
  the other side changed in the same file, and the reverted work is
  invisible in the PR diff (it lives on the base branch). `rebase -X
  theirs` is not the same smell — it picks a side only inside
  conflicting hunks and still merges the other side's nonconflicting
  changes; flag it only when the reverted hunks held real concurrent
  work. Resolve hunks, then diff the resolved file against the
  current base tip (`git diff <base-tip> -- <file>`) — a merge-base
  comparison hides post-fork edits. Confirm every removed line belongs
  to the PR's own changes; a removal of code the PR never touched is
  dropped concurrent work, not a clean resolution, while retained
  concurrent edits are correct and must not be flagged.
- Reading a raw `options` value where a merged defaults object exists
  (`{...DEFAULTS, ...options}`) is **major**: an unset option arrives
  as `undefined` instead of its default and lands in output paths
  (`undefined@latest`, `bin/undefined`). Effective-value reads go
  through the merged object. Raw-`options` reads for caller intent —
  `'x' in options`, presence checks that must distinguish "explicitly
  passed" from "defaulted" — are legitimate and not a finding.
- Round-tripping a user-editable config file through
  `JSON.parse`+`JSON.stringify` is **major**: `.jsonc` files users
  hand-edit (nx.json, tsconfig, `.vscode/*.json`) may carry comments
  and custom formatting that a re-serialize destroys, and a bare
  `JSON.parse` throws on legal comments. Parse with `jsonc-parser`
  (declared as a direct dependency of the importing package), collect
  its errors and throw on any, and write via `modify`/`applyEdits` so
  untouched text survives verbatim. Manifest and lock files
  (`package.json`, lockfiles) are strict JSON — comments are illegal
  there, so `JSON.parse` is correct and adding comments is itself a
  finding.
- `packages/core` is vendor-neutral: it holds contracts, registries, and
  generic mechanics only (`agents.<kind>` knob bags, `sessionPlanes`,
  `connectors.*` seam). An import, path, identifier, or hard-coded state
  layout that names a concrete agent backend or provider (devin, tmux,
  gascity, opencode, …) in `packages/core` is a **major** finding —
  vendor knowledge lives in the plugin layer (`packages/cli`, connector
  packages), which registers with the core registry. Low-level shell
  helpers for tools bro itself invokes (`gh.ts`, `git.ts`) are plumbing,
  not facades, and stay in scope as their own modules.
- A vendor's knowledge lives in the vendor's own package
  (`packages/<vendor>`), and the vendor's **plugin** (`plugins/<client>`)
  inherits that facade — it does not re-implement it. The same vendor
  logic split across the CLI, the core and a plugin is **major**: the
  duplicate drifts, and the drift is invisible until the vendor moves.
- `packages/rig` is the lifecycle engine — usable by planes/ACP without
  a CLI spawn. An import of `plugins.ts` or `commands/*`, or a
  `process.exit`/`console.log` call in `packages/rig` is a **major**
  finding — argv, stdout, and exit codes are the adapter's job and live
  in `packages/cli`. Connector resolution goes through core's
  `facade` + `loadConfig` only.

<!-- BEGIN bro:sdd -->
## SDD gate — the spec is the product yardstick

- A behavior change in code owned by a spec without editing that spec
  (or its relevant part) in the same diff is **critical**, unless the PR
  states `spec unchanged: <reason>` and review confirms a refactor or
  no-behavior fix. Touching unrelated spec text does not satisfy the gate.
- Code that no spec owns is **major**. Owns-based rules activate once
  `owns` metadata exists; until then judge ownership from spec Owns/scope
  sections, without treating absent metadata as proof of coverage.
- Code ↔ spec divergence in either direction is **critical**. The PR
  must state which side is wrong and fix the other. A declared spec-ahead
  increment is permissible only with an open linked change bead covering
  the unimplemented behavior; otherwise it is a defect. Code-ahead is
  always a defect. Spec touches and commit timestamps are not proof of
  conformance.
- A spec contradicting another spec is **major**; reconcile the product
  contract, do not silently pick the convenient document.
- Specs describe the enduring product; beads describe changes. Bead
  closure never archives a spec. Removal is a product lifecycle change
  (`removed`), with provenance retained in git.
<!-- END bro:sdd -->

## Verification expectations

- Gate-shaped new code is a **minor** finding even before the scanners
  report it — a reviewer who sees a >4-positional-arg signature, a
  discriminator if/else that could be a handler map, a loop carrying
  inner conditionals, N near-identical JSX blocks, index-as-key, or
  `A && B || C` in shell should flag the shape in the diff. The full
  anti-pattern ↔ pattern list lives in AGENTS.md ("Green on first
  write"); review catches it so the gate never has to.

- `hooks/run.sh` changes: must terminate for relative, nonexistent, and
  unset plugin roots (fixed-point break + absolute-path validation).
- Shell fallbacks: a failed candidate must fall through to the next —
  never swallow an error that masks a working fallback.
