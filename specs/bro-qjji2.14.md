# bro-qjji2.14 — pipeline: typed proof refs — verify EvidenceRow.proof is a bare string

Parent: specs/bro-7d5nb.md (pipeline formulas, §typed stage outputs,
§verify). The epic's verify stage (bro-qjji2.4, landed in d5b293b9)
carries each AC's evidence as `proof: string` — an opaque ref the
accept bundle and retros can only interpolate, never check. This bead
gives the ref a typed shape so journaled evidence is machine-checkable.

## Problem

`EvidenceRow.proof` is `string` (`packages/pipeline/src/stages/verify.ts`).
The seam contract is `{ac, verdict, proof: <non-empty string>}` —
`isProof` validates presence only. Downstream, `fixScope` interpolates
`${r.proof}` into the fix-scope notes and `accept`'s `evidenceBundle`
carries the verify rows as journaled payload — both treat the ref as
freeform text. A consumer that wants to know WHETHER the evidence was
a test run, a rendered probe, or a file fact must parse prose. The
accept bundle is the customer-facing evidence surface; retros mine the
journal — neither can branch on an untyped string.

## Design

### The typed shape

```ts
export const PROOF_KINDS = ['test-run', 'probe', 'file-fact'] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

export interface ProofRef {
  kind: ProofKind;
  /** where the evidence lives — a run id, an artifact locator, a
   *  file-fact reference. Non-empty. */
  ref: string;
  /** when the evidence was produced — ISO-8601 by convention;
   *  optional, never fabricated by the stage. */
  ts?: string;
}
```

`EvidenceRow.proof` becomes `ProofRef`. `VerifyPayload.rows` — the
journaled shape `accept`'s bundle and retros read — is therefore
always `{ac, verdict, proof: {kind, ref, ts?}}`.

The three kinds are the spec's own evidence taxonomy verbatim
(§stage semantics: "a test run, a rendered probe, a file fact") —
`test-run` for a test/CI run id, `probe` for a rendered probe or
generic artifact ref, `file-fact` for a fact asserted about a file.

### Seam input — the legacy string still answers

The `e2e` seam is an injected port: operator `--engines` modules were
written against `proof: string`. The stage's contract is therefore:

- `proof` as a `ProofRef` record → validated (`kind` in
  `PROOF_KINDS`, `ref` a non-empty string, `ts` a non-empty string
  when present) and canonicalized — the journaled object carries
  exactly `{kind, ref, ts?}`; producer fields outside the schema are
  not journaled.
- `proof` as a bare non-empty string → the pre-.14 contract,
  normalized to `{kind: 'probe', ref: <string>}`. `probe` is the
  generic kind — a ref whose producer declared no more specific
  kind; the ref itself is preserved verbatim, nothing is invented
  beyond the bucket.
- anything else (missing, empty, wrong types, unknown `kind`) → the
  same fail-loud malformed-row throw as today: unreadable evidence
  is never journaled.

The seam's declared return type widens to match: `e2e` answers
`SeamEvidenceRow` — `{ac, verdict, proof: ProofRef | string}` — and
`checkRow` narrows it to the canonical `EvidenceRow`. A typed
`EvidenceRow` remains assignable to `SeamEvidenceRow`, so existing
TS engine modules keep compiling; the runtime accepts both shapes.

### Rendering — one canonical text form

`formatProof(proof)` renders `${kind}:${ref}` — exported so every
text consumer (the `failed` fix scope today, retros tomorrow) renders
identically instead of re-deriving the format. `fixScope` composes
`(evidence: <kind>:<ref>)` — the kind is scope context for the fix
worker ("this failed a test run" reads differently than "this failed
a file fact"); `ts` stays out of the notes — provenance is journaled,
notes stay compact.

### Compatibility — reads, not rewrites

- Journaled history is untouched: `accept`'s `evidenceBundle` carries
  verify payloads as `unknown` and never re-validates rows, so
  pre-.14 journals with bare-string proofs still emit and read.
- The seam keeps accepting bare strings (above) — no `--engines`
  module breaks on upgrade; new producers emit the typed shape for
  machine-checkable evidence.
- No store migration, no journal rewrite, no CLI surface change —
  `bro pipeline accept|answer` are verdict channels, not evidence
  producers.

## Non-goals

- A real `e2e` runner — production still binds the throwing seam
  (`pipeline-engines.ts`); `--engines` modules are the producers.
  This bead types the contract they answer to.
- Retro mining of proof refs — the typed shape ENABLES it; the
  retro consumer is a later bead.
- Validating `ref` contents (URI schemes, run-id formats) — `ref` is
  an opaque locator by contract; `kind` carries the semantics.
- `ts` format enforcement — ISO-8601 is the documented convention,
  the validator checks non-empty string only (same posture as the
  customer record's `ts` gate).

## Verification

- `packages/pipeline/src/stages/verify.test.ts` — typed-proof
  fixtures throughout; new cases: legacy string normalizes to
  `{kind:'probe', ref}`; each malformed shape throws (missing/empty
  `ref`, `kind` outside the enum, non-string `ts`, `proof` record
  without `kind`); canonicalization drops extra producer fields;
  `fixScope` notes render `kind:ref`.
- `packages/pipeline/src/index.ts` exports `PROOF_KINDS`,
  `ProofKind`, `ProofRef`, `SeamEvidenceRow`, `formatProof`.
- `specs/bro-7d5nb.md` §typed stage outputs + §verify updated to the
  typed shape.
- `npm run build`, `npm run typecheck`, `npm test` (pipeline
  package), biome on touched files.
- Live smoke: a scripted `--engines`-style e2e seam emitting typed
  proofs through `runPipeline` → journal rows carry the typed shape
  → `evidenceBundle` surfaces them → a legacy-string seam row still
  verifies and journals normalized.
