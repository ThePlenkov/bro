---
parent: bro-xkv42
---

# bro-xkv42.5 — `bro learn promote <id>`: open rule-edit bead + record promotedTo

## Problem

The learn store accumulates lessons, but a lesson that proves durable has no
path to become enforceable: nothing turns "the agent should always do X" into
a tracked rule-edit bead, and the store has no record that promotion happened.
Operators must hand-copy lesson text into beads, losing the trigger/evidence
provenance and with no idempotency guard against double-promotion.

## Design

### 1) `promoteLesson` (packages/learn/src/promote.ts)

One store-lock transaction (`withStoreLock`):

- Lesson missing → `LessonStoreError` (fail loud, invalid input).
- `promotedTo` already set → idempotent `{ alreadyPromoted: true }`, no
  second bead.
- Otherwise `taskStore.create` a bead labeled `learn` carrying the lesson's
  rule + trigger + evidence + a routing note, then `putLesson` marks
  `promotedTo` (the bead id) and `updatedAt`.
- If the bead mark fails after creation, the orphan bead is closed
  best-effort so a retry cannot leave a duplicate.

### 2) CLI verb `bro learn promote <id>`

`packages/cli/src/commands/learn.ts`: usage, `KNOWN_FLAGS`, `cmdPromote`;
bare bead id on stdout, "already promoted" notice on stderr for the
idempotent path. Exported via `packages/learn/src/index.ts` and registered
in `packages/cli/src/plugins.ts` summary.

### 3) Tests

- Unit (`promote.test.ts`): scripted fake `bd` covering kv/create/close,
  miss error, idempotent re-promote, and `FAKE_BD_KV_FAIL` compensation.
- E2E (`learn.e2e.test.ts`): promote round-trip against a real temp store.

## Acceptance

- `bro learn promote <lesson-id>` creates exactly one `learn`-labeled bead
  with rule/trigger/evidence and marks the lesson `promotedTo`.
- Re-running is a no-op returning the existing bead id.
- A missing lesson id exits non-zero with `LessonStoreError`.
- Spec'd-pending sibling (bro-f4ot.1) remains out of scope: suppression of a
  promoted lesson once its rule-edit bead closes is v2.
