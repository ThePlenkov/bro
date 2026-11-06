# bro-t3jiq — the router's stack: four layers over PR #922

Child of bro-olfvd.1 (specs/bro-olfvd.1.md) — the router's own work.
Layers: bro-dzrzn, bro-aaxiu, bro-sy4q3, bro-lzj2f.

## Problem

PR #922 carries two arcs and 39 commits — 110 files, +10 175/−523. Its
review runs five bots over the whole diff at once (CodeScene, SonarCloud,
Codacy, Kody, Amazon Q), and everything the review found landed in the
same branch: nine fix commits, then nine more, then two refactors. The
operator reads one 10 000-line diff to find a five-line fix, and every
push re-runs the heavy review over all of it.

What is left is **four unrelated concerns**, each with its own shape, its
own risk and its own review weight:

| layer | concern                                                                          | shape                                     | review weight                  |
| ----- | -------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------ |
| 1     | the command-base arc's code-health debt                                          | mechanical, 13 + 14 + 17 findings         | heavy bots, mechanical diff    |
| 2     | the proxied decision model's token in `process.env`                              | a contract change in `@broject/providers` | every consumer of the api kind |
| 3     | the Claude Code loop — the conductor answers in text, the client repeats         | a protocol bridge, the largest unknown    | the whole client contract      |
| 4     | the claude-code client writes its model block — and the client must recognize it | a write outside the repo, needs proof     | small diff, live verification  |

One PR mixes them: a protocol bridge lands next to a mechanical refactor and
neither reads as itself. Four PRs without a stack make the operator rebase
four branches by hand and lose the merge order — the token seam must not land
before the debt it sits on, and the client must not land before the bridge
it proves.

## Design

### The stack

```text
main
 └── feat/router-routes            PR #922 (draft) — smart routes + explain
      └── stack/router/1-code-health   PR #923 — bro-dzrzn
           └── stack/router/2-token    PR #925 — bro-aaxiu
                └── stack/router/3-tool-use   PR #936 — bro-sy4q3
                     └── stack/router/4-client   PR #942 — bro-lzj2f
```

Layer 4's first PR (#941) was closed by an outside action before the stack
landed; the layer itself lives in #942, on the same branch and the same
content.

The branches live in the repo's own stack namespace (`stack/<name>/<n>-<slug>`),
so `bro stack list` reads the chain, `bro stack sync` retargets the child PRs
and rebases the child branches after a merge, and `bro stack publish` registers
the chain as the host's server-side stack. Layer 1 bases on `feat/router-routes`
explicitly — the stack roots on PR #922, not on `main`, because the arc's code
exists only there.

### The rules

- **Draft PRs, human merges.** The operator tries the feature; the act gate is
  the merge mechanism, not the stack.
- **Bottom-up merge order.** Layer N merges only after N−1. `bro stack merge`
  does the cascade; `bro stack sync` fixes the children afterwards.
- **One bead per layer, one spec per bead.** Each layer claims its own bead,
  carries `specs/<bead>.md` (the SDD gate requires it), and lands its own
  tests. A layer never edits a layer below it — a fix that belongs below goes
  below, and the stack rebases up.
- **The heavy bots run per layer.** Layer 1's diff is the arc's debt and
  nothing else; layer 3's diff is the protocol bridge. A bot that finds
  something in layer 3 points at layer 3.
- **No merge by me.** The operator merges; the stack is prepared, not landed.

### Layer 1 — the code-health debt (bro-dzrzn)

The command-base arc (`bro-3bplj`, dff33ea8) brought its debt in; the
smart-routes delta on top of it is already clean. The findings, verbatim:

**CodeScene (13, the arc's files):**

- `packages/command/src/command.ts` — Complex Method ×2, Complex Conditional,
  Bumpy Road Ahead, Overall Code Complexity
- `packages/core/src/cli-args.ts` — Complex Method, Complex Conditional ×2,
  Bumpy Road Ahead
- `packages/brouter/src/gateway.ts` — Complex Method, Bumpy Road Ahead
- `packages/brouter/src/catalog.ts` — Complex Method
- `packages/brouter/src/settings.ts` — Complex Conditional
- `packages/command/src/fixtures/cli.ts` — Code Duplication
- `packages/core/src/config.ts` — Complex Conditional (degraded 10.5 → 12.5)

**SonarCloud (14 on the same files):** `command.ts` — unused import, nested
template literal, cognitive complexity 16; `exits.ts` — nested template literal;
`fixtures/cli.ts` — async without await; `gateway.ts` — cognitive complexity 18,
two regexes; `policy.ts` — regex; `catalog.ts` — cognitive complexity 18;
`cli.ts`, `cli/src/index.ts` — promise chain; `cli/src/commands/router.ts` —
regex; `core/src/config.ts` — cognitive complexity 20.

**Codacy (17 added)** — the per-file detail needs the account
(app.codacy.com, or an API token); the PR's own check carries the list.

The bar the layer answers to is the repo's own (`.codescene/code-health-rules.json`):
function CC ≤ 9, file mean CC ≤ 4, function LoC ≤ 50, args ≤ 4, nesting ≤ 4,
duplication ≥ 10 LoC @ 75 %, ≤ 4 consecutive asserts — and the critical rules
(Low Cohesion, Deep Nested Logic, Bumpy Road, Brain/God Functions) must not
fire at all.

**Acceptance:** `npm run check:codescene` on the layer's delta is green; the
CodeScene, SonarCloud and Codacy checks on the layer's PR pass; no finding is
suppressed (the suppression is a last resort, and a finding that cannot be
fixed without a redesign is deferred with a bead, not hidden).

### Layer 2 — the token seam (bro-aaxiu)

`proxiedEntry` assigns the router's token to `process.env.BRO_ROUTER_TOKEN`
and names that variable in the api entry's `apiKeyEnv`. The api kind reads its
key from the environment at call time, so the token has to live in the
environment — and the token is the router's own, read from the repo's state
file. Today one process handles one repo, so one token, so the write is
idempotent; the shape is still wrong, and the race needs two tokens in one
process to bite (the failure would be a 401 and a fail-open decision — never a
leak to a third party).

The fix is a seam, not a patch: the key travels with the request.

- the api kind grows a **runtime-only** key field — the config side never
  holds a key value, and the config schema does not grow a `key` field;
- the providers package reads it before the env, so a configured entry keeps
  its behaviour byte for byte;
- the proxied entry carries the token inline, and `process.env` is never
  written.

**Acceptance:** the api kind reads a runtime key; the config schema is
unchanged (a pasted key in config still fails to parse); a test proves two
concurrent proxied decisions use their own token; `process.env.BRO_ROUTER_TOKEN`
is never set.

### Layer 3 — the tool-use bridge (bro-sy4q3)

The loop, as reproduced against the live router: Claude Code posts
`/v1/messages` with 16 Anthropic tools; the conductor hands the agent a **text**
contract (emit exactly `<tool_call>{...}</tool_call>`); the ACP agent (`devin-acp`)
never emits it — it runs its own commands and answers in plain text imitating
the Claude Code UI (`⏺ Ran timeout` / `✓ Ran timeout`); the conductor's answer
carries no `tool_use` block, so the client executes nothing and repeats the
request; the router answers the repeat from the replay cache in 149 ms — an
endless loop that never reaches the agent again.

The bridge is the fix: **the client's protocol is the client's.** The conductor
must answer in the client's own vocabulary — `tool_use` blocks the client
executes — instead of narrating the agent's tools into text.

The shape is decided by what the ACP update stream actually carries, so the
layer's spec settles it first: the conductor already renders
`narrateStart`/`narrateTerminal` from `session/update`, and the same update
carries the tool call's name/kind and its raw input — enough to map the
agent's tool onto the client's tool by capability (a shell command is the
client's `Bash`; a file write is `Write`/`Edit`), not by name.

**Acceptance:** a client that offers tools gets `tool_use` blocks back and
executes them; a turn without tools still answers in text; the replay cache
never serves a tool answer as the next turn's answer; a test drives the
conductor's Anthropic response for a tool-bearing turn and asserts the blocks.

### Layer 4 — the client proof (bro-lzj2f)

`brouter client claude-code --write` writes the served catalog into
`~/.claude/settings.json` — one entry per served model, in the client's own
vocabulary (the adapter pins the targets it was written against: Claude Code
2.1.309).

Writing is not the point; the **proof** is:

- the written block is what this client version reads;
- a model the client does not know is still served, and the warning
  "model X isn't recognized" does not appear for the models the router serves;
- the context window the client assumes is the served model's own, not the
  200k default;
- the loop from layer 3 is gone in the same session.

The write is opt-in (`--write`), the dry-run shows the diff before anything
lands, and the operator's own `~/.claude/settings.json` is never overwritten
silently.

**Acceptance:** the written block round-trips through the adapter's reader; a
live check with the real client against a running router shows the models
recognized and no repeat-request loop; the dry-run and the write agree.

## Verify

**Per layer** — the same bar every layer answers to:

1. `npm run check:codescene` on the layer's delta — green, no new findings.
2. The repo's CI, exactly as it runs on GitHub (`npm run build`, `npm run
   typecheck`, `npm test`, the `check:*` family).
3. The bots on **that layer's** PR: the heavy review runs on the layer's diff,
   not on the whole stack.
4. `bro review act status <PR>` — the gate is the verdict, not the local run.

**The stack as a whole:**

- `bro stack list` reads the chain in order, each member's PR numbered and
  open;
- the merge order is bottom-up, and `bro stack sync` retargets the children
  after each merge;
- PR #922 stays open until the layers under it are done (the operator merges
  it last, or keeps it open while trying the feature).

**The operator's own check** — the feature works: the router serves the
catalog, the client recognizes the models, the loop is gone.

## Not in the stack

- **The router's own catalog contents.** Layer 4 proves what the client sees;
  which models the router serves is the operator's config (the served
  universe), not a layer.
- **The ACP agent's narration.** The `⏺ Ran …` / `✓ Ran …` lines stay for the
  text path; layer 3 adds the tool path beside them, it does not remove the
  narration.
- **The replay cache's general policy.** Layer 3 only forbids serving a tool
  answer as the next turn's answer; what else the cache may serve is the
  cache's own bead.
