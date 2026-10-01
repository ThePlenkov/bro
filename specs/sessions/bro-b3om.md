# bro-b3om — loop worktrees: pin agent bd at the shared store; honor a close verdict

## Problem

A loop worktree is a full checkout, and an agent's `bd` inside it is not
guaranteed to resolve the main store — a tracked `.beads` copy can shadow
git-common-dir discovery, and older bd versions lack that discovery
entirely. Every `bd close`/`bd update` then lands in a database that dies
with the worktree. Worse, even when writes do reach main, the loop counts
"agent exited, no PR" as failure: `failNoPr` reopens the bead,
resurrecting a deliberate close as phantom-open in `bd ready`. Seen in
docker-x/devenv (9 beads) and cdk8s-charts (2) — all verified-done by
agents, all still open in main.

## Design

Two coupled changes in `bro loop`:

- **Pin the store.** At run start, resolve the beads dir the loop's own
  `taskStore` calls use (`bd where --json` → `.path`) and inject it as
  `BEADS_DIR` into the spawned agent's env (and bootstrap's). An explicit
  env pin beats discovery on every bd version — the worktree cannot fork
  bead state, whatever it contains.
- **Honor the verdict.** The work prompt gains a rule: when the task
  needs no code, `bd close "$BRO_BEAD_ID" --reason '<why>'` IS the
  verdict. `runItem` checks bead status when the agent leaves no PR:
  `closed` → a new `closed` tally bucket, not a reopen. A bd outage on
  the check falls through to the existing failure path.

Non-goal: `bro work enter` — it spawns no process, so env cannot be
pinned; its sessions are human-driven and current bd already resolves
the common-dir store.

## Plan

- [ ] `resolveBeadsDir` + `BEADS_DIR` in agent/bootstrap spawn env
      (`packages/cli/src/commands/loop.ts`)
- [ ] `agentVerdict` — agent-closed bead without a PR tallies `closed`,
      not `failed`
- [ ] work-prompt verdict rule (`packages/loop/src/prompt.ts`) + skill doc
- [ ] tests + `npm test`
