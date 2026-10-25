---
name: evidence
description: Full proof discipline for non-trivial changes. Every claim of done/fixed/passing/verified/green MUST be backed by a real executed command and `.evidence/.../claim.json` validated by `scripts/validate.py`. Required for HTML, UI, browser JavaScript, hydration, routing, and client-side behavior. Use $skill{evidence-lite} for trivial changes.
---

# /evidence — file-first, run-first producer discipline

## Tier selection

Before producing evidence, decide which tier applies:

| Tier | Trigger | Skill |
| --- | --- | --- |
| `lite` | files_changed ≤ 2 AND lines_changed ≤ 20 AND no test/config/build files AND change is doc/comment/typo/rename/trivial refactor | $skill{evidence-lite} |
| `full` | everything else (production code, features, fixes, browser/API claims) | this skill |

Default for non-trivial code changes: `full`. Explicit `/evidence lite`
or `/evidence full` overrides auto-detection.

## The only rule (restated, sharper)

> **No run → no claim → no report.**
> A claim not anchored to a real executed command (real exit code, real
> captured output) and a matching evidence file on disk is a
> **fabrication**, even if it happens to be true.

The discipline has two halves and both are mandatory:

1. **Run something real** — not "I think it works", not "I read the
   code and it looks right". You must have a command in your shell
   history that you actually executed, with a real exit code, with
   output you can quote.
2. **Record it on disk** — the evidence file lives in the repo, not in
   your chat reply. Chat pastes of "here's the log" are lossy and
   unverifiable; the file is the proof.

If a peer (verifier agent, parent, human) can
`cat .evidence/<date>/<task>/<slug>.json` and re-derive your claim from
the file alone, you have evidence. Otherwise you have a story.

## What counts as a claim

If any of these words (or close paraphrases) appear in your reply, that
sentence is a claim and must be backed by an evidence file:

| Trigger | Examples (non-exhaustive) |
| --- | --- |
| completion | "done", "implemented", "fixed", "applied", "shipped" |
| verification | "tested", "verified", "passing", "covers X", "matches spec" |
| correctness | "works", "behaves like Y", "produces the right output" |
| absence | "no regression", "lint clean", "no flaky tests", "no TS errors" |
| state | "all green", "build passes", "CI happy", "merged" |
| conformance | "follows the contract", "matches the API", "respects the schema" |

When in doubt: it is a claim. Back it.

## Per-environment minimum viable run

The single most important part of this skill. **For each target
environment, this is the minimum run that produces real evidence.**
Anything less is `produced`, not `proved`.

The recipes for Web, Backend/API, CLI/script, Library, Static analysis,
Docs/config, and Database migration (with the explicit "forbidden as
evidence" rules for each) live in
[`references/per-environment-runs.md`](references/per-environment-runs.md).
Pick the one that matches your `target_environment`; do not paraphrase,
do not skip steps.

## Anti-evidence (the things that LOOK like proof but are not)

| Looks like evidence | Why it isn't | Replace with |
| --- | --- | --- |
| `curl http://localhost:3000` returns `<html>` | HTML presence ≠ JS executed ≠ layout works ≠ WebSocket connected | headless browser with console + screenshot + DOM assertion |
| `node -e "require('./build')"` succeeds | Node has no DOM, no layout, no WebSocket, no fetch | headless browser |
| Lint passes | Lint ≠ runtime behaviour | run the actual test that exercises the changed code path |
| "I read the code, looks right" | Not reproducible, not in file | run a command that, if it failed, would falsify the claim |
| Test exists in the repo | Existed ≠ ran this turn | `vitest run <file>` this turn, quote the PASS line |
| `tsc --noEmit` passes | Only the type checker; the code may still throw at runtime | run the actual code path |
| Screenshot of an old build | Stale | re-take screenshot AFTER the change, this turn |
| Network log without status assertions | "Connection attempted" ≠ "connection succeeded" | assert status 200 / WS OPEN / 2xx in evidence file |
| `git status` shows the file changed | Tracked ≠ correct | run the test that exercises the file |
| Pasted log into chat | Lossy, can't re-derive | `.evidence/.../commands.json` with `stdout_excerpt` |
| `expected: X, received: Y` quoted as success | That quote is a FAILURE, not proof | fix until the quote is a PASS, then quote the PASS line |
| `coverage: 100%` | Coverage ≠ correctness — tests can pass without asserting the right thing | quote an assertion that, if false, would fail the test |

## Evidence file

### Location

```
.evidence/<YYYY-MM-DD>/<task-id>/<claim-slug>/
├── claim.json          # the structured proof (mandatory)
├── spec.ts             # the test that was run (for browser/library)
├── screenshot.png      # or trace.har (for browser)
├── console.log         # for browser
├── out.stdout          # for CLI
└── out.stderr          # for CLI
```

`<claim-slug>` is a kebab-case label for the claim (e.g.
`private-section-handled`, `e2e-suite-green`, `login-form-renders`).
Sample claims live in [`references/examples/`](references/examples/).

### Schema (v1)

The full schema (mandatory keys, per-`target_environment` artifact
rules, `commands` / `assertions` shape) is in
[`references/evidence-schema.md`](references/evidence-schema.md). The
JSON template is at
[`references/claim.json`](./references/claim.json).

### The three-state rule

```
produced  →  file written, claim under test
checked   →  re-read commands + assertions against captured output, still holds
proved    →  matched to its evidence file end-to-end → safe to report
```

A claim is `proved` only when you can point to, in one breath:

1. the evidence file path,
2. one assertion inside that file that, **if false, would falsify the
   claim** (the "killing assertion").

If you cannot name such an assertion, the claim is **not proved** — even
if the file exists. Downgrade to `produced` and either add the
assertion or run more checks.

### Required report

Every turn with a claim ends with **one four-line block per claim**:

```
claim:        <one line, identical to file.claim>
slug:         <slug>
file:         <absolute path to .evidence/.../claim.json>
killing ass.: <one assertion name that falsifies the claim>
gaps:         <[] or honest list>
```

That four-line block is the proof. Without it, the report is rejected
by this skill. The user (or a downstream verifier) can `cat` the file
and check.

## Security note — `validate.py` path-traversal guard

`scripts/validate.py` reads `artifacts[].path` from disk when
cross-checking `assertions[].evidence_quote`. A malicious `claim.json`
could otherwise point `path` at a file outside the project tree (system
files, credential stores, other users' homes) and have the file
contents surface in this script's stdout (which is shared in CI logs /
PR comments).

The script enforces: a path is **only** read if it resolves to a
descendant of the claim directory or the current working directory.
Absolute paths to system files, other users' homes, or anywhere outside
the project tree are rejected with a clear `path-traversal guard` error
and the claim is marked invalid. To point at a file outside `claim_dir`
/ `cwd`, use a relative path that resolves into the project tree.

The guard is tested by the included malicious-claim fixture: a claim
whose sole artifact references an absolute path outside the project is
rejected before any read.

## How to use this skill (the loop)

1. **Plan** the claims you intend to make at the end of this turn.
2. **Pick the per-env recipe** from
   [`references/per-environment-runs.md`](references/per-environment-runs.md)
   that matches `target_environment`.
3. **Run the recipe** — do not paraphrase, do not skip steps. Capture
   full stdout/stderr OR copy to `.evidence/.../out.stdout` etc. Use
   pinned versions for any `npx` invocation (e.g.
   `npx --yes vitest@2.1.5`) — unpinned `npx` is a known rug-pull
   vector.
4. **Write the evidence dir** — `mkdir -p .evidence/<date>/<task>/<slug>`
   then `claim.json` plus any per-env artifacts.
5. **Validate structurally** — run `validate.py` (included with this
   skill) against the claim.json file. It exits non-zero on (a)
   JSON-schema violations, (b) any `assertions[].evidence_quote` that
   does not appear verbatim in `commands[*].stdout_excerpt` /
   `stderr_excerpt` / a referenced artifact file, (c) any
   `db-migration` log artifact that is empty or has a stub
   `content_excerpt`. The script is the only thing that can promote
   `produced` to `checked`.
6. **Self-recheck** — re-read the file. For each assertion, locate the
   `evidence_quote` inside the captured output. Set
   `self_recheck.result`.
7. **Report** — only now state the claim, with the four-line proof
   block.
8. **Carry over** between turns with `@see <previous-claim-slug>`
   references; do not re-evidence the same fact twice.

## Integration with other skills

- **/e2e** — when the verification is a scenario, `e2e-agent run …`
  writes `E2E_EVIDENCE_FILE=...`. Reference that path as
  `artifacts[].path` inside your evidence file. /evidence wraps /e2e;
  it does not replace it.
- **verifier agent** — independent second pair of eyes. Producers
  SHOULD NOT delegate verification to themselves and call it done; if
  only the producer ran the check, the claim is `produced`/`checked`,
  not `proved`-in-the-PR-sense.
- **/act, $skill{handoff}, $github-pr-review, $triage-issue** — every
  "fixed" / "resolved" / "verified" / "green" sentence in a reply must
  reference its evidence file path.

## Runtime proof

The runtime-proof machinery (target-environment classification,
backend/API vs frontend/browser rules, required output block) is in
[`references/runtime-proof.md`](references/runtime-proof.md). Reach
for it when the SKILL body isn't enough.

## Self-check before sending (copy-paste this)

```text
Before I report "done/fixed/passing/verified":

  [ ] I have one .evidence/<date>/<task>/<slug>/ per claim.
  [ ] Each claim.json has ≥ 1 command with a REAL exit_code I captured this turn.
  [ ] Each assertion has an evidence_quote that is a literal line from the captured output.
  [ ] For browser claims: screenshot.png and console.log are inside the slug dir, console is empty.
  [ ] For API claims: I seeded data, I hit the endpoint, I asserted response + side effect.
  [ ] For static-analysis claims: I quoted the actual "0 errors" line from each tool.
  [ ] I can name the killing assertion out loud.
  [ ] My report ends with one four-line block per claim.

If any box is unchecked: I am about to lie. Downgrade to "produced" or run more.
```
