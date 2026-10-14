# bro-9ww2q — doctor guard: client classifier pinned at an acp-conductor wire

## Problem

The serve conductor (spec bro-xeozo) answers `/v1/messages` by opening an
ACP session — session-grade: `session/new` pays full session-start hooks
(`bro state`, watch rearm, bd/dolt reads) before the first token. A
client whose `ANTHROPIC_BASE_URL` lands on that endpoint routes **every**
Messages call through it — including its internal permission/safety
classifier, a check that must answer in seconds. The classifier
fail-closes on the spin-up cost and interactive approvals deadlock
(retro bro-p0baz: "every check fail-closes as 'temporarily unavailable'").

The config triangle is static and therefore detectable before the first
deadlocked session:

1. `providers.<name>` entry of `type: acp` referenced by the serve
   endpoint (`BRO_PROVIDER_BACKEND` in the server's env).
2. A client env block (`~/.claude/settings*.json`,
   `<repo>/.claude/settings*.json`, process env) pointing
   `ANTHROPIC_BASE_URL` at the live endpoint, or pinning a classifier
   knob at a wire only the acp conductor serves.
3. Known classifier model knobs — the dedicated small/fast lane
   (`ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`) and,
   when unset, the main-model lane the classifier inherits
   (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{SONNET,OPUS}_MODEL`, settings
   `model`).

## Design

One `conductor` row in `bro doctor` (warn, never fail).

**Endpoint evidence.** `BRO_PROVIDER_BACKEND` resolves in doctor's own
env first; when a live `bro serve` exists (`<git-common>/bro/serve.json`
+ live pid) the running server's `/proc/<pid>/environ` is the second leg
(non-/proc platforms degrade to client-side evidence only). The name
must resolve to a `type: acp` entry — any other kind cannot be a
conductor.

**Wire vocabulary.** An acp entry's served model ids are its pinned
`model` field plus `--model` flags inside its `command`. The conductor
strips any `<prefix>/` off the caller's id before resolving, so the
match vocabulary is bare ids — `<name>/<id>` spellings hit the same
wire, and a `<acp-name>/` prefix is conductor vocabulary outright.

**Verdict.**

- `ANTHROPIC_BASE_URL` (any source) normalizes to the live serve url AND
  the backend is proven acp → warn: the client's classifier rides
  session/new regardless of which model name it sends (there is no
  separate classifier URL knob). Matched classifier pins are listed in
  the detail.
- A classifier pin (dedicated lane wins; main lane only when the
  dedicated knobs are unset) names an acp wire → warn naming
  knob=value → providers.<name>, even without endpoint proof — the id
  resolves nowhere else.
- Otherwise ok: `N acp provider(s) — no classifier pins on their wires`,
  or `no acp-backed serve endpoint`.

**Remediation** (the hint): point the client's classifier lane at a
`kind: api` provider — the acp conductor is session-grade (docs:
bro-xh5jg; stateless fast path: bro-ddksm).

## Explicit non-goals

- **Probing `/v1/models` on the live endpoint** — doctor stays
  synchronous and spawn-free of HTTP; the served catalog is a second
  verification leg this spec deliberately skips (the env+wire evidence
  above already catches the reported config).
- **Non-claude clients** — the env-knob vocabulary is Claude Code's;
  other ACP-era clients share the shape (`*/`-prefixed wires still
  match) but only the known knobs are scanned.
- **Fixing the conductor path** — session-less fast path for stateless
  traffic is bro-ddksm; permission policy is bro-84qhx.
