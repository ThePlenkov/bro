# bro-qjji2.13 — pipeline: taskSpec annotate crash-window dedup

Parent: specs/bro-7d5nb.md (pipeline formulas, §task spec facade).
Sibling of the intake engine (bro-qjji2.3): intake documents the
semantic-idempotence contract — a crash inside the annotate→verdict
window re-fires intake and appends a second `## Questions`. This bead
makes the facade's write path literally idempotent for an identical
artifact, inside `packages/core` only — no caller changes.

## Problem

`taskSpec.annotate` is append-only: `annotate → appendSection` lands
`## <heading>` + lines unconditionally (taskspec.ts). `guardDuplicate`
throws only for MANAGED names (Acceptance/DoD/DoR/Scenarios) —
unmanaged artifact headings (Questions/Declined/Answers, any other
domain name) always append. A crash between the annotate write and
the verdict journal re-fires `invoke`: the worker re-judges the
enriched spec and, on the same questions/declined outcome, annotate
appends a second identical `## Questions`/`## Declined` section.
Semantic idempotence holds (the unanswered questions are still
unanswered) but the spec accretes — every crash window adds another
copy, and an `## Answers` drain can interleave between two identical
Questions annotates, so "check the last section" is not enough.

## Design

Audit option A — self-contained in core, inside `annotate`, after
`guardDuplicate`: scan `stripMeta(row.description)` for an existing
live level-2 section whose heading name matches case-insensitively
AND whose content lines equal the new lines exactly; on a match the
annotate is a no-op (idempotent skip, never a throw).

Chosen over option B (idempotency keyed by run+stage): the facade is
store-generic — a run/stage key is pipeline vocabulary the core seam
must not learn, and the window it repairs is exactly "the same
artifact text landing twice", which content equality already names.
No journal or caller contract moves.

### The section model — the parser's own boundaries

A candidate section is a LIVE level-2 ATX heading (`headingOf`: ≤3
leading spaces, `##` + space — `##Questions` is prose) plus the raw
lines up to the next live heading of ANY level or EOF — the same
boundary the parser's sink model applies (a `###` ends a managed
section's content; it ends an artifact section's the same way).
Fenced regions stay opaque through the same `fenceOf`/`closesOn`
machinery the parser uses: a `## Questions` inside ```/~~~ is an
example, never a match, and fence lines inside a section are literal
content. A naive substring scan is rejected — it false-positives on
prefix-subsets (`- q1\n- q2` inside `- q1\n- q2\n- q3`) and cannot see
fences.

The scan walks EVERY level-2 heading in the body — all same-named
sections are candidates, not just the last: an `## Answers` drain can
land between two identical `## Questions` annotates, and the earlier
section is the one that must match.

### Content equality — exact, normalized only where markdown is

- Content lines compare line-for-line, never substring: a prefix or
  superset list is a different artifact (spec history appends).
- Artifact elements can carry embedded line breaks (a multi-line
  `answer` record lands as ONE element); the compare flattens each
  element on `/\r?\n/` — the same sequence the append's
  `lines.join('\n')` materializes as body lines, so `['a\nb']` and
  `['a','b']` are the same written artifact.
- Trailing blank-only lines drop on BOTH sides before compare: they
  are the `\n\n` separator before the next section (or stripMeta's
  trimEnd at EOF), never artifact content — without the drop the
  interleaved-Answers case cannot match. Leading and interior blanks
  stay exact.

Managed names never reach the dedup: `guardDuplicate` throws first
whenever a managed section is present, so the skip applies to
unmanaged artifact headings — exactly the crash-window surface. (An
unmanaged-position `## Acceptance` cannot exist live: the first live
level-2 managed heading always marks `present`.)

### Placement and contract

Inside `annotate`, after `guardDuplicate`, before `appendSection`:
`alreadyAnnotated(stripMeta(row.description), h, lines)` → return
with no `store.update` — the write already landed. Skip is a no-op,
never a throw: dedup is best-effort crash repair, and a false
negative only restores today's append (semantic idempotence still
holds); a false positive is impossible by construction — matching
requires identical heading name AND identical content.

The `TaskSpecFacade.annotate` doc gains the contract line: an
identical existing section makes the call a no-op — consumers must
not rely on append-always. intake.ts's crash-window note updates:
a same-outcome re-fire is now literally idempotent; differing content
still appends (a second questions round after answers is a NEW
artifact — history preserved). The answers drain gets the same
literal idempotence for free: a re-drained record annotates the same
lines, which dedup skips.

## Non-goals

- No run/stage-keyed idempotency (option B) — pipeline vocabulary
  stays out of the store-generic facade.
- No `guardDuplicate` change — a managed-name dup still throws, even
  when the content is identical (first-wins is a harder contract than
  artifact idempotence).
- No read-path change — `parseBody`/`spec()` untouched; the dedup
  scan runs inside annotate only, so spec reads pay nothing.
- No testkit (`specStore`) change — the spy records calls and stays
  append-shaped, same posture as its managed-dup-guard exemption;
  dedup is the prod adapter's crash repair.
- No dedup across different heading names — `## Questions` never
  matches `## Declined`; no fuzzy matching — case-insensitive name +
  exact content only.

## Verification

- `packages/core/src/taskspec.test.ts` — new cases: identical
  re-annotate dedups (one update, one section); different content
  under the same heading still appends (history); case-insensitive
  heading match dedups; every same-named section is scanned —
  identical content matching an EARLIER section with an interleaved
  `## Answers` still dedups; a fenced `## Questions` never matches;
  prefix/superset content does NOT dedup; interior blanks stay exact;
  a multi-line artifact element compares flattened; managed-name dup
  still throws on identical content; the dedup path writes nothing
  (meta trailer untouched by construction — no update call).
- `npm run build`, `npm run typecheck`, `npm test` (core package;
  full suite if feasible), biome on touched files.
- Live smoke through the real facade: annotate Questions twice with
  same content → single section; different content → two sections;
  managed duplicate → throws.
