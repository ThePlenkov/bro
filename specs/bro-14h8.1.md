---
parent: bro-14h8
scope:
  - packages/core/src/connectors.ts
  - packages/core/src/queries.ts
  - packages/core/src/config.ts
  - packages/query/
  - packages/github/src/queries.ts
  - packages/gitlab/src/queries.ts
  - packages/cli/src/plugins.ts
---

# bro-14h8.1 — `query` plan kind: combined cross-provider GraphQL plans

Parent: `bro-14h8` (epic). Pinning the design before children decompose.

## Problem

Agents answer cross-system questions — "which open PRs touch issues
still In Progress in Jira", "which GitLab MRs lack a linked bead" — by
hand-running `gh api graphql`, `glab api graphql`, and an Atlassian
GraphQL call, then joining the JSON in the prompt. Every session
re-derives the auth env, the output join, and the failure handling. bro
already owns the machinery: the plan engine (`bro run` → kind routing →
version gate → planSchema → runPlan), the connector registry
(github/gitlab already serve `reviews`), and the fan-out precedent
(`pooled(items, cap=4)` in both review packages). A `query` plan kind
makes the cross-provider question a validated, versioned artifact
instead of per-session plumbing.

## Terms

- **query plan** — a TOML plan with `kind = "query"`: an ordered list
  of GraphQL steps plus fan-out policy. Executed by `bro run
  <plan.toml>`; `bro plan validate` checks it without executing.
- **step** — one GraphQL document sent to one provider: `id`,
  `provider`, `graphql`, optional `vars`/`env`.
- **provider** — the *data plane*: a connector name (`github`,
  `gitlab`, `atlassian`, …) resolved through the existing connector
  registry. Explicitly **not** a `providers[]` registry entry —
  bro-ribc.1's registry is the *model plane* (call/spawn surfaces for
  judge and fleet); a query step names the system that holds the data.
- **`queries` facade** — a new `FacadeMap` capability:
  `graphql(doc, vars, opts) → { data?, errors? }`. Named by domain
  semantics like `reviews`/`tasks`; GraphQL is an open spec, not a
  vendor API, so the name is honest. Connectors that can serve raw
  GraphQL implement it; presence advertises, absence is honest.
- **fan-out** — independent steps run concurrently under a cap;
  results merge into one deterministic document keyed by step id.

## Model

```toml
kind = "query"
version = 1                # optional — schema pin (PLAN_VERSION)
concurrency = 4            # optional plan-level fan-out cap, ≥1

[[steps]]
id = "gh-prs"
provider = "github"        # optional — absent → connectors.queries pin, then auto-detect
graphql = """
query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 20, states: OPEN) {
      nodes { number title url }
    }
  }
}
"""
[steps.vars]
owner = "theplenkov"
name = "bro"

[[steps]]
id = "jira-open"
provider = "atlassian"
graphql = "query { jira { issueSearch(...) { issues { key status } } } }"
[steps.env]                # per-step env overlay for the spawned CLI
ATLASSIAN_API_URL = "https://api.atlassian.com/gateway/api/graphql"
```

Step rules (all enforced in `planSchema`, so `bro plan validate` catches
them):

- `id` required, unique, non-empty string — it is the output key.
- `graphql` required, non-empty string — the raw document.
- `provider` optional string; the runner resolves
  `facade('queries', { dir }, { connector: provider, prefer: loadConfig(dir).connectors })`
  — `facade()` never reads config itself, so the runner threads the
  loaded `connectors` map through `prefer`. When `provider` is present
  it wins (`opts.connector` outranks `prefer`), and a name that serves
  no `queries` facade errors at resolution with the connector's name,
  exactly like every other facade lookup. When absent, a
  `connectors.queries` pin in `bro.config.json` applies first, then
  auto-detect — so an omitted provider can never silently land on an
  unrelated connector the config already pinned away.
- `vars` — a table of scalar values (string/number/bool). github/gitlab
  serialize each entry as a CLI field (`-f k=v` — strings on the wire,
  matching the existing `reviews.ts` usage); atlassian serializes the
  table as the JSON `variables` body verbatim. Non-scalar vars (tables,
  arrays) are rejected for gh/glab steps at run time — the provider is
  not always known at validate time.
- `env` — a string→string table merged over `process.env` for that
  step's spawn only, values **literal** (the `GlabOpts.env` contract:
  `{ ...process.env, ...env }`). This is the mechanism for instance
  pinning, not credentials: `GITLAB_HOST` for self-hosted GitLab,
  `GH_HOST` for GitHub Enterprise, `ATLASSIAN_API_URL` for Atlassian.
  Credentials are never named — because the overlay *inherits*
  `process.env`, the operator's `ATLASSIAN_TOKEN` / `GH_TOKEN` /
  `glab` login reaches the spawned CLI by omission. Writing
  `ATLASSIAN_TOKEN = "ATLASSIAN_TOKEN"` is not indirection — it sets
  that literal string and shadows the real credential. (Unlike
  `apiKeyEnv`, which *is* name-indirection resolved at runtime, `env`
  carries no indirection; choosing among multiple operator-held
  credentials is a v2 question.)
- **Read-only.** `planSchema` rejects a step whose document contains
  `mutation` or `subscription` as a word-boundary keyword after
  stripping `#` comments and string literals. The gate fails *closed*:
  an actual mutation cannot evade it — the operation keyword must
  appear verbatim in executable position — while over-rejection is the
  documented cost (a legal field, alias, directive, or enum value
  spelled `mutation` trips it and cannot be expressed in v1). For a
  read-only gate, erring toward rejection is the safe direction: the
  worst case is a query the plan cannot write, never a mutation that
  slips through. Mutations need dry-run/idempotency semantics (epic's
  open question); they are a `version = 2` discussion, not a silent
  v1 hole.
- No `needs`/ordering between steps in v1 — steps are independent by
  definition; output order is declaration order regardless of
  completion order.

## Providers

Each provider is a connector's `queries` facade — bro shells out to the
system's own CLI so auth, proxies, and self-hosted setups ride the
operator's existing login, exactly the `gh`/`glab` precedent:

- **github** — `gh api graphql -f query=<doc> -f <k>=<v>…`. The exact
  pattern already running in `packages/github/src/reviews.ts:700` for
  thread mutations; helpers live in `packages/core/src/gh.ts`
  (`ghJsonAsync` — the fan-out must not block the loop). `ghAsync`
  takes `(args, cwd)` today and **gains an `opts.env` overlay**
  mirroring `GlabOpts.env` (`{ ...process.env, ...env }` at spawn) so
  the step's `env` actually reaches `gh` — without it the promised
  `env.GH_HOST` pin would be dropped. Ambient `gh auth`;
  `env.GH_HOST` pins an enterprise host.
- **gitlab** — `glab api graphql -f query=<doc> -f <k>=<v>…` via the
  existing `glabAsync` in `packages/gitlab/src/glab.ts`, which already
  carries the `env`/`GITLAB_HOST` pinning contract.
- **atlassian** — `atlassian gql '<doc>' --variables '<json>' --json`.
  Verified 2026-10-05 in the gqlb repo
  (`packages/atlassian-cli/src/commands/gql.ts`):
  the CLI is a raw-GraphQL passthrough — takes a query string or
  `--file`, a `--variables` JSON body, `--url`/`--token` overrides, and
  prints `{data, errors}` JSON. Auth is the CLI's own: `atlassian auth
  login` (cli-oauth, service `atlassian-tools`), `ATLASSIAN_TOKEN` env
  override, `ATLASSIAN_API_URL`/config `apiUrl` for the endpoint
  (default `https://api.atlassian.com`, `…/gateway/api/graphql`); token
  auth is `Basic base64(email:token)`, OAuth is `Bearer`. **This
  answers the epic's open question**: raw-string passthrough exists
  today — gqlb's `createQueryBuilder` is a proxy *builder* needing
  codegen'd types (`@atlassian-tools/gql`'s 8000-type schema); a plan
  file carries documents as text, so the builder path is the wrong fit
  and `atlassian gql` is the executor.

A new connector `atlassian` registers with the `queries` facade only —
it exists to serve query plans and splits into its own package when it
grows `reviews`/`tasks` facades. `connectors.queries` in
`bro.config.json` is the precedence hook for repos where auto-detect
should not pick (already free — it's the `FacadeMap` machinery, no new
config surface).

## Execution

`runPlan` fans steps out under `concurrency` (default 4 — the
`pooled(items, 4)` precedent in both review packages), bounded the same
way. The runner awaits every step, then emits one JSON document on
stdout — results are buffered, never streamed, and keys are written in
declaration order, so completion order never leaks into output:

```jsonc
{
  "ok": false,
  "steps": {
    "gh-prs":    { "provider": "github", "data": { /* … */ } },
    "jira-open": { "provider": "atlassian",
                   "error": "atlassian gql failed: not authenticated" }
  }
}
```

- A step failure is recorded, never fatal — one dead provider must not
  starve the rest. Per-step result shape is fixed: `{ provider, data?,
  errors? }` on a completed call, `{ provider, error }` when the CLI
  itself failed. `data`/`errors` are the provider's GraphQL response
  fields passed through raw; `error` is transport-level (spawn failure,
  non-zero exit) and carries the CLI's stderr line.
- Exit code is 1 when any step failed, 0 otherwise — results print
  regardless, so a partial answer is still machine-usable.
- No normalization. A normalized `items` shape (title/status/url for
  bead import) is the epic's second open question and a follow-up spec,
  not v1: raw output is the honest substrate, normalization is
  opinionated per consumer.
- `bro query <plan.toml>` is the convenience surface — validate + run
  in one step over the same `resolvePlanDoc` pipeline `bro run` uses;
  there is no second parser.

## Config

```jsonc
{ "query": { "concurrency": 4, "env": { "GITLAB_HOST": "gl.corp.example" } } }
```

`query` is the plugin's configKey; `concurrency` is the plan-level
default (a plan's own `concurrency` wins), `env` is a global overlay
applied under each step's `env`. Absent section is a valid config —
absent knobs mean defaults, consistent with the "0 disables"/no-default
precedent: nothing here silently picks a provider the plan didn't name.

## Where it lives

```text
packages/core/src/queries.ts        QueryFacade { graphql } + FacadeMap.queries
                                    + Connector.queries
packages/core/src/gh.ts             gh/ghAsync/ghJsonAsync gain an opts bag with
                                    env — parity with GlabOpts.env
packages/query/package.json         @broject/query
packages/query/src/plan.ts          parseQueryPlan + PLAN_VERSION — strict
                                    unknown-key rejection, errors listed once
packages/query/src/run.ts           applyQueryPlan — pooled fan-out, merge,
                                    stdout JSON, exit code
packages/query/src/atlassian.ts     atlassian connector — queries facade over
                                    `atlassian gql` raw passthrough
packages/github/src/queries.ts      github connector's queries facade (gh api)
packages/gitlab/src/queries.ts      gitlab connector's queries facade (glab api,
                                    env host pin)
packages/cli/src/plugins.ts         query plugin entry: planSchema, planVersion,
                                    runPlan, skill: 'query'
skills/query/SKILL.md               thin wrapper — mechanics live in the CLI
```

## Non-negotiables

- **No GraphQL parser dependency.** Operation-type detection is
  comment/string stripping plus a keyword scan — `graphql-js` buys
  nothing a v1 read-only gate needs and costs a dep every `bro`
  invocation would load. If the sniff proves insufficient, the fix is a
  spec revision, not a bigger hammer.
- **Data plane ≠ model plane.** `provider` on a query step names a
  *connector*; `providers[]` entries (bro-ribc.1) name model services.
  The two registries never cross — a query step cannot name
  `kilo-cli`, a judge cannot name `github`. Specs must keep the
  vocabularies apart or the collision becomes config split-brain.
- **Facades stay vendor-blind, connectors don't fake.** `queries` is a
  capability a connector either serves or doesn't — absence errors at
  resolution naming the connector, never a silent skip. Facade method
  names are domain words (`graphql`), the CLI wiring underneath is the
  connector's own business.
- **Read-only is a gate, not a hope.** `mutation`/`subscription` are
  rejected at `planSchema` time — `bro plan validate` catches a
  mutating plan before any provider sees it.
- **Secrets never appear in a plan.** `env` is a literal overlay, so
  `env.ATLASSIAN_TOKEN = "…"` would embed a token value outright —
  there is no name-indirection here. Operator credentials reach the
  spawned CLI through the inherited `process.env`; the plan writes only
  non-secret pins (`*_HOST`, `*_API_URL`). `vars`/`env` values that
  look like secrets are the author's leak, but the schema never
  *requires* a secret — auth always resolves through the provider
  CLI's own login.

## Milestones

1. `bro-14h8.1` this spec.
2. `queries` facade in core (`QueryFacade`, `FacadeMap`, `Connector`
   member); `kind = "query"` plugin skeleton — `parseQueryPlan` +
   version gate + strict keys; `bro plan validate` accepts the kind.
3. github provider — `gh api graphql` executor, `vars` → `-f`, `env`
   overlay; first end-to-end plan.
4. gitlab provider — `glab api graphql`, `GITLAB_HOST` pin.
5. atlassian connector — `atlassian gql` passthrough, JSON vars,
   `ATLASSIAN_*` env contract.
6. `bro query` command surface + `query` config section + skill; docs
   and `bro doctor` line when a provider CLI is missing.

## Risks named up front

- **Keyword-sniff false positives.** A document with a field literally
  named `mutation` is legal GraphQL but rejected by the read-only gate.
  Documented limitation; the escape hatch is a spec revision carrying a
  real parser when a consumer actually hits it — YAGNI until then.
- **CLI drift.** All three executors depend on user-installed CLIs
  (`gh`, `glab`, `atlassian`) whose flag surface can move. Mitigation
  is the same as everywhere in bro: thin argv construction, stderr
  passthrough on failure, `bro doctor` reporting the missing binary.
- **`vars` typing asymmetry.** gh/glab `-f` fields are strings on the
  wire (GitHub's API coerces `String` vars fine; `Int`/`Boolean`
  variables need the `k[type]=v` field syntax or `-F`); atlassian gets
  typed JSON. v1 pins scalar-string `-f` for gh/glab and documents it —
  a plan needing typed variables against GitHub is the v2 signal.
- **Provider-name confusion.** The word `provider` now exists in two
  planes (connectors vs bro-ribc.1 model registry). The spec pins the
  data-plane meaning on the step field; if reviews show readers
  conflating them, the field renames to `connector` before the schema
  version ships — cheaper before external plans exist.
