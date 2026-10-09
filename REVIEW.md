# Review policy — bro

## Skip these paths — do not review

Generated or vendored content; reviewing them burns the review budget on
code nobody edits by hand.

- `plugins/**` — generated client adapters (`scripts/gen-plugins.ts`);
  review the canonical sources (`skills/`, `hooks/`, `plugin.json`) and the
  generator itself instead. Two exceptions stay in scope:
  `plugins/claude/bro/hooks/hooks.json` and
  `plugins/codex/bro/hooks/hooks.json` (hand-written event names), and
  every `plugins/<client>/bro/skills` entry. That entry must be a symlink
  to the repo `skills/` tree. A real directory there is a second copy of
  the skill tree — **major**, even though the rest of `plugins/**` is
  skipped. Review the link, not the skill bodies.
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
  adapters is **major** — a stale manifest or a skills link that is not
  the repo `skills/` tree ships to users verbatim.
- A second copy of `skills/` is **major**: a real directory at
  `plugins/<client>/bro/skills`, a duplicated `SKILL.md` outside
  `skills/`, or a generator mode that copies the tree for one host.
  One tree, symlinks only. A host that drops symlinks at install time
  does not justify committing the copy.
- `packages/core` is vendor-neutral: it holds contracts, registries, and
  generic mechanics only (`agents.<kind>` knob bags, `sessionPlanes`,
  `connectors.*` seam). An import, path, identifier, or hard-coded state
  layout that names a concrete agent backend or provider (devin, tmux,
  gascity, opencode, …) in `packages/core` is a **major** finding —
  vendor knowledge lives in the plugin layer (`packages/cli`, connector
  packages), which registers with the core registry. Low-level shell
  helpers for tools bro itself invokes (`gh.ts`, `git.ts`) are plumbing,
  not facades, and stay in scope as their own modules.

## Verification expectations

- `hooks/run.sh` changes: must terminate for relative, nonexistent, and
  unset plugin roots (fixed-point break + absolute-path validation).
- Shell fallbacks: a failed candidate must fall through to the next —
  never swallow an error that masks a working fallback.
