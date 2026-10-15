# bro-j1kk2.4 — landing rewrite: the act-gate wedge

Current landing sells persona ("every agent needs a bro") then dumps ~28
commands as "the whole vocabulary". The wedge is narrower and stronger:
**your agent opened a PR — who drives it to merge, and who sweeps up
after?** The act gate is the answer, and the live `/debt` ledger is the
proof.

## Scope

`site/src/routes/index.tsx` + `site/src/scenarios.ts`:

- **Hero** — the JTBD, not the persona: agent opened a PR, bro drives
  it through the review gate to merge and sweeps the debt. Install
  stays.
- **Demo** — the Terminal already has a `review` group ("done is a
  verdict"); move it to position 0 in `groups` so autoplay and the tab
  order open on the act gate instead of planning.
- **Proof section** — replace the abstract "bro writes bro" loop with
  the concrete claim: the gate verdict is one line (threads, checks,
  SAST, mergeable), merged ≠ done, and the debt ledger is public at
  `/debt`.
- **Orchestration second screen** — the system pieces and the
  "not another orchestrator" argument merge into one section below the
  proof. It stays — it's the second JTBD, just not the intro.
- **Vocabulary wall → docs link** — delete the 28-command wall from the
  landing; it rots against the CLI. Point at `docs/glossary` (`.5`)
  and the commands reference.

## Acceptance

- `vite build` prerenders `/` clean.
- First thing below the hero is the act-gate demo; first autoplayed
  scenario group is `review`.
- No vocabulary table remains on the landing; a docs link covers it.
- Voice unchanged: terse, lowercase glosses, "gates, not loops".
