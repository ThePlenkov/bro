import { assertMutableConfig } from '../config-policy.ts';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type {
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  ConnectorCtx,
  SpawnSpec,
} from './types.ts';
import * as harness from './core.ts';
const {
  registerAgentConnector,
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
type DockerLaunchInput = {
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
};

/** The effective `--user` uid of operator runArgs — accepts every docker
 *  spelling (`--user X`, `--user=X`, `-u X`, glued `-uX`). Returns the raw
 *  value or undefined when no user flag rides the args. */
function dockerUserOf(runArgs: string[]): string | undefined {
  // docker applies the LAST repeated flag — validating the first would
  // judge a principal the run never uses
  let user: string | undefined;
  for (let i = 0; i < runArgs.length; i++) {
    const a = runArgs[i];
    if (a === '--user' || a === '-u') {
      user = runArgs[i + 1];
    } else if (a.startsWith('--user=')) {
      user = a.slice('--user='.length);
    } else if (a.startsWith('-u') && a.length > 2) {
      user = a.slice(2);
    }
  }
  return user;
}

/** Refuse a numeric uid that can never traverse the mount permissions:
 *  the agents dir is 0700 host-owned and prompt/log files 0600 — any uid
 *  that is neither root nor the host uid dies with EACCES inside the
 *  container and only stderr hints why. Named users can't be resolved
 *  without inspecting the image — they pass through (bro-frida). */
function assertDockerUserCompatible(runArgs: string[]): void {
  const user = dockerUserOf(runArgs);
  if (user === undefined || !/^\d+(?::\d+)?$/.test(user)) {
    return;
  }
  const uid = Number(user.split(':')[0]);
  // no getuid → no POSIX modes either (win32) — the whole EACCES premise
  // is absent there, so validating would only false-positive
  if (typeof process.getuid !== 'function') {
    return;
  }
  const hostUid = process.getuid();
  if (uid !== 0 && uid !== hostUid) {
    throw new SpawnError(
      `agents.docker.runArgs pins --user uid ${uid} — the mounted agents dir is 0700 uid ${hostUid}, ` +
        `so the worker would die with EACCES. Use the host uid, root (0), or a named user the image resolves.`,
      'config'
    );
  }
}

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
  assertDockerUserCompatible(runArgs);

  const findEntry = (id: string) => findAgentEntry(dir, 'docker', id);

  const launchDockerContainer = (input: DockerLaunchInput): string => {
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
      removeDockerContainer(name);
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
      assertDockerRunSucceeded(res);
      return res.out.trim().split('\n')[0] ?? '';
    } catch (err) {
      cleanupDockerLaunch(name, envFile);
      throw err;
    }
  };

  const removeDockerContainer = (name: string): void => {
    dockerRun({ args: ['rm', '-f', name] });
  };

  const cleanupDockerLaunch = (name: string, envFile: string): void => {
    removeDockerContainer(name);
    try {
      rmSync(envFile, { force: true });
    } catch {
      // cleanup must not mask the launch error
    }
  };

  const assertDockerRunSucceeded = (res: ReturnType<typeof dockerRun>): void => {
    if (res.code !== 0) {
      const why = res.err !== '' ? res.err : `exited ${res.code}`;
      throw new SpawnError(`docker run failed — ${why}`, 'unavailable');
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
    return dockerRunArgv({
      name,
      spec,
      mounts: dockerMounts(spec),
      envFile,
      agentId,
      promptFile,
      cliBadge,
      mol,
      runArgs,
      image,
      wrapper,
      strictEnv: getCredentialScope(env, 'docker').strictEnv,
    });
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
    const name = `bro-${prepared.agentId}`;
    try {
      const containerId = launchPreparedDocker({ spec, home, image, mol: mol!, name, prepared });
      return finalizeDockerSpawn({
        dir,
        spec,
        home,
        name,
        agentId: prepared.agentId,
        containerId,
        lease: prepared.lease,
        reservation: prepared.reservation,
        crossKindReservations: prepared.crossKindReservations,
        dockerPidIsLocal,
      });
    } catch (err) {
      return releaseDockerSpawn({
        err,
        reservation: prepared.reservation,
        crossKindReservations: prepared.crossKindReservations,
        lease: prepared.lease,
        molStep: spec.molStep,
      });
    }
  };

  const launchPreparedDocker = (input: {
    spec: SpawnSpec;
    home: string;
    image: string;
    mol: string;
    name: string;
    prepared: ReturnType<typeof prepareSpawn>;
  }): string =>
    launchDockerContainer({
      spec: input.spec,
      home: input.home,
      agentId: input.prepared.agentId,
      promptFile: input.prepared.promptFile,
      log: input.prepared.log,
      stderrLog: input.prepared.stderrLog,
      exitFile: input.prepared.exitFile,
      resumeSessionId: input.prepared.resumeSessionId,
      name: input.name,
      mol: input.mol,
      image: input.image,
    });

  const finalizeDockerSpawn = (input: {
    dir: string;
    spec: SpawnSpec;
    home: string;
    name: string;
    agentId: string;
    containerId: string;
    lease: Parameters<typeof rebindSpawnLease>[1];
    reservation: Parameters<typeof releaseSessionSlot>[0] | undefined;
    crossKindReservations: Parameters<typeof releaseSessionStart>[0];
    dockerPidIsLocal: boolean;
  }): AgentInfo => {
    const {
      dir: root,
      spec: spawnSpec,
      home: agentHome,
      name: containerName,
      agentId: id,
      containerId: idValue,
      lease: spawnLease,
      reservation: slot,
      crossKindReservations: otherSlots,
      dockerPidIsLocal: localPid,
    } = input;
    const insp = dockerInspect({ name: containerName });
    const spawned = recordDockerContainer({
      dir: root,
      spec: spawnSpec,
      containerId: idValue,
      pid: insp.pid,
    });
    rebindSpawnLease(root, spawnLease, localPid ? { host: hostname(), pid: insp.pid } : {});
    if (localPid && insp.pid !== undefined) retagSessionSlots([slot, ...otherSlots], insp.pid);
    writeWorkMarker(root, id, spawnSpec.molStep, insp.pid);
    return toDockerInfo({ dir: root, home: agentHome, molStep: spawnSpec.molStep, entry: spawned });
  };

  const recordDockerContainer = (input: {
    dir: string;
    spec: SpawnSpec;
    containerId: string;
    pid: number | undefined;
  }): AgentRegistryEntry => {
    const { dir: root, spec: spawnSpec, containerId: id, pid } = input;
    return patchAgentRegistry(root, spawnSpec.molStep, {
      containerId: id,
      ...(pid === undefined ? {} : { pid, pidStart: null }),
    });
  };

  const dockerLiveness =
    (spec: SpawnSpec) =>
    (e: AgentRegistryEntry): boolean => {
      const name = dockerContainerName(e);
      if (name === undefined) return false;
      const p = dockerInspect({ name });
      if (p.live === 'unknown') {
        throw new SpawnError(`cannot verify ${spec.molStep}'s container — ${p.err}`, 'unavailable');
      }
      if (p.live === 'running') touchWorkMarker(dir, e.agentId);
      return p.live === 'running';
    };

  const prepareDocker = (input: {
    spec: SpawnSpec;
    home: string;
    image: string;
    mol: string;
    dockerPidIsLocal: boolean;
  }): AgentInfo => {
    const { spec, home, image, mol, dockerPidIsLocal } = input;
    return withAgentRegistryLock(dir, () => {
      const prepared = prepareSpawn(dir, home, 'docker', spec, {
        isLive: dockerLiveness(spec),
        liveDetail: e => `container ${dockerContainerName(e) ?? '?'}`,
        entry: id => ({ container: `bro-${id}`, containerId: undefined }),
        cap: { max: fleetCapOf(env), env },
        env,
        sessionQuota: () => sessionQuotaOf(env, 'docker', spec, command),
        spawnCommand: command,
        external: externalGuardOf(env),
      });
      return completeDockerSpawn({ spec, home, image, mol, dockerPidIsLocal, prepared });
    });
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
      return prepareDocker({
        spec,
        home,
        image: image!,
        mol: mol!,
        dockerPidIsLocal,
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
          agents: entries.map(([molStep, e]) =>
            toDockerInfo({ dir, home, molStep, entry: e, live })
          ),
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
      return toDockerInfo({ dir, home: agentsHome(dir), molStep: hit[0], entry: hit[1] });
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

registerAgentConnector('docker', makeDockerConnector, {}, { builtin: true });
