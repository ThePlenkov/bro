# Review policy — bro

## Skip these paths — do not review

Generated or vendored content; reviewing them burns the review budget on
code nobody edits by hand.

- `plugins/**` — generated client adapters (`scripts/gen-plugins.mjs`);
  review the canonical sources (`skills/`, `hooks/`, `plugin.json`) and the
  generator itself instead
- `vendor/**` — upstream submodule, not ours
- `package-lock.json`, `**/dist/**`, `**/*.generated.ts`
- `.agents/skills/`, `.agents/review-debt/` — local runtime state

## Severity calibration

- Hooks and launchers must fail open: a missing binary, empty env var, or
  network error must never stall or fail the client session. Any path that
  can `exit 1`, hang, or block on a hook event is a **critical** finding.
- `packages/cli/dist` and PATH fallbacks are the production path for
  installed plugins — treat breakage there as **major**, not minor.
- `scripts/gen-plugins.mjs` drift between canonical sources and generated
  adapters is **major** — stale copies ship to users verbatim.

## Verification expectations

- `hooks/run.sh` changes: must terminate for relative, nonexistent, and
  unset plugin roots (fixed-point break + absolute-path validation).
- Shell fallbacks: a failed candidate must fall through to the next —
  never swallow an error that masks a working fallback.
