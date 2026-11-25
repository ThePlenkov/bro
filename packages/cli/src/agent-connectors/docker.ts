import { assertMutableConfig } from '../config-policy.ts';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { AgentConnector, AgentInfo, ConnectorCtx, SpawnSpec } from './types.ts';
import * as harness from './spawn-harness.ts';
const {
  AgentNotFound,
  SpawnError,
  agentsHome,
  dockerContainerName,
  dockerDaemonUp,
  dockerImageFor,
  dockerInspect,
  dockerLiveContainers,
  dockerMounts,
  dockerRun,
  dockerRunArgs,
  dockerRunArgv,
  externalGuardOf,
  findAgentEntry,
  fleetCapOf,
  getCredentialScope,
  markStoppedEntry,
  patchAgentRegistry,
  pidAlive,
  pollUntilGone,
  prepareSpawn,
  readAgentRegistry,
  rebindSpawnLease,
  releaseSessionSlot,
  releaseSessionStart,
  releaseSpawnLease,
  retagSessionSlots,
  sessionQuotaOf,
  shQuote,
  spawn,
  spawnHome,
  stepParent,
  toDockerInfo,
  touchWorkMarker,
  warnNoPromptFile,
  withAgentRegistryLock,
  workerCliBadge,
  workerRunLine,
  workerWithResume,
  writeDockerEnvFile,
  writeWorkMarker,
} = harness;
type AgentConnectorEnv = harness.AgentConnectorEnv;
type ListResult = harness.ListResult;

export function makeDockerConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents['docker'] ?? {};
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ??
    env.loop?.agent ??
    '';
  const runArgs = dockerRunArgs(knobs.runArgs);

  const findEntry = (id: string) => findAgentEntry(dir, 'docker', id);

  return {
    name: 'docker',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      // NOSONAR — connector contract is async; the work is one sync critical section
      // policy BEFORE the daemon probe and image pull/build — a refused
      // spawn must not pay (or log) a docker fetch it will never use
      assertMutableConfig(dir);
      const home = spawnHome(dir, 'docker', command, spec);
      const daemon = dockerDaemonUp();
      if (!daemon.up) {
        throw new SpawnError(`docker unavailable — ${daemon.err}`, 'unavailable');
      }
      // image resolution outside the lock: a first devcontainer build
      // pays minutes — holding the registry lock through it would
      // serialize every concurrent spawn behind one `docker build`
      const image = dockerImageFor(spec, knobs);
      const mol = stepParent(spec.beadsDir, spec.molStep);
      // only a LOCAL daemon's State.Pid is probeable from this host
      const dockerPidIsLocal =
        process.env.DOCKER_HOST === undefined && process.env.DOCKER_CONTEXT === undefined;
      return withAgentRegistryLock(dir, () => {
        const {
          agentId,
          promptFile,
          log,
          stderrLog,
          exitFile,
          lease,
          reservation,
          resumeSessionId,
          crossKindReservations,
        } = prepareSpawn(dir, home, 'docker', spec, {
          isLive: e => {
            const n = dockerContainerName(e);
            if (n === undefined) {
              return false;
            }
            const p = dockerInspect(n);
            if (p.live === 'unknown') {
              // an unverifiable liveness probe must not let a duplicate
              // spawn run beside a worker that may still be alive
              throw new SpawnError(
                `cannot verify ${spec.molStep}'s container — ${p.err}`,
                'unavailable'
              );
            }
            if (p.live === 'running') {
              touchWorkMarker(dir, e.agentId);
            }
            return p.live === 'running';
          },
          liveDetail: e => `container ${dockerContainerName(e) ?? '?'}`,
          entry: id => ({ container: `bro-${id}`, containerId: undefined }),
          cap: { max: fleetCapOf(env), env },
          env,
          sessionQuota: () => sessionQuotaOf(env, 'docker', spec, command),
          spawnCommand: command,
          external: externalGuardOf(env),
        });
        const name = `bro-${agentId}`;
        const envFile = join(home, `${agentId}.env`);
        let containerId = '';
        try {
          // a corpse with our name (crash between entry and rm, a
          // respawn over a stopped container) collides docker run —
          // clear it
          dockerRun(['rm', '-f', name]);
          writeDockerEnvFile(envFile, spec);
          const worker = workerWithResume(spec.worker, resumeSessionId);
          warnNoPromptFile(worker, command);
          const cliBadge = workerCliBadge(worker, command);
          const runLine = workerRunLine(worker, command);
          // the native wrapper, verbatim — the mounted paths make .exit/
          // log land where the host ladder reads them. --init gives the
          // worker a reaper so grandchildren can't zombie inside; --rm
          // removes the corpse on exit so `docker ps -a` doesn't fill
          // with bro litter and the name frees for a respawn.
          const wrapper =
            stderrLog !== undefined
              ? `{ ${runLine}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} ); } >> ${shQuote(log)} 2>> ${shQuote(stderrLog)}`
              : `{ ${runLine}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} ); } >> ${shQuote(log)} 2>&1`;
          const res = dockerRun(
            dockerRunArgv(
              name,
              spec,
              dockerMounts(spec),
              envFile,
              agentId,
              promptFile,
              cliBadge,
              mol,
              runArgs,
              image,
              wrapper,
              getCredentialScope(env, 'docker').strictEnv
            )
          );
          rmSync(envFile, { force: true }); // the env is baked into container config — the file has done its job
          if (res.code !== 0) {
            const why = res.err !== '' ? res.err : `exited ${res.code}`;
            throw new SpawnError(`docker run failed — ${why}`, 'unavailable');
          }
          containerId = res.out.trim().split('\n')[0] ?? '';
        } catch (err) {
          // ANY setup failure after the reservation releases it — a
          // leaked slot starves the quota until its TTL lapses. The
          // registry entry already landed; the spawnError fields it,
          // and the env file (ambient secrets included) goes too.
          dockerRun(['rm', '-f', name]);
          try {
            rmSync(envFile, { force: true });
          } catch {
            // a cleanup failure must not mask the launch error or
            // skip the slot/lease releases below — same guard the
            // tmux catch carries
          }
          if (reservation !== undefined) {
            releaseSessionSlot(reservation);
          }
          releaseSessionStart(crossKindReservations);
          releaseSpawnLease(dir, lease);
          try {
            patchAgentRegistry(dir, spec.molStep, {
              spawnError: err instanceof Error ? err.message : String(err),
            });
          } catch {
            // the entry landed already — the SpawnError still reports
          }
          throw err;
        }
        const insp = dockerInspect(name);
        const spawned = patchAgentRegistry(dir, spec.molStep, {
          containerId,
          ...(insp.pid !== undefined
            ? // State.Pid is a display handle only — a remote/VM daemon
              // reports ITS host's pid, meaningless to local /proc and
              // pidAlive; pidStart stays null so nothing correlates it
              { pid: insp.pid, pidStart: null }
            : {}),
        });
        // a usable local State.Pid downgrades the born-TTL lease to
        // local governance — a remote daemon's pid names its own host,
        // and an empty patch keeps the foreign stamp
        rebindSpawnLease(dir, lease, dockerPidIsLocal ? { host: hostname(), pid: insp.pid } : {});
        // the slot claims follow the lane's holder — a local container
        // pid is probeable like native's child (spec bro-x601l); a
        // remote daemon's pid names its own host and retags nothing
        if (dockerPidIsLocal && insp.pid !== undefined) {
          retagSessionSlots([reservation, ...crossKindReservations], insp.pid);
        }
        writeWorkMarker(dir, agentId, spec.molStep, insp.pid);
        return toDockerInfo(dir, home, spec.molStep, spawned);
      });
    },

    async list(): Promise<ListResult> {
      // NOSONAR — connector contract is async; the work is sync
      try {
        const daemon = dockerDaemonUp();
        if (!daemon.up) {
          return { agents: [], degraded: daemon.err };
        }
        const home = agentsHome(dir);
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'docker'
        );
        // one daemon round-trip for the whole fleet — a name absent
        // from a successful listing is provably not running; a failed
        // one degrades the list rather than reporting corpses
        const live = dockerLiveContainers();
        if (live === undefined && entries.length > 0) {
          return { agents: [], degraded: 'docker ps failed — daemon unreachable' };
        }
        return {
          agents: entries.map(([molStep, e]) => toDockerInfo(dir, home, molStep, e, live)),
        };
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async status(id: string): Promise<AgentInfo> {
      // NOSONAR — connector contract is async; the work is sync
      const hit = findEntry(id);
      if (!hit) {
        throw new AgentNotFound(`no docker agent ${id}`);
      }
      return toDockerInfo(dir, agentsHome(dir), hit[0], hit[1]);
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id);
      if (!hit) {
        return; // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit;
      const name = dockerContainerName(entry);
      if (name !== undefined && entry.stopped !== true) {
        // rm by the immutable container ID when recorded — respawns
        // reuse agentId (and thus the name), so a name-targeted rm
        // landing after a respawn's run would kill the NEW worker
        const target =
          typeof entry.containerId === 'string' && entry.containerId !== ''
            ? entry.containerId
            : name;
        dockerRun(['rm', '-f', target]);
        // let the rm land before recording the stop — 'stopped' on a
        // still-live container would let a respawn run beside it
        await pollUntilGone(() => dockerInspect(name).live === 'running');
      }
      // a respawn during the rm re-probes and re-pins the entry under
      // the registry lock — re-verify under the SAME lock or 'stopped'
      // lands on a live, respawned entry
      markStoppedEntry({
        dir,
        molStep,
        entry,
        id,
        what: 'container',
        probe: name === undefined ? undefined : () => dockerInspect(name),
      });
    },

    capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' }),
  };
}
