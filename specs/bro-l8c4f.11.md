---
parent: bro-l8c4f
scope:
  - specs/bro-l8c4f.11.md
  - site/content/docs/commands/provider.md
  - site/content/docs/commands/providers.md
  - site/content/docs/commands/status.md
  - skills/provider/SKILL.md
  - packages/cli/src/commands/provider-boundary.test.ts
---

# bro-l8c4f.11 — Оставить provider proxy явной opt-in transport capability

Parent: `bro-l8c4f` (principal audit 2026-10-18 — provider-boundary).

## Problem

BRO carries two model-plane surfaces on top of the workflow mechanics:
the `providers` registry (`packages/core/src/providers.ts` — `api`/`acp`/`cli`
kinds judge and fleet consume by name) and the `/v1/*` proxy/auth plane
(`packages/cli/src/commands/serve-provider.ts` — the Messages-API byte
proxy plus the ACP conductor behind `bro serve`/`bro provider serve`).

The audit asks to *keep* this transport but bound it: do NOT delete it
and do NOT force a package split — instead separate its product contract,
security/operations documentation, and the rationale for future gateway
features from the core workflow value. Two acceptance claims must hold
and stay held:

- **The minimal gate/debt scenario does NOT require a model proxy.**
  `bro review act` + `bro review debt` must run with no `providers`
  entry, no listener, and no upstream credential.
- **Documentation separately describes** mechanics / execution backend /
  model transport AND credential / retention / approval boundaries —
  distinct documented concerns, not one blended page.

## Verified boundary (evidence)

Traced on `origin/main` at spec time:

- `packages/cli/src/commands/debt.ts` — zero provider/proxy references.
  The ledger rides the review-host facade (`gh`/`glab`/connector) and
  the filesystem only.
- `packages/cli/src/commands/act.ts` — no `serve-provider` import, no
  `providerConfig`/`providerProxy`/`BRO_PROVIDER_*`/`ANTHROPIC_*`
  reference. Its one model-adjacent surface is `judgeFacade(dir)`
  inside `shadowNotes()`, called only after the
  `judgeConfig(dir).judge.mode !== 'shadow'` early-return — shadow
  annotation is config opt-in, off by default.
- `packages/cli/src/plugins.ts` — the dispatcher wiring. `act`/`debt`
  import `loadBroConfig` from it, and it statically loads `serve.ts` →
  `serve-provider.ts`, so the import *graph* does reach the proxy plane.
  The boundary is references, not graph reach: neither command names
  the arming surface, which is what the regression test pins.

So the acceptance claim is *true in code today*: the wedge needs no
model transport. What was missing is the contract saying so — the
boundary was implicit, and the provider plane's product/security story
was scattered across `status.md` mechanics, the skill, and config
reference with no separated treatment of credential, retention, and
approval boundaries.

## Terms

- **mechanics** — the workflow contract itself: `task → agent → PR →
  gate → debt` (`bro review act`, `bro review debt`, the ledger).
  Always present; needs no model plane.
- **execution backend** — where a worker process runs: fleet
  `agents.<backend>` connectors and `acp`/`cli` provider spawn entries.
  Opt-in per spawn.
- **model transport** — how model calls reach a model: the `providers`
  registry for judge/fleet consumers, and the `/v1/*` listener (byte
  proxy or ACP conductor) for interactive clients. Opt-in per consumer.
- **credential boundary** — the session-token ↔ real-key swap: config
  names key *sources* (`apiKeyEnv`/`apiKeyCommand`), never values; the
  0600 state file is possession; loopback + Host/Origin guards;
  `redirect: 'manual'` so a swapped key never crosses origins.
- **retention** — what the plane persists: `serve.json`/`provider.json`
  state files; in-memory conversation reuse in the conductor (TTL +
  cap); telemetry *metadata* (backend/model/tokens/duration — never
  message content); ACP session transcripts living in the hosted agent
  CLI's own storage.
- **approval boundary** — who may approve: the conductor default-denies
  `session/request_permission` (policy, not a human); client `tool_use`
  is gated by the client's own permission machinery; `autoApprove`
  belongs to fleet spawn entries; merge approval is the act gate — the
  transport approves nothing.

## Contract

1. **Spec first.** This file lands before implementation (SDD gate).
2. **Docs separation.** `site/content/docs/commands/provider.md` becomes
   the provider plane's product contract: it states the plane is
   opt-in model transport, names the three layers (mechanics /
   execution backend / model transport) as separate concerns, and
   carries dedicated credential / retention / approval boundary
   sections. `providers.md` gains a one-line pointer distinguishing
   the registry (config-plane connections) from the `/v1/*` transport.
   `status.md`'s provider-plane section keeps the mechanics detail and
   links to `provider.md` for the boundary contract.
   `skills/provider/SKILL.md` gains the opt-in line — an agent reading
   the skill learns the workflow needs no listener.
3. **Regression check.** A source-boundary test
   (`packages/cli/src/commands/provider-boundary.test.ts`, the
   import-graph convention) pins the minimal-scenario claim
   mechanically: `act.ts`/`debt.ts` may not reference the proxy arming
   surface (`serve-provider`, `providerConfig`, `fileProviderConfig`,
   `providerProxy`, `forwardBody`, `BRO_PROVIDER_`, `ANTHROPIC_`,
   `serve.json`, `provider.json`), and `act.ts`'s single
   `judgeFacade(` call site must sit inside `shadowNotes` after the
   `mode !== 'shadow'` guard — a future change that routes the gate
   through model transport fails the test, not the docs.
4. **No behavior change.** The transport is not deleted, split, or
   redesigned; grouped CLI + flat aliases, the portable skills tree,
   and existing facades are preserved.

## Acceptance criteria

- [x] The minimal gate/debt scenario requires no model proxy —
      verified in code and pinned by `provider-boundary.test.ts`.
- [x] `provider.md` documents mechanics / execution backend / model
      transport as distinct layers AND credential / retention /
      approval as distinct boundary sections.
- [x] The rationale for the plane (why it exists, why it stays
      separate — the mount point future gateway features build on) is
      documented there, not implied by mechanics docs.
- [x] `npm run check:command-docs`, `check:contract`, `check:docs` pass;
      targeted `npx nx test @broject/bro` covers the new boundary test.

## Non-negotiables

- Do NOT delete the transport, do NOT split the package — scope is
  contract + docs + one regression test.
- Preserve grouped CLI + permanent flat aliases, one portable skills
  tree, existing semantic facades.
- No breaking redesign without owner alignment.
- Docs must not present the advisory/deny postures as human approval —
  the conductor's deny is bro policy; `autoApprove` is a fleet knob.
