# bro-lzj2f — the claude-code client writes its model block — and the client recognizes it

Child of bro-t3jiq (specs/bro-t3jiq.md) — the router's own work.
Layer 4 of the stack. Base: `stack/router/3-tool-use` (PR #936).

## Problem

`bro router client claude-code --write` already writes the served catalog into
the client's settings file (the `modelPicker` block, one row per served model).
Writing is not the point: the point is that the client afterwards RECOGNIZES
those models.

Three things were unproven, and one of them was wrong:

1. **The write was silent.** `--write` replaced the block and said only "wrote
   N model row(s)". The operator's settings file is theirs; a dry-run that
   prints the block is not a diff — it says nothing about what changes in
   THEIR file, and the file's other keys are the part a merge can break.
2. **Nothing read the block back.** The block was written and assumed good.
   The client's own read — the rows it offers, the handling it borrows — was
   never checked, so a schema drift in the client (a new release, a renamed
   field) would silently turn the picker into an empty list.
3. **Nothing ran the real client.** The bead asks for a proof against a
   running router with the real Claude Code, on the operator's own machine.

## Design

### The dry-run diff

`packages/brouter/src/settings-diff.ts` — the diff of the SETTINGS OBJECT, key
by key: the key the client owns is replaced, every other key is untouched, and
the operator reads both facts before the file is touched at all.

The write stays opt-in. Without `--write` the command says what it WOULD do
and writes nothing:

```text
dry run — nothing written
/home/pepl/.claude/settings.json:
  modelPicker: added — 557 model row(s)
```

The diff is read from the same file the write would replace and is computed
from the same merge the write performs — what the operator saw is what lands.
With `--json` the machine shape is the block alone.

### The round-trip test

`packages/brouter/src/client-roundtrip.test.ts` — the block is written into a
scratch settings file and read back the way the client reads it: the file,
parsed, the block taken out of it.

The read-back must show that the client's model list IS the served catalog —
one row per served model, the honest id, in the served order — and that every
row borrows a handling the client knows. The other keys survive the write.

### The live check

`scripts/claude-code-live-check.ts` — the real client against a running router.
The check never touches the operator's own settings: the block lands in a
scratch config dir and the client is pointed at it with `CLAUDE_CONFIG_DIR`.

The check measures four facts, and refuses to pass without all of them:

1. **The client sends the served id** — the block's row is taken verbatim; the
   router re-pins it onto its lane.
2. **The client knows the model** — the client's handling of the served id is
   the BORROWED model's handling, down to the effort profile and the output
   cap. The unknown-model fallback (effort `high`, a 32k cap) is gone.
3. **The client's model list is the router's catalog** — the picker row carries
   the router's own label, not the client's.
4. **The loop is gone** — the router's `tool_use` runs, the client sends the
   tool result, the agent answers, and nothing repeats.

## Measured, not assumed

Claude Code 2.1.309, the real client, the live router (557 served models),
the served id `devin-acp/adaptive` — a model the client does NOT know by its
tail, borrowed as `claude-sonnet-5-5`:

| what                                | without the block                          | with the block                      |
| ----------------------------------- | ------------------------------------------ | ----------------------------------- |
| the effort profile the client sends | `high` (the generic unknown-model default) | `medium` (the borrowed model's)     |
| the output cap the client sends     | 32 000                                     | 128 000                             |
| the picker's label for the id       | `Haiku 5.5` (the client's own)             | `devin-acp/Adaptive` (the router's) |

The borrowed model's own profile, measured against the same client, is
`medium` / 128 000 — the served id's profile with the block IS the borrowed
model's profile. That equality is what "the client recognizes the model"
means, and it is what the live check asserts.

The transcript of the tool turn is the fourth fact: the first assistant answer
is a `tool_use` block, the client sends a `tool_result`, the agent answers in
text, and no answer repeats.

## The client's own vocabulary

The block is the client's shape, pinned to the client version this adapter was
written against (Claude Code 2.1.309):

- `modelPicker.options[]` — `{model, label?, description?, behavesAs?}`; the
  row's `model` is taken verbatim and is the id the client sends.
- `behavesAs` — the id of a model THIS client version knows, whose client-side
  handling (prompt profile, capability, effort defaults, context window)
  applies to the row. Without it the client falls back to the generic
  unknown-model handling and warns "isn't recognized · context assumed to be
  200k tokens".
- `replaceBuiltInOptions` — the picker shows the Default row and these rows;
  the built-in lineup and the gateway-discovered models are hidden.

The context window the client assumes is the BORROWED model's window — the
client gives a model it recognizes the same window that model has on the
Anthropic API. For a served model that IS a Claude model (the router serves
89 such ids) that is the served model's OWN window. For a served model that is
not a Claude model the client's vocabulary has no window of its own; the
router's catalog carries the upstream's real one (`max_context_tokens` — 262
000 for the SWE-2 family), and the operator's lever is the client's
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` (or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for the
compaction boundary). bro does not guess a window it cannot know.

## Verify

1. `packages/brouter/src/client-roundtrip.test.ts` — the block round-trips:
   the client's model list is the served catalog, every row borrows a
   handling, the other keys survive, and the dry run writes nothing.
2. `scripts/claude-code-live-check.ts` — the four facts, against the real
   client and a running router: the served id is sent verbatim, the client's
   handling equals the borrowed model's, the picker carries the router's
   label, and the tool turn ends without a repeat.
3. `cs review` on every file this layer touches — no finding.
4. `npm run check:codescene` — green: nothing introduced, nothing degraded.
5. The repo's CI, exactly as GitHub runs it.

## Not in this layer

- **The operator's settings file.** The check writes into a scratch config
  dir and never into `~/.claude/settings.json`; the dry-run reads the
  operator's file to compute the diff, and the write is still opt-in.
- **The client's own release.** The borrowed models are pinned to Claude Code
  2.1.309; a client release that retires them is a new pin, not a silent
  change.
- **The upstream's context window.** bro reads it from the provider's
  catalog; it does not invent one.
- **The router's own windows.** The router's ledger and compaction live in
  the conductor's plane (the token layer and the tool layer), not in the
  client's settings.
