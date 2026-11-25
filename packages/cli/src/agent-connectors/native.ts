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
export {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
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

type NativeSpawnWorkerArgs = {
  scoped: boolean;
  args: string[];
  scopeArgv: string[];
  spawnOpts: SpawnOptions;
  stderrLog: string | undefined;
  log: string;
  handleFile: string;
  exitFile: string;
};

function spawnNativeWorker({
  scoped,
  args,
  scopeArgv,
  spawnOpts,
  stderrLog,
  log,
  handleFile,
  exitFile,
}: NativeSpawnWorkerArgs): {
  child: ReturnType<typeof spawn>;
  scopeRetried: boolean;
} {
  const spawnWorker = (wrap: boolean) => {
    if (wrap && spawnTestSeam.scopeRefused === true) {
      return spawn('sh', ['-c', 'exit 1'], spawnOpts);
    }
    return spawn(wrap ? 'systemd-run' : 'sh', wrap ? scopeArgv : args, spawnOpts);
  };
  let child = spawnWorker(scoped);
  if (scoped && !scopeAdmitted(child.pid, handleFile, exitFile)) {
    appendPrivateFileSync({
      path: stderrLog ?? log,
      data: 'bro: systemd-run refused the scope — respawned without the wrap\n',
    });
    child.on('error', () => {
      /* the retry owns the verdict now */
    });
    child = spawnWorker(false);
    return { child, scopeRetried: true };
  }
  return { child, scopeRetried: false };
}

type PublishNativeChildArgs = {
  dir: string;
  molStep: string;
  spec: SpawnSpec;
  agentId: string;
  goFile: string;
  child: ReturnType<typeof spawn>;
  reservation: Parameters<typeof releaseSessionSlot>[0] | undefined;
  crossKindReservations: Parameters<typeof releaseSessionStart>[0];
  lease: Lease | undefined;
};

function publishNativeChild({
  dir,
  molStep,
  spec,
  agentId,
  goFile,
  child,
  reservation,
  crossKindReservations,
  lease,
}: PublishNativeChildArgs): AgentRegistryEntry {
  // an unhandled 'error' event would take the whole CLI down —
  // a failed exec records itself on the entry and reads 'lost'
  const spawnStamp = readAgentRegistry(dir)[spec.molStep]?.spawnedAt;
  watchNativeChild({
    child,
    dir,
    molStep: spec.molStep,
    agentId,
    spawnStamp,
    reservation,
    crossKindReservations,
    lease,
  });
  child.unref();
  // the launcher died between OS spawn and pid publication —
  // a live detached child the registry cannot yet name (spec
  // bro-l8c4f.5 failpoint)
  maybeAbandonSpawn('os-spawn');
  const spawned = patchAgentRegistry(dir, spec.molStep, {
    pid: child.pid ?? -1,
    // the starttime pins identity against pid reuse — without it
    // a recycled pid keeps a dead agent 'running' in every
    // dedup/stop decision the registry drives
    pidStart: typeof child.pid === 'number' ? (procStat(child.pid)?.start ?? null) : null,
  });
  // the spawned pid IS probeable — downgrade the born-TTL
  // lease to local governance so a dead worker frees the key
  // without waiting out the TTL
  rebindSpawnLease(dir, lease!, { host: hostname(), pid: child.pid });
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
  return spawned;
}

function watchNativeChild({
  child,
  dir,
  molStep,
  agentId,
  spawnStamp,
  reservation,
  crossKindReservations,
  lease,
}: {
  child: ReturnType<typeof spawn>;
  dir: string;
  molStep: string;
  agentId: string;
  spawnStamp: string | undefined;
  reservation: Parameters<typeof releaseSessionSlot>[0] | undefined;
  crossKindReservations: Parameters<typeof releaseSessionStart>[0];
  lease: Lease | undefined;
}) {
  child.on('error', err => {
    try {
      const cur = readAgentRegistry(dir)[molStep];
      if (cur?.agentId !== agentId || cur?.spawnedAt !== spawnStamp) return;
      patchAgentRegistry(dir, molStep, { spawnError: err.message });
      if (reservation !== undefined) releaseSessionSlot(reservation);
      releaseSessionStart(crossKindReservations);
      releaseSpawnLease(dir, lease!);
    } catch {
      // The entry may not have landed yet.
    }
  });
}

type NativeLaunchArgs = {
  dir: string;
  home: string;
  mol: string;
  spec: SpawnSpec;
  env: AgentConnectorEnv;
  command: string;
  knobs: Record<string, unknown>;
  agentId: string;
  promptFile: string;
  log: string;
  stderrLog: string | undefined;
  exitFile: string;
  resumeSessionId: string | undefined;
  handleFile: string;
  goFile: string;
  workerTmp: string | undefined;
};

type NativeProcessArgs = {
  scoped: boolean;
  args: string[];
  scopeArgv: string[];
  spawnOpts: SpawnOptions;
  stderrLog: string | undefined;
  log: string;
  handleFile: string;
  exitFile: string;
};

function spawnNativeProcess(args: NativeProcessArgs) {
  return spawnNativeWorker(args);
}

type NativeLaunchProcessArgs = {
  args: string[];
  agentId: string;
  spec: SpawnSpec;
  knobs: Record<string, unknown>;
  env: AgentConnectorEnv;
  workerTmp: string | undefined;
  promptFile: string;
  cliBadge: string | undefined;
  mol: string;
  fd: number;
  errFd: number | undefined;
  stderrLog: string | undefined;
  log: string;
  handleFile: string;
  exitFile: string;
};

// NOSONAR — keeps native launch setup together as one transaction.
function launchNativeProcess({
  args,
  agentId,
  spec,
  knobs,
  env,
  workerTmp,
  promptFile,
  cliBadge,
  mol,
  fd,
  errFd,
  stderrLog,
  log,
  handleFile,
  exitFile,
}: NativeLaunchProcessArgs) {
  const options = nativeLaunchOptions({
    args,
    agentId,
    spec,
    knobs,
    env,
    workerTmp,
    promptFile,
    cliBadge,
    mol,
    fd,
    errFd,
  });
  return spawnNativeProcess({
    ...options,
    stderrLog,
    log,
    handleFile,
    exitFile,
  });
}

function nativeLaunchOptions({
  args,
  agentId,
  spec,
  knobs,
  env,
  workerTmp,
  promptFile,
  cliBadge,
  mol,
  fd,
  errFd,
}: Omit<NativeLaunchProcessArgs, 'stderrLog' | 'log' | 'handleFile' | 'exitFile'>): Omit<
  NativeProcessArgs,
  'stderrLog' | 'log' | 'handleFile' | 'exitFile'
> {
  const scoped = systemdScopeFor(knobs);
  const scopeArgv = [
    ...SCOPE_RUN_PREFIX.slice(1),
    `--description=bro agent ${agentId} ${spec.molStep}`,
    '--',
    'sh',
    ...args,
  ];
  const spawnOpts: SpawnOptions = {
    cwd: spec.repoRoot,
    env: nativeSpawnEnvironment({
      spec,
      env,
      workerTmp,
      agentId,
      promptFile,
      cliBadge,
      mol,
    }),
    stdio: ['ignore', fd, errFd],
    detached: true,
  };
  return {
    scoped,
    args,
    scopeArgv,
    spawnOpts,
  };
}

// NOSONAR — keeps native launch setup together as one transaction.
function launchNativeChild(args: NativeLaunchArgs): {
  fd: number;
  errFd: number | undefined;
  child: ReturnType<typeof spawn>;
  scopeRetried: boolean;
} {
  const files = openNativeLogs(args.log, args.stderrLog);
  try {
    const worker = launchNativeChildWorker(args, files);
    return { ...worker, fd: files.fd, errFd: files.errFd };
  } catch (error) {
    closeNativeLogs(files);
    throw error;
  }
}

function launchNativeChildWorker(
  args: NativeLaunchArgs,
  files: { fd: number; errFd: number | undefined }
): { child: ReturnType<typeof spawn>; scopeRetried: boolean } {
  ensureWorkerTmpDir(args.workerTmp);
  const worker = workerWithResume(args.spec.worker, args.resumeSessionId);
  warnNoPromptFile(worker, args.command);
  const payload = nativePayloadArgs({
    worker,
    command: args.command,
    exitFile: args.exitFile,
    handleFile: args.handleFile,
    goFile: args.goFile,
    promptFile: args.promptFile,
  });
  const spawned = launchNativeProcess({
    args: payload.args,
    agentId: args.agentId,
    spec: args.spec,
    knobs: args.knobs,
    env: args.env,
    workerTmp: args.workerTmp,
    promptFile: args.promptFile,
    cliBadge: workerCliBadge(worker, args.command),
    mol: args.mol,
    fd: files.fd,
    errFd: files.errFd,
    stderrLog: args.stderrLog,
    log: args.log,
    handleFile: args.handleFile,
    exitFile: args.exitFile,
  });
  return { child: spawned.child, scopeRetried: spawned.scopeRetried };
}

function openNativeLogs(
  log: string,
  stderrLog: string | undefined
): {
  fd: number;
  errFd: number | undefined;
} {
  return {
    fd: openPrivateAppendSync({ path: log }),
    errFd: stderrLog === undefined ? undefined : openPrivateAppendSync({ path: stderrLog }),
  };
}

function closeNativeLogs(files: { fd: number; errFd: number | undefined }): void {
  closeSync(files.fd);
  if (files.errFd !== undefined) closeSync(files.errFd);
}
type NativeSpawnFailureArgs = {
  dir: string;
  molStep: string;
  agentId: string;
  runId: string;
  reservation: Parameters<typeof releaseSessionSlot>[0] | undefined;
  crossKindReservations: Parameters<typeof releaseSessionStart>[0];
  lease: Lease | undefined;
  childPid: number | undefined;
};
function handleNativeSpawnFailure(error: unknown, args: NativeSpawnFailureArgs): never {
  const { dir, molStep, agentId, runId, reservation, crossKindReservations, lease, childPid } =
    args;
  if (reservation !== undefined) {
    releaseSessionSlot(reservation);
  }
  releaseSessionStart(crossKindReservations);
  releaseSpawnLease(dir, lease!);
  stampNativeSpawnFailure({ dir, molStep, agentId, runId, error, childPid });
  throw error;
}
function stampNativeSpawnFailure({
  dir,
  molStep,
  agentId,
  runId,
  error,
  childPid,
}: {
  dir: string;
  molStep: string;
  agentId: string;
  runId: string;
  error: unknown;
  childPid: number | undefined;
}) {
  try {
    patchAgentRegistryIf(
      dir,
      molStep,
      {
        stopped: true,
        spawnError: error instanceof Error ? error.message : String(error),
      },
      cur =>
        cur?.agentId === agentId &&
        cur?.runId === runId &&
        cur?.pid === undefined &&
        childPid === undefined
    );
  } catch {}
}
type NativeEnvironmentArgs = {
  spec: SpawnSpec;
  env: AgentConnectorEnv;
  workerTmp: string | undefined;
  agentId: string;
  promptFile: string;
  cliBadge: string | undefined;
  mol: string;
};
function nativeSpawnEnvironment({
  spec,
  env,
  workerTmp,
  agentId,
  promptFile,
  cliBadge,
  mol,
}: NativeEnvironmentArgs): Record<string, string> {
  const policy = getCredentialScope(env, 'native');
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => {
      if (e[1] === undefined) return false;
      if (envKeyDropped(e[0], workerTmp !== undefined)) return false;
      if (GIT_REPOSITORY_ENV_KEYS.has(e[0])) return false;
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
    ...ambient,
    ...fromSpec,
    ...Object.fromEntries(workerTmpEnvPins(workerTmp)),
    ...Object.fromEntries(agentEnvPins(spec, agentId, promptFile, cliBadge, mol)),
  };
}
function nativePayloadArgs({
  worker,
  command,
  exitFile,
  handleFile,
  goFile,
  promptFile,
}: {
  worker: ReturnType<typeof workerWithResume>;
  command: string;
  exitFile: string;
  handleFile: string;
  goFile: string;
  promptFile: string;
}) {
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
  return { args, goTicks };
}

function prepareNativeSpawn({
  dir,
  home,
  spec,
  env,
  command,
}: {
  dir: string;
  home: string;
  spec: SpawnSpec;
  env: AgentConnectorEnv;
  command: string;
}) {
  return prepareSpawn(dir, home, 'native', spec, {
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
}

type NativeSpawnArgs = {
  dir: string;
  home: string;
  mol: string;
  spec: SpawnSpec;
  env: AgentConnectorEnv;
  command: string;
  knobs: Record<string, unknown>;
};

function runNativeSpawn({ dir, home, mol, spec, env, command, knobs }: NativeSpawnArgs): AgentInfo {
  return withAgentRegistryLock(dir, () => {
    const prepared = prepareNativeSpawn({ dir, home, spec, env, command });
    // prettier-ignore
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
    maybeAbandonSpawn('reservation');
    const { handleFile, goFile } = attemptHandles(home, agentId, runId);
    const workerTmp = workerTmpDir(spec.repoRoot, agentId);
    let fd: number | undefined;
    let errFd: number | undefined;
    let childPid: number | undefined;
    let spawned: AgentRegistryEntry;
    try {
      const launched = launchNativeChild({
        dir,
        home,
        mol,
        spec,
        env,
        command,
        knobs,
        agentId,
        promptFile,
        log,
        stderrLog,
        exitFile,
        resumeSessionId,
        handleFile,
        goFile,
        workerTmp,
      });
      fd = launched.fd;
      errFd = launched.errFd;
      const child = launched.child;
      childPid = launched.scopeRetried ? undefined : child.pid;
      spawned = publishNativeChild({
        dir,
        molStep: spec.molStep,
        spec,
        agentId,
        goFile,
        child,
        reservation,
        crossKindReservations,
        lease,
      });
    } catch (err) {
      handleNativeSpawnFailure(err, {
        dir,
        molStep: spec.molStep,
        agentId,
        runId,
        reservation,
        crossKindReservations,
        lease,
        childPid,
      });
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
}

export function makeNativeConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir;
  const knobs = env.agents['native'] ?? {};
  const command = resolveNativeCommand(env);

  const findEntry = (id: string) => findAgentEntry(dir, 'native', id);

  // NOSONAR — the lock callback owns one synchronous spawn transaction
  // NOSONAR — the lock callback owns one synchronous spawn transaction.
  const spawnNative = (spec: SpawnSpec, home: string, mol: string): AgentInfo =>
    withAgentRegistryLock(dir, () => runNativeSpawn({ dir, home, mol, spec, env, command, knobs }));
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
