---
parent: bro-huy5o
scope:
  - packages/core/src/connectors.ts
  - packages/github/src/tasks.ts
  - packages/github/src/index.ts
  - packages/cli/src/commands/next.ts
  - packages/cli/src/commands/loop.ts
  - packages/cli/src/commands/work.ts
  - packages/cli/src/commands/doctor.ts
---

# bro-huy5o.1 — tasks connector: github-issues (zero-install task store)

Parent: `bro-huy5o` (epic — adoption-first connector backlog).

## Problem

`bd` is bro's only `tasks` backend. A repo that wants `bro next` /
`bro loop` / `bro task` / the stop-gate task probe must install beads
first — the single largest adoption barrier (jsonl-only `stores` drops
the *artifact* projection, not the task store). GitHub Issues already
carries the primitives a task store needs — open/closed state,
assignees, labels, sub-issues, and `blocked_by` dependencies — so a
`tasks` facade on the github connector makes a GitHub clone a working
bro rig with zero installs beyond `gh`.

## Selection

- `connectors.tasks = "github"` in bro.config picks the facade by name.
  Pair with `stores: ["jsonl"]` to drop the beads artifact requirement —
  that is the zero-install shape.
- The facade is **name-only**: `optInFacades: ['tasks', 'tasksAsync']` on the github
  connector keeps `matchRemote` from silently claiming `tasks` on every
  github.com clone (a repo with `.beads` must not wake up on Issues).
  `optInFacades` is the per-facade form of `optIn` — listed facades are
  excluded from unnamed resolution; named picks bypass the filter.
- Default stays beads — unchanged.

## Mapping (Issues → TaskStore)

- **id** — the bare issue number (`"42"`); accepted forms `#42`, `42`,
  issue URLs.
- **status** — `closed` ↔ closed; open + `bro:claimed` label or any
  assignee ↔ `in_progress`; open + blocked ↔ `blocked`; else `open`.
- **blocked** — an open issue is blocked when it has an open
  `blockedBy` dependency, an open sub-issue (decomposed work is not
  itself ready — the sub-issues are), or a `blocked` label (manual
  marker for repos without dependency-API coverage).
- **ready** — open + unblocked + unassigned + unclaimed, ordered
  priority asc then created asc.
- **claim** — `addAssignees(me)` then verify then `bro:claimed` label.
  Check-then-act can't be atomic over REST: the protocol reads first
  (claimed → throw), writes the assignee, re-reads — a contested
  assignee set resolves to the lexicographically smallest login, the
  loser unassigns and throws. The label lands last so "label present ⇒
  claim verified".
- **close** — `gh issue close --comment <reason>`; `reopen` unassigns
  the actor and drops `bro:claimed` so the issue re-queues.
- **type / priority** — GitHub has no fields: `issueType` (native issue
  types) wins when set, then a `type:<t>`/`kind:<t>`/`epic` label, then
  a `<!-- bro: {...} -->` metadata trailer in the body (written by
  create/update). Priority reads `p<N>`/`priority:<N>` labels then the
  trailer; default 2 (bd's default).
- **children/deps** — `subIssues` and `blockedBy`/`blocking` edges;
  `link` supports `blocks`/`blocked-by` and `parent-child` (sub-issue),
  other types throw — never faked as comments. The sub-issue parent is
  NOT mapped to `row.parent`: in the contract that field means
  orchestrated-step (molecule/epic-child), which `bro next` gates out —
  a GitHub sub-issue has no orchestrator and must stay claimable.
- **prefix()** — `undefined` (the repo IS the scope); the probe still
  runs — a repo-resolution failure throws (fail closed).
- **GHES fallback** — `blockedBy`/`subIssues`/`issueType` are github.com
  schema additions. A schema error on those fields retries the query
  without them: relationships degrade to "none known" (everything
  unblocked, `children`/`deps` empty) — declared absent, not faked.

## Absent capabilities (honest, not faked)

mols/convoy, mesh, drill frames, provenance, the `bro task exec` escape
hatch, and `next --global` keep requiring bd — `checkBeads` call sites
in those commands are untouched. Commands that only need the TaskStore
surface (`next`, `loop --dry-run`, `bro task` verbs, `bro work enter`'s
best-effort claim) resolve through `facade('tasks')` and gate on the
*serving* backend: beads → `checkBeads()`; anything else → the
connector's `auth()` probe (`gh auth status`).

## Hook probes

The beads connector's sessionStart / parallelWork / stopGate probes
route through the resolution-aware `tasksAsync(dir, prefer)` instead of
the bd-bound `taskStoreAsync`, so the claimed-tasks gate and the
ready-queue context work on whichever backend serves — identical
behavior when beads serves.

## Doctor

A `tasks` row reports the resolved backend name and its auth probe —
`tasks: beads` / `tasks: github (issues)` or the remediation line.

## Acceptance

- `connectors.tasks="github"` + `stores:["jsonl"]`, no `bd`: `bro next`,
  `bro loop --dry-run`, `bro task` verbs, and the stop-gate task probe
  work; `bro doctor` shows the tasks backend.
- Tests: claim race (second claim throws; contested assignee resolves
  single winner), blocked-by ordering (blocked excluded, unblocked
  ordered), `optInFacades` never auto-picked.
