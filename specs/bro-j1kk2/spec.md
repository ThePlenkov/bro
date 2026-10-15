# bro-j1kk2 — release: bro next-major — positioning, live-tail streaming & site/docs overhaul

## Problem

Product review (2026-10-15), verdict: strong product, sick packaging.

- **Positioning lags the product by two generations.** `plugin.json`
  description/keywords and the README still sell the review-debt pipeline;
  the product is an agent-work rig. The landing page sells a persona and a
  vocabulary dump (28 commands under "the whole vocabulary") instead of one
  job-to-be-done.
- **The concept wall is the adoption tax.** ~30 named abstractions (bead,
  mol, convoy, loop, drive, fleet, rig, pulse, act, debt, drill, wtf, retro,
  learn, guard, judge, mesh, plane, connector, sink, bus, stamp, dogfood)
  arrive before the reader has a reason to care.
- **Live observability exists and surfaces nowhere.** acp-worker streams
  every `session/update` into `<git-common>/bro/agents/<id>.log`, but no
  command or endpoint tails it — a running agent reads as "frozen, then
  done" to anyone watching.
- **Docs coverage is partial.** ~20 hand-maintained site pages against a
  ~50-member plugin registry; several plugins ride under other skills'
  names; the command reference drifts.
- **CLI migration is mid-flight.** Grouped namespaces shipped, flat
  spellings still work, retirement is open (`bro-vlmrb.3`). A major
  boundary is the natural cut.
- **`specs/` masquerades as docs.** ~90 historical per-bead specs are
  project memory, not documentation — the corpus needs an
  archive-vs-curate decision.
- **Release hygiene gaps.** CHANGELOG stalled at 0.2.4 while npm carries
  0.2.5; `@theplenkov/bro` is a stale alias of `@broject/bro` that
  misleads install instructions.

## Decision

**Version: 1.0.0.** The release is a positioning statement; 0.x keeps
breaking-change legality ambiguous exactly where we need it (flat-alias
retirement, registry churn). 1.0 puts the *plugin contract*
(`plugin.json` + `skills/*/SKILL.md` — the spec-stable surface) under
semver while CLI registry evolution continues under the `deprecated:`
per-command mechanism. Recorded at `bro-j1kk2.7`.

**npm alias: deprecate.** `@theplenkov/bro` gets a final deprecation
notice pointing at `@broject/bro`; install docs standardize on
`npx -y @broject/bro@1`. Recorded at `bro-j1kk2.6`.

**Wedge story: one JTBD.** "Your agent opened a PR — who drives it to
merge and sweeps behind it?" The act gate (`bro review act status` as
exit-gate-as-code) plus the public debt ledger is the 30-second demo.
Orchestration scale-out (fleet/loop/convoy/mesh) is the second screen,
not the intro.

## Children — the work

| Bead | Deliverable |
| ---- | ----------- |
| .1 | `bro fleet agents log <ref> [-f\|--follow]` — live tail of a managed agent's log (canonical grouped spelling; `bro agents log` stays as the flat alias until `bro-vlmrb.3` retires it) |
| .2 | positioning: `plugin.json`/`package.json`/README — orchestration-first |
| .3 | `bro fleet serve`: SSE `GET /api/v1/agents/<ref>/log?follow` — bearer-token gated like the write routes (agent logs can carry secrets; the 127.0.0.1 bind is the transport boundary, not the auth one) |
| .4 | site: landing rewrite around the act-gate wedge |
| .5 | site/docs: glossary page — one line per concept |
| .6 | decision: deprecate `@theplenkov/bro` — **deprecate** |
| .7 | decision: semver boundary — **1.0.0** |
| .8 | site/docs: generated command reference from the plugin registry |
| .9 | `specs/` archive-vs-docs — curate live specs, sweep the rest |
| .10 | CHANGELOG catch-up — audit `npm view @broject/bro versions` against CHANGELOG; every published version gets an entry (known gap: 0.2.4 → 0.2.5 → 1.0.0) |
| .11 | docs coverage audit — every skill area has a docs page or an `internal` marker |
| .12 | release pins: `@broject/bro@0` → `@1` — `broSpawnArgv` fallback, every `skills/*/SKILL.md` prerequisite, README/site install snippets |

## Non-goals

Rig-engine unification (`bro-oy3k1`), planes facade (`bro-9rls`),
flat-spelling retirement mechanics (`bro-vlmrb.3`), god-file
decomposition, heartbeat-family collapse — existing epics this release
lands around, not duplicates. The release may *cite* the rig engine as
the roadmap; it does not block on it.

## Exit criteria

- All children closed; decision beads carry recorded outcomes.
- No shipped surface pins `@broject/bro@0` — runtime fallbacks and
  documented install/Requires lines resolve the released major (`.12`).
- `npm run build`, `npm run typecheck`, `npm test` green on main.
- Site deployed with the new landing + glossary + generated reference.
- GitHub release + npm publish at the chosen version; CHANGELOG current.
