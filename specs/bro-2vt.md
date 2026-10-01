---
parent: distro
---

# bro-2vt — bro doctor: environment diagnostics command

## Problem

bro orchestrates `gh` + `bd` + `git` + worktrees + spawned agents — four
external tools with independent failure modes — and there is no diagnostic
entrypoint. When a user's setup breaks (gh auth lapsed, bd too old for the
Dolt store, hooks silently no-op because nothing resolves), the failure
shows up as a missing gate or a mid-command crash, not as a diagnosis.

## Design

`bro doctor` runs a fixed set of probes and reports one line each —
`✓` ok, `!` warn, `✗` fail — plus a trailing hint for anything not ok.
Exit 1 when any check fails; warnings pass. `--json` emits
`{ ok, checks: [{ name, status, detail, hint }] }` for machines.

Checks:

- **node** — `process.version` ≥22.18 (native type stripping is what
  makes `bro.config.ts` loadable). Below → warn, json config still works.
- **git** — `git --version` resolves; missing → fail (everything shells
  out to it).
- **gh** — `gh --version` then `gh auth status`. Missing → fail (hard
  runtime dep); present but unauthenticated → fail with `gh auth login`.
- **bd** — `bd --version` parses a semver. Missing → fail when `beads`
  is an active store, warn otherwise (jsonl-only is a supported shape).
  Compat probe: `bd dolt remote list` succeeding proves the Dolt-era
  backend bro relies on; failing → warn "bd predates Dolt — upgrade".
  When `.beads/` exists, `bd list --json -n 1` proves the store is
  readable; failing → fail (initialized but broken).
- **hooks** — replay the `run.sh` resolution order: local
  `packages/cli/dist/index.js` walking up from the plugin root → `bro`
  on PATH passing the `bro hooks` probe → `npx` fallback. Report which
  leg resolves; none → warn (hooks fail open by design, so this is a
  warn, not a fail).
- **config** — `bro.config.ts` present → ok (note precedence);
  `bro.config.json` must parse to an object → fail on invalid JSON;
  unknown top-level keys → warn (typo'd section names silently no-op).
  No config at all → ok, "defaults".
- **remote** — `git remote get-url <sync.remote>` → ok with the URL /
  warn when absent (`bro sync` and dolt replication need it). When
  `.beads/` exists: `bd dolt remote list` non-empty → ok; empty → warn
  "beads state is local-only".

Probes shell out through the existing `bdTry`/`gitTry`/`spawnSync`
contracts — PATH lookup, generous timeouts, fail-open internals. A probe
that errors reports `fail`/`warn` with the stderr detail; doctor itself
never throws.

`doctor` is a diagnostics command, not a policy surface — no skill, no
config section, no plan schema (same shape as `setup`/`cleanup`).

## Plan

- [ ] `packages/cli/src/commands/doctor.ts` — probes + report + `--json`
- [ ] register `doctor` in `plugins.ts` (visible in `bro --help`)
- [ ] `doctor.test.ts` — fake-bin PATH shims (spec.test.ts pattern):
      missing bd fails under beads stores, warns under jsonl; bad config
      JSON fails; unknown config keys warn; exit code reflects failures
- [ ] README commands table row
- [ ] `npm test` (the CI gate) green
