---

parent: bro-36sx7
scope:
- packages/cli/src/commands/doctor.test.ts

---

# bro-36sx7.12 — doctor: duplicate hook wiring audit + hooks-wiring coverage close-out

## Problem

Split from bro-36sx7.5: the launcher dedup merged in
[ThePlenkov/bro#708](https://github.com/ThePlenkov/bro/pull/708) and
the bead text deferred "the bro doctor duplicate-wiring check" here.

**Audit verdict: already shipped.**
[ThePlenkov/bro#740](https://github.com/ThePlenkov/bro/pull/740)
(bro-36sx7.5) landed `devinWiringCheck` in
`packages/cli/src/commands/doctor.ts` plus five `hooks-wiring` tests
in `doctor.test.ts` — the exact check this bead describes: a
project-local `.devin/hooks.v1.json` carrying a bro chain signature
(`hooks/run.sh` / `bro hooks`) **and** a resolved `bro` entry in
Devin's plugin lockfile (`$XDG_DATA_HOME/devin/cli/plugins/lock.json`)
warns, because both chains then spawn a launcher per bro-wired event.
File absent, non-bro chain, or plugin unresolved all stay `ok` —
advisory, never a failure.

What #740 did **not** pin are three fallback branches of the same
check:

- an **unparseable** `hooks.v1.json` — `devinChainShape` returns
  null, the check falls back to a raw-text signature test, and the
  hint must be the conservative strip-entries one (the file's
  contents are unproven, so "drop the file" is never advised);
- a **populated lockfile that resolves no `bro` entry** — distinct
  from an absent lockfile: `broPluginResolved` must read the
  `resolved` array and still answer "sole wiring";
- an **off-schema event** (non-array group value) — counts as
  foreign so the warn scopes to the provable bro events and keeps
  the file.

## Design

Spec + coverage close-out, no behavior change — the
precedent for a pre-shipped bead is a spec/test PR
([ThePlenkov/bro#983](https://github.com/ThePlenkov/bro/pull/983),
[ThePlenkov/bro#984](https://github.com/ThePlenkov/bro/pull/984)).

- `specs/bro-36sx7.12.md` — this file: the audit trail and the
  branch list above.
- `doctor.test.ts` — three `hooks-wiring` cases:
  unparseable chain + resolved plugin → warn with the safe hint;
  lockfile resolving only a foreign plugin + bro chain → ok sole
  wiring; off-schema event + bro event + resolved plugin → warn
  scoped to the bro events with the keep-the-file hint.
  `resolvedBroPlugin` gains an optional `name` parameter (default
  `bro`) so the foreign-plugin case reuses the same fixture.

## Plan

- [x] audit `hooks-wiring` on origin/main — shipped via
  [ThePlenkov/bro#740](https://github.com/ThePlenkov/bro/pull/740)
- [x] spec records the verdict and the uncovered branches
- [x] `hooks-wiring` tests: unparseable-chain warn, foreign-plugin
  lockfile ok, off-schema-event warn
- [x] `npm run build` / `npm run typecheck` / `npm test`
