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

  const launchDockerContainer = (input: {
    spec: SpawnSpec;
    home: string;
    agentId: string;
    promptFile: string;
    log: string;
    stderrLog: string | undefined;
    exitFile: string;
    resumeSessionId: string | undefined;
    name: string;
    mol: string;
    image: string;
  }): string => {
    const {
      spec,
      home,
      agentId,
      promptFile,
      log,
      stderrLog,
      exitFile,
      resumeSessionId,
      name,
      mol,
      image,
    } = input;
    const envFile = join(home, `${agentId}.env`);
    try {
      dockerRun({ args: ['rm', '-f', name] });
      writeDockerEnvFile(envFile, spec);
      const res = runDockerCommand({
        name,
        spec,
        envFile,
        agentId,
        promptFile,
        log,
        stderrLog,
        exitFile,
        resumeSessionId,
        mol,
        image,
        runArgs,
      });
      rmSync(envFile, { force: true });
      if (res.code !== 0) {
        const why = res.err !== '' ? res.err : `exited ${res.code}`;
        throw new SpawnError(`docker run failed — ${why}`, 'unavailable');
      }
      return res.out.trim().split('\n')[0] ?? '';
    } catch (err) {
      dockerRun({ args: ['rm', '-f', name] });
      try {
        rmSync(envFile, { force: true });
      } catch {
        // cleanup must not mask the launch error
      }
      throw err;
    }
  };

  const runDockerCommand = (input: {
    name: string;
    spec: SpawnSpec;
    envFile: string;
    agentId: string;
    promptFile: string;
    log: string;
    stderrLog: string | undefined;
    exitFile: string;
    resumeSessionId: string | undefined;
    mol: string;
    image: string;
    runArgs: string[];
  }) => {
    const {
      name,
      spec,
      envFile,
      agentId,
      promptFile,
      log,
      stderrLog,
      exitFile,
      resumeSessionId,
      mol,
      image,
      runArgs,
    } = input;
    const worker = workerWithResume(spec.worker, resumeSessionId);
    warnNoPromptFile(worker, command);
    const cliBadge = workerCliBadge(worker, command);
    const runLine = workerRunLine(worker, command);
    const wrapper = dockerOutputWrapper(runLine, log, stderrLog, exitFile);
    return dockerRun({
      args: dockerLaunchArgs({
        name,
        spec,
        envFile,
        agentId,
        promptFile,
        cliBadge,
        mol,
        runArgs,
        image,
        wrapper,
      }),
    });
  };

  const dockerOutputWrapper = (
    runLine: string,
    log: string,
    stderrLog: string | undefined,
    exitFile: string
  ): string =>
    stderrLog === undefined
      ? `{ ${runLine}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} ); } >> ${shQuote(log)} 2>&1`
      : `{ ${runLine}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} ); } >> ${shQuote(log)} 2>> ${shQuote(stderrLog)}`;

  const dockerLaunchArgs = (input: {
    name: string;
    spec: SpawnSpec;
    envFile: string;
    agentId: string;
    promptFile: string;
    cliBadge: string | undefined;
    mol: string;
    runArgs: string[];
    image: string;
    wrapper: string;
  }): string[] => {
    const { name, spec, envFile, agentId, promptFile, cliBadge, mol, runArgs, image, wrapper } =
      input;
    return dockerRunArgv(
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
    );
  };

  const releaseDockerSpawn = (input: {
    err: unknown;
    reservation: Parameters<typeof releaseSessionSlot>[0] | undefined;
    crossKindReservations: Parameters<typeof releaseSessionStart>[0];
    lease: Parameters<typeof rebindSpawnLease>[1];
    molStep: string;
  }): never => {
    const { err, reservation, crossKindReservations, lease, molStep } = input;
    if (reservation !== undefined) releaseSessionSlot(reservation);
    releaseSessionStart(crossKindReservations);
    releaseSpawnLease(dir, lease);
    try {
      patchAgentRegistry(dir, molStep, {
        spawnError: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // the entry landed already — the SpawnError still reports
    }
    throw err;
  };

  const completeDockerSpawn = (input: {
    spec: SpawnSpec;
    home: string;
    image: string;
    mol: string;
    dockerPidIsLocal: boolean;
    prepared: ReturnType<typeof prepareSpawn>;
  }): AgentInfo => {
    const { spec, home, image, mol, dockerPidIsLocal, prepared } = input;
    const {
      agentId,
      promptFile,
      log,
      stderrLog,
      exitFile,
      runId,
      lease,
      reservation,
      resumeSessionId,
      crossKindReservations,
    } = prepared;
    const name = `bro-${agentId}`;
    try {
      const containerId = launchDockerContainer({
        spec,
        home,
        agentId,
        promptFile,
        log,
        stderrLog,
        exitFile,
        resumeSessionId,
        name,
        mol: mol!,
        image,
      });
      const insp = dockerInspect({ name });
      const spawned = patchAgentRegistry(dir, spec.molStep, {
        containerId,
        ...(insp.pid !== undefined ? { pid: insp.pid, pidStart: null } : {}),
      });
      rebindSpawnLease(dir, lease, dockerPidIsLocal ? { host: hostname(), pid: insp.pid } : {});
      if (dockerPidIsLocal && insp.pid !== undefined) {
        retagSessionSlots([reservation, ...crossKindReservations], insp.pid);
      }
      writeWorkMarker(dir, agentId, spec.molStep, insp.pid);
      return toDockerInfo(dir, home, spec.molStep, spawned);
    } catch (err) {
      return releaseDockerSpawn({
        err,
        reservation,
        crossKindReservations,
        lease,
        molStep: spec.molStep,
      });
    }
  };

  return {
    name: 'docker',

    // NOSONAR — connector contract is async; the critical section is intentionally centralized
    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      assertMutableConfig(dir);
      const home = spawnHome(dir, 'docker', command, spec);
      const daemon = dockerDaemonUp();
      if (!daemon.up) {
        throw new SpawnError(`docker unavailable — ${daemon.err}`, 'unavailable');
      }
      const image = dockerImageFor(spec, knobs);
      const mol = stepParent(spec.beadsDir, spec.molStep);
      const dockerPidIsLocal =
        process.env.DOCKER_HOST === undefined && process.env.DOCKER_CONTEXT === undefined;
      return withAgentRegistryLock(dir, () => {
        const {
          agentId,
          promptFile,
          log,
          stderrLog,
          exitFile,
          runId,
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
            const p = dockerInspect({ name: n });
            if (p.live === 'unknown') {
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
        return completeDockerSpawn({
          spec,
          home,
          image: image!,
          mol: mol!,
          dockerPidIsLocal,
          prepared: {
            agentId,
            promptFile,
            log,
            stderrLog,
            exitFile,
            runId,
            lease,
            reservation,
            resumeSessionId,
            crossKindReservations,
          },
        });
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
        dockerRun({ args: ['rm', '-f', target] });
        // let the rm land before recording the stop — 'stopped' on a
        // still-live container would let a respawn run beside it
        await pollUntilGone(() => dockerInspect({ name }).live === 'running');
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
        probe: name === undefined ? undefined : () => dockerInspect({ name }),
      });
    },

    capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' }),
  };
}
