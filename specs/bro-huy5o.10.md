---
parent: bro-huy5o
scope:
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/agent-connectors.test.ts
  - packages/cli/src/agent-connectors-gascity.test.ts
  - packages/cli/src/commands/agents.test.ts
  - packages/cli/src/commands/testrepo.ts
  - skills/agents/SKILL.md
  - site/content/docs/configuration.md
---

# bro-huy5o.10 — agents: container isolation backend (docker / devcontainer)

Parent: `bro-huy5o` (epic — adoption-first connector backlog).

## Problem

Every bro worker runs on the host: `native` spawns a detached `sh -c`,
`tmux` a pane on a shared server, `gascity` a managed session. Parallel
workers on one host share everything — the toolchain (node/python
versions), the port space (two `npm run dev` instances collide), the
ambient env (one worker's `npm install` rewrites the shared cache). The
fleet cap keeps the count honest but does nothing about the blast
radius between the workers it admits.

## Design

A `docker` agent connector — same registry contract as the built-ins:
one registry entry per molStep, `pid`→container's host pid,
`containerId`→the docker id, same `bro/agents/` artifacts (prompt, log,
`.exit`), same beads claim, same fleet cap and session-quota admission.

### Isolation model — same paths inside and out

`docker run` mounts every path the worker needs at its **identical
absolute host path**:

- the worktree (`--workdir` too) — `spec.repoRoot`
- the git common dir — covers `.git/worktrees/<n>` (the worktree's
  `.git` file resolves verbatim), `bro/agents/` (prompt, log, `.exit`,
  `.env`), `bro/hooks/`
- the shared beads dir — `spec.beadsDir` when it isn't already covered
  by the mounts above

Because paths are identical inside and out, the in-container wrapper is
the native one's shape: `{ <worker>; s=$?; printf %s "$s" > <exit>; }
>> <log> 2>&1` — the `.exit` file, log append, and `logFrom` segment
pinning the recorded-death ladder relies on all work unchanged. Spawn
worker payloads ride verbatim: `template` expands `{promptFile}`,
`argv` elements single-quote into the same exec line tmux renders.

### Env

Ambient env (`process.env` + `spec.env` minus the connector-owned pins)
rides `--env-file <agentId>.env` — a 0600 file in the mounted agents
home, deleted after the `docker run` call the way tmux's env file is
deleted after the pane sources it. Values containing newlines are
dropped (docker's env-file is line-based and takes quotes literally).
The identity pins go on `-e` flags — non-secret, same as tmux.

### Image resolution

1. `agents.docker.image` — used verbatim (`docker run` pulls if absent).
2. Else the repo's devcontainer: `agents.docker.devcontainer` path,
   default `<repoRoot>/.devcontainer/devcontainer.json`. Parsed as
   JSONC (string-aware comment/trailing-comma stripping — devcontainer
   files are commented JSON, not strict JSON).
   - `"image": "<ref>"` — used verbatim.
   - `"build": {"dockerfile"|"dockerFile": <f>, "context": <c>}` —
     built once per content as `bro-dev-<sha256(dc+df)[:12]>`;
     `docker image inspect` skips the rebuild. Context defaults to the
     devcontainer's directory. `build.args` ride as `--build-arg`.
   - `dockerComposeFile` without image/build → a named config gap
     (compose lifecycle is out of scope), never a silent fallback.
3. Neither → `SpawnError 'config'` naming `agents.docker.image`.

Features/lifecycle hooks in devcontainer.json are documented as not
applied — honoring them needs the `devcontainer` CLI, a different
orchestration model; the docker-CLI path is the contract here.

### Liveness + death

- `docker run -d --init --rm`: `--init` reaps grandchildren, `--rm`
  removes the corpse on exit — `docker ps -a` collects no bro litter
  and the name frees for a respawn.
- Probe: `docker inspect <name> --format '{{json .State}}'` → Running /
  Pid. `No such object/container` → dead (with `--rm`, absent IS dead —
  a present-but-stopped container reads the same either way); any other
  failure (daemon down, timeout) → `unknown`, which never reports
  `lost` and never frees the occupancy slot.
- Batch: `docker ps --filter label=bro.managed=1 --format '{{.Names}}'`
  — one call liveness for list()/occupancy; a failed call degrades, it
  doesn't corpse the fleet.
- Recorded death: the mounted `.exit` file is the only record — native
  semantics verbatim, the shared ladder harvests it unchanged.
- `stop`: `docker rm -f` (SIGKILL semantics, like `kill-session`), then
  the same locked revalidation + `stopped` patch + marker drop.

### Selection + capabilities

Explicit pick only — `connectors.agents: "docker"` or
`--connector docker`. No `matchDir`: a repo's devcontainer.json is the
project's file, not a claim on bro's backend resolution; auto-routing
every devcontainer'd repo into containers would hijack native spawns.

`capabilities()`: `{ attach: false, respawn: true, supervisor: 'none' }`
— the daemon is the process supervisor; `docker version` gates spawn
(`'unavailable'` when absent/down).

### Knobs (`agents.docker`)

| Key | Default | What |
| --- | ------- | ---- |
| `image` | unset | Image ref; wins over the devcontainer lookup |
| `devcontainer` | `.devcontainer/devcontainer.json` | Path, repoRoot-relative or absolute |
| `command` | `loop.agent` | Agent command template, `{promptFile}` expanded |
| `runArgs` | unset | Extra `docker run` args — array or whitespace-split string (`--network`, `-p`, `--memory`, mounts for credentials/config) |
| `provider`, `sessionKind` | — | The shared cross-backend keys, unchanged |

The agent CLI itself must exist inside the image — the devcontainer
image is the operator's statement that the toolchain (including the
agent) is provisioned there. `npx`-resolvable CLIs work wherever npm
does.

## Plan

- [x] `specs/bro-huy5o.10.md` — this spec
- [x] `agent-connectors.ts` — `docker` connector: `dockerRun`, JSONC
      devcontainer parse, image resolution + content-hash build,
      spawn (env file + mounts + `docker run -d --init --rm`),
      inspect/ps liveness, `docker rm -f` stop, `dockerLive` occupancy
      probe, registration
- [x] `agent-connectors.test.ts` — `FAKE_DOCKER` shim (state-file
      containers, detached `sh -c` spawn) + the shared connector
      contract suite + docker-specific cases (image resolution,
      devcontainer parse, daemon-down degradation)
- [x] docs — `skills/agents/SKILL.md` backend mention,
      `configuration.md` `agents.docker` rows
