export {
  gh,
  ghAsync,
  ghHost,
  ghJson,
  ghJsonAsync,
  ghTry,
  ghTryAsync,
  issueLink,
  prLink,
  resolveRepo,
  resolveRepoAsync,
} from './gh.ts'
export {
  git,
  gitTry,
  gitCommonDir,
  gitLogPathRecords,
  gitDriftRef,
  gitLogStamp,
  gitBranchLog,
  gitIsAncestor,
  gitIsShallow,
  gitUpstreamBehind,
  gitWorktreeRoots,
  mainWorktreeRoot,
  unquoteGitPath,
  worktreeGitDir,
} from './git.ts'
export type { GitLogPathRecord, GitStamp, GitLogStamp } from './git.ts'
export {
  bd,
  BdCompatError,
  bdAsync,
  bdAt,
  bdJson,
  bdJsonAsync,
  bdTry,
  bdTryAsync,
  beadsDir,
  beadsStoreStamp,
  checkBeads,
  evidenceKind,
  initBeadsStealth,
  isBdCompatError,
  isBdNotFound,
  probeBdCompat,
  refKind,
} from './bd.ts'
export type { BdCompat } from './bd.ts'
export {
  actSection,
  beadsSection,
  CONFIG_LAYER_FILES,
  CONFIG_LAYERS,
  CONFIG_SECTION_LAYERS,
  CORE_CONFIG_SECTIONS,
  debtSection,
  DEFAULT_CONFIG,
  DEFAULT_GLOBAL_BEADS_DIR,
  DEFAULT_IGNORE_CONSECUTIVE_FAILURES,
  DEFAULT_IGNORE_THREAD_WINDOW_DAYS,
  defineConfig,
  fleetSection,
  globalConfigDir,
  js,
  loadConfig,
  loadConfigLayers,
  mcpSection,
  meshSection,
  mirrorSection,
  notifySection,
  PERSONALITIES,
  probeConfigFile,
  providersSection,
  querySection,
  repoOptedIn,
  sddSection,
  SDD_MODES,
  serveSection,
  SINK_TYPES,
  stackSection,
  STORE_BACKENDS,
  sweepSection,
  syncSection,
} from './config.ts'
export type { IgnoreCheckEntry, IgnoreCheckRule, SinkDef, SinkType } from './config.ts'
export {
  API_WIRES,
  cliCommandModel,
  expandModelArg,
  getProvider,
  isEnvName,
  isSystemoneFamily,
  modelBase,
  parseProviderEntry,
  providerCallGrade,
  PROVIDER_KINDS,
  PROVIDER_REGISTRY,
  ProviderSurfaceError,
  requireProviderSurface,
  resolveApiModel,
  UnknownProviderError,
} from './providers.ts'
export type {
  ApiEntry,
  ApiWire,
  CallSurfaceGrade,
  FleetProfile,
  ProviderEntry,
  ProviderKind,
  ProviderKindSpec,
  ProviderSurface,
} from './providers.ts'
export {
  CLASS_LABEL_PREFIX,
  DEFAULT_STEP_CLASS,
  deriveProviderWalls,
  fleetRouter,
  fleetRouting,
  ON_WALL,
  resolveStepClass,
  routeStepClass,
  stepClassInfo,
  wallText,
} from './routing.ts'
export type {
  ChainEntry,
  FleetRouter,
  OnWall,
  ProviderWall,
  ResolvedClass,
  RoutingClass,
  RoutingTable,
} from './routing.ts'
export {
  DATA_REF,
  dataRefCommit,
  dataRefPull,
  dataRefPush,
  dataRefRoot,
} from './dataref.ts'
export type { BroConfig, ConfigLayerHit, ConfigLayerName, ConfigLayersResult, ConfigSection, JsonSchema, MirrorPolicy, Personality, SddMode, StoreBackend } from './config.ts'
export {
  configDiagnostics,
  configPolicyErrors,
  CONFIG_SCHEMA_URL,
  configSchemaDocument,
  jsonSchemasFor,
  validateSchemaValue,
} from './config-schema.ts'
export type { ConfigDiagnostic, SchemaError } from './config-schema.ts'
export type { QueryFacade, QueryOpts, QueryResult } from './queries.ts'
export { definePlugin } from './plugin.ts'
export type { BroPlugin, CliContract, CliSubContract } from './plugin.ts'
export { docTypeNamed, docVerbs, STANDARD_VERBS, verbMethod } from './docs.ts'
export type { DocAdapter, DocCtx, DocFlags, DocType, DocVerb, Scope } from './docs.ts'
export {
  bdActor,
  bdActorAsync,
  canonicalTaskRel,
  getTasks,
  getTasksAsync,
  nativeTaskRel,
  parseSlotAcquire,
  parseSlotCheck,
  taskStore,
  taskStoreAsync,
  taskStoreAt,
} from './tasks.ts'
export type {
  ClaimCapability,
  DepOpts,
  PublishResult,
  SlotAcquire,
  TaskDepEdge,
  TaskFilter,
  TaskInput,
  TaskRel,
  TaskRow,
  TaskSlot,
  TaskStore,
  TaskStoreAsync,
} from './tasks.ts'
export {
  bridgeFetch,
  bridgePublish,
  displayUrl,
  DOLT_DATA_REF,
  doltDirHealth,
  doltHeadHealth,
  doltRemoteSrc,
  doltSyncPlan,
  fileTargetPath,
  gitUpstream,
  lastGoodDoltHead,
  listDoltRemotes,
  manifestTables,
  mirrorPathFor,
  probeDoltRemote,
} from './dolt-bridge.ts'
export type { BdProbe, DoltBridge, DoltHeadHealth, DoltRemote, DoltSyncPlan } from './dolt-bridge.ts'
export { emitLifecycle, LIFECYCLE_KINDS, lifecyclePath, readLifecycle } from './lifecycle.ts'
export type {
  LifecycleEvent,
  LifecycleInput,
  LifecycleKind,
  LifecycleRead,
} from './lifecycle.ts'
export { bodyMeta, broTrailer, stripMeta, withMeta } from './taskmeta.ts'
export {
  PR_MANAGED_LABEL,
  PR_REVIEW_LABEL,
  prOwnership,
  prOwnershipMark,
  stampPrOwnership,
} from './ownership.ts'
export type { PrOwnership, PrStamp } from './ownership.ts'
export { JudgeUnavailable } from './judge.ts'
export type {
  DecideResult,
  Disposition,
  JournalRow,
  JsonValue,
  JudgeAnswer,
  JudgeFacade,
  JudgeQuestion,
  JudgeText,
  Verdict,
} from './judge.ts'
export type {
  ApprovalProbeOpts,
  ApprovalVerdict,
  CheckInfo,
  EnqueueOpts,
  MergeOpts,
  MergeQueueFacade,
  MergedPr,
  MergedPrInfo,
  MergedPrQuery,
  MergedPrScan,
  PrLabelOp,
  PrMeta,
  PrTarget,
  ReviewComment,
  ReviewFacade,
  ReviewThread,
  ScanOpts,
} from './review.ts'
export {
  gitStacks,
  MANUAL_CASCADE,
  mergeChainPerLayer,
  shQuote,
} from './stacks.ts'
export type {
  StackCascade,
  StackChainMember,
  StackFacade,
  StackMembership,
  StackMergeOpts,
  StackMergeReport,
} from './stacks.ts'
export {
  collectGuards,
  connectorHooks,
  connectors,
  ensureAuth,
  ensureTasksBackend,
  facade,
  facadeAuth,
  facadeName,
  isOwnClaim,
  mergeQueueHost,
  parallelWorkLines,
  parallelWorkProbe,
  postToolLines,
  preToolVerdicts,
  promptContextLines,
  registerConnector,
  reviewHost,
  specStore,
  sessionPinnedClaims,
  sessionStartLines,
  sessionStartProbe,
  sessionTaskClaims,
  stackHost,
  stopGateContributions,
  tasksAsync,
} from './connectors.ts'
export { PROBE_TIMEOUT_MS } from './connectors.ts'
export type { CollectedGuard } from './connectors.ts'
export {
  GUARD_DEFAULT_BUDGET,
  GUARD_EVENTS,
  GUARD_NAME_RE,
  GUARD_SAY_MAX_CHARS,
  GUARD_SAY_MAX_LINES,
  guardProblems,
  isGuardEvent,
} from './guards.ts'
export type {
  Guard,
  GuardEvent,
  GuardJudge,
  GuardMatch,
  GuardState,
  GuardWhen,
} from './guards.ts'
export {
  eventMatches,
  eventTopicMatches,
  isEventInput,
} from './events.ts'
export type {
  EventEnvelope,
  EventFilter,
  EventHandlers,
  EventInput,
  EventProbeResult,
  EventPublishResult,
  EventsFacade,
  EventSubscription,
} from './events.ts'
export {
  busConnector,
  busEvents,
  mailboxConnector,
  mailboxEvents,
} from './events-connectors.ts'
export {
  deliverSinks,
  registerSinkBuilder,
  unregisterSinkBuilder,
  renderEventText,
  requestFor,
  sinkMatches,
  sinkSecrets,
  sinkStatePath,
  withSinks,
  type DeliverOpts,
  type FetchFn as SinkFetchFn,
  type SinkDelivery,
  type SinkRequest,
  type SinkRequestBuilder,
} from './sinks.ts'
export {
  addressedTo,
  coalesceDrops,
  drainDirs,
  drainMailbox,
  type DrainOpts,
  dropMailbox,
  mailboxDir,
  mailboxEvent,
  mailboxIdentity,
  type MailboxIdentity,
  type MailboxPeek,
  notifyConnector,
  notifyDir,
  peekMailbox,
  renderDrop,
  userMailboxDir,
} from './notify.ts'
export type {
  Connector,
  ConnectorCtx,
  ConnectorHooks,
  FacadeMap,
  FacadeOpts,
  GateContribution,
  MaybePromise,
  PreToolVerdict,
  ProbeReporter,
  ProbeResult,
  ProbeTiming,
} from './connectors.ts'
export {
  AgentNotFound,
  AGENT_CAUSES,
  acquireAgentRegistryLock,
  agentEntryBlocked,
  agentRegistryPath,
  agentsSection,
  claimStep,
  classifyExitCause,
  classifyExitCauseParts,
  commandCliName,
  isAgentCause,
  mintAgentId,
  patchAgentRegistry,
  probeStep,
  readAgentRegistry,
  removeAgentRegistryEntries,
  rebindStep,
  SpawnError,
  stepParent,
  withAgentRegistryLock,
  writeAgentRegistry,
} from './agents.ts'
export type {
  AgentCapabilities,
  AgentCause,
  AgentConnector,
  AgentInfo,
  AgentRegistryEntry,
  AgentState,
  ExitClassification,
  ListResult,
  SpawnErrorKind,
  SpawnSpec,
  SpawnWorker,
} from './agents.ts'
export {
  admitSessionSlot,
  BATCH_MARKER_ENV,
  clearSessionPlanes,
  countSessionReservations,
  isBatchSpawn,
  registerSessionPlane,
  releaseSessionSlot,
  reserveSessionSlot,
  reserveSessionSlotOnce,
  SESSION_SLOT_TTL_MS,
  sessionPlane,
  sessionPlaneForCli,
  sessionPlanes,
  sessionQuotaConfig,
  sessionSlotsDir,
} from './session-planes.ts'
export type {
  DiscoveredSession,
  ReservationLane,
  SessionPlane,
  SessionQuota,
} from './session-planes.ts'
export {
  planeStartingSessions,
  releaseSessionStart,
  reserveSessionStart,
  sessionCapRefusal,
  sessionCapRefusalFor,
  sessionCapViews,
  sessionReservationsDir,
} from './session-cap.ts'
export type { SessionCapView } from './session-cap.ts'
export {
  clearPlanes,
  planeNames,
  planes,
  PlaneUnavailable,
  PlaneVerbError,
  registerPlane,
  verbsNotWired,
} from './planes.ts'
export type {
  EventRow,
  Finding,
  Gate,
  LessonRow,
  LifecycleRow,
  PlaneArgSchema,
  PlaneCtx,
  PlaneDescriptor,
  PlaneFactory,
  PlaneFilter,
  PlaneRow,
  Run,
  VerdictRow,
  Worker,
  WorkItem,
} from './planes.ts'
export {
  acquireFileLock,
  awaitFileLock,
  holdFileLock,
  lockHolderPid,
  LockTimeout,
  staleLock,
  withFileLock,
  type FileLockOptions,
  type HeldLockOptions,
} from './filelock.ts'
export {
  fileBackedJanitorDeps,
  janitorBroDir,
  janitorDidWork,
  janitorLine,
  runJanitor,
} from './janitor.ts'
export type { JanitorDeps, JanitorOpts, JanitorReaped, JanitorReport } from './janitor.ts'
export type { SpecNode, SpecStore } from './specs.ts'
export { warnDeprecated } from './deprecation.ts'
export { EXIT, EXIT_CODES, hasHelpFlag, printUsage, usageWriter } from './exits.ts'
export type { ExitCode, ExitCodeRow } from './exits.ts'
export { markerLive, markerOwner, pidAlive, procStat } from './proc.ts'
export { checkPlanVersion, planKind, readPlanDoc } from './plan.ts'
export type { PlanSchema } from './plan.ts'
export { makePrinter } from './output.ts'
export type { Printer } from './output.ts'
export {
  BUS_RING_LIMIT,
  BUS_TIMEOUT_MS,
  BusRing,
  BUS_PROBE_LIMIT,
  busMatches,
  busProbe,
  busPublish,
  busSocketPath,
  busStatePath,
  busStatus,
  busSubscribe,
  busTopicMatches,
  busWake,
  isBusEventInput,
  startBusBroker,
  startBusBrokerAt,
} from './bus.ts'
export type {
  BusBroker,
  BusBrokerOptions,
  BusCursor,
  BusEnvelope,
  BusEventInput,
  BusFilter,
  BusProbeResult,
  BusPublishResult,
  BusRecord,
  BusStatus,
  BusSubscription,
  BusSubscriptionHandlers,
  BusWake,
} from './bus.ts'
export {
  pickOrphanProcs,
  readProcRows,
  sweepOrphanProcs,
  trackChild,
  unrefPendingChildren,
} from './live-procs.ts'
export type { OrphanSweepReport, ProcRow } from './live-procs.ts'
// test seam — scrubbed fixture git spawns + the ambient-env guard,
// shared by every package's suites (same role as providers' testkit)
export { AMBIENT_GIT, doltManifest, doltStoreCommit, scrubEnv, testGit, testGitEnv, testGitSpawn, testRepoInit } from './testkit.ts'
