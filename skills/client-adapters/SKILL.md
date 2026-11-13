---

name: client-adapters
description: "Use when a thin client — Claude Code the CLI — must run on the router's agents: the served catalog rendered as the client's own model block (`bro router client <id> --write`, `client-adapters client <id>`), the claude-code pilot, `behavesAs`, or the @broject/client-adapters package boundary. Mechanics live in @broject/client-adapters; this skill carries the contract and policy only."
---

# /client-adapters (bro)

**Mechanics live in the `@broject/client-adapters` package.** The router
(`@broject/brouter`) serves the catalog; the adapters render it in each
thin client's own vocabulary — Claude Code the CLI running on other
agents (opencode, Devin, any ACP lane). The dependency points one way:
the adapters read the catalog through brouter's public API, and brouter
never imports the adapters. The split is deliberate (spec bro-0ykhg.6):
the adapters break on CLIENT releases (`behavesAs` targets, the
`modelPicker` schema), not on routing changes, so their churn does not
ride the router's review and release cycle.

## The problem it solves

The router serves the truth; the CLIENT decides what to show. Claude
Code's discovery keeps only the ids matching `/(claude|anthropic)/i` —
so an honest `<entry>/<model>` id never reaches the picker (measured
against the live gateway: 547 served, 89 survive).

The fix is a rendering, not a filter bypass: the served models, in the
client's own vocabulary, written into the client's own settings. The
client's settings path does not filter — `modelPicker.options` rows are
curated rows, taken verbatim — so the model block lands there.

## Commands

| Command                                                                  | What it does                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `client-adapters client [--json]`                                        | the adapter registry — id, title, settings key, settings path          |
| `client-adapters client <id> [--write] [--settings P] [--wire] [--json]` | render the model block; `--write` merges it into the client's settings |
| `bro router client <id> [--write] [--settings P] [--wire] [--json]`      | the same command, bro's grouped spelling                               |
| `bro router client [--json]`                                             | the adapter registry, bro's spelling                                   |
| `brouter client …`                                                       | compat alias for one release — prints the new spelling, runs nothing   |

`brouter client` is a tombstone: brouter never imports the adapters, so
the flat spelling cannot run them — it names `bro router client …` (and
the standalone `client-adapters client …`) and exits.

## The claude-code block

```jsonc
{
  "modelPicker": {
    "options": [
      {
        "model": "devin-acp/swe-2-high", // the honest id, verbatim
        "label": "devin-acp/SWE-2", // the catalog's own label
        "description": "devin-acp", // where it comes from
        "behavesAs": "claude-sonnet-5-5" // the handling it borrows
      }
    ],
    "replaceBuiltInOptions": true // Default + the served models
  }
}
```

- `behavesAs` — the model whose client-side handling (prompt profile,
  capability, effort defaults, context window) the row borrows. Without
  it the client warns "isn't recognized · context assumed to be 200k
  tokens". The targets are the CLIENT's, pinned to the client version —
  a client release retires them, not the catalog.
- `replaceBuiltInOptions: true` — the built-in lineup AND the client's
  own filtered discovery are hidden. Without it the served models are
  added after the built-in lineup and the filtered leftovers stay.

## Policy

- **Honest ids, always.** `<entry>/<model>` — no protocol, no
  re-spelling. A label is a label; the id is what the client sends.
- **No credential in a settings file.** The router's token rides the
  client's own credential mechanism; the wiring a client gets is ENV
  only.
- **The merge never eats.** Writing the model block preserves every
  other key of the client's settings.
- **Absent = off.** An unregistered client changes nothing; an unknown
  client id is an error naming the known ones.
- **The router never renames a model to survive a client's filter.**
  That is the client's business, and the adapter's.

## The order that matters

A client reads its settings at START — so the router must be up and the
settings must carry the block BEFORE the client starts:

1. the router is up (`bro serve`),
2. the client's model block is written (`bro router client claude-code --write`),
3. the client starts.

Step 2 without step 1 writes a stale catalog; step 3 without step 2
shows the client's own (filtered) lineup.

## Config

`serve.client.<client>` — where the block lands and which binary the
launch stage runs:

```jsonc
{
  "serve": {
    "client": {
      "claude-code": { "settingsPath": "~/.claude/settings.json" }
    }
  }
}
```

The catalog itself — which models the router serves and from which
lanes — is `brouter.models` and the router's own surface; see the
`brouter` skill.
