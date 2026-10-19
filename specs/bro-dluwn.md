---
parent: bro-bvipw
scope:
  - packages/cli/src/commands/provider.ts
  - packages/cli/src/commands/provider.test.ts
  - skills/provider/SKILL.md
---

# bro-dluwn — host-level API gateway: one /v1 listener per machine

Parent: `bro-bvipw` (epic — full client support through the gateway).
`bro-om6m8.1` shipped the host listener (`bro provider serve`, port
4545, `provider.json` under XDG state) as a **manually started**
foreground command. This bead removes the start step and gives the
host plane the same model backends the repo plane has.

## Problem

User ruling: the anthropic-compatible API is a shared host service —
N clients must never spawn N gateways, and no human/agent may ever
have to "start the server". Two gaps make today's shape violate that:

1. **No self-initiation.** `bro provider token` is a pure read: a dead
   listener exits 1 and the client dies with ECONNREFUSED until someone
   runs `bro provider serve` by hand. The repo plane already solved
   this — `bro serve ensure` resolve-or-spawns. The host plane has no
   equivalent.
2. **No backend on the host listener.** `provider serve` only wires the
   env-key byte-proxy (`BRO_PROVIDER_API_KEY`/`UPSTREAM`). The repo
   serve prefers a configured `serve.backend`/`providers.<name>` acp
   conductor — the machine's real model plane can be keyless (devin
   acp), so a proxy-only host listener cannot even boot on a host whose
   plane is a backend.

## Terms

- **host listener** — `bro provider serve` on the well-known port
  (default 4545); `provider.json` under `$XDG_STATE_HOME/bro/`, one per
  machine enforced by `<provider.json>.lock`.
- **ensure** — the resolve-or-spawn contract, mirroring `bro serve
  ensure`: probe health, spawn detached when dead, print the session
  token on stdout; failures are stderr + nonzero.

## Decisions

- **`bro provider ensure [--port N]`** — the apiKeyHelper for the host
  plane. Probe `GET /api/v1/health`; accept only a listener whose
  reported pid equals the recorded `provider.json` pid (the impostor
  check serve ensure already runs). Dead → detached spawn
  (`process.execPath argv[1] provider serve`), poll until pid-matched
  healthy (20s cap, 250ms), print the token. Concurrent ensures race
  harmlessly: the lock loser exits, the winner's state is what the
  poller reads.
- **`bro provider token` self-heals.** When resolution finds no live
  endpoint, token runs the ensure path once, re-resolves, and prints —
  the already-published settings block
  (`apiKeyHelper: "bro provider token"`) keeps working through dead
  windows. New wiring may point at `bro provider ensure` directly;
  both satisfy the contract.
- **Host listener speaks conductor.** `provider serve` resolves
  `conductorConfig(env, hostDir)` first (explicit backend beats
  byte-proxy, same as `bro serve`), `providerConfig(env)` second,
  refuses when neither configures — a provider-only host with nothing
  to serve is a loud exit, not a 404 farm.
- **The host conductor reads the global config layer only.** `dir` for
  `conductorConfig`/`loadConfig` is the provider state dir
  (`$XDG_STATE_HOME/bro`) — not a git checkout, so no project/local
  layer merges; `providers.*`/`serve.backend` for the gateway live in
  `~/.config/bro/config.*`. Session cwd for spawned backends is the
  user's home directory. The spawner's repo config never leaks into a
  machine-level service.
- **Secrets stay in the server env.** `ensure` spawns with
  `process.env` — the caller's environment is the credential channel
  (unchanged). acp backends carry no key at all. A config-surface for
  the proxy upstream is separate debt (filed).
- **Resolution flips host-first.** `resolveProviderEndpoint`:
  `ANTHROPIC_BASE_URL` pin (unchanged, exact match across both planes)
  → live **host** listener → cwd repo's provider-wired serve → exit 1.
  One gateway means the host wins whenever it exists; the repo /v1
  plane stays wired as the back-compat/fallback path, not the
  preferred endpoint.

## User-facing contract

One block in `~/.claude/settings.json`, forever — no start step, no
per-repo wiring:

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4545" },
  "apiKeyHelper": "bro provider ensure"
}
```

The first claude auth refresh after a reboot spawns the listener; every
claude/codex/agent on the machine shares it. Dead listener → next
helper call revives it; the dead-listener window of bro-ofbw4 narrows
to one helper invocation.
