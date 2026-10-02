# bro-vf1j — bro watch — one-shot convoy/session status surface

Parent: `bro-f4ot` (agents facade + bro fleet). `bro fleet` (bro-g4vn)
renders one table; `bro watch` is the deterministic heartbeat an
orchestrator calls — the same snapshot whether the driver is a
subagent, nohup, or cron.

## Problem

Supervising parallel convoys is hand-rolled per session: `bro convoy
status` per mol, `bro fleet` for agents, `bro act status` per PR —
three reads a watcher must glue together, and none answers the actual
question: *what needs attention right now?* A fleet row marked
`lost — respawn?`, a human gate that became ready, a PR whose exit
gate went BLOCKED — those are events a parent session should see, but
today they only surface when someone thinks to look.

## Design

`bro watch` composes the three read planes into one snapshot:

- **mols** — every open molecule through `nextStep()`: `state`
  (step/gate/blocked/complete), ready steps, gates, in-progress,
  blocked. Pure beads reads — no backend, no network.
- **gates** — the act exit gate per PR discovered through the fleet
  (worktree branch → open PR). `fetchPrActState` +
  `evaluateExitGate` with the repo's `act.ignoreChecks`/`maxRounds`.
  Best-effort: no review host (or a dead one) renders the section
  `unavailable`, never kills the snapshot.
- **fleet** — the `bro fleet` rows (mols × steps × agents ×
  worktrees × PRs), same machinery, same honesty rules: a degraded
  backend renders `unknown`, never `lost`.

The snapshot leads with an **attention** list — the heartbeat's
answer: ready human gates, `lost — respawn?` agents, BLOCKED exit
gates. Empty list = the fleet is quiet.

```text
bro watch [--once]      one snapshot (default — the heartbeat call)
bro watch --every N     tick the snapshot every N seconds
bro watch --notify      drop each tick's snapshot into the mailbox
bro watch --json        machine-readable: {ts, attention, mols, gates, fleet}
```

`--every` exists so `bro watch` *can* loop, but the cadence owner is
the deployment — a supervisor that wants ticks on a schedule re-invokes
`--once`; the flags compose (`--every 60 --notify`).

**Read-only.** `bro watch` never claims, never mutates beads, never
touches the registry. The only write is `--notify`'s mailbox drop.

**Mailbox** — `<git-common-dir>/bro/notify/`, the contract bro-d8zo's
notify connector drains. Each emission is one atomic file
(`watch-<epoch_ms>-<rand>.txt`, tmp+rename — a reader never sees a
half-written event) containing the rendered snapshot. In `--every`
mode an unchanged snapshot is not re-emitted — a heartbeat reports
transitions, not noise. No common dir → `--notify` warns and skips.

The `watch` skill carries arming policy only (when a session should
run a watcher) — all mechanics live here.

## Plan

- [ ] `packages/cli/src/commands/watch.ts` — snapshot collection +
      render + `--every`/`--notify`/`--json`
- [ ] fleet.ts: export `collectAgents`/`fleetRows`; `FleetRow` gains
      `prNum` so watch can feed PRs to the act gate without re-parsing
      the rendered link
- [ ] plugin entry (`watch`, skill `watch`) in plugins.ts
- [ ] `skills/watch/SKILL.md` + `agents/openai.yaml`; regen
      skills-data + plugin adapters
- [ ] `watch.test.ts` — arg parsing, attention derivation, notify
      dedup/atomicity (fixture repo)
- [ ] `npm test` (exact CI command)
