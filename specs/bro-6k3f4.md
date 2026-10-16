# bro-6k3f4 — stale-checkout drift must be visible

A checkout whose HEAD trails its recorded upstream fabricates phantom
state for every agent reasoning over it: files that look reverted,
"edits" that are really just an old main, drive verdicts read against
code nobody will ship. The trap is silent — nothing in `bro status` or
the session-start context names the drift, so an agent learns it only
after drawing a wrong conclusion.

## Change

`gitUpstreamBehind(dir)` in `@broject/core` — `@{u}` resolves the
branch's configured tracking ref, `rev-list --count HEAD..@{u}` the
drift. Strictly local: the remote-tracking ref is only as fresh as
the last fetch, and surfacing exactly that staleness is the point —
fetching inside a board/hook read would turn a cheap probe into a
network call. Returns `{ behind, upstream }` for positive drift,
`null` for current/no-upstream/git-failure — callers surface positive
drift only.

Two consumers:

- **`bro status`** — a `sync:` row under the `board:` line naming
  `<branch> N behind <upstream>`; the JSON board carries the same
  `sync` field for programmatic reads.
- **session-start context** (`sessionContextText` in `@broject/learn`)
  — a `sync:` context line so every hooked session sees the staleness
  before it interprets file state, not after.

## Invariants

- No fetch. The probe reads only `refs/remotes/*` — "behind the last
  fetch" is the honest claim, never "behind origin".
- Positive drift only: a current checkout emits nothing (null, not 0).
- Fail-open everywhere: detached HEAD, unborn history, no configured
  upstream, or git failure all read null — never an error on a board
  or a hook.

## Rejection test

- Repo with `origin/main` tracking: commit+push 2 ahead, reset local
  back → `{ behind: 2, upstream: 'origin/main' }`; reset to
  `origin/main` → null.
- No remote / detached HEAD → null, no throw.
