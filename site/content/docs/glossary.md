---

title: Glossary
description: One line per concept — the vocabulary bro uses everywhere, defined once.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

## Work items

- **bead** — one unit of work in the `bd` store; the atom every bro workflow is made of.
- **molecule** (**mol**) — the persistent instantiation of a formula: a root bead plus child step beads wired by `blocks` edges.
- **formula** — a named, reusable workflow template; pour it to get a molecule.
- **proto** — an uninstantiated molecule template; beads' own name for what bro calls a formula.
- **wisp** — an ephemeral molecule in the wisp namespace, outside `bd list`; drill frames use it so a scratch descent never litters the queue.
- **gate** — a blocking condition on a step (`agent` gates run unattended, `human` gates stop the convoy for a person).
- **ready** — a bead with no open blockers; `bd ready` is the queue workers pull from (see [next](/docs/commands/next)).
- **claim** — an atomic take on a bead or molecule step; two sessions cannot claim the same step.

## Orchestration

- **[convoy](/docs/commands/convoy)** — a molecule in execution: `bro flow convoy` is the scheduler as code (`next` claims, `done` advances).
- **[fleet](/docs/commands/fleet)** — the set of registered agents bro has spawned, their worktrees, claims, and exit records.
- **rig** — one machine's whole bro installation: checkout, config layers, stores, daemons, fleet.
- **[loop](/docs/commands/loop)** — the hands-off backlog runner: claims ready beads, works them through the gate, repeats.
- **drive** — post-PR supervision: orphaned threads get a fixer agent, orphaned green PRs merge (see [act](/docs/commands/act)).
- **watch** — the monitor loop over molecules and PRs; point checks, never blocking waits (see [act](/docs/commands/act)).
- **pulse** — a session-owned beat that ticks on a cadence so long-running work stays observable (see [fleet](/docs/commands/fleet)).
- **daemon** — the project-scoped supervisor: `bro daemon run` _(0.3.0)_ _is_ the drive loop — post-PR supervision that outlives your session; watch rearm rides the session-start nudge, not the daemon.
- **[stack](/docs/commands/stack)** — a bead→worktree→PR chain where each PR builds on the previous one.
- **mesh** — federation between rigs: `mesh://` identities, peer bindings, cross-repo work requests.
- **mailbox** — the per-session notification spool; `bro notify` drops land there and drain at turn boundaries (see [events](/docs/commands/events)).

## Review & quality

- **[act](/docs/commands/act)** — the review-fix loop on an open PR: `bro act status` is the merge gate, threads are the work.
- **[debt](/docs/commands/debt)** — review findings left on merged PRs, swept into a ledger and worked later.
- **[judge](/docs/commands/judge)** — the calibrated decider inside loops: triages review comments, escalates low-confidence calls.
- **[guard](/docs/commands/guard)** — a declarative prompt contribution that fires on a hook event when its condition holds.
- **[drill](/docs/commands/drill)** — a scoped descent frame: narrow investigation, mandatory result and prevention plan on close.
- **retro** — the end-of-session self-review: uncommitted work, dangling watches, lessons worth keeping (see [retrospect](/docs/commands/retrospect)).
- **wtf** — the frustration capture: vents become structured findings instead of lost context (see [retrospect](/docs/commands/retrospect)).
- **[learn](/docs/commands/learn)** — the lesson store; `bro self learn` makes a finding outlive the session.
- **sdd** — spec-driven development: `specs/<bead>.md` before code, enforced when the gate mode is on (see [spec](/docs/commands/spec)).
- **[sweep](/docs/commands/sweep)** — pruning: dispose closed beads, archive history, run the harvest pipeline.
- **dogfood** — bro's e2e self-test: a committed runbook executed by a fresh agent in a scratch repo.

## Planes & plumbing

- **connector** — the swap-in boundary for a backend: review host, task store, agent plane, events (see [providers](/docs/commands/providers)).
- **agent plane** — where workers run (native spawn, docker, ACP…); `bro fleet agents` is its facade (see [fleet](/docs/commands/fleet)).
- **worktree** — a linked git checkout; `bro work enter` gives each unit of work its own.
- **serve** — the HTTP facade (`bro fleet serve`): agents/fleet/snapshot planes as JSON + SSE for thin clients (see [fleet](/docs/commands/fleet)).
- **[status](/docs/commands/status)** — the live project board in one read: beads, fleet, drill frames, PRs.
- **hook** — a client lifecycle event (session start, stop, post-compaction) bro hangs state on.
- **skill** — the policy half of a capability: markdown an agent reads; the CLI is the mechanics half (see [skills](/docs/skills)).
- **plugin** — the portable packaging contract: root `plugin.json` plus `skills/*/SKILL.md` (see [plugins](/docs/plugins)).
- **trace** — session journals shipped to an OTel backend for cost and behavior attribution.
- **sync** — publishing bro artifacts across machines via git refs (`refs/dolt/data`, `refs/bro/data`; see [restore](/docs/restore)).
