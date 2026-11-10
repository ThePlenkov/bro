---

scope:
- packages/cli/src/commands/watch-clock.ts
- packages/cli/src/commands/watch-clock.test.ts
- packages/cli/src/commands/watch.ts
- packages/cli/src/commands/watch-heartbeat.ts
- packages/cli/src/commands/watch-heartbeat.test.ts
- packages/cli/src/commands/watch.test.ts
- skills/watch/SKILL.md
- skills/pulse/SKILL.md

---

# bro-i7t3b — watchdog: verify ticks against an external clock

## Problem

Incident: a watcher subagent on synthetic context reported a digest
claiming 5 merges across PRs #660–#665 — with merge timestamps in the
_future_. The report was fabricated (the named PRs were not all merged)
and the timestamps were impossible, yet nothing in the pipeline caught
either: the orchestrator relayed the digest, and the tick's own
timestamp was never checked against anything but the local wall clock.

Two trust gaps:

1. **A tick's `ts` is self-certified.** `bro watch`/`bro pulse` stamp
   every snapshot and `heartbeat.json` from `Date.now()`. A skewed
   local clock (suspend/resume drift, WSL time jump) — or a reader
   comparing a stamp against its own skewed clock — produces "last
   tick Nm ago" and merge times that can be impossible, with no marker
   that the times are unverifiable.
2. **Merge reports are relayed unverified.** A watcher digest that says
   "merged" is prose — the authoritative verdict is `gh pr view`'s
   `state: MERGED` + `mergedAt`. Digest policy never required the
   probe, so a hallucinated merge read exactly like a real one.

## Design

### The clock plane — `watch-clock.ts`

Every tick cross-checks the local wall clock against the review host's
own clock: the HTTP `Date` response header `gh api / --include` returns
(RFC 7231 GMT) — the same external authority the bead names. The
snapshot gains:

```ts
clock?: {
  local: string        // Date.now() at probe time, ISO
  remote?: string      // the host's Date header, ISO
  skewMs?: number      // remote - local; + = local clock behind
  skewed?: boolean     // |skewMs| > CLOCK_SKEW_MS — times unverifiable
  error?: string       // probe failed — clock unverified, not skewed
}
```

- **Gating.** The probe runs only when the serving reviews connector
  is `github` (`facadeName('reviews')`) — a non-gh host has no gh clock
  to check, so `clock` is omitted rather than a per-tick error.
- **Bound.** `CLOCK_SKEW_MS = 60_000`: sub-minute drift leaves every
  "Nm ago" reading honest; past it a reported time can be impossible.
- **Attention.** `skewed` →
  `clock skew ±Ns (local <ts> vs host <ts>) — reported times unverifiable`;
  probe failure → `clock unverified — <err>`. Verified-and-aligned is
  silent — quiet is a verdict too.
- **Header.** `renderSnapshot` annotates `bro watch — <ts>` with
  `· clock skew +135s` / `· clock unverified` so the drop's own headline
  carries the caveat.
- **Dedup.** `snapshotKey` folds `clock` down to `{skewed, error}` —
  `local`/`remote`/`skewMs` move every tick; keying on them would mail
  every beat instead of transitions.
- The snapshot (and therefore `heartbeat.json`) carries `clock`, so any
  consumer of a past tick can see whether its stamps were verified.

### The read side — `watch-heartbeat.ts`

`readHeartbeat` currently clamps a future `ts` to `ageMs 0` — a
skewed writer's stamp reads "just now", the exact masking the incident
showed. A `ts` more than `CLOCK_SKEW_MS` ahead of the reader's clock
surfaces as `futureMs` instead: `heartbeatLine` renders
`last tick stamped Ns in the future — writer clock skew — <tail>`.

### Digest policy — skills/watch + skills/pulse

Mechanics cannot stop an agent from writing a false digest; policy
makes the honest shape explicit:

- Never report a merge/settle without `gh pr view <N> --json
  state,mergedAt` in hand — a digest names the verified state or says
  "unverified", never "merged" from memory.
- Report times only against a verified clock — read `clock` off the
  snapshot; `skewed`/`error` means every local stamp (ages, merge
  times) is unverifiable and must be flagged, not trusted.

## Plan

- [ ] `watch-clock.ts`: `CLOCK_SKEW_MS`, `WatchClock`, `dateHeaderMs`
  (parse the `Date:` header block of `gh api --include` output),
  `clockVerdict`, `clockPlane` (github-host gated, fail-open to
  `error`)
- [ ] `watch.ts`: `WatchSnapshot.clock`, collectSnapshot wiring +
  attention lines, header annotation, `snapshotKey` normalization
- [ ] `watch-heartbeat.ts`: `HeartbeatSummary.futureMs`, `heartbeatLine`
  skewed-writer render
- [ ] `skills/watch/SKILL.md` + `skills/pulse/SKILL.md`: the
  merge-verification + verified-clock digest rules
- [ ] Tests: `watch-clock.test.ts` (header parse, bound, verdict
  matrix, probe failures); `watch-heartbeat.test.ts` future-ts;
  `watch.test.ts` header/attention/dedup-key cases
- [ ] `npm run build`, `npm run typecheck`, `npm test` (exact CI
  commands)

## Assert

- `bro watch --once --json` on a github rig emits `clock` with
  `skewMs`; a stubbed +90s remote yields `skewed: true`, the attention
  line, and the header annotation — and `snapshotKey` ignores the
  moving fields.
- A heartbeat whose `ts` sits >60s in the reader's future renders the
  skew verdict instead of "just now".
- A failing `gh api` leaves `clock.error` + the `clock unverified`
  attention line — never a fabricated `remote`.
- A `fakehost`/non-github rig omits `clock` entirely — no gh call, no
  noise.
