---
parent: bro-l8c4f
scope:
  - packages/debt/src/collectors.ts
  - packages/debt/src/types.ts
  - packages/debt/src/index.ts
  - packages/debt/src/collectors.test.ts
  - packages/cli/src/commands/debt.ts
  - packages/cli/src/commands/debt.test.ts
  - packages/cli/src/commands/debt-import.e2e.test.ts
  - packages/cli/src/plugins.ts
  - skills/debt/SKILL.md
  - site/content/docs/commands/debt.md
---

# bro-l8c4f.15 — sverka/SARIF as a source for the debt ledger → beads

Parent: `bro-l8c4f` (principal audit 2026-10-18 — sarif-debt).

## Problem

`bro check` runs sverka and renders findings, but nothing lands in the
debt ledger — check.ts named findings→beads an explicit follow-up. The
first iteration (PR #938) added a `sverka` debt source that sweeps
`.sverka/artifacts/` + `.sverka/sarif/` during `debt collect`. Three gaps
remained against the bead contract:

1. **No explicit artifact import.** Only the fixed dir set is readable —
   `sverka run --format sarif` writes `.sverka/findings.sarif` (sverka's
   own default, unscanned) or anywhere via `-o`; an artifact outside the
   two scanned dirs cannot be imported at all.
2. **Artifact-declared fingerprints ignored.** Identity derived from
   `fingerprint(message|path)` — a re-run that changes message wording
   mints a new thread_id (dup rows), even though sverka emits
   `result.fingerprints.primary` precisely as the re-run-stable identity
   (`sha256(checkId|rule|file|startLine|endLine)`, message-insensitive).
3. **Resolve scope was the whole source.** `resolvedThreadIds` closes any
   open `sverka` row absent from the fresh collect — sound while the only
   producer was the dir-scan, but an explicit partial-scope import would
   falsely close rows whose artifacts it never read.

## Contract

- **`bro debt import <file.sarif>…`** — explicit import of a completed
  run/artifact. Positionals are SARIF files anywhere on disk. Repo for
  identity resolves `--repo OWNER/REPO` → git `origin` remote →
  `gh repo view`; all three failing is a loud error naming `--repo`.
- **Identity** — `thread_id` =
  `sverka:enc(repo):enc(tool):enc(ruleId):enc(artifact):enc(fp)`
  where `artifact` is the SARIF path normalized checkout-relative (inside
  root) or absolute (outside), `fp` is the result's declared fingerprint
  — `result.fingerprints` (prefer `primary`, else lexicographically
  first key) → `result.partialFingerprints` (same rule) → a computed
  fallback over the canonical JSON `[uri, line, message]` — and `enc` is
  percent-encoding (composite-key segments never carry a bare `:`).
  The ledger upserts by `thread_id`; `external_ref` in beads equals it —
  two imports of one artifact produce one record / one bead.
- **Provenance** — `DebtRecord.artifact` records the normalized SARIF
  path (the resolve-scope key); the file also rides in the body text.
  `thread_url` stays empty (a machine-local path is a dead link
  elsewhere).
- **Resolve scope** — a row may resolve only when the sweep re-read its
  owning scope completely and the finding is absent. Scope of a row =
  `artifact` (recovered from legacy thread_ids that predate the field).
  - dir-scan scope: every artifact under `.sverka/artifacts/`,
    `.sverka/sarif/`, plus `.sverka/findings.sarif` — membership by path,
    so a deleted artifact's rows still resolve;
  - `debt import` scope: exactly the file set passed. Importing one file
    can never close rows imported from another.
- **Fail closed** — all import files are parsed before any write; one
  unreadable/malformed file aborts the whole import with nothing
  written, nothing resolved. Same rule as the dir-scan's `SourceSkipped`.
- **Dry-run** — `--dry-run` prints the records + the thread_ids it would
  resolve; writes nothing (no harvest file, no overlay, no summary, no
  beads projection, no data-ref publish).
- **No automatic writes** — `bro check` still never writes the ledger;
  the import is an explicit verb, and `sverka` stays an opt-in
  `debt.sources` entry.

### Identity migration

PR #938 thread_ids (`sverka:tool:rule:uri:line:relFile:fp`) predate the
repo segment and declared fingerprints. After upgrade, a complete scan
re-reports each live finding under the new id: the legacy row resolves
`done` (its recovered artifact is in scan scope) while the new row opens
fresh — a one-time close+open per finding, honest in the ledger, and
each side lands as its own bead transition. Legacy rows keep resolving
correctly because the old `relFile` segment still decodes to a scan-scope
path.

## Acceptance criteria

- [ ] Two imports of the same SARIF → one record / one bead — thread_id
      upsert + `external_ref` idempotency; a second import only bumps
      `times_seen`.
- [ ] A known fingerprint survives a re-run — same declared
      `fingerprints.primary` with changed message wording keeps the
      thread_id; no dup.
- [ ] Dry-run writes nothing — no harvest file, overlay, summary, or
      projection mutation.
- [ ] Failed/partial collection closes nothing — malformed SARIF (bad
      JSON, non-object, non-array `results`, null run/result) aborts
      before any write; a multi-file import with one bad file writes
      nothing at all.
- [ ] Resolve only for a complete snapshot of the same scope — an import
      of file B cannot resolve rows scoped to file A; a dir-scan cannot
      resolve rows scoped to an out-of-dirs artifact; re-reading the
      owning scope complete and missing the finding does resolve.

## Non-negotiables

- No new scanners, no automatic writes on `bro check` — import is
  explicit; the dir-scan remains opt-in via `debt.sources`.
- Incomplete snapshots never close rows: parse-all-then-write, scope is
  the read set, legacy rows resolve only inside their recovered scope.
- Reuse `DebtRecord`, ledger upsert, `external_ref` beads projection —
  no second backlog, nothing written into the sverka repo.
- Grouped CLI + permanent flat aliases preserved (`bro review debt
  import` rides the same dispatch).
