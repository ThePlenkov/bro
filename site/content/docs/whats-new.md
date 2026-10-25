---
title: What's New
description: Human-readable release notes — what each bro release lets you do, grouped by capability.
---

Release notes for people, not for `git log`. Every release gets one
section — what you can now do, grouped by capability, plus whatever
upgrading actually asks of you. The canonical ledger stays in
[CHANGELOG.md](https://github.com/ThePlenkov/bro/blob/main/CHANGELOG.md);
this page is its narrative twin.

## 0.3.0 — the rig wakes up (upcoming)

*Not yet on npm — this section tracks the upcoming release.*
*Latest published is 0.2.5.*

### Watch a worker think

A running agent used to read as "frozen, then — everything at once."
The wire always streamed; nothing surfaced it. Now it does:

- **`bro fleet agents log <ref> --follow`** (flat alias
  `bro agents log --follow`) — a live tail of any managed agent's
  recorded log, by agent id or molecule step. Janitor truncation and
  respawn-reopen are announced on stderr, never silently skipped;
  stdout carries log bytes only, so it pipes clean.
- The same tail over HTTP:
  **`GET /api/v1/agents/<ref>/log?follow`** on `bro fleet serve` —
  server-sent events, gated by the serve bearer token (agent logs can
  carry secrets; loopback alone is not the auth boundary).
- Underneath, a generic seam: ACP `onUpdate` notifications are now a
  streaming surface providers can ride — `chat`/`call` stream where
  the backend supports it, and the acp conductor keeps one session
  per client conversation instead of respawning per turn.

### `bro fleet serve` grew a catalog

The HTTP facade stopped being a pile of hand-written routes:

- **`GET /api/v1/planes`** — the plane index: every registered plane
  with declared reads, verbs, and live capabilities. Reads
  (`/api/v1/planes/<plane>`, `/<plane>/<read|ref>`) and verbs
  (`POST /api/v1/planes/<plane>/<verb>`) are generated from the same
  descriptors the MCP server consumes — REST and MCP can never
  disagree about what a plane exposes.
- **`GET /ui`** — a dashboard generated from that index: one panel
  per plane, live capability badges, degraded planes dim instead of
  faking empty lists, and an SSE upgrade when the events plane can
  stream. The index *is* the layout contract.
- **`GET /api/v1/events/stream`** — server→client SSE over the local
  bus with native `Last-Event-ID` resume; `asyncapi.json` ships the
  generated schema next to it.
- The **ACP conductor** re-landed: `POST /v1/messages` rides
  `devin acp` — claude-class models through the operator's existing
  devin auth, no Anthropic key — now with image content blocks on the
  wire and retained sessions (see
  [the provider plane](/docs/commands/status)).

### One engine under the orchestration

`loop`, `drive`, and `convoy` each reinvented fragments of the same
lifecycle. The rig engine is the single state machine they now share
— worktree = materialized work item, replay from durable state as the
resume model:

- **`bro work queue <subject>`** — frame-scoped intake: rank-ordered
  items (`ls`, `bump`, `rm`) that promote to drill frames with
  `bro work queue drill <id>` — the queue is labels on beads, so it
  syncs with the store.
- **`bro work drill park --wake "<predicate>"`** /
  **`bro work drill wake`** — a frame can suspend itself until
  something is true; the waiting stack (`waiting`) stops cluttering
  the active set.
- **`bro fleet agents up <step>`** mints the worktree itself —
  enter → claim → spawn is one transition. No more manual
  `git worktree add` mid-flow.
- **`bro rig next`** — the engine's stateless re-entry verdict
  (`step|gate|wait|done|blocked`); loop and drive re-entry now ride
  it instead of keeping private schedulers.

Design notes: [the rig engine](/docs/design/rig-engine).

### A human in the merge gate

`drive.merge:auto` could land agent output with zero human sign-off —
a green exit gate meant threads, CI, reviewers, and SAST settled, never
that a human approved the code. **`act.requireApproval: true`** (in
`bro.config`) adds the sign-off: auto-merge waits for a trusted human's
approving review **on the PR's current head** — the latest decision
review per reviewer decides, a standing `CHANGES_REQUESTED` vetoes, bot
approvals never count, and **`act.approvers`** narrows "trusted" to
named logins so a machine account can't sign off on the agent's own
output. GitLab approvals map lazily — probed only while the gate is on
— and an unanswerable probe reads as *not approved*, never a pass. On
GitLab, current-head binding rides the project's
reset-approvals-on-push rule; keep `drive.merge: 'never'` plus branch
protection as the server-side boundary either way.

### The site you're reading

The docs caught up with the product: the landing rewritten around one
job-to-be-done ("your agent opened a PR — who drives it to merge?"),
a [glossary](/docs/glossary) — one line per concept — a generated
[command reference](/docs/reference/agents) with one page per registry
command so docs can't drift from the CLI, a curated
[design section](/docs/design/rig-engine) for the load-bearing specs,
and this page.

### Upgrading to 0.3.0

- **Package:** `@theplenkov/bro` is deprecated — install
  **`@broject/bro`** (`npx -y @broject/bro@0`). The npx pin now
  derives from the plugin's own major, so it can't lag a release
  again.
- **Commands:** nothing was removed. Grouped spellings
  (`bro <group> <member>`) are canonical; flat spellings still
  dispatch. The `flatDeprecated` knob shipped — a flagged flat name
  warns once and points at its grouped form — and no built-in name is
  flagged yet. Retirement, when it comes, is per-name, never in bulk.
- **Config:** `act.requireApproval` defaults off — opt in for human
  sign-off on auto-merge.
- **Also in the ledger:** `bro fleet status` surfaces stale-checkout
  drift (a sync row when you're behind upstream); worktree removal
  refuses while processes are rooted in it; drive enumerates
  remote-only fleet branches as PR candidates; a devin session plane
  rides a read-mostly connector; the claude-plugin dogfood scenario
  joined the self-test runbook. Fixes, test work, and CI bumps stay
  in [CHANGELOG.md](https://github.com/ThePlenkov/bro/blob/main/CHANGELOG.md).
