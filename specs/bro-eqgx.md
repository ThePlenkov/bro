# bro-eqgx — bro check: sverka as check executor, findings + stats back

## Problem

bro has no check facade. Repos that adopt sverka (terraform/stack-health)
run `sverka run` directly: bro can't surface per-step stats or findings,
can't gate on them, and the findings→beads direction has no ingestion
point. This bead lands the facade — execution + passthrough. Dedup of
findings into the debt ledger is a follow-up (deliberately out of scope —
it needs ledger schema work of its own).

## Design

New plugin `check` (CLI subcommand + skill + `check` config section —
plugin-shaped growth per AGENTS.md). `bro run` is taken (plan-file
executor, `kind`-routed); `check` collides with no doc verb/noun.

**sverka is the executor.** `bro check` spawns
`sverka run --format json` — the canonical machine contract — and parses
its envelope:

```json
{"command":"run","data":{"planId":"…","status":"success",
 "steps":[{"stepId","status","durationMs","exitCode","stdout","stderr","error"}…],
 "findings":N,"verdict":"…","summary":{…}},"durationMs":…}
```

`findings`/`verdict`/`summary` appear only under `--evaluate` (sverka
collects `*.sarif` from `.sverka/artifacts` and runs the policy gate).

**Binary resolution** (first hit wins):

1. `check.bin` in bro.config (path or command name — escape hatch)
2. `<root>/node_modules` walking up from the run root — the repo's own
   pinned install wins (stack-health case); the package entry
   (`@sverka/cli/dist/bin.mjs`, spawned via `process.execPath`) is
   preferred over `.bin` shims so Windows `.cmd` launchers never reach
   `spawn`
3. `sverka` on `PATH`
4. the `@sverka/cli` bundled with `@broject/bro` (new runtime dep —
   `bro check` works in any repo, not just ones that installed sverka)

Nothing resolving → exit 1 with an install hint. This is the same
shell-out posture bro takes with `gh`/`bd`/`git`; the bundled dep is the
fallback, not the contract.

**Config section** `"check"` (all optional):

```json
"check": {
  "bin": "sverka",            // override resolution entirely
  "config": "sverka.config.ts",
  "entry": "default",
  "executor": "host",          // host|docker → sverka --executor
  "evaluate": false            // pass --evaluate (SARIF collect + policy gate)
}
```

**Flags override config**: `--root <dir>` (default cwd), `--config`,
`--entry`, `--executor`, `--evaluate`, `--format text|json` (`--json`
alias — both spellings seen in bro), `-q/--quiet` and `-v/--verbose`
pass through to sverka.

**Output**

- text (default): one line per step — `✓ scan/gql 1.7s`,
  `✗ scan/rest-terraform exit 1 (error)` — then a totals line
  (`9 steps · 8 ok · 1 failed — 14.8s`), plus `findings: N · verdict: …`
  when evaluation ran. Failed steps also print a short stderr tail.
- `--format json`: the sverka `data` payload rewrapped as
  `{"command":"check","data":{…},"durationMs":…}` — passthrough, bro owns
  the envelope name only.

**Exit code** mirrors the executor: sverka's own code (0 clean; nonzero
on step failure or a failing policy verdict — sverka owns verdict→exit
mapping). Usage errors exit 2; unspawnable sverka or unparseable JSON
exits 1.

**COLLECTION_FAILED retry**: `--evaluate` on a config whose steps produce
no SARIF artifacts makes sverka emit `{"error":"COLLECTION_FAILED"}` and
lose the step stats. bro detects that payload, warns, and retries once
without `--evaluate` so the run report still lands (the flag/config then
wants fixing — the warn says so).

**Not in this PR**: findings→beads mapping + ledger dedup (needs the
debt-source seam), a `check` plan schema (flags suffice today), `bro
check` auto-wiring into `act`/the stop gate.

## Plan

- [x] spec (this file)
- [x] `packages/cli`: add `@sverka/cli` runtime dep; `src/commands/check.ts`
      — binary resolution, spawn, JSON parse, text/json render, exit codes
      (config section split into `check-config.ts` — leaf module, avoids
      a plugins.ts↔check.ts init-time cycle)
- [x] `check` config section + plugin registration in `plugins.ts`
- [x] `check.test.ts` — scripted `sverka` shim (node, like testrepo's fake
      bd): resolution order, flag pass-through, success/failure exit codes,
      COLLECTION_FAILED retry, bad JSON, renderText
- [x] `skills/check/` SKILL.md + agents/openai.yaml; plugin copies regen'd
      by `npm run build` (gen-plugins)
- [x] dogfood: `bro check` against terraform/stack-health (repo-local
      sverka, 10 steps ok) and a tmp-dir smoke config (bundled fallback,
      failing step → exit 1, --evaluate COLLECTION_FAILED retry)
- [ ] PR; act gate; merge
