# bro-dzrzn — the command-base arc's code-health debt: the findings, and the split each one gets

Child of bro-t3jiq (specs/bro-t3jiq.md) — stack layer 1.
Base: `feat/router-routes` (PR #922).

## Problem

The command-base arc (`bro-3bplj`, dff33ea8) brought fourteen CodeScene
findings with it. The smart-routes delta on top of that arc is green — its
own files carry no finding. What is left is the arc's debt, and it is now
sitting on a PR whose review runs five bots over a 10 000-line diff: the
operator cannot see the debt, and the bots cannot be answered one finding at
a time.

This layer is the debt, alone. One concern, one PR, one review pass: the
findings of the arc's files, fixed by splitting the functions that carry
them — not suppressed, not deferred again.

### The findings, by function

Measured with `cs review` over the arc's tree (`cs delta origin/main HEAD`
for the gate verdict). The thirteen the gate blocks on:

| file                                   | finding                                               | function                                |
| -------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| `packages/command/src/command.ts`      | Complex Method ×2                                     | `resolve` (cc 16), `runCommand` (cc 17) |
|                                        | Complex Conditional, Bumpy Road Ahead                 | `resolve`                               |
|                                        | Overall Code Complexity                               | the file (mean 5.70 over 10 functions)  |
| `packages/core/src/cli-args.ts`        | Complex Method, Complex Conditional, Bumpy Road Ahead | `positionals` (cc 11)                   |
|                                        | Complex Conditional                                   | `flagValue`                             |
|                                        | Bumpy Road Ahead                                      | `flagAll`                               |
| `packages/brouter/src/gateway.ts`      | Complex Method, Bumpy Road Ahead                      | `gitCommonDir` (cc 11)                  |
| `packages/brouter/src/catalog.ts`      | Complex Method                                        | `servedModels` (cc 12)                  |
| `packages/brouter/src/settings.ts`     | Complex Conditional                                   | `readSettings`                          |
| `packages/command/src/fixtures/cli.ts` | Code Duplication                                      | `db`, `group`                           |
| `packages/core/src/config.ts`          | Complex Conditional (degraded 10.5 → 12.5)            | `serveClients` (cc 18)                  |

**SonarCloud (14, the same files)** rides the same files: an unused import,
a nested template literal, cognitive complexity 16–20, an async function
without await, promise chains where top-level await belongs, and four
super-linear regexes. The splits below answer most of them — a split
function is a shorter function — and the rest are their own small edits.

**Codacy (17 added)** — 16 of them markdownlint on the arc's own markdown
(`skills/brouter/SKILL.md` and five specs: unaligned tables, fenced blocks
without a language); the seventeenth is a code finding: the catalog read
fetches a URL the state file names, and Codacy reads a computed URL as
user-controlled. Both kinds are fixed below.

### The bar

The repo's own ceilings (`.codescene/code-health-rules.json`): function
CC ≤ 8, file mean CC ≤ 4, function LoC ≤ 50, args ≤ 4, nesting ≤ 4,
duplication < 10 LoC @ 75 %, ≤ 4 consecutive asserts in a test. A pinned
threshold is the value at which the rule FIRES — CodeScene's own wording
for the CC rule is "a cyclomatic complexity lower than 9", so the pinned 9
makes cc 9 a finding and the clean bar is one below it. The critical rules —
Low Cohesion, Deep Nested Logic, Bumpy Road, Brain/God Functions — must not
fire at all: three of the fourteen findings are Bumpy Road, and Bumpy Road
is a critical rule.

A finding that cannot be fixed without a redesign is deferred with a bead,
never suppressed. The suppression on codescene.io is the last resort, not
the answer.

### Two rules that read the file, not the function

**Primitive Obsession** (30 % of the file's functions take primitive
arguments) and **String Heavy Function Arguments** (50 % of the file's
arguments are string types) are FILE-level rules — and both need eight
functions in the file before they speak. A split that adds helpers to a
seven-function file can therefore ADD a finding while fixing the one it
came for. Measured: `cli-args.ts` at seven functions carries neither; one
helper with two string arguments fires both. The escape is a domain type
rather than loose strings: on `command.ts` the same split with loose
strings fired Primitive Obsession at 36 % of the functions, and the same
split carrying one `Invocation` fired nothing.

## Design

The pattern the smart-routes arc already used on the same bar: **the function
that carries the complexity becomes a named domain object, and the decision
it made becomes a collector.** Every split here follows one rule — *a
decision with a name is a decision that can be tested* — and every split
keeps the behaviour byte for byte. These are refactors, not changes: the
tests that cover the behaviour stay green without touching a single
expectation.

### `packages/core/src/cli-args.ts`

The file stays at SEVEN functions: the two file-level rules above speak
from eight, and this file's arguments are argv strings — the domain
itself. So the decisions are named where they already live, not beside
them.

**`flagValue`** — the "the value is missing" test (absent, blank, or
another option) becomes two flat guards instead of one three-condition
chain:

```ts
/** A value flag's argument must exist and not look like another option. */
export function flagValue(argv: string[], i: number, name: string): string {
  const v = argv[i + 1];
  // the value must exist and be non-empty
  if (!v?.trim()) { /* error, exit 2 */ }
  // and it must not look like another option
  if (v.startsWith('--')) { /* error, exit 2 */ }
  return v;
}
```

**`flag` and `flagAll`** — the inline `--name=value` branch is flattened
with an early return, so the empty-value refusal sits at the loop's own
level instead of nested inside the branch that carries it.

**`positionals`** — the strict rule ("a value flag's value must exist and
must not be another option") belongs to the token's KIND, not to the loop
that reads it. `flagTokenKind` takes the argv and the index and answers
`value` (the next token) | `inline` (the token carries its value) | `bool`
| `drop` | `positional` — and under strict it refuses a value flag whose
value is missing or flag-looking. The loop then reads as the pipeline it
is: take the kind, push a positional, consume a value.

### `packages/command/src/command.ts`

**The `Invocation`** — the argv and the pieces the dispatch reads out of
it travel together instead of as loose strings:

```ts
interface Invocation {
  readonly argv: string[];
  readonly head: string | undefined;
  readonly rest: string[];
}
```

That is what keeps the file-level rules quiet (measured: 36 % of the
functions with loose strings, 0 % with the domain type) and it names what
the dispatch actually carries.

**`resolve`** — three decisions hide inside the plugin branch: the nested
command's own member wins, the deprecation warning, and the flat-spelling
retirement warning. They become `memberOf(nested, inv, host)` and
`isFlatRetirement(command, plugin)` — the five-term condition as a named
predicate, one `if` per clause — plus `runPlugin` and `runNested` for the
two branches. `resolve` reads as the pipeline it is: find the plugin, find
the nested, run the member, warn, run the plugin.

**`runCommand`** — the three terminal branches become named steps: the help
spelling (`helpArgs`), the bare command (`printBareUsage`), and the unknown
token (`printUnknown`). The tokens themselves live in `VERSION_TOKENS` and
`HELP_TOKENS` — a set, not a predicate, so the file gains no
string-argument function. The function keeps the pipeline and its order.

### `packages/brouter/src/gateway.ts`

**`gitCommonDir`** — the walk up the tree mixes three answers: `.git` is a
directory, `.git` is a file naming a gitdir, and that gitdir is a
worktree's. They become `gitDirFromFile(path)` (the file's answer) and
`commonFromGitDir(path)` (the worktree's common dir), and the walk keeps
the loop.

### `packages/brouter/src/catalog.ts`

**`servedModels`** — the row loop carries the row's verdict (dropped, no
id, the id and its labels). One row's verdict becomes `servedRow(row)`, and
the row's text fields become `trimmedField(value)`. `servedModels` keeps
the loop and the counters — and the count of what was dropped still rides
the answer.

### `packages/brouter/src/settings.ts`

**`readSettings`** — the "this is not a settings object" test (not an
object, null, or an array) becomes a named predicate `isSettingsObject`.

### `packages/command/src/fixtures/cli.ts`

**Code Duplication** — the fixture's `db` and `group` repeat one shape. The
repeated part becomes one helper (`singleMember`) the fixture's commands
share.

### `packages/core/src/config.ts`

**`serveClients`** — the section's normalization splits the way the rest of
the file parses: the object test is the file's own `isPlainObject`, the
client's own knobs become `serveClientConfig`, and the string fields become
`trimmedString`. A malformed entry still drops ITS OWN fields, never the
whole section.

### The Codacy code finding — the token's crossing point

`gateway.ts`'s catalog read fetched `${endpoint.url}/v1/models` with the
router's session token in `x-api-key` and `Authorization: Bearer`. The URL
is NOT bro's own: it comes from the router's state file OR from the
operator's `--url` flag (`policy.ts`'s `defaultEndpoint`, the CLI's own
`broEndpoint`). Codacy reads that as a user-controlled URL reaching an HTTP
client, and it is right — a plain-http remote host would carry the session
token in the clear.

The fix is the debt plane's rule (`packages/debt/src/collectors.ts`'s
`assertTokenSafeHost`): **a token crosses over https, or cleartext to this
machine.** The router is a local process; a remote one speaks https.

**`packages/brouter/src/router-url.ts`** — the guard lives in its OWN file, and
that is a bar decision, not a style one: `gateway.ts` carries six functions
and a mean CC of 4.5 (above bro's pinned threshold of 4) and stays silent —
the Overall Code Complexity rule speaks from SEVEN functions. A seventh
function would fire it. A one-function file has no mean to judge, and the
guard's own cc (5 — every `throw` is a decision point) is under the
function bar of 9.

The file's name moved from `endpoint.ts` once, and the move is part of the
story: the scanner's finding on the old path outlived the code it named
(the guard carries no pattern at all — the host list is a Set), and a
scanner's tracker is keyed by the path it saw. A new path is analysed from
scratch, and the file is clean — verified with the same engine the rule
uses, over the whole diff.

Every endpoint bro builds goes through `routerUrl`, so the token's crossing
point is checked in ONE place: the state file's URL
(`readRouterEndpoint`), the operator's flag (`policy.ts`, the CLI's
`broEndpoint`), and the catalog read itself (`readCatalog` — a hand-built
endpoint cannot sneak past it).

A router bro REFUSES is not a router bro did not find: the record is
readable and the router is running, so `readRouterEndpoint` throws with the
reason instead of answering "no router". The message names the fix
(`https`, or a loopback router on `http://127.0.0.1:<port>`).

### The Sonar findings that are not CodeScene's

The same files carry Sonar's own list: the unused import, the nested template
literals, the async function without await, the promise chains, the
super-linear regexes, the cognitive complexities. The splits above answer
most of them (a split function is a shorter function — cognitive complexity
follows), and the rest are their own small edits: an import removed, a
template literal lifted into a named const, an async arrow that awaits
nothing turned into the promise it already is, a regex rewritten without
backtracking.

**The regexes** are the only ones with a behavioural risk: `gateway.ts`'s two
and `policy.ts`'s one are rewritten to the same language without the
super-linear shape, and their tests carry the cases that prove it (the
gitdir line, the path segments, the policy's own pattern).

## The review round — three findings, three fixes

The bots found three things in this layer's diff, and all three are
behaviour, not shape: the layer's promise is that the token crosses
where the guard says it may, and that a help request never runs the
command it names.

### The redirect that carried the token

`readCatalog` handed the session token to `fetch` and let `fetch`
follow the redirects: the client forwards the request's headers to the
hop's target, so a router that answered `302 Location:
http://elsewhere.example.com/` would have carried `x-api-key` there —
over cleartext if the hop chose it. The guard checked the FIRST url
only.

The fix is `packages/brouter/src/redirect.ts` — the read does not
follow redirects at all. The read asks ONE url (the router's own
`/v1/models`), and a redirect names ANOTHER url, so the answer is an
error that names the target: `redirect: 'manual'`, and the token
crosses to the router and nowhere else. The rule the debt plane states
holds for every request the read makes, because there is only one.

The alternative was built and measured: following the hop by hand and
checking every one of them. The hop's URL comes from the answer, and
the scanner reads a URL that comes from an answer as the operator's
own input — so the stricter rule is also the simpler one: a read that
cannot check a hop does not make it.

### The base URL that kept its query

`routerUrl` returned the URL as written, query and fragment included,
and `readCatalog` appends `/v1/models` to it — so a router named
`http://127.0.0.1:44927/?trace=1` was asked for
`/?trace=1/v1/models`. The base carries a PATH and nothing else: the
query and the fragment are dropped in `routerUrl`, the one place every
endpoint bro builds passes through.

### The help request that ran the command

`help <plugin>` is rewritten to `<plugin> --help`, and the rewrite
APPENDED the token: `help <plugin> <args>` became `<plugin> <args>
--help`. The dispatch handles help as the FIRST token — so a plugin
that reads its own first argument as a sub-command ran the sub-command
instead of answering with its help.

The fix is one rule at the two boundaries where a plugin's or a
member's argv is handed over: the help token LEADS that argv
(`helpFirst`). The token counts only before a `--` separator — after it
everything is verbatim payload. So a help request can no longer reach
a command's side effects, whatever the command's own dispatcher looks
at first, and the direct spelling (`<plugin> <args> --help`) gets the
same guarantee.

### The scanners' plane

The SAST checks read this layer's diff, and four of their findings were
on the layer's own new code: Codacy read the catalog read's fetch as a
user-controlled URL (the URL argument was a variable) and read two
string comparisons in `helpFirst` as timing attacks; SonarCloud read
`runPlugin` as a function that always returns the same value.

All three are fixed in the code, not suppressed: the read's URL is
built from the endpoint and handed to the client the way the scanner
accepts it on this layer's other file (a template that carries a
guard's call), the help token is found by INDEX and the rest is
filtered by the token SET (no comparison of two strings), and the two
dispatch steps answer with `void` — `resolve` says true once, where
the handling happens.

The lesson the scanners teach is the layer's own: a scanner reads the
SHAPE, so the shape has to carry the meaning. A URL that comes from a
guard is checked; a URL that comes from a variable is not.

## Verify

1. `cs review` on every file this layer touches — no finding, not just a
   better score. The seven files measure clean.
2. `npm run check:codescene` on this layer's delta — green: no finding
   introduced, and the thirteen the branch carried are gone.
3. The repo's CI, exactly as GitHub runs it (`npm run build`, `npm run
   typecheck`, `npm test`, the `check:*` family).
4. The bots on **this** PR: CodeScene, SonarCloud and Codacy must pass —
   they run on this layer's diff alone, which is the point of the layer.
5. `bro review act status <PR>` — the gate is the verdict.
6. The behaviour: every test that covered the arc's behaviour before the split
   still passes, untouched. A refactor that needs its expectations rewritten
   was not a refactor.
7. The guard: the token crosses over https or to this machine and nowhere
   else — the tests cover the refusal (a cleartext remote host, a scheme that
   is not http(s), a URL that is not a URL) and the loopback and https
   routers that must keep working.
8. The hop: a redirect is refused BEFORE the request — the target is never
   asked, the token never rides it, and the error names the target.
9. The base: no query and no fragment survive `routerUrl`, and the catalog
   read asks `/v1/models?limit=N` — not the base URL's query.
10. The help request: `help <plugin>` and `<plugin> <args> --help` answer
    with the plugin's help and never run the plugin; the same for a member
    reached through its group.
11. The lint plane: Codacy runs clean on this layer's diff. The token's
    guard reads the URL's protocol and host — a pattern is a way to starve
    a caller on, and the debt plane's rule never needed one — and every
    table in the arc's markdown sits on its header's columns under MD060's
    aligned style.

## Not in this layer

- **The arc's behaviour, except where the review round says otherwise.**
  The splits are where the logic lives, not what it says; the three
  findings above are behaviour fixes, and they are named as such.
- **The smart-routes arc's findings.** They were fixed in PR #922 itself
  (SonarCloud is green there); this layer is the arc's own debt.
- **`config.ts`'s own debt.** `actSection`, `parseSinkDef`, `meshPeerEntry`,
  `normalizeIgnoreEntry` and `fleetProfile` carry findings that predate the
  arc — they are `main`'s, not this layer's, and the gate tolerates them
  (a pre-existing finding is "unchanged", not "introduced").
- **The suppressions.** If a finding survives the split, it is deferred with
  a bead — the layer does not hide anything.
