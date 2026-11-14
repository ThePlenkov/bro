# bro-e2t6h — serve: config owns the byte-proxy upstream (serve.upstream / serve.apiKeyEnv)

Retro-spec: shipped in [#931](https://github.com/ThePlenkov/bro/pull/931)
ahead of this document — the bead stayed open on the missing spec.

## Problem

The provider plane's upstream pair lived only in env —
`BRO_PROVIDER_UPSTREAM` + `BRO_PROVIDER_API_KEY` (typically exported by
`~/.config/bro/provider.env`). No config surface owned the byte-proxy
upstream, so the 'provider' namespace spanned two planes with nothing
to tell them apart: `serve.backend`/`providers.*` name the acp
conductor's entries, while the byte proxy's upstream had only env.
Config should own the URL; env stays the override + secret channel.

The motivation that made it urgent (spec bro-6asnu): the conductor's
fast lane arms only when `providerConfig(env, serve)` yields an
upstream+key pair. An env-only pair meant a repo could not steer the
lane — or the proxy — from committed config; the upstream had to reach
every spawn path's env (apiKeyHelper children do not inherit
settings.env).

## Design

Two fields on the `serve` config section, both consumed by the ONE
resolver every upstream consumer shares —
`providerConfig(env, serve)` in `serve-provider.ts`:

- **`serve.upstream`** — the Messages-API base the byte proxy forwards
  to. Config owns the URL; `BRO_PROVIDER_UPSTREAM` overrides it (a
  set-but-blank override starves nothing — it falls through to
  config). Trailing slashes normalize off; a slash-only value reads as
  unset, never as a configured base. Default stays
  `https://api.anthropic.com`.
- **`serve.apiKeyEnv`** — NAMES the env var holding the real
  credential (SCREAMING_SNAKE enforced; a bad name drops loud at load,
  value kept out of the diagnostic — CodeQL reads `*key*` values as
  sensitive). The secret channel stays env either way: config only
  picks the name. `BRO_PROVIDER_API_KEY` / `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` override the named var.

No key from any channel → the pair is undefined: `/v1/*` 404s and the
fast lane stays unarmed — a half-configured provider is a miss, never
a degraded proxy.

**One resolver, both consumers.** The byte proxy resolves through
`fileProviderConfig` (loads the file layer's `serve` section; a
throwing load degrades to env-only WITH a warning — a pinned
credential name must never silently unwire). The conductor's fast lane
calls `providerConfig(env, cfg.serve)` on the same `cfg` it already
loads — a config-only upstream steers the lane to the configured host
instead of silently keying the default one.

**Layer scope.** `bro provider serve` (the host listener) scans the
GLOBAL layer only — a committed `bro.config` must never redirect the
machine-wide listener's upstream. Repo-scoped `bro serve` reads the
full merge, so a checkout can point its own `/v1/*` at a local
gateway.

**Namespace.** `serve.backend` picks the acp conductor entry,
`providers.*` holds the registry, `serve.upstream`/`serve.apiKeyEnv`
own the proxy plane — the judge/provider/proxy knobs read distinctly.

## Plan

- [x] `serve` section gains `upstream` + `apiKeyEnv` (core config +
  generated JSON schema)
- [x] `providerConfig(env, serve)` — config under env, `apiKeyEnv`
  resolves the secret last behind `BRO_PROVIDER_API_KEY`/`ANTHROPIC_*`
- [x] `fileProviderConfig` — file-layer half for the byte proxy,
  warn-and-degrade on a throwing load
- [x] conductor fast lane resolves the same pair (`resolveFastLane`
  passes `cfg.serve`)
- [x] `bro provider serve` global-layer scan feeds the host listener
- [ ] skill docs name the config fields (this PR)

## Verifies

- unit (`serve-provider.test.ts`): config owns upstream+apiKeyEnv; env
  overrides both; the named var resolves the secret; a blank
  `BRO_PROVIDER_UPSTREAM` falls through to config; slash-only
  normalizes to default; no key → undefined.
- unit (`config.test.ts`): `serve.upstream`/`serve.apiKeyEnv` parse;
  a non-SCREAMING_SNAKE `apiKeyEnv` drops with the value out of the
  diagnostic.
- `check:config-schema` — generated schema carries both fields.
