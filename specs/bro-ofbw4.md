# bro-ofbw4 — serve lifecycle: dead-listener windows break claude auth path

## Problem

Live incident 2026-10-18: a claude session's Agent/Monitor calls failed
11:16–11:18 with "temporarily unavailable (timed out)" — no listener on
the pinned port for ~4 minutes until the apiKeyHelper's next run spawned
a 4th serve generation. Two gaps in the serve lifecycle:

1. **Re-ensure only happens on auth refresh.** The apiKeyHelper contract
   (`bro serve ensure --port <n>`) runs when claude refreshes auth, not
   per request. A dead serve between refreshes fails every call — the
   auto-mode classifier included — for the whole window. The listener
   needs its own keepalive/respawn leg; client cadence is not ours to
   change.
2. **`dir` anchors to the spawning worktree.** `bro serve` records
   `process.cwd()` in serve.json and runs with it as cwd; a serve
   spawned from a linked worktree (`bro--*` from `bro work enter`, a
   loop/convoy frame) keeps that path as `dir` and process cwd. When
   the worktree is later removed, the live serve's acp spawns break and
   `ensure` from the main checkout refuses ("port already serves
   \<dead path\>"). The common-dir serve.json already implies one serve
   per *repo* — the anchor must be the main worktree root, which
   outlives any linked checkout.

## Design

### Main-worktree anchor

`mainWorktreeRoot(dir)` in `@broject/core` (git.ts): the primary
checkout's root. `dirname(gitCommonDir(dir))` covers every ordinary
`<main>/.git` layout — linked worktrees resolve the same common dir, so
the answer is identical from any checkout. When the common dir is not
literally named `.git` (separate-git-dir exotica), the first
`git worktree list --porcelain -z` entry is the main worktree — git
guarantees the order. `null` outside a repository.

`runServeCommand` chdirs to the main root before anything reads cwd —
`dir`, the recorded serve.json `dir`, the health answer, the conductor's
`cfg.cwd`, and every child spawn inherit the durable anchor. Deleting a
linked worktree can no longer pull the floor out from under a live
serve. `ensureServe` resolves `repo` through the same helper, so an
ensure invoked from a linked worktree and a serve anchored to the main
root agree on one identity string (both realpath'd).

### Dead-anchor healing in `ensure`

The probe verdict is re-ordered to check *identity before location*: a
listener whose pid matches the recorded `serve.json` pid IS this repo's
serve — the file could only be written by a starter that resolved this
repo's common dir. Given pid-match:

- `h.dir === repo` → healthy, return the token (unchanged).
- `h.dir` names a path that no longer exists → the anchor is dead
  (deleted worktree, moved checkout): SIGTERM the recorded pid, wait
  out its grace (SIGKILL if wedged), then fall through to the normal
  spawn + poll path. The respawned serve anchors to the main root.
- `h.dir` differs but still exists → a pre-fix serve anchored to a
  live worktree is functional; accept it (token). Its respawn lands on
  the main root whenever the generation next turns over.

pid-mismatch keeps the existing refusals: foreign `dir` →
"already serves", same-dir foreign pid → "not the recorded serve",
up-without-state → "serve.json missing". In the post-spawn poll loop,
missing-state/pid-mismatch stay tolerated startup races; foreign-dir
still throws.

### Watchdog — the keepalive leg

Every `bro serve` arms exactly one detached watchdog after its
serve.json write: `bro serve watchdog --port <bound> --pid <servepid>`,
cwd the anchor dir, stdio appended to `bro/serve.log`. The watchdog
polls `readStateFile` every ~5s:

- record missing → **retire** (deliberate stop retracts serve.json
  before the process exits).
- `state.pid` differs → **retire** (a successor generation armed its
  own watchdog — at most one live watchdog per repo, modulo the handoff
  tick).
- recorded pid dead → respawn `bro serve --port <bound>` detached on
  the anchor, then settle ~15s; the serve.json.lock serializes any
  racing `ensure`-spawned starter — the loser refuses harmlessly.
  Persistent bind failure (squatted port) retries on the same cadence —
  cheap, self-healing when the port frees.

Spawn failure (e.g. the anchor itself is gone) is caught — the leg must
not die on a transient; the next tick reads the same dead record.

Exit paths (`SIGINT`/`SIGTERM` → server close → `clearServeState`) leave
no window where pid-dead + record-present is the steady state: the file
is retracted before exit, so only a crash (SIGKILL, OOM, parent-death)
produces a respawn — exactly the dead-listener window the incident
showed.

## Plan

- [ ] `mainWorktreeRoot` in `packages/core/src/git.ts` (+ index export)
- [ ] `runServeCommand`: chdir to main root; arm watchdog after
      `writeServeState` (bound port from `server.address()`)
- [ ] `ensureServe`: `repo` via `mainWorktreeRoot`; probe verdict as a
      shared `classify` — pid-first identity, dead-anchor heal
      (SIGTERM → grace → SIGKILL), preserve existing refusals
- [ ] `bro serve watchdog` internal subcommand (flag-validated, hidden
      from usage examples)
- [ ] Tests: `mainWorktreeRoot` from main + linked worktree; ensure
      from a linked worktree accepts a main-anchored serve; dead-anchor
      pid-match respawns (spawnServer called, kill observed); watchdog
      verdict table (missing → retire, different pid → retire, dead →
      respawn) via injectable deps
- [ ] `npm test`, commit, push, PR

## Assert

- A `bro serve` started inside a linked worktree records `dir` = main
  root and reports it from `/api/v1/health`; `bro work leave` on that
  worktree does not break the serve's spawns.
- `bro serve ensure --port <n>` from the main checkout and from a
  linked worktree both print the live serve's token.
- An ensure facing a recorded serve whose `dir` is gone SIGTERMs it and
  returns the next generation's token — no "already serves" refusal.
- A killed serve is re-listened on its bound port within seconds
  without any client call; a cleanly stopped serve leaves no watchdog
  behind.
