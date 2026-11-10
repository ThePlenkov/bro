# bro-ybo8z — spawn workers into their OWN systemd scope — loop's cgroup wipe kills in-flight sessions on every supervisor crash

## Problem

Native-backend workers (`bro fleet agents up`, `bro loop`, drive fixers,
acp workers) are detached `sh -c` children of the spawning process. When
the spawner is the loop/daemon **systemd user unit**, every worker lands
in that unit's cgroup. Under the default `KillMode=control-group`, any
supervisor crash — and any manual `systemctl stop bro-loop` — kills the
whole cgroup: every in-flight worker dies mid-session, no `.exit` file,
registry state `lost`.

Evidence (2026-10-26/27): loop crash ~22:37Z killed bro-i7t3b /
native-7806b9b3 (spawned 22:16Z) — dead with no record. Interim
mitigation in place: `KillMode=process` drop-ins on
`bro-{loop,daemon}.service`. This spec is the durable fix.

## Design

Wrap the native spawn in `systemd-run --user --scope` when a user
manager is reachable:

    systemd-run --user --scope --quiet --expand-environment=no \
      --description="bro agent <agentId> <molStep>" -- sh -c <wrapper> …

- **`--scope`, not a transient service.** systemd-run moves _itself_
  into the new scope and then **execs the payload in place** — cwd, the
  assembled env, and the stdio fds (.log/.stderr) ride the exec with
  zero plumbing. A transient service would reparent to the user manager
  and need `StandardOutput=`/env re-wiring — nothing else gained.
- **`--expand-environment=no` is mandatory.** systemd-run expands
  `$FOO`/`$$` in argv (ExecStart-style): the handshake script's `$$`,
  `$1`, `$@` would be mangled before `sh` ever saw it.
- **Process shape: pid continuity.** The exec preserves the pid:
  `child.pid` (registry pid), the handle file's `$$`, and the scope's
  main pid are **one** — `run-p<pid>-i*.scope`, a sibling of
  `bro-loop.service` in `app.slice`. The recorded pid keeps naming the
  real worker; `handle == pid`, scoped or not.
- **Survival.** The worker's scope is never a child of
  `bro-loop.service`: a loop crash, `systemctl stop bro-loop`, even a
  `KillMode=control-group` wipe of the whole unit cgroup leaves
  `run-*.scope` untouched.
- **Availability is probed, once per process**:
  `systemd-run --user --scope --quiet --expand-environment=no -- true`.
  No systemd-run / no user manager / refused → the plain `sh` spawn,
  today's shape unchanged. Opt-out: `agents.native.systemdScope: false`;
  `true` forces it (skips the probe). Test seam: `spawnTestSeam.scope`.

### Consequences for the supervision invariants

- **Liveness (nativeState)** — unchanged, and _stays_ unchanged:
  `pidAlive`/`groupMemberAlive` on the recorded pid answer the scoped
  worker directly (it IS that pid). A loop crash leaves it running in
  its own cgroup — no `.exit`, registry 'running', re-attachable.
- **Stop (`bro agents down`)** — `kill(-pid)` still reaches the scoped
  worker's own group. Two hardenings ride along so `down` stays correct
  under _either_ systemd-run topology and closes a documented blind
  spot:
  - The pre-signal tree snapshot (`unitSnapshot`) now also yields every
    **process group** the tree spans; `SIGTERM` goes to each —
    `{wrapper pgid} ∪ {member pgrps}`. Under an exec-style systemd-run
    that set is the single group it always was; under a _fork-style_
    one the scope payload's own pgid gets the signal too — and a
    `setsid`-escaped descendant (the blind spot bro-l8c4f.3 documented
    as 'unverified, not stopped') now dies with the unit.
  - `adoptNativeHandle` previously ran only when `entry.pid` was
    _missing_. Under a fork-style systemd-run the payload's handle pid
    would differ from the recorded shim pid — a dead recorded pid + a
    live orphan would have skipped adoption and been stamped `stopped`
    while still running. The handle is now consulted whenever the
    recorded pid fails liveness.
- **Registry** — no schema change: `pid`/`pidStart` keep pinning the
  spawned child, which under scope-exec is the worker itself.
- **Scope lifecycle** — scopes are transient; an emptied `run-*.scope`
  evaporates. No `--unit` naming — a respawn reusing the agentId must
  never collide on a lingering scope; `--description` carries
  `bro agent <agentId> <molStep>` for `systemd-cgls` forensics.

Not in scope: the daemon's own supervisor spawn (`bro daemon up` — a
supervisor, not a worker; `bro-daemon.service` + `KillMode=process`
owns its posture), tmux/docker/gascity/devin backends (different
survival models).

## Plan

- [x] spec (this file)
- [x] `agent-connectors.ts`: `systemdScopeProbe()` (exported, cached),
  `spawnTestSeam.scope`, knob `agents.native.systemdScope`, wrap the
  `spawn('sh', …)` call
- [x] `agent-connectors.ts` `stop()`: consult the handle when the
  recorded pid is dead (fork-topology insurance); signal every pgid
  in the pre-signal tree snapshot
- [x] tests: scope wrap lands the worker in `.scope` cgroup outside the
  spawner's; `handle == pid` holds under the wrap (exec-in-place);
  argv workers scope too; `systemdScope:false` keeps the worker in
  the spawner's cgroup
- [x] `.git/bro/watchdog.md` Night config section — scope posture
  documented, drop-in now redundant-but-harmless
- [x] CI-parity verification (`npm run build && npm run typecheck && npm test`)
