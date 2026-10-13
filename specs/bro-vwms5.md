# bro-vwms5 — bro dogfood: scenario-driven e2e self-test

## Goal

An e2e dogfooding framework inside bro, on the formula:

1. **Scenario** — a committed markdown runbook (`dogfood/<name>.md`)
   describing an agent journey through bro's own surface: commands in
   backticks, `$skill` names inlined, no links — everything the runner
   needs is in-repo.
2. **Runner** — a *fresh* agent spawned through the fleet registry
   (`spawnStepAgent` — the `bro fleet agents up` path, never nohup),
   working in a scratch repo provisioned per run, executing the
   scenario literally.
3. **Analyst** — a second agent (same spawn path; `--analyst <backend>`
   picks a different connector, `--analyst same` reuses the runner's)
   that reads the scenario, the runner's transcript, and the scratch
   repo's end state, then writes a verdict.

The run is orchestration-only: `bro self dogfood` composes the existing
registry spawn, run records, and exit classification — it does not
reimplement agent supervision.

## Command surface

Grouped under `self` (the judge lane):

- `bro self dogfood scenarios` — list committed `dogfood/*.md`.
- `bro self dogfood run <name> [--backend <c>] [--analyst <c|same|none>]
  [--keep]` — provision a run dir, spawn the runner, return the run
  id. `--analyst` defaults to `same` (the runner's backend); `none`
  skips the verdict pass; a connector name picks a different lane.
- `bro self dogfood status [run-id]` — run ledger: phase, agent ids,
  scratch repo path. Calling status **advances the pipeline lazily**:
  a runner recorded `exited`/`lost` triggers the analyst spawn there,
  not in a hidden daemon.
- `bro self dogfood report <run-id>` — print the verdict once written;
  the runner's exit record + log paths otherwise.

## Run lifecycle

Each run gets `bro/dogfood/<run-id>/` in the git-common dir:

```
scenario.md        — verbatim copy of the source scenario
state.json         — { phase, runnerAgent, analystAgent, bead, repo }
runner.prompt.md   — the wrapped prompt the runner received
analyst.prompt.md  — the wrapped prompt the analyst received
verdict.md         — the analyst's output
```

The scratch checkout itself lives under `os.tmpdir()`
(`bro-dogfood-*`), recorded as `state.repo` — never inside the run
dir or anywhere under the host tree: `bd init` walks ancestor
directories for an existing `.beads` config, and a scratch nested
under the host checkout would silently bootstrap the host's beads
remote instead of starting empty.

Phases: `running` → `analyzing` → `done` (or `failed` on
spawn/registry errors — recorded, never thrown mid-write).

## Runner mechanics

- The scratch repo is `git init`'d under tmpdir (own git store, own
  stealth `bd init` beads store — the runner's claims stay inside it).
  `bro` resolves on PATH — scenarios dogfood the installed build,
  which is the point.
- A real step bead is created per agent (`dogfood <name> <run-id>`
  for the runner, `<run-id> analyst` for the verdict pass) in the
  SCRATCH store — `spawnStepAgent`'s registry pin, claim, and dedup
  semantics apply unmodified, and the runner's entry can never
  collide with the analyst's. Host claims stay untouched.
- Scenarios resolve against the CURRENT checkout (`rev-parse
  --show-toplevel`) — a scenario still on a feature branch runs
  before it merges. The run dir and registry share
  `gitCommonDir(dir)`, so linked worktrees land in one ledger.
- The runner prompt = scenario markdown + the operating contract: work
  only inside the scratch repo, follow steps literally, note anything
  the runbook left ambiguous, end with a short report.
- Prompt/log land under `bro/agents/<id>.*` via the registry — never
  argv, never world-readable /tmp.

## Analyst mechanics

- Prompt = scenario + the `## Assert` expectations + the runner's
  transcript (log + `.exit` record) + instructions to inspect the
  scratch repo's surviving state (`git log`, `bd list`, worktree list,
  `bro status` output).
- Output contract: verdict line (`PASS` / `ISSUES`) then findings as
  bullets — the report renders it verbatim; a `fail` line lists
  assertions the run violated.
- `--analyst same` means "same backend", not "same session" — the
  analyst is always a fresh spawn; only the connector is inherited.

## Scenario contract

- Committed at `dogfood/<name>.md`; one `#` title, then prose steps.
- Commands the runner must execute appear in backticks and name real
  surface (`bro …`, `bd …`); skill invocations as `$skill` mentions.
- Optional `## Assert` section — natural-language expectations the
  analyst checks against transcript + repo state.
- No URLs: scenarios never send the runner to external docs; what it
  needs is the repo itself.
- v1 scope: remote-free functionality only (bd claims, specs,
  worktrees, janitor/resume, status/doctor, skill invocation).
  Scenarios needing a live forge wait on a `dogfood.remote` sandbox
  config — out of scope here.

## Non-goals

- Not a blocking watcher: `run` returns the run id; `status` is the
  point check. No `--wait` sugar — blocking waits are the anti-
  pattern the whole fleet surface exists to prevent.
- No agent reimplementation: runner/analyst are ordinary registry
  agents — `bro fleet agents`, occupancy caps, and exit records apply.
- No hidden scheduling: the pipeline advances only when someone asks
  (`status`/`report`), never from a background tick.

## Tests

- e2e: a scripted fake connector (the e2e matrix's spawn seam) runs a
  scenario whose steps are shell-verifiable; assert state.json phase
  transitions, run-dir layout, verdict.md written, scratch repo
  isolation (host `bro/` untouched).
- e2e: `--analyst none` skips the second spawn; `status` after runner
  exit is what spawns the analyst (lazy advance).
- e2e: a second `run` while one is `running` reports both; no shared
  state leaks between run dirs.
- unit: scenario discovery + run-id generation + prompt wrapping.

## Spec

spec: specs/bro-vwms5.md
