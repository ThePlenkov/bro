import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  AgentNotFound,
  type AgentConnectorEnv,
  SpawnError,
  agentsHome,
  findAgentEntry,
  fleetCapOf,
  getCredentialScope,
  isAllowedByEnvPolicy,
  markStoppedEntry,
  patchAgentRegistry,
  pollUntilGone,
  prepareSpawn,
  rebindSpawnLease,
  releaseSessionSlot,
  releaseSessionStart,
  releaseSpawnLease,
  retagSessionSlots,
  spawnHome,
  stepParent,
  tmuxProbe,
  tmuxRun,
  tmuxSessionName,
  toTmuxInfo,
  touchWorkMarker,
  warnNoPromptFile,
  workerRunLine,
  workerTmpDir,
  workerTmpEnvPins,
  workerWithResume,
  writePrivateFileSync,
  writeWorkMarker,
  ensureWorkerTmpDir,
  envKeyDropped,
  GIT_REPOSITORY_ENV_KEYS,
  agentEnvPins,
  externalGuardOf,
  sessionQuotaOf,
  shQuote,
  workerCliBadge,
  readAgentRegistry,
  procStat,
  TMUX_DEAD_ERR,
  withAgentRegistryLock,
} from './spawn-harness.ts';
import type {
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  ConnectorCtx,
  SpawnSpec,
} from './types.ts';
import { rmSync } from 'node:fs';
import { assertMutableConfig } from '../config-policy.ts';
import type { Lease } from '@broject/core';

interface TmuxSpawnInput {
  dir: string;
  env: AgentConnectorEnv;
  command: string;
  socket: string;
  spec: SpawnSpec;
}

interface TmuxPreparedSpawn {
  agentId: string;
  promptFile: string;
  log: string;
  stderrLog?: string;
  exitFile: string;
  lease: Lease;
  reservation: Parameters<typeof releaseSessionSlot>[0] | undefined;
  resumeSessionId?: string;
  crossKindReservations: Parameters<typeof releaseSessionStart>[0];
  mol: string;
  home: string;
  panePid?: number;
}

async function spawnTmuxAgent(input: TmuxSpawnInput): Promise<AgentInfo> {
  const { dir, env, command, socket, spec } = input;
  assertMutableConfig(dir);
  const home = spawnHome(dir, 'tmux', command, spec);
  const ver = tmuxRun(socket, ['-V']);
  if (ver.missing || ver.code !== 0) {
    throw new SpawnError(
      `tmux unavailable — ${ver.missing ? 'not on PATH' : ver.err}`,
      'unavailable'
    );
  }
  const mol = stepParent(spec.beadsDir, spec.molStep);
  let spawnLease: Lease | undefined;
  try {
    return withAgentRegistryLock(dir, () => {
      const prepared = prepareTmuxSpawn({
        dir,
        env,
        command,
        socket,
        spec,
        home: home!,
        mol: mol!,
      });
      spawnLease = prepared.lease;
      launchTmuxSession({ ...input, home: home!, mol: mol! }, prepared);
      const spawned = patchAgentRegistry(
        dir,
        spec.molStep,
        prepared.panePid === undefined
          ? {}
          : {
              pid: prepared.panePid,
              pidStart: procStat(prepared.panePid)?.start ?? null,
            }
      );
      const hasPanePid = prepared.panePid !== undefined;
      rebindSpawnLease(
        dir,
        prepared.lease,
        hasPanePid ? { host: hostname(), pid: prepared.panePid } : {}
      );
      if (hasPanePid) {
        const panePid = prepared.panePid!;
        retagSessionSlots([prepared.reservation, ...prepared.crossKindReservations], panePid);
      }
      writeWorkMarker(dir, prepared.agentId, spec.molStep, prepared.panePid);
      return toTmuxInfo(socket, dir, home, spec.molStep, spawned);
    });
  } catch (err) {
    if (spawnLease !== undefined) releaseSpawnLease(dir, spawnLease);
    throw err;
  }
}

function prepareTmuxSpawn(
  input: TmuxSpawnInput & { home: string; mol: string }
): TmuxPreparedSpawn {
  const { dir, env, command, socket, spec, home, mol } = input;
  const prepared = prepareSpawn(dir, home, 'tmux', spec, {
    isLive: e => {
      const name = tmuxSessionName(e);
      if (name === undefined) return false;
      const probe = tmuxProbe(socket, name);
      if (probe.live === 'unknown') {
        throw new SpawnError(
          `cannot verify ${spec.molStep}'s tmux session — ${probe.err}`,
          'unavailable'
        );
      }
      if (probe.live === 'running') touchWorkMarker(dir, e.agentId);
      return probe.live === 'running';
    },
    liveDetail: e => `session ${tmuxSessionName(e) ?? '?'}`,
    entry: id => ({ session: `bro-${id}` }),
    cap: { max: fleetCapOf(env), env },
    env,
    sessionQuota: () => sessionQuotaOf(env, 'tmux', spec, command),
    spawnCommand: command,
    external: externalGuardOf(env),
  });
  return { ...prepared, mol, home, reservation: prepared.reservation };
}

function launchTmuxSession(
  input: TmuxSpawnInput & { home: string; mol: string },
  prepared: TmuxPreparedSpawn
): void {
  const { dir, env, command, socket, spec, home } = input;
  const {
    agentId,
    promptFile,
    log,
    stderrLog,
    exitFile,
    reservation,
    crossKindReservations,
    resumeSessionId,
  } = prepared;
  const session = `bro-${agentId}`;
  const workerTmp = workerTmpDir(spec.repoRoot, agentId);
  tmuxRun(socket, ['kill-session', '-t', session]);
  const envFile = join(home, `${agentId}.env`);
  try {
    const launch = buildTmuxLaunch({ env, command, spec, prepared, envFile, workerTmp });
    const res = tmuxRun(socket, [
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      spec.repoRoot,
      ...launch.envArgs,
      launch.paneCommand,
    ]);
    if (res.code !== 0) throw new SpawnError(`tmux new-session failed — ${res.err}`, 'unavailable');
  } catch (err) {
    try {
      rmSync(envFile, { force: true });
    } catch {
      /* preserve launch error */
    }
    if (reservation !== undefined) releaseSessionSlot(reservation);
    releaseSessionStart(crossKindReservations);
    try {
      patchAgentRegistry(dir, spec.molStep, {
        spawnError: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* entry remains for diagnostics */
    }
    throw err;
  }
  const pane = tmuxRun(socket, ['list-panes', '-t', session, '-F', '#{pane_pid}']);
  const panePid = pane.code === 0 ? Number(pane.out.trim().split('\n')[0]) : Number.NaN;
  prepared.panePid = Number.isInteger(panePid) && panePid > 0 ? panePid : undefined;
}

function buildTmuxLaunch(input: {
  env: AgentConnectorEnv;
  command: string;
  spec: SpawnSpec;
  prepared: TmuxPreparedSpawn;
  envFile: string;
  workerTmp: string | undefined;
}): { envArgs: string[]; paneCommand: string } {
  const { env, command, spec, prepared, envFile, workerTmp } = input;
  const policy = getCredentialScope(env, 'tmux') ?? { strictEnv: false };
  const ambient = Object.entries({ ...process.env, ...spec.env })
    .filter((e): e is [string, string] => isTmuxEnvEntry(e, workerTmp, spec, env, policy))
    .map(([key, value]) => `export ${key}=${shQuote(value)}`)
    .join('\n');
  writePrivateFileSync({ path: envFile, data: `${ambient}\n` });
  const worker = workerWithResume(spec.worker, prepared.resumeSessionId);
  const envArgs = [
    ...agentEnvPins(
      spec,
      prepared.agentId,
      prepared.promptFile,
      workerCliBadge(worker, command),
      prepared.mol
    ),
    ...workerTmpEnvPins(workerTmp),
  ].flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  ensureWorkerTmpDir(workerTmp);
  warnNoPromptFile(worker, command);
  const runLine = workerRunLine(worker, command);
  const stderr = prepared.stderrLog === undefined ? '2>&1' : `2>> ${shQuote(prepared.stderrLog)}`;
  const script = `. ${shQuote(envFile)}; rm -f ${shQuote(envFile)}; { ${runLine}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(prepared.exitFile)} ); } ${stderr} | tee -a ${shQuote(prepared.log)}`;
  return { envArgs, paneCommand: `sh -c ${shQuote(script)}` };
}

function isTmuxEnvEntry(
  entry: [string, unknown],
  workerTmp: string | undefined,
  spec: SpawnSpec,
  env: AgentConnectorEnv,
  policy: ReturnType<typeof getCredentialScope>
): entry is [string, string] {
  return (
    typeof entry[1] === 'string' &&
    /^[A-Za-z_]\w*$/.test(entry[0]) &&
    !envKeyDropped(entry[0], workerTmp !== undefined) &&
    !GIT_REPOSITORY_ENV_KEYS.has(entry[0]) &&
    isAllowedByEnvPolicy(
      entry[0],
      entry[1],
      'tmux',
      spec,
      env,
      policy,
      Object.hasOwn(spec.env ?? {}, entry[0])
    )
  );
}

export function makeTmuxConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents['tmux'] ?? {};
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ??
    env.loop?.agent ??
    '';
  const socket = typeof knobs.socket === 'string' ? knobs.socket : 'bro';

  const findEntry = (id: string) => findAgentEntry(dir, 'tmux', id);

  return {
    name: 'tmux',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      return spawnTmuxAgent({ dir, env, command, socket, spec });
    },

    async list() {
      // NOSONAR — connector contract is async; the body is sync
      try {
        const ver = tmuxRun(socket, ['-V']);
        if (ver.missing || ver.code !== 0) {
          return { agents: [], degraded: ver.missing ? 'tmux not on PATH' : ver.err };
        }
        const home = agentsHome(dir);
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'tmux'
        );
        // one server round-trip for the whole fleet instead of a
        // has-session per entry — a name absent from a SUCCESSFUL
        // listing is proof of dead, and so is a dead-server error (the
        // server holds its sessions). Any other failure degrades the
        // list rather than reporting live agents as corpses
        const ls = tmuxRun(socket, ['list-sessions', '-F', '#{session_name}']);
        if (ls.code !== 0 && !TMUX_DEAD_ERR.test(ls.err)) {
          return { agents: [], degraded: ls.err !== '' ? ls.err : `tmux exited ${ls.code}` };
        }
        const live = new Set(ls.out.split('\n').filter(s => s !== ''));
        return {
          agents: entries.map(([molStep, e]) => toTmuxInfo(socket, dir, home, molStep, e, live)),
        };
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async status(id: string): Promise<AgentInfo> {
      // NOSONAR — connector contract is async; the body is sync
      const hit = findEntry(id);
      if (!hit) {
        throw new AgentNotFound(`no tmux agent ${id}`);
      }
      return toTmuxInfo(socket, dir, agentsHome(dir), hit[0], hit[1]);
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id);
      if (!hit) {
        return; // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit;
      const name = tmuxSessionName(entry);
      if (name !== undefined) {
        tmuxRun(socket, ['kill-session', '-t', name]);
        // let the kill land before recording the stop — 'stopped' on a
        // still-live session would let a respawn run alongside it
        await pollUntilGone(() => tmuxProbe(socket, name).live === 'running');
      }
      // a respawn during the kill wait re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' + the marker drop land on a live, respawned entry
      markStoppedEntry({
        dir,
        molStep,
        entry,
        id,
        what: 'tmux session',
        probe: name === undefined ? undefined : () => tmuxProbe(socket, name),
      });
    },

    capabilities: () => ({ attach: true, respawn: true, supervisor: 'none' }),
  };
}
