# bro-asdps — the open-PR listing breaks past Node's 1 MiB spawnSync buffer

## Problem

`bro act status` (and `bro act threads`) died with a bare `gh api failed:`
and nothing after it — no reason, no context, exit 0 — on a repo whose
open-PR listing is large enough. The gate that decides "is this PR done"
could not answer, and the error named nothing actionable.

The cause is a two-part interaction:

1. **`openPrs` asked for everything.** The REST pull listing
   (`repos/<repo>/pulls?state=open&...&per_page=100`) returns the FULL pull
   objects — every body, every reaction count. The connector reads two
   fields (`number`, `head.ref`) and threw the rest away. On this repo one
   page of open PRs answered **~1.9 MB**; the projection of the same page
   answers **~3.5 KB**.
2. **Node caps `spawnSync` output at 1 MiB.** Past the cap the child is
   KILLED with `ENOBUFS`: `proc.status` goes `null`, and `proc.error` holds
   the only clue. In THIS failure `gh` wrote nothing to stderr before it
   died, so `proc.stderr` was empty too — a child that speaks first would
   have left the reason there instead. `gh()` read `stderr` alone and
   swallowed `proc.error`, so the failure rendered as `gh api failed:`
   with nothing after it — an empty reason.

The async twins (`ghAsync`/`ghTryAsync`) stream into a string and never had
the cap; only the sync path was exposed.

## Design

Two fixes, one per cause — the projection is the root cause, the buffer is
the robustness floor.

### `packages/github/src/reviews.ts` — `openPrs` asks for the projection

```ts
'api',
`repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
'--jq',
'[.[]|{number,head:.head.ref}]',
```

`--jq` emits ONE json array (the `[...]` wrapper matters — bare
`.[]|{...}` emits NDJSON, which `JSON.parse` cannot read). The facade's
contract is unchanged: `{ pr, headRef }` rows, most-recently-updated first.

### `packages/core/src/gh.ts` — a real buffer, and a legible reason

- The sync helpers get `maxBuffer: 64 MiB` — orders of magnitude above the
  listing sizes these calls produce, and still bounded. The cap is a Node
  default, not a policy this repo chose. A `--paginate` listing over a very
  large repo can still exceed it; the caller then reads the ENOBUFS reason
  instead of silence.
- `ghFailure(proc)` replaces the bare `stderr` read, in this order: stderr
  when the CLI spoke, else the spawn error, else a bounded head of stdout
  (some tools print the diagnosis there), else the signal, else the exit
  code. A failure is never empty — an undiagnosable failure is its own bug.
- `ghTry` keeps a silent SUCCESS silent; only a silent FAILURE gains a
  reason. The CLI's own stderr still wins over the exit code, and a stdout
  diagnosis is never dropped in favour of a bare exit number.

## Verify

- `packages/core/src/gh.test.ts` — a fake `gh` that fails without stderr
  yields `gh api failed: exit 3` (and `ghTry` reports `exit 3`); a silent
  success stays silent; the CLI's stderr still wins; a diagnosis on stdout
  survives; a signal-killed child names the signal; a child printing 2 MiB
  survives (the regression: past 1 MiB Node killed it).
- `packages/github/src/reviews.test.ts` — `openPrs` maps the projected
  listing to `{ pr, headRef }` rows AND the recorded argv carries the
  `--jq` projection (the projection is the contract, not an optimization).
- Live: `bro act status` with no PR number resolves the repo's most
  recently updated open PR and prints its gate, instead of dying with
  `gh api failed:` and nothing after it.
