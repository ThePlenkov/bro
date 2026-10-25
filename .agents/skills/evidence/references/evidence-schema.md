# Evidence File Schema (v1)

The canonical schema for `.evidence/<date>/<task>/<claim-slug>/claim.json`.
See [`./claim.json`](./claim.json) for the JSON
template. Mandatory keys + rules:

- `claim` — exact sentence you intend to send
- `slug` — kebab-case, matches the dir name
- `agent`, `session_id`, `produced_at`
- `target_environment` — `backend | cli | frontend | browser | integration | static-analysis | test-suite | db-migration | docs | other`
- `verification_method` — `command | test-suite | browser-automation | static-analysis | manual | e2e-scenario`
- `preconditions` — non-empty list of what was true before the claim
- `commands` — **≥ 1 entry, each with `cmd`, `cwd`, `exit_code`, `duration_ms`, `stdout_excerpt`, `stderr_excerpt`**. Empty `commands` is structurally invalid.
- `assertions` — **≥ 1 entry, each with `name`, `passed`, `evidence_quote`**. `evidence_quote` MUST be an exact line from one of the `commands[*].stdout_excerpt` or from a sibling artifact. A name without a quote is structurally invalid.
- `files_changed` — absolute paths
- `artifacts` — log / screenshot / trace / report / bundle with `path` + `sha256`. **For `target_environment=browser`, `artifacts` MUST include ≥ 1 entry with `kind` in {`screenshot`, `trace`}. For `target_environment=db-migration`, ≥ 1 entry with `kind=log` showing the post-migration schema.**
- `remaining_gaps` — honest, non-decorative list (can be empty)
- `self_recheck.performed` — MUST be `true`
- `self_recheck.result` — `still-holds | drifted | invalid`
