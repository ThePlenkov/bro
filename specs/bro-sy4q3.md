# bro-sy4q3 — the conductor answers the client with tool_use — the Claude Code loop ends

Child of bro-t3jiq (specs/bro-t3jiq.md) — stack layer 3.
Base: `stack/router/2-token` (PR #925).

## Problem

The loop, reproduced against the live router: Claude Code posts `/v1/messages`
with 16 Anthropic tools; the conductor hands the agent a TEXT contract (emit
exactly `<tool_call>{...}</tool_call>`); the ACP agent (devin-acp) never emits it —
it runs its own commands and answers in plain text that imitates the Claude
Code UI (`⏺ Ran timeout` / `✓ Ran timeout`); the conductor's answer carries no
`tool_use` block, so the client executes nothing and repeats the request; the
router answers the repeat from the replay cache in 149 ms — an endless loop
that never reaches the agent again.

The client's protocol is the client's. The conductor must answer with the
client's own vocabulary — `tool_use` blocks the client can execute — instead
of narrating the agent's tools into text.

## What the ACP stream actually carries

Measured, not assumed: the live devin-acp agent over stdio
(`devin acp --model swe-2-max`, one `session/prompt`).

The tool call arrives as a `session/update`:

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "exec:0#133e71b20e274535a7143fbbcbe4375e",
  "title": "Ran echo",
  "kind": "execute",
  "content": [
    {
      "type": "content",
      "content": {
        "type": "resource",
        "resource": {
          "mimeType": "text/x-shellscript",
          "text": "echo hello-from-bridge"
        }
      }
    }
  ],
  "rawInput": { "command": "echo hello-from-bridge" }
}
```

Then `tool_call_update` carries the status (`in_progress` → `completed`).

**`rawInput` carries the call's arguments** — that is what makes the bridge
possible. The `kind` is ACP's capability vocabulary (`read`, `edit`, `delete`,
`move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`); the
`name` is absent (the agent's own tool name rides in `_meta`), so a mapping
BY NAME is impossible — it has to be BY CAPABILITY.

The client's side, measured from Claude Code 2.1.309's own request: 16 tools,
of which four answer a capability — `Bash` (command), `Read` (file_path),
`Edit` (file_path, old_string, new_string), `Write` (file_path, content).

## Design

### The vocabulary — `packages/cli/src/commands/serve-conductor-tools.ts`

The request's tool definitions → the bridge's vocabulary: each tool's NAME and
its schema's shape (the required properties, the property names). A tool the
request did not offer is a tool the client cannot run.

### The bridge — `packages/cli/src/commands/serve-conductor-bridge.ts`

`clientCall(update, tools)` → the client's `{name, input}` or undefined.

The bridge is four small files, one concern each — the bar below demands
it: a file's MEAN cyclomatic complexity is capped at 4, and a translation
that grows a branch grows the mean of the file it sits in.

- **`serve-conductor-bridge.ts`** — the translation: the capability the
  call asks for, and the first candidate the client's schema accepts.
- **`serve-conductor-bridge-input.ts`** — the raw input (the agent's own
  shape) into the client's: the fields that map onto the client's own
  properties, the rest dropped.
- **`serve-conductor-bridge-schema.ts`** — the client's schema, the last
  word: whether a value fits the type the client declared, and whether the
  client's own schema accepts the call.
- **`serve-conductor-bridge-status.ts`** — the call's own status: a report
  is not a request.

- **The capability decides the tool.** ACP's `execute` → the client's `Bash`,
  `read` → `Read`, `edit` → `Edit` (or `Write`), `search`/`fetch` → the client's
  own greps and fetches. The first candidate whose REQUIRED properties the
  call covers wins — so an `edit` carrying `content` lands on `Write`, and one
  carrying `old_string`/`new_string` lands on `Edit`.
- **The schema is the contract.** The raw input's fields are mapped onto the
  tool's properties by name (`command` → `command`), by the alias table
  (`path` → `file_path`, `cmd` → `command`, `oldString` → `old_string`), and
  the rest are dropped — the client's schema, not the agent's, decides what
  the client receives.
- **A call the client cannot run is never invented.** No matching tool, a
  missing required property, a value the client's own schema rejects, a raw
  input that is not an object → undefined, and the edge stays what it was: a
  narrated edge. An EMPTY input is not a rejection: a tool that takes no
  arguments runs it.

### The capability tables — `packages/cli/src/commands/serve-conductor-capabilities.ts`

The two vocabularies and the lookups between them: the ACP kind → the
client's tools that answer it, and the raw field → the client's property
that holds it. Both tables are `Map`s: the kind and the field name are the
agent's own strings, and a lookup by one must not reach into a prototype
("toString", "constructor") nor into a key the caller controls — a `Map` has
neither, and its `get` says honestly when the table has no such entry.

### The conductor — `packages/cli/src/commands/serve-conductor.ts`

The streamed turn (`LiveTurn`) asks the bridge first: a call the client can
run becomes a `tool_use` block on the wire (the client's own id, the client's
own input), and the turn's `stop_reason` is `tool_use` — the client's loop
ends there and the client executes.

The agent's own edges for THAT call are gone: the open edge never reaches the
narrator (the bridge answers the update first), and the terminal edge is
suppressed by the narrator's own once-only gate — the bridge marks the call
as done, so the agent's closing edge cannot narrate it a second time. The
bus plane still records the agent's own edges (`tool_activity`) for the
operator.

The buffered turn has no stream to write to: it collects the calls in the
agent's own markup, and the answer parses them like the agent's (the same
`parseReply` the markup path already uses). Its `stop_reason` follows the
blocks (`tool_use`).

### The replay — a tool answer is never replayed

The conversation's reuse path answers a resend that carried nothing new from
the recorded reply. A recorded reply with a `tool_use` block is NOT such an
answer: the client would execute the call a second time. The resend asks the
agent afresh instead (the divergent path's pattern — evict, then a fresh
turn). A recorded TEXT answer still replays: the text path is unchanged.

### The bar — the conductor is at its limits

`serve-conductor.ts` carries 152 functions, a mean CC of 4.41 and a `messages`
of 80 lines. Every one of those is already a finding, so a change that
GROWS one is a "degraded" finding — the gate's blocker. The bridge therefore:

- lives in its own files (`serve-conductor-tools.ts` — the vocabulary,
  `serve-conductor-bridge.ts` — the translation, and the two files beside
  it — the input and the schema), so the conductor's own functions do not
  grow;
- splits `continuationTurn`'s repin branch into `repinModel`, which pays for
  the replay rule's branch (cc 14 → 11 — the finding IMPROVES);
- adds no nested block and no multi-part condition to the conductor (the
  Bumpy Road and Complex Conditional rules fire at two).

Measured after the change (`cs delta stack/router/2-token HEAD`): the
bridge's own files carry NO finding, and the conductor's three
pre-existing findings DEGRADE by the tool_use path — `serve-conductor.ts`
+30 lines, +4 functions, `messages` +1 cyclomatic point. The conductor
stands on the `bare_minimum` rung, so the delta reports those and the
gate tolerates them; the debt is carried by its bead, not hidden here.

## Verify

1. The mapping — the unit tests: the capability decides the tool; the agent's
   `path` is the client's `file_path`; the first candidate whose required
   fields are covered wins; a call the client cannot run is not invented; the
   schema's shape wins and the extra fields are dropped.
2. The wire — the conductor's tests: the agent's tool call lands as the
   client's `tool_use` (name, input, `stop_reason: tool_use`) and the
   narration is gone; a call the client cannot run stays narrated; the
   buffered answer carries the `tool_use` too.
3. The replay — a resend of a tool-bearing request runs the turn again (the
   agent is reached), and a text answer still replays.
4. `npm run check:codescene` — the bridge's own files carry no finding, and
   the conductor's pre-existing findings stay on the `bare_minimum` rung:
   the bridge lives in its own files, and the conductor's tool_use path is
   the debt its bead carries.
5. The repo's CI, exactly as GitHub runs it.

## Not in this layer

- **The client's own tools.** The bridge answers with the tools the CLIENT
  offered; it never asks the client for a tool it did not offer.
- **The agent's own execution.** The agent runs its tools in its own
  sandbox; the client's `tool_use` is the client's own work, executed where
  the client lives. The two are separate by design.
- **The OpenAI and chat dialects.** They have their own tool vocabularies
  (function calls, not `tool_use`); the bridge answers the Anthropic
  messages dialect, which is the client's shape this bead is about.
- **The client's settings.** The model block the client needs to recognize
  the router is layer 4 (bro-lzj2f).
