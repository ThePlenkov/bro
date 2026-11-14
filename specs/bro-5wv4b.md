---
scope:
  - packages/cli/src/commands/serve.ts
  - packages/cli/src/commands/serve.test.ts
---

# bro-5wv4b — serve: SSE snapshot slicing can split a surrogate pair mid-frame

Deferred review debt from [#584](https://github.com/ThePlenkov/bro/pull/584)
(thread `PRRT_kwDOUamqtM6uFUZO`, kilo-code-bot on `serve.ts`).

## Problem

`followTerminalOutput`'s snapshot drain slices the buffered output into
`SSE_SNAPSHOT_SLICE` (65 536) code-unit pieces:

```ts
chunk.slice(i, i + SSE_SNAPSHOT_SLICE)
```

`String.prototype.slice` cuts UTF-16 code units, so the boundary can
land between the high and low surrogate of one astral character (an
emoji in agent output). `JSON.stringify` escapes the lone surrogate
(`\ud83d` alone), and a client that encodes each frame's text on its own
emits U+FFFD instead of the character — breaking the route's promise
that "JSON keeps the stream byte-exact against plain GET's output" for
any client that does not concatenate frames before decoding.

## Status

The implementation fix already landed on main in
[#850](https://github.com/ThePlenkov/bro/pull/850) (`f9a4cf2f`):
`adjustForSurrogatePair` backs the slice end off by one when
`chunk[end - 1]` is a high surrogate and `chunk[end]` is its low half,
and extends by one in the (unreachable-at-64 KiB, defensive) case where
the slice would contain only the high surrogate. Audit of the merged
code against the bead's edge cases:

- **Boundary at string start/end** — `end >= chunk.length` returns
  `end` unmodified; a short snapshot is one slice. Correct.
- **Consecutive astral chars** — backing off puts the high surrogate at
  the head of the next slice, whose `end'` is ≥ `i' + 2` (the low half
  at `i' + 1` is always inside). Correct.
- **Loop progress** — every return path is `> i` (`end > i` by
  construction; `end - 1` only when `> i`; `end + 1` otherwise), so no
  infinite loop and no skipped content.

What is missing: the regression test #850 added (`term-surrogate`) was
dropped by [#963](https://github.com/ThePlenkov/bro/pull/963)
(`524d32c0`) during its own `serve.test.ts` rewrite — the protection is
live but unpinned, so a refactor could silently reintroduce the split.

## Design

Restore the coverage, extended to the bead's edge cases, inside the
existing `GET /api/v1/terminals/<id>/output — … SSE follow` test —
same fake-registry harness, one `Map<id, output>` driving both the
`snapshot` and `follow` branches:

- `term-surrogate` — `'x' × 65 535 + 😀 + tail`: the pair straddles the
  65 536 boundary (the original #850 case, restored).
- `term-pairs` — `'y' × 65 533 + 😀🙂 + tail`: consecutive astral
  chars, the *second* pair straddles (backed-off slice must still
  deliver the first pair whole).
- `term-edge` — `'z' × 65 534 + 😀`: the pair completes exactly at
  index 65 536 — `end === chunk.length`, no adjustment is the right
  answer.
- `term-lead` — `😀 + lead`: astral char at offset 0 of a short
  snapshot (boundary-at-start, single-slice path).

Assertions per case, both halves of the promise:

1. every emitted `data:` frame's decoded JSON string is well-formed —
   no lone surrogate inside any one frame (the per-frame-encoding
   client failure from the review thread);
2. the frames' concatenation equals the snapshot byte-exactly — the
   same assertion shape the `term-big` case already makes.

## Non-goals

- No changes to `adjustForSurrogatePair` itself — the audit above finds
  it correct; churn on working code is out of scope.
- No protection for genuinely malformed input (a lone surrogate in the
  source buffer): `JSON.stringify` escapes it identically on both the
  plain-GET and SSE paths, so byte-exactness already holds there.

## Verify

- New cases fail on the pre-#850 slice (`chunk.slice(i,
  i + SSE_SNAPSHOT_SLICE)` directly) — demonstrated locally — and pass
  on main's `adjustForSurrogatePair` path.
- `tsx --test packages/cli/src/commands/serve.test.ts` green.
- `npm run build`, `npm run typecheck` — CI-identical.
