# bro-t3jiq.1 — the client dry-run names the rows a write would remove

Child of bro-t3jiq (specs/bro-t3jiq.md). Amends the layer-4 diff claim
(specs/bro-lzj2f.md) — raised by the CodeRabbit review of the stack: the
spec claimed a diff without saying what the diff shows.

## Problem

`brouter client <id>` (and `bro router client <id>`) computes the write's
effect as a diff of the SETTINGS OBJECT, key by key
(`packages/brouter/src/settings-diff.ts`): the key the client owns
(`modelPicker`) is replaced — "547 model row(s) → 89 model row(s)" — and
every other key is untouched. What the diff does NOT do is name the ROWS
the write removes.

The block is regenerated, not accumulated: a curated row the router no
longer serves — a model the upstream dropped, a lane that went away —
disappears from the client's picker without being listed anywhere. The
operator reads "547 → 89" and cannot tell WHICH 458 entries the write
takes with it. For a settings file the operator owns, that is the part of
the change the dry-run exists to show.

## Design

The diff names the rows it drops, in `settings-diff.ts` — the module that
already owns "what changed".

- `SettingsChange` gains `dropped?: string[]` — the names of the rows the
  change removes, present only when the key holds a row block (the
  `{options: […]}` shape the diff already counts) and rows actually drop.
  The field is additive: the JSON shape consumers already read is
  unchanged.
- A row is named by its own id field — `model`, then `id`, then `name` —
  by itself when it is a scalar, and by its JSON when it is neither: a row
  the diff cannot name is a row the operator cannot check. Identity is the
  NAME, not the whole row: a row the router still serves keeps its place
  even when the write refreshes its label or `behavesAs` — only a row whose
  name is gone from the new block is dropped.
- `changed` — rows in the old block's `options` whose names the new block's
  `options` does not carry. `removed` (the whole key goes) — every row the
  old block carried. `added` — nothing to drop.
- `formatSettingsDiff` prints the names under the change, in the file's
  own order, one per line:

  ```text
  /home/pepl/.claude/settings.json:
    modelPicker: changed — 547 model row(s) → 89 model row(s)
      dropped 458 row(s):
        - devin-acp/swe-2-high
        - …
  ```

  No cap: the point of the list is that the operator reads which curated
  entries the write takes — a truncated list would hide exactly the rows
  the bead exists to name.

The write path is untouched: `runClient` computes the same diff before and
after the write, so the dry-run and the write say the same thing — now
including the names.

## Verify

1. `packages/brouter/src/client-roundtrip.test.ts` — a settings file whose
   `modelPicker` carries a row the router no longer serves: the diff's
   `dropped` names it, the formatted diff prints it, a row the router
   still serves is not named, and the no-drop case is unchanged.
2. Live smoke — a dry-run against a fixture catalog that drops ≥1 curated
   row prints each dropped row's id; a catalog that drops none prints the
   same diff as before.
3. `npm run build`, `npm run typecheck`, `npm test`, the `check:*` gates —
   green, exactly as CI runs them.
4. `bro review act status` on the PR — the gate is the verdict.

## Not in this bead

- **Rows that change but survive.** A served row whose label or
  `behavesAs` the write refreshes is not a dropped row; naming modified
  rows is a different diff.
- **Row-level adds.** The count already says "before → after"; which NEW
  rows appear is the served catalog's own list (`brouter models`), not the
  settings diff's job.
- **The block print.** The full block is still printed on its own; the
  diff names drops, it does not re-print rows.
