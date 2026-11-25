/**
 * Agent connector registry + shared types/helpers.
 */
import { type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type AccountWall,
  type AgentCause,
  type AgentConnector,
  type AgentInfo,
  AgentNotFound,
  type AgentRegistryEntry,
  type AgentState,
  admitSessionSlot,
  agentEntryBlocked,
  agentExitFileName,
  agentRegistryLockDepth,
  agentsSection,
  appendPrivateFileSync,
  BATCH_MARKER_ENV,
  type BrouterConfig,
  BrouterConfigError,
  bdActor,
  brouterStaticCatalog,
  type ConnectorCtx,
  claimStep,
  classifyExitCause,
  classifyExitCauseParts,
  cliCommandModel,
  commandCliName,
  countSessionReservations,
  DEFAULT_CONFIG,
  type DiscoveredSession,
  deriveAccountWalls,
  deriveProviderWalls,
  emitLifecycle,
  entryRunId,
  externalPlanes,
  type FleetLeaseTtls,
  type FleetMatrix,
  type FleetProfile,
  type FleetRouter,
  type FleetWallTtls,
  ghHost,
  gitTry,
  groupMemberAlive,
  handleOwner,
  isAgentCause,
  isAgentLearnCheck,
  isBatchSpawn,
  isQualifiedRouteId,
  JudgeUnavailable,
  type Lease,
  type LeaseHolder,
  type LeaseStore,
  type ListResult,
  laneBudgetKey,
  laneBudgetRefund,
  loadConfig,
  localLeaseStore,
  type MatrixVerdict,
  type ModelRoute,
  mainWorktreeRoot,
  mintAgentId,
  mintRunId,
  mkdirPrivateSync,
  openPrivateAppendSync,
  type ProcEntry,
  type ProviderCapLane,
  type ProviderEntry,
  ProviderSurfaceError,
  type ProviderWall,
  patchAgentRegistry,
  patchAgentRegistryIf,
  pidAlive,
  planesStartingSessions,
  probeStep,
  procStat,
  projectId,
  providerAccount,
  providerCallGrade,
  providerCapCensus,
  providerCapRefusal,
  providerSlotsDir,
  providerWallOwners,
  type ResolvedClass,
  type RoutingTable,
  rateDeathBackoff,
  readAgentRegistry,
  readLedgerWalls,
  rebindStep,
  recordWall,
  releaseSessionSlot,
  releaseSessionStart,
  requireProviderSurface,
  resolveModelRoute,
  resolveStepClass,
  retagSessionSlots,
  SESSION_SLOT_TTL_MS,
  type SessionPlane,
  SpawnError,
  type SpawnSpec,
  type SpawnWorker,
  sessionCapViews,
  sessionPlane,
  sessionPlaneForCli,
  sessionQuotaConfig,
  sessionSlotsDir,
  stepParent,
  taskStoreAt,
  UnknownProviderError,
  walkChain,
  wallText,
  withAgentRegistryLock,
  worktreeGitDir,
  writeAgentRegistry,
  writePrivateFileSync,
} from '@broject/core';
// builtin session planes self-register on import — the connector layer
// is the plugin host for agent backends, and admission planes ride the
// same surface
import {
  commandCliNames,
  commandWorkerClis,
  devinLogsDir,
  devinPidBead,
  devinPidCwd,
  devinPidLog,
  devinProcDir,
  devinSessionPlane,
  listDevinSessions,
} from '@broject/devin';
import { expandAgentCmd, LEARN_RETRO_CLOSEOUT, type LoopConfig, loopSection } from '@broject/loop';
import { type AcpSeam, type FetchFn, otelEvent } from '@broject/providers';
import { enterWorktree } from '../commands/work.ts';
import { assertMutableConfig } from '../config-policy.ts';
import {
  COPILOT_COUNT_TTL_MS,
  copilotCountFile,
  readCopilotCount,
  writeCopilotCount,
} from '../session-planes/copilot.ts';
import { VERSION } from '../version.ts';
import {
  copilotEntryRepo,
  copilotHasPullArtifact,
  copilotHeadRef,
  copilotRemoteRepo,
} from './copilot-refs.ts';
import { copilotSweepLandedSlots } from './copilot-slots.ts';
import {
  type CopilotSession,
  type CopilotTask,
  copilotLatestSession,
  copilotSessionError,
  copilotTaskIdOf,
  copilotTaskState,
} from './copilot-tasks.ts';
import { checkRunLearnEvidence } from './learn-evidence.ts';
import { entryPidStart, signalUnitGroups } from './proc-units.ts';
import {
  admitPlanefreeProviderLane,
  claimGatePlaneStarts,
  type ProviderGateAdmit,
  rejudgeSharedProviderLane,
} from './provider-admit.ts';
import {
  admitSpawnedCommandStarts,
  EMPTY_KEYS,
  type ProviderGate,
  providerGatePayload,
} from './session-admit.ts';
import { restoreRegistryRow, rollbackSpawnClaim } from './spawn-rollback.ts';
import { markStoppedEntry, pollUntilGone } from './stop-entry.ts';
import {
  agentsHome,
  dropWorkMarker,
  SAFE_AGENT_ID,
  touchWorkMarker,
  writeWorkMarker,
} from './work-markers.ts';
// external-activity planes self-register on import — the spawn guard
// reads every ecosystem's "an agent bro does not own is working" probe
import '../session-planes/markers.ts';
import '../session-planes/opencode.ts';

export { spawn, spawnSync } from 'node:child_process';
export { createHash } from 'node:crypto';
export {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
export { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
export * from '@broject/core';
export { expandAgentCmd, type LoopConfig, loopSection } from '@broject/loop';
export type { AcpSeam, FetchFn } from '@broject/providers';
export { otelEvent } from '@broject/providers';
export type {
  AgentCause,
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  AgentState,
  ConnectorCtx,
  DiscoveredSession,
  FleetProfile,
  FleetRouter,
  ListResult,
  ProviderEntry,
  ProviderWall,
  ResolvedClass,
  RoutingTable,
  SessionPlane,
  SpawnSpec,
  SpawnWorker,
};
export {
  AgentNotFound,
  admitSessionSlot,
  agentEntryBlocked,
  agentExitFileName,
  agentsSection,
  appendPrivateFileSync,
  BATCH_MARKER_ENV,
  bdActor,
  claimStep,
  classifyExitCause,
  classifyExitCauseParts,
  cliCommandModel,
  commandCliName,
  DEFAULT_CONFIG,
  deriveProviderWalls,
  emitLifecycle,
  entryRunId,
  ghHost,
  gitTry,
  isAgentCause,
  isBatchSpawn,
  JudgeUnavailable,
  loadConfig,
  mintAgentId,
  mintRunId,
  mkdirPrivateSync,
  openPrivateAppendSync,
  ProviderSurfaceError,
  patchAgentRegistry,
  probeStep,
  procStat,
  providerCallGrade,
  readAgentRegistry,
  rebindStep,
  releaseSessionSlot,
  requireProviderSurface,
  resolveStepClass,
  SESSION_SLOT_TTL_MS,
  SpawnError,
  sessionPlane,
  sessionPlaneForCli,
  sessionQuotaConfig,
  sessionSlotsDir,
  shQuote,
  stepParent,
  UnknownProviderError,
  withAgentRegistryLock,
  writeAgentRegistry,
  writePrivateFileSync,
};

import '../session-planes/copilot.ts';
import {
  type LaneAdmission,
  laneGateAdmission,
  laneGateTake,
  reconcileLanePauseForRegistry,
} from '../lane.ts';
import * as harness from './spawn-harness.ts';
const {
  agentRegistry,
  unregisterAgentConnector,
  agentConnectorNames,
  loadAgentEnv,
  fleetCapOf,
  fleetProfileOf,
  profileModelFor,
  backendProvider,
  broSpawnArgv,
  brouterSpawnRoute,
  isConfiguredBrouterModel,
  argvMcpServersExtra,
  requireTypedRouterGrade,
  MatrixHoldError,
  matrixLanePick,
  resolveAgentConnector,
  guardPrimed,
  probeAgentConnectors,
  probeOne,
  firstAgentConnector,
  makeAgentConnector,
  eachAgentConnector,
  AGENT_PIN_KEYS,
  TMP_ENV_KEYS,
  envKeyDropped,
  getCredentialScope,
  isAllowedByEnvPolicy,
  GIT_REPOSITORY_ENV_KEYS,
  telemetryDimsMemo,
  worktreeTelemetryDims,
  workerTmpDir,
  workerTmpEnvPins,
  ensureWorkerTmpDir,
  agentEnvPins,
  memo,
  tmuxLiveSessions,
  tmuxOccupies,
  gcOccupies,
  dockerOccupies,
  entryOccupies,
  occupancyProbes,
  fleetOccupancy,
  fleetOccupancyFor,
  providerRegistryCensus,
  BUDGET_LIMITS,
  budgetEntry,
  budgetSnapshot,
  budgetSnapshotFor,
  providerWallsFor,
  fleetWallRowsFor,
  budgetLines,
  enforceFleetCap,
  sessionKindOf,
  sessionQuotaOf,
  providerCapLaneOf,
  providersForSpawnedCommand,
  providerForSpawnedCommand,
  providerEntryCommand,
  liveSessionKeysByKind,
  blockedRespawnDetail,
  guardExistingEntry,
  isPhantomAdhoc,
  guardClaim,
  batchWallRefusal,
  enforceExternalGuard,
  externalGuardOf,
  moreRestrictive,
  spawnWalls,
  applySpawnRoute,
  pullRequestLeaseKey,
  spawnLeaseKey,
  remoteLeaseHost,
  acquireSpawnLease,
  rebindSpawnLease,
  releaseSpawnLease,
  providerGateStarts,
  providerGateQuotaStarts,
  providerGateOf,
  admitProviderGateStarts,
  prepareSpawn,
  rollbackSpawnWrite,
  outgoingAttemptOf,
  commitMcpArtifact,
  commitSpawn,
  logSizeOrZero,
  recordSpawnClaim,
  enterSpawnTree,
  readExitFile,
  LOG_TAIL_BYTES,
  readLogTail,
  emitProviderWall,
  isCurrentExitGeneration,
  recordClassifiedWall,
  emitClassifiedExitLifecycle,
  emitLearnMissLifecycle,
  persistClassifiedExit,
  releaseClassifiedLease,
  ensureExitCause,
  recordedDeath,
  findAgentEntry,
  spawnHome,
  nativeIsRunning,
  inHandoffGrace,
  nativeState,
  infoCause,
  infoLearn,
  infoProvenance,
  toInfo,
  warnNoPromptFile,
  workerCliBadge,
  workerRunLine,
  workerWithResume,
  GO_WAIT_TICK_MS,
  GO_WAIT_TICKS,
  HANDSHAKE_SCRIPT,
  SpawnAbandoned,
  spawnTestSeam,
  SCOPE_RUN_PREFIX,
  scopeProbeCache,
  systemdScopeProbe,
  systemdScopeFor,
  SCOPE_ADMIT_TICK_MS,
  SCOPE_ADMIT_TICKS,
  scopeAdmitWait,
  scopeAdmitted,
  armNativeSpawnTestSeam,
  maybeAbandonSpawn,
  attemptHandles,
  handleIdentity,
  adoptNativeHandle,
  resolveNativeCommand,
  SH_SQUOTE,
  shQuote,
  TMUX_SESSION_NAME,
  tmuxRun,
  tmuxSessionName,
  TMUX_DEAD_ERR,
  tmuxProbe,
  probeState,
  toTmuxInfo,
  gcMatchDir,
  gcRun,
  gcErr,
  listGcSessions,
  gcSessionFor,
  gcState,
  gcSupervisorRunning,
  gcRigDirOf,
  TOML_SHORT_ESCAPES,
  tomlStr,
  GC_SUBMIT_PROMPT_MAX,
  GC_CITY_TOML,
  GC_AGENT_TOML,
  GC_PROMPT_TEMPLATE,
  gcConfigDir,
  gcEffectiveCommand,
  dockerRun,
  dockerDaemonUp,
  dockerLiveContainers,
  DOCKER_CONTAINER_NAME,
  dockerContainerName,
  DOCKER_NO_SUCH,
  dockerInspect,
  jsoncSkipLineComment,
  jsoncSkipBlockComment,
  jsoncSkipTrivia,
  jsoncCopyString,
  jsoncToJson,
  dockerRunArgs,
  dockerMounts,
  devcontainerPath,
  readDevcontainer,
  devcontainerDockerfile,
  buildDevcontainerImage,
  dockerImageFor,
  ensureDockerImage,
  dockerProbeVerdict,
  toDockerInfo,
  DOCKER_HOST_ENV,
  DOCKER_ENV_FLAGS,
  filterStrictRunArgs,
  writeDockerEnvFile,
  dockerRunArgv,
  refuseCopilotWorker,
  ghRun,
  COPILOT_LIVE_STATES,
  copilotResolvePr,
  copilotSessionUrl,
  copilotFetchTask,
  copilotLiveTaskIds,
  copilotOccupies,
  copilotPatch,
  copilotTerminalPatch,
  copilotAbsorb,
  copilotTaskProbe,
  copilotInfoFor,
  toCopilotInfo,
  copilotSessionQuota,
  copilotRefreshCount,
  primeCopilotForExternalGuard,
  devinSessionInfo,
  makeDevinConnector,
} = harness;
type AgentConnectorEnv = harness.AgentConnectorEnv;
type AgentConnectorFactory = harness.AgentConnectorFactory;
type AgentConnectorMatchers = harness.AgentConnectorMatchers;
type SpawnProviderPick = harness.SpawnProviderPick;
type MatrixLanePick = harness.MatrixLanePick;
type WorktreeTelemetryDims = harness.WorktreeTelemetryDims;
type OccupancyProbes = harness.OccupancyProbes;
type BudgetReset = harness.BudgetReset;
type BudgetCause = harness.BudgetCause;
type BudgetSnapshot = harness.BudgetSnapshot;
type BudgetWalk = harness.BudgetWalk;
type FleetWallRow = harness.FleetWallRow;
type SessionQuotaLane = harness.SessionQuotaLane;
type SpawnWorkLease = harness.SpawnWorkLease;
type GateAdmitArgs = harness.GateAdmitArgs;
type SpawnAbandonAt = harness.SpawnAbandonAt;
type TmuxResult = harness.TmuxResult;
type TmuxLiveness = harness.TmuxLiveness;
type GcSession = harness.GcSession;
type DockerLiveness = harness.DockerLiveness;
type DockerInspect = harness.DockerInspect;
type DockerMount = harness.DockerMount;
type Devcontainer = harness.Devcontainer;
type GhResult = harness.GhResult;
export function makeNativeConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents['native'] ?? {};
  const command = resolveNativeCommand(env);

  const findEntry = (id: string) => findAgentEntry(dir, 'native', id);

  const spawnNativeWorker = (
    scoped: boolean,
    args: string[],
    scopeArgv: string[],
    spawnOpts: SpawnOptions,
    stderrLog: string | undefined,
    log: string,
    handleFile: string,
    exitFile: string
  ): { child: ReturnType<typeof spawn>; scopeRetried: boolean } => {
    const spawnWorker = (wrap: boolean) => {
      if (wrap && spawnTestSeam.scopeRefused === true) {
        return spawn('sh', ['-c', 'exit 1'], spawnOpts);
      }
      return spawn(wrap ? 'systemd-run' : 'sh', wrap ? scopeArgv : args, spawnOpts);
    };
    let child = spawnWorker(scoped);
    if (scoped && !scopeAdmitted(child.pid, handleFile, exitFile)) {
      if (stderrLog !== undefined) {
        appendPrivateFileSync({
          path: stderrLog,
          data: 'bro: systemd-run refused the scope — respawned without the wrap\n',
        });
      } else {
        appendPrivateFileSync({
          path: log,
          data: 'bro: systemd-run refused the scope — respawned without the wrap\n',
        });
      }
      child.on('error', () => {
        /* the retry owns the verdict now */
      });
      child = spawnWorker(false);
      return { child, scopeRetried: true };
    }
    return { child, scopeRetried: false };
  };

  // NOSONAR — the lock callback owns one synchronous spawn transaction
  const spawnNative = (spec: SpawnSpec, home: string, mol: string): AgentInfo => {
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
      } = prepareSpawn(dir, home, 'native', spec, {
        // 'spawned' counts as live for dedup: inside the handoff
        // window a pid-less entry may still be a worker about to
        // publish its handle — a respawn beside it is the
        // crash-window bug (spec bro-l8c4f.5)
        isLive: e => {
          const s = nativeState(dir, home, spec.molStep, e);
          return s === 'running' || s === 'spawned';
        },
        liveDetail: e => (typeof e.pid === 'number' ? `pid ${e.pid}` : 'spawn handoff in flight'),
        cap: { max: fleetCapOf(env), env },
        env,
        sessionQuota: () => sessionQuotaOf(env, 'native', spec, command),
        spawnCommand: command,
        external: externalGuardOf(env),
      });
      // the launcher crashed after the reservation — registry+claim
      // landed, no OS child ever ran (spec bro-l8c4f.5 failpoint)
      maybeAbandonSpawn('reservation');
      const { handleFile, goFile } = attemptHandles(home, agentId, runId);
      // resolved once inside the lock — the git probe is the only IO
      // the pin needs and every consumer (mkdir, env) shares it
      const workerTmp = workerTmpDir(spec.repoRoot, agentId);
      // the worker's stderr gets its own append fd — the .log stays
      // the agent-updates stream; the child/agent noise (and every
      // template worker's diagnostics) lands in .stderr (bro-e2ec0).
      // Both open INSIDE the guard — a throw must hand the session
      // reservation back like any other spawn failure, not strand it.
      let fd: number | undefined;
      let errFd: number | undefined;
      // whether any spawnWorker produced a child — read by the catch
      // to tell a pre-launch throw (no child, the row is dead weight)
      // from a post-spawn one (a live child can still publish its
      // handle, and the handoff grace window owns the row)
      let childPid: number | undefined;
      let spawned: AgentRegistryEntry;
      try {
        fd = openPrivateAppendSync({ path: log });
        if (stderrLog !== undefined) {
          errFd = openPrivateAppendSync({ path: stderrLog });
        }
        // the worker's tmpdir exists before the payload execs — the
        // nx daemon's mkdtemp needs the parent (spec bro-v96mp)
        ensureWorkerTmpDir(workerTmp);
        // the wrapper captures $? into the .exit file — the only exit
        // record a detached process can leave once the parent is gone.
        // The write targets the literal quoted path, never $out: a
        // 'template' payload runs in this shell's scope and assigning
        // `out` would retarget the exit write (the shape tmux/docker
        // already use).
        // Worker payloads (spec bro-5hx1.1): a 'template' worker's
        // command substitutes for the backend's own template; an
        // 'argv' worker execs verbatim through the wrapper's "$@"
        // positional passthrough — the provider argv (a `model` value
        // could carry shell metachars) is never string-concatenated.
        const worker = workerWithResume(spec.worker, resumeSessionId);
        warnNoPromptFile(worker, command);
        // the handshake runs before the payload: the worker publishes
        // its own handle, then holds on the launcher's go stamp — a
        // launcher that died mid-publish never admits it (75), so a
        // survivor can never silently double a respawn (spec
        // bro-l8c4f.5)
        const goTicks = String(spawnTestSeam.goWaitTicks ?? GO_WAIT_TICKS);
        const args =
          worker?.kind === 'argv'
            ? [
                '-c',
                `${HANDSHAKE_SCRIPT} shift 4; "$@"; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} )`,
                'bro-agent',
                exitFile,
                handleFile,
                goFile,
                goTicks,
                ...worker.argv,
                promptFile,
              ]
            : [
                '-c',
                `${HANDSHAKE_SCRIPT} ${expandAgentCmd(worker?.kind === 'template' ? worker.command : command)}; s=$?; ( umask 077; printf %s "$s" > ${shQuote(exitFile)} )`,
                'bro-agent',
                exitFile,
                handleFile,
                goFile,
                goTicks,
              ];
        const cliBadge = workerCliBadge(worker, command);
        // the scope wrap (bro-ybo8z): the payload runs under
        // systemd-run so a supervisor's cgroup kill cannot reach it.
        // --description carries the run's identity (never --unit — a
        // respawned agentId must not collide on a lingering scope)
        const scoped = systemdScopeFor(knobs);
        const scopeArgv = [
          ...SCOPE_RUN_PREFIX.slice(1),
          `--description=bro agent ${agentId} ${spec.molStep}`,
          '--',
          'sh',
          ...args,
        ];
        const spawnOpts: SpawnOptions = {
          // NOSONAR — operator-configured agent command (same contract as loop)
          cwd: spec.repoRoot,
          env: (() => {
            const policy = getCredentialScope(env, 'native');
            const ambient = Object.fromEntries(
              Object.entries(process.env).filter((e): e is [string, string] => {
                if (e[1] === undefined) return false;
                // the tmpdir triple drops only when a pin replaces
                // it — a repo-less spawn keeps the ambient tmpdir
                if (envKeyDropped(e[0], workerTmp !== undefined)) return false;
                if (GIT_REPOSITORY_ENV_KEYS.has(e[0])) return false;
                // ambient BRO_BATCH is stripped, not passed — the
                // marker reaches the worker only via spec.env below
                return isAllowedByEnvPolicy(e[0], e[1], 'native', spec, env, policy);
              })
            );
            const fromSpec = Object.fromEntries(
              Object.entries(spec.env ?? {}).filter((e): e is [string, string] => {
                if (e[1] === undefined) return false;
                if (envKeyDropped(e[0], workerTmp !== undefined)) return false;
                if (GIT_REPOSITORY_ENV_KEYS.has(e[0])) return false;
                return isAllowedByEnvPolicy(e[0], e[1], 'native', spec, env, policy, true);
              })
            );
            return {
              // ambient env minus the connector-owned pins
              ...ambient,
              ...fromSpec,
              // the tmpdir pin rides the pin layer too — a spec.env
              // TMPDIR must not re-aim worker scratch at the tmpfs
              // (spec bro-v96mp)
              ...Object.fromEntries(workerTmpEnvPins(workerTmp)),
              // identity pins last — spec.env must never redirect the
              // claim store or re-badge the worker as another bead/agent
              ...Object.fromEntries(agentEnvPins(spec, agentId, promptFile, cliBadge, mol)),
            };
          })(),
          stdio: ['ignore', fd, errFd],
          detached: true,
        };
        // the scope refusal path needs a second shot at the same spawn —
        // the seam's refusal stand-in dies instantly like a real refused
        // systemd-run, but runs the payload verbatim for everything else
        const spawnedWorker = spawnNativeWorker(
          scoped,
          args,
          scopeArgv,
          spawnOpts,
          stderrLog,
          log,
          handleFile,
          exitFile
        );
        let child = spawnedWorker.child;
        childPid = spawnedWorker.scopeRetried ? undefined : child.pid;
        // an unhandled 'error' event would take the whole CLI down —
        // a failed exec records itself on the entry and reads 'lost'
        const spawnStamp = readAgentRegistry(dir)[spec.molStep]?.spawnedAt;
        child.on('error', err => {
          try {
            // stamp only our own run — a respawn that reused this
            // molStep/agentId owns the entry now; an old child's error
            // must not mislabel a live respawn (bro-ooud)
            const cur = readAgentRegistry(dir)[spec.molStep];
            if (cur?.agentId !== agentId || cur?.spawnedAt !== spawnStamp) {
              return;
            }
            patchAgentRegistry(dir, spec.molStep, { spawnError: err.message });
            // the devin session never started — hand the slot back now
            // rather than block peers for the reservation's whole TTL
            if (reservation !== undefined) {
              releaseSessionSlot(reservation);
            }
            releaseSessionStart(crossKindReservations);
            releaseSpawnLease(dir, lease);
          } catch {
            // the entry may not have landed yet — nothing else to do
          }
        });
        child.unref();
        // the launcher died between OS spawn and pid publication —
        // a live detached child the registry cannot yet name (spec
        // bro-l8c4f.5 failpoint)
        maybeAbandonSpawn('os-spawn');
        spawned = patchAgentRegistry(dir, spec.molStep, {
          pid: child.pid ?? -1,
          // the starttime pins identity against pid reuse — without it
          // a recycled pid keeps a dead agent 'running' in every
          // dedup/stop decision the registry drives
          pidStart: typeof child.pid === 'number' ? (procStat(child.pid)?.start ?? null) : null,
        });
        // the spawned pid IS probeable — downgrade the born-TTL
        // lease to local governance so a dead worker frees the key
        // without waiting out the TTL
        rebindSpawnLease(dir, lease, { host: hostname(), pid: child.pid });
        // the slot claims follow the lane's real holder — a spawning
        // CLI exits but the session's lane lives with the child
        // (spec bro-x601l); a swept claim retags to nothing
        if (child.pid !== undefined) {
          retagSessionSlots([reservation, ...crossKindReservations], child.pid);
        }
        writeWorkMarker(dir, agentId, spec.molStep, child.pid);
        // died after publishing the handle — pid+marker are durable,
        // the worker's admission stamp never lands
        maybeAbandonSpawn('publication');
        // the admission stamp — durable only after pid+marker, so a
        // crash earlier can never admit a worker the registry cannot
        // reach. Existence is the signal; the pid inside is forensic.
        writePrivateFileSync({ path: goFile, data: `${child.pid ?? -1}\n` });
      } catch (err) {
        // sync failure after the reservation — hand the slot back
        if (reservation !== undefined) {
          releaseSessionSlot(reservation);
        }
        releaseSessionStart(crossKindReservations);
        releaseSpawnLease(dir, lease);
        // a pre-launch throw leaves the row prepareSpawn committed
        // pid-less: inside the handoff TTL it reads 'spawned' and the
        // retry is refused 'spawn handoff in flight' over a child that
        // never ran. Stamp this attempt terminal — matched by
        // agentId+runId under the lock — so the retry re-picks. A
        // produced child pid skips the stamp: that attempt can still
        // publish its handle and the grace window owns its row (spec
        // bro-l8c4f.5).
        try {
          patchAgentRegistryIf(
            dir,
            spec.molStep,
            {
              stopped: true,
              spawnError: err instanceof Error ? err.message : String(err),
            },
            cur =>
              cur?.agentId === agentId &&
              cur?.runId === runId &&
              cur?.pid === undefined &&
              childPid === undefined
          );
        } catch {
          // a registry write failure must not mask the launch error
        }
        throw err;
      } finally {
        if (fd !== undefined) {
          closeSync(fd);
        }
        if (errFd !== undefined) {
          closeSync(errFd);
        }
      }
      return toInfo(dir, home, spec.molStep, spawned);
    });
  };

  return {
    name: 'native',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      // policy before preflight — a refused spawn must not run even the
      // harmless probes (prepareSpawn re-checks inside the lock for the
      // claim/registry writes)
      assertMutableConfig(dir);
      const home = spawnHome(dir, 'native', command, spec);
      // dedup → claim → spawn → pid-patch runs as ONE critical section:
      // without the lock a second bro process can pass the liveness
      // check between our read and our write and double-spawn (TOCTOU).
      // Everything inside is synchronous — the bd subprocesses are
      // spawnSync — so the hold is milliseconds in the common case.
      // stepParent's bd show runs OUTSIDE it for the same reason the
      // fleet memo exists: a slow beads store must not hold the lock.
      const mol = stepParent(spec.beadsDir, spec.molStep);
      return spawnNative(spec, home!, mol!);
    },

    async list() {
      try {
        const home = agentsHome(dir);
        const agents = Object.entries(readAgentRegistry(dir))
          .filter(([, e]) => e.backend === 'native')
          .map(([molStep, e]) => toInfo(dir, home, molStep, e));
        return { agents };
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async status(id: string): Promise<AgentInfo> {
      const hit = findEntry(id);
      if (!hit) {
        throw new AgentNotFound(`no native agent ${id}`);
      }
      return toInfo(dir, agentsHome(dir), hit[0], hit[1]);
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id);
      if (!hit) {
        return; // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit;
      // a crashed launcher's survivor self-published its handle — adopt
      // it here too so `down` reaches the worker the registry never got
      // a pid for (spec bro-l8c4f.5). The consultation now also fires
      // when the recorded pid is simply DEAD: a fork-style
      // `systemd-run --scope` (bro-ybo8z) leaves the payload alive in
      // another cgroup under a pid the registry never recorded, and
      // stamping `stopped` over that live orphan would free a respawn
      // beside a live writer.
      const home = agentsHome(dir);
      const entryPid = typeof entry.pid === 'number' ? entry.pid : undefined;
      const adopted =
        entryPid !== undefined &&
        (pidAlive(entryPid, entryPidStart(entry)) ||
          groupMemberAlive(entryPid, entryPidStart(entry)))
          ? undefined
          : adoptNativeHandle(dir, home, molStep, entry);
      const pid = adopted?.pid ?? entryPid;
      const start = adopted !== undefined ? (adopted.start ?? undefined) : entryPidStart(entry);
      // signal every process group the unit spans, then wait for the
      // unit to die — the returned probe answers unit liveness for the
      // lock-time re-check even when no signal was sent (a repeated
      // `down` can find the wrapper dead while a descendant still
      // holds the group)
      const unitAlive = await signalUnitGroups(pid, start);
      // a respawn during the kill wait re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' + the marker drop land on a live, respawned entry
      markStoppedEntry({ dir, molStep, entry, id, stillLive: unitAlive });
    },

    capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' }),
  };
}
