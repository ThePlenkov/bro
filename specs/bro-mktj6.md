# bro-mktj6 — macOS parity for /proc-based paths

## Problem

/proc is read in commands/{peer,doctor,daemon,proc-owner,refguard}.ts and core/src/{proc,live-procs}.ts; on macOS these paths either crash or degrade silently. We need macOS parity for peer attribution, doctor, and live-procs (and related process inspection used by those paths) while keeping behavior correct on Linux.

Specific sites (from grep):
- core/src/proc.ts: reads /proc/<pid>/stat; pidAlive/procStat assume Linux /proc
- core/src/live-procs.ts: readProcRows/sweepOrphanProcs short-circuit to [] on non-linux or assume /proc layout; orphan sweep is Linux-specific
- packages/cli/src/commands/peer.ts: walks /proc/net/tcp{,6}, scans /proc/*/fd for socket inodes, reads /proc/*/stat/cmdline — all Linux-only
- packages/cli/src/commands/proc-owner.ts: reads /proc/*/{cmdline,environ,status,cwd}, walks process tree via /proc — Linux-only
- packages/cli/src/commands/daemon.ts: reads /proc/<pid>/cwd/cmdline/start time for supervision
- packages/cli/src/commands/refguard.ts: reads /proc/<pid>/cmdline
- packages/cli/src/commands/doctor.ts: reads /proc/<pid>/environ in places (serve env detection)

## Design

Provide cross-platform process inspection with injectable roots/probes (tests use fakes) and platform-specific implementations:

1. **core/src/proc.ts**: Make procStat/pidAlive work on macOS. 
- On macOS, use `ps -p <pid> -o stat=,lstart=` or parse `ps` output to get state and a start identifier. Also need starttime/start token for reuse detection (pidAlive compares start). 
- Alternatively use `sysctl` (KERN_PROC_PID) or shell out to ps. Keep same API shape `{ state: string, start: string } | null`. For zombies on macOS, state may be indicated differently; need to detect Z/zombie.
- On non-Linux, try macOS path; if neither works, return null/fail-open as before.
- Ensure injectable procDir not directly used here, but be compatible with patterns.

2. **core/src/live-procs.ts**: readProcRows currently returns [] if not linux. Need macOS implementation using ps/sysctl/lsof to build ProcRow equivalents (pid, comm, ppid, parentComm, cwd, startMs). Orphan sweep logic can remain similar if we can produce ProcRow objects. Also need to compute startMs (epoch ms). 
- For cwd on macOS, can use `lsof -a -p <pid> -d cwd -Fn` or `pwdx` not always available; or use `proc_pidinfo` via node-ffi? No native deps. Better use `lsof` or `ps` + `pwdx`? Or read /proc equivalent doesn't exist - use `lsof -p <pid> | grep cwd` or `lsof -Fn -p <pid> -a -d cwd`. Also `ps` can give cwd on some systems? Maybe use `lsof` (common on macOS). 
- For parent comm, need to read parent process info.
- This needs to be robust and testable (allow injecting command runners).

3. **packages/cli/src/commands/peer.ts**: Peer attribution needs to find which process owns the socket (remotePort/localPort) and walk process tree.
- On Linux: /proc/net/tcp + /proc/*/fd scanning. 
- On macOS: use `lsof -i TCP@localhost:<remotePort> -sTCP:ESTABLISHED` or similar to find connection; or `netstat -anv -p tcp | grep ...` Also need to map to pid. `lsof -i` can show PID. Also to find which local process has a socket connected to specific remote port on localhost, can do `lsof -nP -i TCP -sTCP:ESTABLISHED | grep <remotePort>`. Then get pid. Also need to be careful about which direction - peer is the other end connecting to our server.
- Process tree walking on macOS: use `ps -o pid,ppid,comm=` or read via sysctl? Or walk up by getting parent via `ps -o ppid= -p <pid>`. Also need comm and cmdline. `ps -o comm= -p <pid>` gives comm, `ps -o command= -p <pid>` gives full command line.
- Make all of this cross-platform with fallbacks.

4. **packages/cli/src/commands/proc-owner.ts**: Uses /proc extensively. Need macOS implementations:
- readProcText for /proc/* files -> use ps/lsof/sysctl equivalents
- procPpid via /proc/*/status PPid -> use `ps -o ppid= -p <pid>`
- procIsAgentCmd reads cmdline -> use `ps -o command= -p <pid>` or `ps -ww -o args= -p <pid>`
- AGENT_ENV_RE checks environ -> on macOS, getting environ of another process is possible via `ps eww -p <pid>` or `sysctl` on some systems? Or use `xargs -0` style from procfs not available. Getting another process's environment on macOS is restricted; may need to use `ps e -p <pid>` (but format varies). Also sometimes need to use `sysctl` KERN_PROCARGS or other methods. This can be tricky. But need best effort parity.
- proc cwd via /proc/*/cwd -> use `lsof -a -p <pid> -d cwd -Fn | tail -1 | cut -c2-` or `pwdx <pid>` (not always present). Alternatively `lsof` is common.
- For processesRootedIn/agentProcessesIn, need to enumerate all processes on macOS - `ps -axo pid=`, get cwd/cmdline for each. This is more expensive than /proc readdir but doable.

5. **packages/cli/src/commands/daemon.ts, refguard.ts, doctor.ts**: Similar adaptations - check for /proc existence, provide macOS alternatives.

Key principles:
- Preserve existing APIs and behavior on Linux
- On macOS, implement reasonable equivalents using standard tools (ps, lsof, sysctl) available on macOS
- Make operations injectable/testable where possible (like procDir parameter already exists in some places)
- Fail gracefully/degrade silently on macOS when info not available (as per task saying "macOS degrades silently" currently - we need to make it not silently fail in bad ways, make it work)
- Follow repo style (TypeScript, no native modules)
- Keep changes minimal but correct

## Verify

- On Linux: all existing tests pass (no regressions)
- On macOS (this environment is Linux per uname, but we need to write code that would work on macOS): code paths should not crash when platform is darwin; should use macOS implementations
- Add/update tests as needed for cross-platform behavior
- Run tests like CI: `npm test` or affected tests
