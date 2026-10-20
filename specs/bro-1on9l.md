# bro-1on9l — review fixer — PR #579

## Problem

PR #579's `modelBase` strip only reached `resolveTurnModel` — the
pooled/retained conductor paths. Review threads flagged the raw-pin
paths left: `acpOp`/`acpConverse` (the one-shot `acpClient` call/chat
surfaces) forward `opts.model ?? entry.model` verbatim to
`session/set_config_option`; the tool-less provenance label
(`configuredLabel`) is served with the suffix still on; and
`isSystemoneFamily` itself doesn't see through the suffix, so a
`typesafe/jev-1.13[1m]` judge pin binds the prose chat surface and
grades 'prose' in `providerCallGrade` before the catalog is even
consulted.

## Design

Normalize centrally, not per call site:

- `modelBase` moves to `@broject/core` next to `isSystemoneFamily`,
  which strips the context suffix before the family test —
  `acpClient`, `providerCallGrade`, and `applyOption`'s family-swap
  verify all see the base id.
- `applyModel` strips the value sent to `session/set_config_option` —
  covers `acpOp`, `acpConverse`, and `resolveTurnModel`'s resolved
  path in one place.
- `converseModel` strips the label it serves verbatim under tool-less
  backends — covers `configuredLabel` from both pooled callers.

## Plan

- [x] core: export `modelBase`, normalize inside `isSystemoneFamily`
- [x] acp: `applyModel`/`converseModel` strip; drop the local helper
- [x] tests: one-shot client, judge-pin surface binding, tool-less
  provenance label
