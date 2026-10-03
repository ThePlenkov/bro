---
parent: sdd
scope:
  - packages/cli/src/commands/spec.ts
  - packages/cli/src/spec-connectors.ts
  - packages/core/src/specs.ts
  - packages/core/src/git.ts
---

# bro-fvhz — spec drift: flag specs the code left behind

## Problem

Specs are "what the project now is" — but nothing checks that a spec
still matches the code. A bead closes, its spec lands on main, and the
next bead that touches the same paths leaves the spec silently stale.
SDD audits *coverage* (`bro spec check` — has a spec?) but not
*freshness* (is the spec still true?). `bro spec drift` is that audit.

## Design

New subcommand `bro spec drift [id…]` in `commands/spec.ts` — same
module as check/tree/init, same TSV + exit-code contract.

### Scan set

Default: **closed** beads whose `specState` is `spec` or `link` —
drift audits shipped specs. Open/in_progress beads are mid-change;
their spec lagging the code is expected, not a finding. `--all` widens
to every spec'd bead regardless of status; explicit ids scan exactly
those beads. Exempt beads (chore / `trivial` / `debt` labels) never
enter the set — same rule as `specState`.

### Scope — bead → repo path set

Precedence chain, first hit wins:

1. **`scope:` frontmatter** on the spec file — explicit wins. YAML
   list or a single string; entries are git pathspecs passed verbatim
   (argv, never a shell string) after `--`. Repo-relative only — an
   absolute or `../` entry makes the row `unverifiable` ("bad scope
   path"), never silently widens. An explicit scope that matches zero
   committed paths is a typo the audit must not bless — `unverifiable`
   ("scope matches nothing"), never `fresh`.
2. **Bead-id commits** — commits on the drift ref whose *subject*
   contains `(<id>)` (the squash-merge convention `… (bro-x) (#N)`);
   the union of their touched paths is the scope. Subject-only:
   `--format` records filtered in-process — `--grep` searches bodies
   too. One `git log --format=%H%x09%s -z --name-only <ref>` pass.
   Output is unbounded (full history × touched paths) — the probe must
   not rely on `spawnSync`'s default `maxBuffer`: stream via `spawn`
   or set an explicit cap.
3. Nothing resolves → `no-scope` — its own row state, never silently
   fresh.

Rejected: closing-PR file list. It needs `gh` plus a bead→PR join that
doesn't exist locally, and the squash commit's `(id) (#N)` subject
already carries the same paths through option 2 — remote state buys
nothing.

The spec file itself is always excluded from its own scope
(`:(exclude)<spec-path>` appended to the pathspecs) — a `scope:
specs/**` can't mask its own drift.

### Staleness predicate

Two committer-date timestamps on the drift ref:

- `spec-ts` — last commit touching the spec path, `--follow` (a
  renamed spec doesn't look freshly written).
- `scope-ts` — newest commit over the scope pathspecs (no `--follow` —
  "anything touched this surface" is the question).

`STALE` ⇔ `scope-ts > spec-ts`. Committer dates have one-second
resolution, so a tie is not automatically fresh — same SHA is fresh
(the commit updated spec and code together, the ideal landing); equal
timestamps on different SHAs resolve by ancestry — `git merge-base
--is-ancestor <scope-sha> <spec-sha>`: the scope commit predating the
spec commit is fresh, otherwise STALE.

**The ref**: `origin/HEAD` (the remote default branch) — drift
compares *landed* spec vs *landed* code; a feature branch's own
commits would otherwise flag the very spec it's about to update.
Fallback chain: `origin/HEAD` → local `main`/`master` → `HEAD`
(solo/no-remote repos). `--ref <ref>` overrides.

Honest-failure states — always a row, never a throw:

- `unverifiable` — spec file has no commit on the ref (uncommitted or
  branch-only), unborn/empty history, `spec:` external link (no local
  file to date), shallow history (`git rev-parse --is-shallow-repository`
  — boundary commits masquerade as roots, so path-limited logs can
  attribute spec and scope to the same boundary commit and fake
  `fresh`), git failure. Shallow is checked before any timestamp
  comparison.
- `no-scope` — no frontmatter scope, no bead-id commits.
- `fresh` — `spec-ts` wins the comparison above.
- `STALE` — the scope commit is newer than the spec commit per the
  comparison above (strictly later, or a tie the ancestry check
  loses).

### Output + exit

`bro spec check` precedent — TSV rows, CI-able:

```text
<id>\tSTALE|fresh|no-scope|unverifiable\t<detail>
```

Detail: `spec@<sha8> <iso-date> · scope@<sha8> <iso-date>`, or the
reason for `unverifiable`/`no-scope`. Rows sorted by id — TSV is
parsed, not read. `--json` emits the same rows as objects. Any `STALE`
→ stderr summary `spec drift: N stale spec(s)` + exit 1;
`unverifiable`/`no-scope` report but don't fail (coverage gaps, not
drift). Usage errors exit 2.

### Facade seam

`SpecStore` gains an optional `scope?(id): string[] | null` — the
tool's *explicit* scope only (native: `scope:` frontmatter;
speckit/openspec: absent → the commit-refs fallback still applies;
agent: never). The commit-refs fallback lives in the drift engine —
it's beads+git, not tool-specific. Spec paths come from `tree()` —
which can return several same-id nodes (openspec change + shipped
spec, a flat file beside a dir spec). `tree()` reports them all; the
drift engine picks deterministically with the same rule the
connector's `hasSpec` applies (native: `preferSpec` — non-empty beats
scaffold, dir spec beats flat; openspec: the pick `hasSpec` makes) —
no new accessor needed. Recency helpers go next to
`gitTry` in `packages/core/src/git.ts` — argv only, no shell strings.

## Plan

- [x] this spec (bro-fvhz.1)
- [ ] bro-fvhz.2 scope resolver — `SpecStore.scope?` + native
      frontmatter parse + commit-refs fallback in the drift engine
- [ ] bro-fvhz.3 recency probe — git.ts helpers: `--follow` last-commit
      ts for the spec, newest ts over pathspecs, ref resolution,
      unborn-history honesty
- [ ] bro-fvhz.4 `bro spec drift` command — rows / `--all` / `--json` /
      exit 1 on STALE
- [ ] bro-fvhz.5 tests — fixture repos per state + exit codes
- [ ] bro-fvhz.6 docs — sdd SKILL.md row, CHANGELOG, gen-embedded
