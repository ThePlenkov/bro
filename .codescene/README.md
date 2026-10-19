# CodeScene gates in bro

bro's Code Health policy, expressed as code. Three files carry it:

| File | What it holds |
| --- | --- |
| `code-health-rules.json` | The numeric bar. bro's ceilings are pinned as **warning** thresholds: function CC ≤ 9, file mean CC ≤ 4, function LoC ≤ 50, nesting ≤ 4, bumpy road ≤ 2 bumps at depth 2, function args ≤ 4, constructor args ≤ 5, duplication ≥ 10 LoC @ 75 %. The **alert** thresholds stay at CodeScene's configured value: the alerts are what the PR integration gates on, and moving them moves the gate for the whole repo — a wave decision, not a default. |
| `custom-quality-gates.json` | The ladder — which bar applies to which file. Rules are tried in order, the first match wins; no match means no gates. |
| `../scripts/codescene-gate.ts` | The gate itself — a diff may not add technical debt. |

## The ladder

| Rung | Profile | Who carries it |
| --- | --- | --- |
| 3 | `pay_down_tech_debt` | **60 files** — zero CodeScene findings. The strictest bar: every check, goals enforced. |
| 2 | `bare_minimum` | **129 files** — no *critical* rule fires. The critical-rule safety net plus "no new debt". |
| 1 | `{ "new_code_health": true }` | **134 files** — the legacy backlog. New code must not introduce technical debt; pre-existing debt is tolerated. |

A *critical* rule is one of the four CodeScene names: Low Cohesion, Deep
Nested Logic, Bumpy Road, Brain/God Functions. Everything else is advisory —
advisory rules are a judgement call, critical ones are not.

bro starts at rung 1 for the whole repo — the gentle onboarding path CodeScene
recommends for a codebase that already carries debt — and graduates files one
rung at a time. A rung-3 file is a file that already meets the strictest bar;
a rung-1 file is a file that has not been cleaned yet.

The App's PR review posts the findings and enforces this file; the CI job
(`.github/workflows/codescene.yml`) is the reproducible half of the same bar.

## Running a wave

A wave is a batch of files cleaned and promoted. The loop:

1. **Scan** — `cs review <file> --output-format json` over the source tree.
   324 files, ~45 seconds at 6-way parallelism. The score (0–10) and the
   per-finding detail are the baseline; record the score before touching a
   file.
2. **Rank** — score × churn (commits in the last 90 days) × finding count.
   The worst file with no recent churn is not worth a wave; the worst hot
   file is.
3. **Fix in small steps** — one function per step, each step a named
   extraction rather than a rewrite. Re-measure after each step: the target
   is the finding disappearing, not the score moving.
4. **Verify** — the file's unit tests, then the repo's CI (`npm run build`,
   `npm run typecheck`, `npm test`).
5. **Promote** — when a file's findings are gone, move it up a rung in
   `custom-quality-gates.json`. The config is the scoreboard.

Wave 1 covered `packages/cli/src/commands/serve-conductor.ts` — `conductorConfig`
(cc 22 → gone, split into five named helpers) and `itemToMessages` (cc 14 +
Bumpy Road → four helpers). The file's critical-rule findings went to zero, so
it graduated from the floor to rung 2. The wave also shipped the ladder itself.

## Two traps worth knowing

**A partial threshold list is not a partial bar.** Omitting a threshold does
not fall back to CodeScene's default — it falls back to a stricter one.
Measured on `serve-conductor.ts`: no config → 3.80, full template → 3.80,
and the same file with 8 thresholds left out → **1.84**. The file lists every
threshold; the ones bro does not override carry `"-"` (use the default).

**An explicit threshold beats the project's configured value.** The CLI's
`cs rules-config list-thresholds` reports CodeScene's *defaults*, not what
project 86325 actually enforces. Setting `function_cyclomatic_complexity_alert`
to 9 (the skill's ceiling) fired Complex Method on every cc >= 9 method and
cost 1.3 points of file score on its own. That is why only the warning
thresholds are pinned here, and why the bar is raised one threshold at a time,
each time measured.

## The gate locally

```bash
npm run check:codescene                    # delta vs origin/main
node scripts/codescene-gate.ts <report>    # evaluate a saved report
node scripts/codescene-gate.ts <report> --strict   # also fail on pre-existing findings
```

`--strict` is the wave-N bar for a graduated file: it fails on findings the
diff did not cause, so a file can only climb a rung by getting cleaner.

The gate reads the `change-type` CodeScene reports per finding:

| change-type | Meaning | Fails the gate? |
| --- | --- | --- |
| `fixed` | the diff resolved it | no |
| `improved` | the diff made it milder | no |
| `unchanged` | pre-existing debt, untouched | no (`--strict`: yes) |
| `introduced` | the diff added it | **yes** |
| `degraded` | the diff made it worse | **yes** |

## Enabling the CI job

The job needs `CS_ACCESS_TOKEN` — a CodeScene Personal Access Token
(codescene.io → Account → API tokens) stored as a repository secret:

```bash
gh secret set CS_ACCESS_TOKEN --repo ThePlenkov/bro
```

Without the secret the job **skips**; it never blocks a PR. With it, every
PR gets a delta analysis and the gate above.
