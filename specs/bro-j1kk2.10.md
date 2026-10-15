# bro-j1kk2.10 — CHANGELOG catch-up

`v0.2.5` is tagged (2026-10-07) and published to npm, but `CHANGELOG.md`
tops out at 0.2.4. The gap is real on `origin/main`.

## Scope

- Regenerate the 0.2.5 section with the same tool the release pipeline
  uses — `nx release changelog 0.2.5 --git-commit=false --git-tag=false`
  — so entry style, PR links, and grouping match shipped sections
  verbatim. Never hand-write 146 entries.
- Correct the section date to the tag date (2026-10-07); the generator
  stamps today's date.
- Verify no other released-but-unlogged versions exist: tags and npm
  versions both end at 0.2.5 → 0.2.5 is the only gap.

## Acceptance

- `CHANGELOG.md` opens with `## 0.2.5 (2026-10-07)` followed by the
  generated Features/Fixes/Performance/Thank You groups, then the
  existing 0.2.4 section untouched.
