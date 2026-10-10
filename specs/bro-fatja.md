# bro-fatja — session-attribution for shared mutable state — who last wrote dist is invisible

## Problem

Real incident: a rebuild in the main checkout silently reverted a live
dist hotpatch and the file watcher surfaced it as unattributed "user
action". bro already detects parallel *sessions* — `.work`/`.task`
markers under `<git-common>/bro/hooks/` — but nothing attributes the
*writes* those sessions make to shared mutable outputs (`dist/`,
`node_modules/`, any generated tree). When output changes under you,
"who did this" has no answer; a hotpatch can't tell whether its applied
state still stands or was overwritten by a later build.

The post-merge worker (`bro hooks post-merge-run`) is the recurring
unattributed writer: it rebuilds dist detached after every merge, and
its writes look identical to a hand-run `npm run build`.

## Design

A single-record **build stamp** at `<worktree-gitdir>/bro/last-build.json`
— the worktree's OWN git dir (`--git-dir`, same place `post-merge.done`
lives): outputs are per-worktree, so attribution is too, and the record
dies with `git worktree remove`. `.git/bro/last-build.json` on the main
checkout — the bead's literal path.

```json
{ "session": "agent-na", "ts": 1760000000000, "head": "abc…", "inputs": "sha256…", "via": "post-merge" }
```

| Field | Meaning |
| --- | --- |
| `session` | Writer's session id — env (`BRO_SESSION_ID` → `BRO_AGENT_ID` → runtime vars) → single-live-session marker scan of `<git-common>/bro/hooks/` → `'unknown'`. Attribution degrades to the `via` mechanism, never to a guessed name. |
| `ts` | Epoch ms of the write. |
| `head` | `HEAD` at write time — powers "build is behind HEAD". |
| `inputs` | sha256 over `HEAD` + `git stash create` (tracked/index content) + `git status --porcelain` (states + untracked names). Two stamps of the same tree state share inputs; a rebuild over moved code differs. Known gap: content churn inside an untracked file without a rename. |
| `via` | Writer label: `post-merge` for the refresh worker, a caller-chosen tag for `bro stamp` (`build`, `patch`, …). |

Writers:

- **`bro hooks post-merge-run`** stamps `via=post-merge` after a
  refresh pass that ran steps and advanced done-sha — inside the same
  file lock, fail-open like the rest of the worker. A no-step pass
  (nothing was written) does not stamp.
- **`bro stamp [via]`** is the manual door: a session that builds or a
  hotpatch script that applies state records its own write
  (`npm run build && bro stamp build`; a hotpatch ends `bro stamp patch`).
  Bare `bro stamp` reads the record back (`--json` for scripts) —
  that's the "did something overwrite my state" check: the newest
  record naming another session/via after your write is the overwrite.

Readers:

- **`bro doctor`** gains a `build` row: absent → ok "no stamped build";
  `head` behind `HEAD` → warn; another resolvable session's stamp →
  warn "another session rebuilt since your write". An unresolvable
  current session never guesses "not yours" — the row still reports
  the attribution.
- **`bro status`** gains a `build` field on the board (session, via,
  ts, behind-HEAD, mine) — one file read, local-only like the rest of
  the fast path.

Policy:

- **Fail-open everywhere.** Stamping must never fail a build, the
  refresh, or a hook; a missing/corrupt record reads as "no stamp".
- **Single record, last writer wins** — the file names the CURRENT
  owner of the output, not a history. Forensics live in the trace
  journals, not here.
- **Advisory, never a gate.** The row warns; nothing blocks.

## Plan

- [ ] `packages/cli/src/commands/buildstamp.ts` — record type,
      read/write, session resolution, inputs fingerprint, `bro stamp`
- [ ] `githooks.ts` — export `liveSessionIds` (any live marker, not
      just `.task` claims)
- [ ] `postmerge.ts` — stamp on successful refresh with steps
- [ ] `status.ts` — `build` board field + render line
- [ ] `doctor.ts` — `build` row (behind-HEAD + foreign-session warns)
- [ ] `plugins.ts` — register `stamp`; `utility.md` row
- [ ] tests: buildstamp unit (roundtrip, session chain, fingerprint),
      postmerge stamp assertion, doctor row, status field
