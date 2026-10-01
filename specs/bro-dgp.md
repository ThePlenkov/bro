---
parent: sessions
---

# bro-dgp — E2E matrix for dangerous paths: loop auto-merge, hook gates, worktree lifecycle

## Problem

bro's riskiest mechanics are its least tested:

- `bro loop` claims beads, spawns an agent in a worktree, and **merges PRs
  autonomously** — yet the whole drive-gate/finalize path (claim → spawn →
  gate → merge → close → cleanup) has zero end-to-end coverage. A
  regression lands code nobody reviewed or strands claimed beads and
  worktrees silently.
- `bro hooks` carries the **fail-open contract** — a wedged hook must
  never stall an agent session, and the stop gate must only block
  sessions that armed the aspect. Both invariants are pure policy with
  no process-level test; a broken `hooks/run.sh` or a swallowed
  `decision: block` ships unnoticed.
- `bro work` owns the **worktree lifecycle** — spawn/leave/prune. Refusal
  paths (dirty tree, locked, main worktree, stale admin entries) are the
  data-loss guardrails; they are only unit-tested at the parser level.

## Design

Tests run the **built CLI** (`packages/cli/dist/index.js` — CI builds
before `npm test`) against real-git fixture repos (`initRepo` in
`testrepo.ts`). No `bd`, no `gh`, no network:

- **Fake `bd`** — a node shim earlier on `PATH`, backed by a JSON file
  (`FAKE_BD_DB`). Implements the loop surface: `ready`, `show`,
  `update --claim/--status/--notes`, `close`, `list`, `where`,
  `config get issue_prefix`, `merge-slot create|acquire|release`,
  `--version`. Real claim semantics: claiming a non-open bead fails.
- **Fake review host** — an external connector plugin (`fakehost.ts`
  written into the fixture, loaded via bro.config.json `plugins` +
  `connectors.reviews`), driven by a `host.json` state file the test and
  the fake agent mutate. `mergePr` persists state so the post-merge
  `prMeta` probe sees `MERGED`. Also exercises the external-plugin seam.
- **Fake agent** — `node fake-agent.js` as `loop.agent`; keys off the
  scenario env var and the prompt file (`<review-threads>` marks a fix
  round), commits in the worktree, opens the "PR" by writing `host.json`,
  or closes the bead via the fake `bd`.
- **Hook gates** — spawn `bro hooks <event>` with a JSON stdin payload in
  fixture repos: armed markers are real files under
  `<git-common>/bro/hooks/`, the `work` stop-gate contribution is real
  (dirty linked worktree), so `decision: block` and the arming scoping
  are verified through the actual dispatch, plus `hooks/run.sh` itself.
- **Work lifecycle** — spawn `bro work enter|leave|list|prune`: exit
  codes and fs state are the assertions (exit paths can't run
  in-process — `process.exit` would kill the test runner).

## Matrix

### loop (`loop.e2e.test.ts`)

- `--dry-run` prints the plan and claims nothing
- land: claim → agent → green gate → merge → `bd close` → worktree +
  branch removed → clean audit
- fail: agent exits non-zero, no PR → bead reopened + noted, worktree
  kept
- verdict: agent `bd close`s the bead → result `closed`, never reopened
- park: open threads with `fixRounds: 0` → parked, worktree kept, claim
  retained
- fix round: open threads → agent respawned on fix prompt → threads
  resolved → landed
- park: `mergePr` reports a non-MERGED post state (merge queue) → parked
- park: PR closed externally while the gate polls → parked
- park: PR lookup failure → parked (never reopens a bead whose PR may
  exist)

### hooks (`hooks.e2e.test.ts`)

- stop: unarmed session in dirty linked worktree → no block (ambient
  state is passive, not an obligation)
- stop: armed `work` + dirty linked worktree → `decision: block`
- stop: `stop_hook_active` → silent (no re-block loop)
- stop: armed `work` + clean worktree → armedHint, not a block
- post-tool: successful `git push` arms `act`; `bro work enter` arms
  `work` + `task`; failed tool_response arms nothing
- permission: `bd`/`bro` auto-approve; other commands don't
- fail-open: garbage stdin, unknown event, non-bro dir → exit 0, silent
- session-start: main checkout gets the parallel-friendly nudge
- `hooks/run.sh`: exits 0 on unknown events; emits the stop block when
  armed + dirty (the real launch path)

### work (`work.e2e.test.ts`)

- enter → sibling worktree on `work/<slug>`; second enter fails
- enter a bead slug → claim surfaces in output (fake `bd`)
- leave → clean linked tree removed, branch kept; `--delete-branch`
  deletes it
- leave refuses a dirty tree; `--force` removes it
- leave refuses the main worktree and a locked tree
- prune drops an admin entry whose directory was deleted by hand
- list reports linked/main with state labels

## Plan

- [ ] spec (this file)
- [ ] `testrepo.ts`: `runCli` (dist spawn, sanitized env), fake `bd`
      installer, fake host plugin + fake agent writers
- [ ] `loop.e2e.test.ts` — the auto-merge matrix
- [ ] `hooks.e2e.test.ts` — gate arming + fail-open + `run.sh`
- [ ] `work.e2e.test.ts` — lifecycle + refusal paths
- [ ] `npm test` (tsx --test, the CI command) green; lint/typecheck
