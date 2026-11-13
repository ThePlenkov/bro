/**
 * `bro loop` — the autonomous backlog runner as a command, not a prompt
 * convention. bro owns the loop: claim the top ready bead (same rules as
 * `bro next`) → fresh sibling worktree → spawn the configured agent →
 * drive the act gate (merge on green, respawn the agent on review
 * threads up to loop.fixRounds) → bd close → repeat until the queue is
 * idle or gated.
 *
 *   bro loop                    run until idle/gated
 *   bro loop --max 3            at most 3 beads
 *   (one loop supervisor per repo — a second `bro loop` stands by
 *   behind the incumbent's `bro/loop.lock` hold and resumes when it
 *   exits; never two concurrent loops, spec bro-2duu9)
 *   bro loop --batch 8          clump up to 8 same-affinity beads per
 *                               work item — one worker, one PR
 *   bro loop --dry-run          print the first item's plan, change nothing
 *   bro loop --agent 'claude -p "$(cat {promptFile})"'
 *   bro loop --agent kilo-cli   spawn through providers.kilo-cli (acp/cli)
 *
 * The agent contract: a `--agent` value that exactly names a configured
 * `providers.<name>` (or `--provider`/`--profile`/`loop.provider`)
 * resolves through the spawn facade — acp providers run `bro acp-worker`
 * headless, cli providers substitute their command for the template.
 * Any other `--agent` value is the raw shell template (the escape
 * hatch): `{promptFile}` in `loop.agent` (bro.config) is replaced with
 * the work-order file path; without the placeholder the path is appended
 * as the last arg. Spawned in the worktree with BRO_BEAD_ID /
 * BRO_BEAD_TITLE / BRO_PROMPT_FILE in env. The agent's job ends at an
 * open PR — merging stays with the gate here.
 *
 * Human gates, epics, and molecule steps are never claimed (next's
 * rules). With `loop.batch`/`--batch` a claim is a CLUMP: the top bead
 * pulls same-affinity neighbors (spec/epic/area/path key) into one
 * worktree + one PR, per-bead commits as checkpoints, uncovered
 * members re-queue on merge (spec bro-nspj7). A bead whose agent fails
 * without a PR is reopened with a
 * note — unless the spawn died inside loop.crashExitMs (default 10s):
 * gone that fast it crashed on the environment, not the bead, and
 * reopening is a respawn-burn, so it parks loud instead (bro-sovl3). A
 * park releases the claim into a deferred snooze —
 * `loop.parkedWakeMin` (default 2h) later the next ready read wakes it
 * to open; the worktree stays as the resume cache the woken claim
 * reuses (bro-hl22w).
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname } from 'node:path';
import { ACT_STATE_TTL_MS, type PrStateCache, prStateCache } from '@broject/act';
import {
  type AgentConnector,
  type AgentInfo,
  admitSessionSlot,
  awaitFileLock,
  BATCH_MARKER_ENV,
  type BrouterModels,
  CLASS_LABEL_PREFIX,
  type ClaimCapability,
  type ClaimRow,
  commandCliName,
  type ExitCode,
  type ExplainSlice,
  ensureTasksBackend,
  explainSlicesOrExit,
  facade,
  facadeName,
  gitTry,
  hasHelpFlag,
  holdRoleLease,
  type Lease,
  type LeaseStore,
  localLeaseStore,
  type MirrorPolicy,
  mkdirPrivateSync,
  openPrivateAppendSync,
  printUsage,
  procStat,
  projectId,
  readAgentRegistry,
  readLifecycle,
  type ResolvedClass,
  type ReviewFacade,
  releaseSessionStart,
  reviewHost,
  routeStepClass,
  SpawnError,
  type SpawnWorker,
  sessionCapRefusalFor,
  sessionCapViews,
  sessionPlane,
  specStore,
  stepClassInfo,
  stepParent,
  type TaskStore,
} from '@broject/core';
import {
  clumpMembers,
  diskFloorBreach,
  diskFloorBytes,
  expandAgentCmd,
  FLEET_HEAD_PREFIXES,
  type FleetPrRow,
  isFleetHead,
  type LoopConfig,
  loopSlug,
  MB,
} from '@broject/loop';
import { isStackName } from '@broject/stack';
import {
  type AgentConnectorEnv,
  applyFleetMatrix,
  applyFleetRouter,
  EMPTY_KEYS,
  fleetProfileOf,
  liveSessionKeysByKind,
  loadAgentEnv,
  MatrixHoldError,
  type MatrixLanePick,
  matrixLanePick,
  profileModelFor,
  providerWallsFor,
  resolveAgentConnector,
  resolveSpawnProvider,
  resolveSpawnRoute,
  type SpawnProviderPick,
  sessionQuotaOf,
  settleAcpSessions,
  worktreeTelemetryDims,
} from '../agent-connectors.ts';
import { type AcpSeam, type FetchFn, otelHeader, otelSpan } from '@broject/providers';
import { loadBroConfig } from '../plugins.ts';
import { runActCommand } from './act.ts';
import { flag, positionals } from './args.ts';
import { installLoop, loopLockPath, readLoopMarker, uninstallLoop } from './daemon.ts';
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts';
import { explainSpawn } from './loop-explain.ts';
import { type RouteTableLane, routeTableLane } from './loop-routes.ts';
import { linkRunToDecision, reconcileOutcomes, reportRoutedOutcome } from './outcome-report.ts';
import { beginLoopRun, endLoopRun, loopRunLog, reapLoopRuns } from './loop-state.ts';
import {
  claimUpTo,
  classify,
  epicParentIds,
  nextScope,
  type ReadyBead,
  readyBeads,
} from './next.ts';
import type { NextPlan } from './next-plan.ts';
import {
  clumpTitle,
  diskProbes,
  freshLoopQueue,
  noteBead,
  runLoop,
  stackPlan,
  type LoopDeps,
  type LoopLane,
  type LoopMember,
  type LoopQueue,
  type StackSlot,
} from '@broject/rig';
import { mergedBranches, stackMemberFor, stackTip, syncStack } from './stack.ts';
import { runSyncCommand } from './sync.ts';
import { isOrchestratorSession } from './watch-pulse.ts';
import {
  defaultBranchName,
  type LitterReap,
  litterClaims,
  parseWorktreePorcelain,
  readStackEdges,
  reapLoopLitter,
  recordStackEdge,
  stackPushLockPath,
} from './work.ts';

interface Ctx {
  /** Review facade bound to the main checkout — host calls follow the
   *  repo, not the caller's cwd. `repo` is its 'owner/name'. */
  rev: ReviewFacade;
  /** The serving tasks backend — beads by default, a pinned connector
   *  (`connectors.tasks`) otherwise. All bead mutations go through it. */
  tasks: TaskStore;
  /** Resolved tasks connector name — beads-only tails (BEADS_DIR,
   *  molecule provenance) engage only on 'beads'. */
  backend: string;
  repo: string;
  root: string;
  leaseStore?: LeaseStore;
  cfg: LoopConfig;
  /** The act gate's own section — service passes share the one read. */
  act: ReturnType<typeof loadBroConfig>['act'];
  /** The shared gate-state feed — every member's service tick reads it,
   *  so loop's own polls plus watch/drive/act-wait passes share one
   *  fetch per PR per TTL window (bro-0tcrl). Null outside a repo. */
  stateCache: PrStateCache | null;
  /** The template `expandAgentCmd` runs — `loop.agent`/`--agent`, or a
   *  cli provider's `command` when the provider lane resolved one. For an
   *  acp (argv) worker this field is inert — the spawn never expands it. */
  agent: string;
  /** The resolved spawn lane when routing is off (or the flag-tier pin
   *  when it's on) — `resolveBeadLane` re-resolves per bead. */
  lane: LoopLane;
  /** The spawn env config — `fleet.routing`/`providers` for per-bead
   *  class resolution (spec bro-1x7p). */
  env: AgentConnectorEnv;
  /** The invocation's lane picks — per-bead resolution merges them
   *  above the routed chain exactly like `bro agents up`. */
  sel: LoopLaneSel;
  /** `fleet.routing` declared AND not bypassed by a template --agent —
   *  each claimed bead resolves `class:` label → `default` → chain
   *  head provider. Flag picks (`--provider`/`--profile`/`--agent
   *  <name>`) still outrank the table piecewise. */
  routing: boolean;
  intervalS: number;
  json: boolean;
  /** The explain slices — when the operator asked for the routing
   *  decision's reasons, the spawn path prints them (stderr). Absent =
   *  the run says nothing about its routing. */
  explain?: ExplainSlice[];
  /** Declared label scope — `bro loop --label debt,ui` only claims
   *  beads carrying one of these labels; the rest of the shared queue
   *  stays untouched. */
  selection: Pick<NextPlan, 'filters' | 'gates' | 'order'>;
  /** The beads dir the loop's task store resolves to — pinned into
   *  agent and bootstrap env as BEADS_DIR so worktree `bd` writes reach
   *  it. Undefined on a non-beads backend: nothing to pin. */
  beadsDir?: string;
  /** The agents facade connector workers spawn through (spec
   *  bro-zpa93) — the `bro agents up` path: detached sh -c, claim under
   *  the registry lock, .exit record in <git-common>/bro/agents/.
   *  Undefined only when beadsDir is — the registry's claim plane needs
   *  a real store to pin against, so the legacy awaited spawn keeps the
   *  serial semantics there. */
  agents?: AgentConnector;
  /** `bro loop --stack <name>` — each claimed bead becomes a member of
   *  the named stack: branch stack/<name>/<n>-<slug> based on the tip,
   *  PR targeting the member below. */
  stack?: string;
  /** Cease claiming new work — only service gate stack + reconcile. */
  claimsHeld?: { open: number; max: number };
  /** Cleanup failures collected during the run — the end-of-run audit
   *  prints them again so a tail never dies in a scrollback line. */
  tails: string[];
  /** Liveness — the stage the run is suspended on. The heartbeat names
   *  it every tick; the mid-run exit audit names it once (spec
   *  bro-snga4). A silent death becomes a named death either way. */
  stage: string;
  /** The bead currently in play — undefined between items so a death
   *  outside an item notes nothing stale. */
  bead?: string;
  /** The tracker projection target — the review-host connector's task
   *  surface when it offers `publish` and isn't the serving store
   *  itself (a github-backend rig's tasks already ARE issues).
   *  Undefined = no projection (spec bro-z2z7f). */
  mirror?: TaskStore;
  /** The projection policy — bro.config `mirror`, defaults applied. */
  mirrorPolicy: MirrorPolicy;
  /** Spec probe for the policy's specLinked rule — the `specs` facade;
   *  a connector-less rig answers false (description links still
   *  count inside mirrorable). */
  specHas: (id: string) => boolean;
  // --- the rig policy's ctx surface (spec bro-u6fp5.1) -------------
  /** Every IO surface the loop FSM touches — the policy's only reach
   *  into this command's machinery. */
  deps: LoopDeps;
  /** Per-run queue state — `runLoop` resets it on each invocation. */
  q: LoopQueue;
  /** The claim scope `runLoop` resolved — read by the claim pick. */
  scope?: unknown;
}

/** Clickable PR ref for this repo — user-facing lines never print bare #N. */
const prRef = (ctx: Ctx, pr: number): string => ctx.rev.prLink(ctx.repo, pr);

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro loop [--max N] [--dry-run] [--json] [--label a,b] [--stack NAME]
       bro loop [--every SEC]        run in supervised loop mode
       bro loop install [--every N] [--print]
       bro loop uninstall
  --agent '<cmd {promptFile}>'   agent template (config: loop.agent) —
                                a value naming a configured providers.<name>
                                spawns through the provider registry instead
  --provider NAME                providers.<name> pick (acp → headless worker)
  --profile NAME                 fleet.profiles.<name> preset
  --class NAME                   pin every claimed bead to one
                                fleet.routing class (default: the bead's
                                class:<name> label, else 'default')
  --model M                      model override for the provider lane
  --auto-approve                 acp permission policy: allow, not deny
  --explain[=SLICES]             print why the bead landed on this route —
                                route, model, health, cost (or a subset)
  --merge-timeout MIN            gate budget per round (loop.mergeTimeoutMin, 45)
  --parked-wake MIN              parked bead's snooze before it wakes to
                                open (loop.parkedWakeMin, 120; 0 = iced
                                until bd undefer)
  --label a,b                    declared scope — only beads carrying one
                                of these labels are claimable
  --stack NAME                   chain claimed beads onto stack NAME —
                                each PR targets the member below
  --max-open N                   cap the gate stack's open PRs (loop.maxOpen, 1)
  --max-open-total N             hard ceiling on total open fleet PRs (loop.maxOpenTotal, 10; 0 = off)
  --disk-min-slots N             disk floor in slot units — pushes hold while
                                free disk < N×loop.worktreeMb on any fs the
                                run writes to (loop.diskMinSlots, 2; 0 = off)
  --batch N                      max beads per claim — a clump shares the
                                lead's affinity key (spec/epic/area/path),
                                one worktree, one worker, one PR
                                (loop.batch, 1 = solo)
  --every SEC                    supervised loop cadence, ≥${MIN_INTERVAL_SEC}s
  --interval SEC                 gate poll interval, ≥0.1s (60)`,
    exitCode
  );
}

const num = (v: string | undefined, dflt: number, min = 1, max?: number): number => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `>= ${min}` : `${min}..${max}`;
    console.error(`bro loop: invalid numeric value "${v}" (must be ${range})`);
    process.exit(2);
  }
  return n;
};

/** Node clamps a timer delay over 2^31-1 ms to 1 ms — a flag that becomes
 *  a raw delay needs a ceiling or an absurd value hot-loops the
 *  heartbeat/gate poll (or fires the agent timeout instantly). */
const TIMER_MAX_MS = 2 ** 31 - 1;

/** Progress lines — stderr under --json so stdout stays a clean
 *  event stream. */
const say = (ctx: Pick<Ctx, 'json'>, msg: string): void => {
  if (ctx.json) {
    console.error(msg);
  } else {
    console.log(msg);
  }
};

/** Agent commands resolve through PATH by design — bro orchestrates the
 *  operator-configured agent; a sanitized PATH would break the very
 *  binary the config names. NOSONAR lives on the spawn helpers. */

export function resolveBeadsDir(root: string, warn?: (msg: string) => void): string | undefined {
  const fail = (why: string): undefined => {
    warn?.(`loop: store data-dir ${why} — agents run unpinned, BEADS_DIR not set`);
    return undefined;
  };
  try {
    const store = facade('tasks', { dir: root }, { prefer: loadBroConfig(root).connectors });
    const dir = store.dataDir?.();
    return dir ?? fail('returned no path');
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Spawn env shared by agent and bootstrap — BEADS_DIR pins every bd
 *  the child runs to the loop's store. Provenance pins the ambient env
 *  can't spoof: BRO_AGENT/BRO_MOL_ID come from the connector (extra),
 *  and ambient copies are stripped so a parent worker's badge can't
 *  bleed into the child's commits (bro-fzot). */
function agentEnv(ctx: Ctx, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'BRO_AGENT',
    'BRO_AGENT_PROVIDER',
    'BRO_AGENT_MODEL',
    'BRO_AGENT_CLASS',
    // the fleet.matrix lane is per-spawn provenance too — a parent
    // worker's pick must not label this child's (spec bro-v0pvd.1.1)
    'BRO_AGENT_MATRIX',
    'BRO_SESSION_ID',
    'BRO_MOL_ID',
    // telemetry dims are per-spawn facts (spec bro-xgejl.1) — a parent
    // worker's worktree/branch/repo must not label this child's spans
    'BRO_WORKTREE',
    'BRO_BRANCH',
    'BRO_REPO',
    // the routing decision id is per-spawn provenance — a parent
    // worker's id must not label this child's outcome join
    'BRO_ROUTER_DECISION',
    BATCH_MARKER_ENV,
  ]) {
    delete env[k];
  }
  return {
    ...env,
    ...(ctx.beadsDir ? { BEADS_DIR: ctx.beadsDir } : {}),
    ...extra,
  };
}

/** The command the template arm expands for a lane — a cli provider's
 *  `command` substitutes for the configured template; argv workers never
 *  reach it. */
const laneCommand = (ctx: Ctx, lane: LoopLane): string =>
  lane.worker?.kind === 'template' ? lane.worker.command : ctx.agent;

/** Commit-provenance pins for the loop's agent (bro-fzot) — the cli the
 *  effective command names (the acp worker's `cliName` on the argv lane),
 *  the provider/model lane labels, and the bead's molecule parent when
 *  the shared store can answer. */
function provenancePins(ctx: Ctx, beadId: string, lane: LoopLane): Record<string, string> {
  const w = lane.worker;
  const pins: Record<string, string> = {
    BRO_AGENT: w?.kind === 'argv' ? (w.cliName ?? 'agent') : commandCliName(laneCommand(ctx, lane)),
  };
  if (lane.provider !== undefined) {
    pins.BRO_AGENT_PROVIDER = lane.provider;
  }
  if (lane.model !== undefined) {
    pins.BRO_AGENT_MODEL = lane.model;
  }
  const mol = ctx.beadsDir !== undefined ? stepParent(ctx.beadsDir, beadId) : undefined;
  if (mol !== undefined) {
    pins.BRO_MOL_ID = mol;
  }
  // the fleet's marker rides on every spawn the loop owns — the raw
  // template arm included: it runs a fleet worker, and the devin plane
  // counts it as one (the template arm reserves no quota slot of its
  // own — bro-3xwvu tracks that gap)
  pins[BATCH_MARKER_ENV] = '1';
  // the routing decision's id — the outcome report joins on it (spec
  // bro-0ykhg.4); absent on unrouted/template-escape spawns
  if (lane.decisionId !== undefined) {
    pins.BRO_ROUTER_DECISION = lane.decisionId;
  }
  return pins;
}

// --- the agent lane: provider registry or raw template (spec bro-c3no8) -------

/** What a spawn runs — the provider-resolved worker when the provider
 *  lane engaged, undefined for the raw `loop.agent`/`--agent` template. */
export interface LoopLaneSel {
  agent?: string;
  provider?: string;
  profile?: string;
  model?: string;
  autoApprove?: boolean;
  class?: string;
}

/** Resolve which lane `bro loop` spawns through. A `--agent` value that
 *  exactly names a configured `providers.<name>` IS a provider pick;
 *  any other value is the escape-hatch template and wins the whole lane
 *  (provider flags beside it are contradictory — SpawnError). The order
 *  is the facade's own — explicit flag pick → flag-named
 *  fleet.profiles preset → the routed chain head (spec bro-1x7p: a
 *  declared `fleet.routing` resolves the bead's class per spawn and its
 *  chain head supplies the initial provider) → the fleet.matrix pick
 *  (spec bro-v0pvd.1.1: below every operator pick, above the route head
 *  and config defaults) → config picks (`loop.profile`,
 *  `loop.provider`) → `agents.native.provider` → legacy template. A bad
 *  name throws SpawnError — the caller exits before a bead is claimed. */
export async function resolveLoopLane(
  env: AgentConnectorEnv,
  sel: LoopLaneSel,
  cfg: LoopConfig,
  route?: ResolvedClass,
  matrix?: MatrixLanePick
): Promise<LoopLane> {
  const agentIsProvider = sel.agent !== undefined && Object.hasOwn(env.providers ?? {}, sel.agent);
  if (agentIsProvider && sel.provider !== undefined && sel.provider !== sel.agent) {
    throw new SpawnError(
      `--agent '${sel.agent}' and --provider '${sel.provider}' name different providers`,
      'input'
    );
  }
  if (sel.agent !== undefined && !agentIsProvider) {
    return templateEscape(sel, cfg, env);
  }
  const { provider, model, autoApprove, profileSourced, flagProvider } = lanePicks(
    env,
    sel,
    cfg,
    route,
    agentIsProvider,
    matrix
  );
  const pick = await resolveSpawnProvider(
    env,
    'native',
    { provider, model, autoApprove },
    pickTier(sel, agentIsProvider, profileSourced)
  );
  const lane = providerLaneOrEmpty(pick, model, autoApprove);
  // a flag-named profile's provider is an explicit pick — outranks the
  // table like --provider/--agent, so matching the chain head must not
  // arm the walk. A config-named profile is the standing default and
  // keeps routing (same tiers as lanePicks' provider order). A matrix
  // pick suppresses the walk the same way — its lane is already the
  // vetted one; chain candidates were never capability-checked.
  const routeSpec =
    route !== undefined &&
    matrix === undefined &&
    sel.provider === undefined &&
    !agentIsProvider &&
    flagProvider === undefined &&
    provider === route.provider
      ? await resolveSpawnRoute(
          env,
          'native',
          route,
          {
            model:
              sel.model ??
              (sel.profile === undefined ? undefined : fleetProfileOf(env, sel.profile)?.model),
            // the effective lane model — a config profile/loop.model
            // the head would otherwise lose to the provider default
            modelFallback: model,
            autoApprove,
          },
          pickTier(sel, agentIsProvider, profileSourced)
        )
      : undefined;
  return {
    ...lane,
    ...(route === undefined ? {} : { class: route.class }),
    // the fleet.matrix lane the enforce pick resolved to — provenance
    // like class; absent on shadow/off/unrouted lanes (spec
    // bro-v0pvd.1.1)
    ...(matrix === undefined ? {} : { matrix: matrix.lane }),
    ...(routeSpec === undefined ? {} : { route: routeSpec }),
  };
}

/** Donor lookup — a recorded `acpSessionId` rides again only when the
 *  fixer's lane is the same provider + an argv (acp) worker, so a
 *  foreign provider or a template lane never receives a meaningless
 *  id (spec bro-5qsnr §3-4). A corrupt registry reads as "no session"
 *  rather than throwing past the claim. */
export function resumeSessionFor(
  ctx: { root: string },
  molStep: string,
  lane: { provider?: string; worker?: SpawnWorker } | undefined
): string | undefined {
  try {
    const reg = readAgentRegistry(ctx.root);
    const entry = reg[molStep];
    if (entry === undefined) return undefined;
    const id = entry.acpSessionId;
    if (typeof id !== 'string' || id === '') return undefined;
    if (lane?.provider === undefined || entry.provider !== lane.provider) return undefined;
    if (lane.worker?.kind !== 'argv') return undefined;
    return id;
  } catch {
    return undefined;
  }
}

/** The pick tiers — flag > flag-named profile > routing table >
 *  config-named profile > config. A flag-named profile is an explicit
 *  pick (outranks the table); a config-named one is a standing default
 *  below it (the same tiers `spawnStepAgent` puts req.profile vs
 *  route.provider in). `profileSourced` reports whether the provider
 *  came off a profile — the provenance tier resolveSpawnProvider logs. */
function lanePicks(
  env: AgentConnectorEnv,
  sel: LoopLaneSel,
  cfg: LoopConfig,
  route: ResolvedClass | undefined,
  agentIsProvider: boolean,
  matrix?: MatrixLanePick
): {
  provider?: string;
  model?: string;
  autoApprove?: boolean;
  profileSourced: boolean;
  /** The flag-named (`--profile`) preset's provider — an explicit
   *  pick that outranks the table; routing must not arm on it. */
  flagProvider?: string;
} {
  const profileName = sel.profile ?? (cfg.profile !== '' ? cfg.profile : undefined);
  const profile = profileName !== undefined ? fleetProfileOf(env, profileName) : undefined;
  const flagProfile = sel.profile !== undefined ? profile : undefined;
  const cfgProfile = sel.profile === undefined ? profile : undefined;
  const provider =
    sel.provider ??
    (agentIsProvider ? sel.agent : undefined) ??
    flagProfile?.provider ??
    // the matrix pick sits below every operator pick and above the
    // class-route head + config defaults — under enforce it is the
    // task-shape authority (spec bro-v0pvd.1.1)
    matrix?.provider ??
    route?.provider ??
    cfgProfile?.provider ??
    (cfg.provider !== '' ? cfg.provider : undefined);
  const model =
    sel.model ??
    // a profile's model rides only on its own provider's lane
    profileModelFor(flagProfile, provider) ??
    // the matrix pick's model rides only on the lane it picked — an
    // override provider never inherits it
    (provider !== undefined && provider === matrix?.provider ? matrix?.model : undefined) ??
    // the chain head's model pin pairs with ITS provider only — an
    // override provider never inherits chain[0]'s model
    (provider !== undefined && provider === route?.provider ? route.model : undefined) ??
    profileModelFor(cfgProfile, provider) ??
    (cfg.model !== '' ? cfg.model : undefined);
  return {
    provider,
    model,
    autoApprove:
      sel.autoApprove ?? flagProfile?.autoApprove ?? matrix?.autoApprove ?? cfgProfile?.autoApprove,
    profileSourced: profile?.provider !== undefined,
    flagProvider: flagProfile?.provider,
  };
}

/** The provenance tier for the provider pick — a flag's typo is caller
 *  'input', a config-sourced name is 'config' (resolveSpawnProvider's
 *  namedBy contract). */
function pickTier(
  sel: LoopLaneSel,
  agentIsProvider: boolean,
  profileSourced: boolean
): 'flag' | 'profile' | 'backend' {
  if (sel.provider !== undefined || agentIsProvider) {
    return 'flag';
  }
  return profileSourced ? 'profile' : 'backend';
}

/** The escape hatch — a template --agent replaces the provider lane for
 *  this run, config picks and fleet.routing included; provider/routing
 *  flags beside it are contradictory input. */
function templateEscape(sel: LoopLaneSel, cfg: LoopConfig, env: AgentConnectorEnv): LoopLane {
  const extras = [
    sel.provider !== undefined ? '--provider' : undefined,
    sel.profile !== undefined ? '--profile' : undefined,
    sel.model !== undefined ? '--model' : undefined,
    sel.class !== undefined ? '--class' : undefined,
    sel.autoApprove === true ? '--auto-approve' : undefined,
  ].filter((f): f is string => f !== undefined);
  if (extras.length > 0) {
    throw new SpawnError(
      `${extras.join(', ')} pick a provider lane, but --agent '${sel.agent}' is a ` +
        'raw template — name the provider instead (--agent <name>)',
      'input'
    );
  }
  if (cfg.provider !== '' || cfg.profile !== '' || cfg.model !== '') {
    console.error(
      'loop: --agent template bypasses the configured provider lane ' +
        '(loop.provider/loop.profile/loop.model)'
    );
  }
  if (env.fleet?.routing !== undefined && Object.keys(env.fleet.routing).length > 0) {
    console.error('loop: --agent template bypasses fleet.routing — every bead runs the template');
  }
  return {};
}

/** A pick without a worker is the raw template lane — but only when
 *  nothing provider-only was asked for: a dangling model/autoApprove
 *  (flag, profile preset, or loop.model) is a config error, not a
 *  silent drop onto the template. */
function providerLaneOrEmpty(
  pick: SpawnProviderPick,
  model: string | undefined,
  autoApprove: boolean | undefined
): LoopLane {
  if (pick.worker !== undefined) {
    return {
      worker: pick.worker,
      provider: pick.provider,
      account: pick.account,
      model: pick.model,
    };
  }
  if (model !== undefined || autoApprove === true) {
    throw new SpawnError(
      '--model/--auto-approve (or loop.model) ride the provider lane — name a ' +
        'provider via --provider, --agent <name>, or loop.provider',
      'config'
    );
  }
  return {};
}

// --- per-bead class routing (spec bro-1x7p / bead bro-zmned) ---------------------

/** The bead's `class:` label — the lane pin `resolveStepClass` reads.
 *  ReadyBead.labels come from the claim read (`bd ready --json` rows
 *  carry them); the parse matches stepClassInfo's exactly. */
function classLabelOf(bead: ReadyBead): string | undefined {
  const hit = bead.labels?.find(l => l.startsWith(CLASS_LABEL_PREFIX));
  const name = hit === undefined ? undefined : hit.slice(CLASS_LABEL_PREFIX.length).trim();
  return name === '' ? undefined : name;
}

/** The routing inputs one bead carries — `class:` label, priority
 *  (the onWall default), and title/description for the judge router.
 *  The ready row already answers; a beads store pays one extra
 *  `bd show` only when the router could fire on an unclassed bead and
 *  needs the description the list row doesn't carry. */
function beadClassInfo(
  ctx: Ctx,
  bead: ReadyBead,
  routerEnabled = true
): { label?: string; priority?: number; title?: string; description?: string } {
  const info = {
    label: classLabelOf(bead),
    priority: bead.priority,
    title: bead.title,
    description: bead.description,
  };
  const router = ctx.env.fleet?.router;
  const matrix = ctx.env.fleet?.matrix;
  const routerMayFire =
    routerEnabled &&
    router !== undefined &&
    router.mode !== 'off' &&
    ctx.sel.class === undefined &&
    info.label === undefined &&
    ctx.beadsDir !== undefined;
  // the matrix router (bro-v0pvd.1) judges every bead's task text — no
  // class/label exemptions — and wants the description the ready row
  // may not carry, so it earns the same extra `bd show` the class
  // router does (still gated on routerEnabled: dry runs never pay it)
  const matrixMayFire =
    routerEnabled &&
    matrix !== undefined &&
    matrix.provider !== undefined &&
    matrix.mode !== 'off' &&
    Object.keys(matrix.models).length > 0 &&
    ctx.beadsDir !== undefined;
  return routerMayFire || matrixMayFire
    ? { ...info, ...stepClassInfo(ctx.beadsDir!, bead.id) }
    : info;
}

/** One claimed bead's spawn lane — fleet.routing resolves its class
 *  (`--class` flag → `class:` label → `default`) and the chain head
 *  supplies the initial provider, exactly like `bro agents up`; the
 *  registry-backed spawn may walk forward from the current provider.
 *  The path is routeStepClass → applyFleetRouter → resolveSpawnProvider. The
 *  flag-tier picks still outrank the table piecewise; `ctx.lane` is the
 *  run's fixed lane when routing is off or bypassed. The judge router
 *  fires only on a genuinely unclassed bead — an explicit `--class` pin
 *  is the top precedence tier and must not be overruled (agents.ts
 *  signals the pin by withholding `info`; here the flag is checked
 *  directly) — and `router:false` skips it entirely for render-only
 *  callers (a dry run must not spend a judge call or journal a shadow
 *  verdict). Throws SpawnError — a bad `class:` label or broken chain
 *  is a config error the caller settles as a failed item, never a
 *  silent template drop. */
/** The task the route table is asked about — the bead's class and
 *  label, plus the served universe the operator declared. */
interface RouteTableTask {
  /** the table's path */
  table: string;
  /** the bead's explicit class */
  class?: string;
  /** the bead's `class:` label */
  label?: string;
  /** the bead's priority */
  priority?: number;
  /** what the operator declared the router serves */
  served?: BrouterModels;
}

function routeTableTask(
  ctx: Ctx,
  table: string,
  label: { label?: string; priority?: number }
): RouteTableTask {
  const task: RouteTableTask = { table };
  if (ctx.sel.class !== undefined) {
    task.class = ctx.sel.class;
  }
  if (label.label !== undefined) {
    task.label = label.label;
  }
  if (label.priority !== undefined) {
    task.priority = label.priority;
  }
  const models = ctx.env.brouter?.models;
  if (models !== undefined) {
    task.served = models;
  }
  return task;
}

/** The route table's lane for one bead — undefined when the operator
 *  declares no table (fleet.routing stays the compatibility face for the
 *  runs that declare none). */
async function routeTableLaneFor(
  ctx: Ctx,
  bead: ReadyBead,
  matrix?: MatrixLanePick
): Promise<{ lane: LoopLane; routed: RouteTableLane } | undefined> {
  const tablePath = ctx.env.brouter?.routes;
  if (tablePath === undefined) {
    return undefined;
  }
  const label = beadClassInfo(ctx, bead, false);
  const routed = await routeTableLane({
    ...routeTableTask(ctx, tablePath, label),
    dir: ctx.root,
    beadId: bead.id,
    text: `${bead.id}: ${bead.title}`,
    // the cascade's carried fields (bro-0ykhg.2) — the bead's labels and
    // the repo's canonical id; absent fields satisfy no match pins
    ...(bead.labels === undefined || bead.labels.length === 0 ? {} : { labels: bead.labels }),
    repo: projectId(ctx.root),
  });
  if (routed === undefined) {
    return undefined;
  }
  const lane = await resolveLoopLane(ctx.env, ctx.sel, ctx.cfg, routed, matrix);
  if (routed.decisionId !== undefined) {
    lane.decisionId = routed.decisionId;
    // the bead pin — `router:decision=<id>` as metadata: idempotent
    // (set-metadata overwrites), and the merge-time outcome report
    // resolves the decision through it before falling back to the
    // journal's run-link reconciliation (spec bro-0ykhg.4)
    try {
      ctx.tasks.update(bead.id, { 'set-metadata': `router:decision=${routed.decisionId}` });
    } catch {
      /* the pin is best-effort — the journal row still carries beadId */
    }
  }
  return { lane, routed };
}

async function resolveBeadLane(
  ctx: Ctx,
  bead: ReadyBead,
  opts: { router?: boolean; fetch?: FetchFn; acp?: AcpSeam } = {}
): Promise<LoopLane> {
  // the matrix router (bro-v0pvd.1 + bro-v0pvd.1.1) judges the TASK's
  // complexity+mode — orthogonal to fleet.routing, the class pin, AND
  // the route table, so it runs before ANY routing face answers: an
  // enforce hold must not be bypassed by a table lane, and an enforce
  // pick binds provider/model/autoApprove above the table's route head
  // piecewise (spec precedence: explicit picks > matrix > class route >
  // static lane). Only the dry-run escape (router:false) skips it,
  // same as the class router: a render must not spend a judge call or
  // journal a verdict.
  const info = beadClassInfo(ctx, bead, opts.router !== false);
  const verdict =
    opts.router === false
      ? undefined
      : await applyFleetMatrix(ctx.root, ctx.env, bead.id, info, opts);
  // verdict → lane: a pick binds provider/model/autoApprove piecewise
  // in resolveLoopLane; no-fit/unanswered under enforce throw
  // MatrixHoldError — the caller's park consumer owns the queue hold
  const matrixPick = matrixLanePick(verdict, ctx.env);
  // the route table is the router's own routing face — when the
  // operator declares one and it answers, its lane stands; the matrix
  // pick (when engaged) binds inside resolveLoopLane above the route
  // head, and an enforce hold already threw above
  const tableLane = await routeTableLaneFor(ctx, bead, matrixPick);
  if (tableLane !== undefined) {
    explainSpawn({ slices: ctx.explain, bead: bead.id, routed: tableLane.routed });
    return tableLane.lane;
  }
  if (!ctx.routing) {
    // no routing table — the static lane stands unless an enforce pick
    // engaged; shadow/off/judge-down return ctx.lane untouched
    return matrixPick === undefined
      ? ctx.lane
      : resolveLoopLane(ctx.env, ctx.sel, ctx.cfg, undefined, matrixPick);
  }
  const routed = routeStepClass(
    ctx.env.fleet,
    ctx.env.providers ?? {},
    ctx.beadsDir,
    bead.id,
    ctx.sel.class,
    info
  );
  const route =
    opts.router === false || ctx.sel.class !== undefined
      ? routed
      : await applyFleetRouter(ctx.root, ctx.env, bead.id, info, routed, opts);
  return resolveLoopLane(ctx.env, ctx.sel, ctx.cfg, route, matrixPick);
}

/** Dry-run rendering for an argv worker — single-quotes only the args
 *  that need it, so the printed line stays readable. */
const shRender = (s: string): string =>
  /[\s'"\\]/.test(s) ? `'${s.replaceAll("'", String.raw`'\''`)}'` : s;

/** Fresh sibling worktree on loop/<id> off origin/main (falls back to
 *  main/HEAD when no origin) — or off `base` when a stack already picked
 *  the fork point. An existing dir is reused as-is. */
function spawnAgent(
  ctx: Ctx,
  lane: LoopLane,
  beadIds: string[],
  title: string,
  promptFile: string,
  dir: string,
  agentId?: string
): Promise<number | null> {
  return new Promise(resolve => {
    const leadId = beadIds[0]!;
    // agent.spawn span + TRACEPARENT — the same child-trace injection
    // spawnStepAgent performs at the `bro fleet agents up` site (spec
    // bro-xgejl.1); without it the worker's own spans root a fresh
    // trace instead of nesting under this spawn
    const dims = worktreeTelemetryDims(dir);
    const span = otelSpan('agent.spawn', {
      'agent.step': leadId,
      'agent.backend': 'template',
      'agent.provider': lane.provider ?? '',
      'agent.model': lane.model ?? '',
      'agent.worktree': dims.worktree,
      ...(dims.branch === undefined ? {} : { 'agent.branch': dims.branch }),
      ...(dims.repo === undefined ? {} : { 'agent.repo': dims.repo }),
    });
    const tp = otelHeader(span.ctx);
    const ep = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const env = agentEnv(ctx, {
      // BRO_BEAD_ID stays the lead for compatibility — batch work orders
      // read the whole clump off BRO_BEAD_IDS
      BRO_BEAD_ID: leadId,
      BRO_BEAD_IDS: beadIds.join(','),
      BRO_BEAD_TITLE: title,
      BRO_PROMPT_FILE: promptFile,
      // the template arm's session/agent ids are the run key — the
      // connector's agentId-fallback semantics (spec bro-xgejl.1)
      ...(agentId !== undefined ? { BRO_AGENT_ID: agentId, BRO_SESSION_ID: agentId } : {}),
      // telemetry dims (spec bro-xgejl.1) — ambient copies are stripped
      // in agentEnv; these are THIS worktree's, never the parent's
      BRO_WORKTREE: dims.worktree,
      ...(dims.branch === undefined ? {} : { BRO_BRANCH: dims.branch }),
      ...(dims.repo === undefined ? {} : { BRO_REPO: dims.repo }),
      TRACEPARENT: tp,
      ...(ep !== undefined && ep !== '' ? { OTEL_EXPORTER_OTLP_ENDPOINT: ep } : {}),
      ...provenancePins(ctx, leadId, lane),
      ...(lane.class === undefined ? {} : { BRO_AGENT_CLASS: lane.class }),
      // the fleet.matrix lane the enforce pick resolved to — same
      // provenance pin the registry path stamps via spec.matrix
      // (spec bro-v0pvd.1.1); absent on shadow/off/unrouted lanes
      ...(lane.matrix === undefined ? {} : { BRO_AGENT_MATRIX: lane.matrix }),
    });
    const slug = loopSlug(leadId);
    const log = loopRunLog(ctx.root, slug);
    let logFd: number | null = null;
    if (log !== null) {
      try {
        mkdirPrivateSync(dirname(log));
        logFd = openPrivateAppendSync(log);
      } catch {
        logFd = null;
      }
    }
    const opts = {
      cwd: dir,
      env,
      stdio:
        logFd !== null
          ? (['inherit', logFd, logFd] as Array<'inherit' | number>)
          : (['inherit', ctx.json ? 2 : 'inherit', 'inherit'] as Array<'inherit' | number>),
      detached: true,
    };
    const w = lane.worker;
    // When a log file is open, prefix every emitted line with an ISO8601
    // timestamp so loop.out/daemon.log-style trails stay attributable
    // (spec bro-7h976). The wrapped command's exit status is captured to
    // a side file before the filter runs, so the pipeline reports the
    // AGENT's code, never the while loop's 0.
    // single-quote escaping, not JSON.stringify: inside the sh -c
    // wrapper a double-quoted assignment still expands $ ` $() and
    // backslashes before eval ever sees the command (kody #760)
    const sqEsc = String.raw`'\''`;
    const shq = (s: string): string => `'${s.replaceAll("'", sqEsc)}'`;
    const wrap = (cmd: string): string =>
      `({ _bro_cmd=${shq(cmd)}; _bro_rcf=$(mktemp); { (eval "$_bro_cmd"; echo $? > "$_bro_rcf") 2>&1 | while IFS= read -r _l || [ -n "$_l" ]; do printf '[%s] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_l"; done; }; _bro_rc=$(cat "$_bro_rcf" 2>/dev/null || echo 1); rm -f "$_bro_rcf"; exit "$_bro_rc"; })`;
    const child =
      w?.kind === 'argv'
        ? // the same `"$@"` positional exec the native backend builds —
          // argv workers are headless by construction (acp); sh resolves
          // argv[0] ('bro'/'npx') on PATH the way the backend does
          logFd !== null
          ? spawn('sh', ['-c', wrap('"$@"'), 'loop-agent', ...w.argv, promptFile], opts) // NOSONAR — argv[0] resolves on PATH by design, same as the backend's spawn
          : spawn('sh', ['-c', 'exec "$@"', 'loop-agent', ...w.argv, promptFile], opts) // NOSONAR — argv[0] resolves on PATH by design, same as the backend's spawn
        : logFd !== null
          ? spawn('sh', ['-c', wrap(expandAgentCmd(laneCommand(ctx, lane)))], opts) // NOSONAR — operator-configured agent command
          : spawn('sh', ['-c', expandAgentCmd(laneCommand(ctx, lane))], opts); // NOSONAR — operator-configured agent command
    if (logFd !== null) {
      // the child holds its own dup — our copy is spent
      closeSync(logFd);
    }
    if (child.pid !== undefined) {
      beginLoopRun(ctx.root, {
        beadId: leadId,
        beadIds,
        slug,
        pid: child.pid,
        pidStart: procStat(child.pid)?.start,
        startedAt: new Date().toISOString(),
        worktree: dir,
        log: log ?? '',
      });
      const logNote = log === null ? '' : ` — log ${log}`;
      say(ctx, `loop: agent ${beadIds.join(', ')} on pid ${child.pid}${logNote}`);
    }
    ctx.stage = `worker pid=${child.pid ?? '?'}`;
    const settle = (code: number | null): void => {
      // custody returns to the loop process — the worker is gone but the
      // claim isn't: findPr and the member's watchBegin still stand
      // between here and a verdict (bro-ho09d: endLoopRun here left a
      // window where a racing sweep saw a dead owner and released a
      // still-settling claim)
      beginLoopRun(ctx.root, {
        beadId: leadId,
        beadIds,
        slug,
        pid: process.pid,
        pidStart: procStat(process.pid)?.start,
        startedAt: new Date().toISOString(),
        worktree: dir,
        log: log ?? '',
      });
      // the span covers the whole run — spawn failure is the only
      // error verdict; a completed run reports its exit code (spec
      // bro-xgejl.1)
      span.end(
        code === null ? { error: 'agent spawn failed' } : { 'agent.exit_code': code },
        code === null ? 'error' : 'ok'
      );
      resolve(code);
    };
    child.on('error', err => {
      console.error(`loop: agent spawn failed — ${err.message}`);
      settle(null);
    });
    child.on('exit', (code, signal) => {
      if (code === null) {
        console.error(`loop: agent died on signal ${signal ?? '?'}`);
        settle(null);
        return;
      }
      settle(code);
    });
  });
}

/** spec.env for the registry spawn — the loop's ambient pins minus
 *  the keys the connector owns (it re-pins BEADS_DIR/BRO_BEAD_ID/
 *  provenance itself; the backend filters them out of caller env
 *  anyway). Only the clump extras are loop-private. */
function specEnv(ctx: Ctx, extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agentEnv(ctx, extra)).filter((e): e is [string, string] => e[1] !== undefined)
  );
}

/** The registry spawn (spec bro-zpa93) — `bro agents up` semantics on
 *  the loop's own work item: the lead bead's claim lands through the
 *  connector's claimStep under the agents-registry lock (a loop-side
 *  pre-claim would read as "claimed outside the registry" and refuse),
 *  the worker detaches `sh -c` in its own process group, and its exit
 *  lands in `<git-common>/bro/agents/<id>.exit` for serviceWorker to
 *  poll — the tick never awaits the run. Sets `m.worker`; a SpawnError
 *  is the caller's settle decision (cap → hold, conflict → park). */
async function spawnWorker(ctx: Ctx, m: LoopMember, prompt: string, lane: LoopLane): Promise<void> {
  const lead = m.beads[0]!;
  // agent.spawn span + TRACEPARENT — the same child-trace injection
  // spawnStepAgent performs at the `bro fleet agents up` site (spec
  // bro-xgejl.1); the registry path bypassed it, so loop-spawned
  // workers emitted rootless spans with no parent chain
  const dims = worktreeTelemetryDims(m.item.worktreeDir);
  const branch = dims.branch ?? m.item.branch;
  const span = otelSpan('agent.spawn', {
    'agent.step': lead.id,
    'agent.backend': ctx.agents!.name,
    'agent.provider': lane.provider ?? '',
    'agent.model': lane.model ?? '',
    'agent.worktree': dims.worktree,
    ...(branch === undefined ? {} : { 'agent.branch': branch }),
    ...(dims.repo === undefined ? {} : { 'agent.repo': dims.repo }),
  });
  const tp = otelHeader(span.ctx);
  const ep = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  let info: AgentInfo;
  try {
    info = await ctx.agents!.spawn({
      molStep: lead.id,
      repoRoot: m.item.worktreeDir,
      beadsDir: ctx.beadsDir!,
      prompt,
      env: specEnv(ctx, {
        BRO_BEAD_IDS: m.beads.map(b => b.id).join(','),
        BRO_BEAD_TITLE: clumpTitle(m.beads),
        // the fleet's own budget must see this worker — the marker rides
        // on every loop spawn, root bead or not (spec bro-9h86l)
        [BATCH_MARKER_ENV]: '1',
        // the routing decision's id — the worker's own provenance and
        // the outcome join key (spec bro-0ykhg.4)
        ...(lane.decisionId === undefined ? {} : { BRO_ROUTER_DECISION: lane.decisionId }),
        TRACEPARENT: tp,
        ...(ep !== undefined && ep !== '' ? { OTEL_EXPORTER_OTLP_ENDPOINT: ep } : {}),
      }),
      provider: lane.provider,
      account: lane.account,
      model: lane.model,
      // the routing lane the spawn resolved to — provenance the registry
      // records and the BRO_AGENT_CLASS env pin both read spec.class
      class: lane.class,
      // the fleet.matrix lane the enforce pick resolved to — same
      // provenance contract (spec bro-v0pvd.1.1)
      matrix: lane.matrix,
      ...(lane.route === undefined ? {} : { route: lane.route }),
      // an explicit worker keeps the backend's own command fallback from
      // re-reading loop.agent config — a --agent flag override would
      // otherwise be silently ignored
      worker: lane.worker ?? { kind: 'template', command: laneCommand(ctx, lane) },
    });
  } catch (err) {
    span.end({ error: err instanceof Error ? err.message : String(err) }, 'error');
    throw err;
  }
  // same end-attrs spawnStepAgent writes — the registry's stamped
  // provenance is what ran (a chain walk can move the spawn off the
  // head pick the span opened with)
  span.end({
    'agent.id': String(info.id ?? ''),
    'agent.pid': info.pid ?? 0,
    'agent.provider': info.provider ?? '',
    'agent.model': info.model ?? '',
  });
  m.worker = {
    agentId: info.id,
    runId: info.runId,
    spawnedAt: info.spawnedAt,
    spawnedMs: Date.now(),
    pid: info.pid,
  };
  // the journal's run-link repair — the decision row learns its worker
  // and run ids now that the spawn landed them (spec bro-0ykhg.4);
  // best-effort, the bead pin already carries the join
  if (lane.decisionId !== undefined) {
    void linkRunToDecision(ctx.root, lane.decisionId, {
      beadId: lead.id,
      worker: info.id,
      runId: info.runId,
    });
  }
  // the run record stays and rides the worker (bro-wg896): custody of
  // the CLAIM transfers to the registry entry at spawn, but retiring
  // the record here left `bro watch`/`bro status` blind for the
  // worker's whole run — re-stamped to the worker's pid + agent log so
  // check-ins read the live run (and silence keeps meaning silence).
  // A pid-less remote worker keeps the loop as the owner on record —
  // the supervisor is the live party polling its .exit.
  const workerPid = info.pid ?? process.pid;
  beginLoopRun(ctx.root, {
    beadId: lead.id,
    beadIds: m.beads.map(b => b.id),
    slug: loopSlug(lead.id),
    pid: workerPid,
    pidStart: procStat(workerPid)?.start,
    startedAt: new Date().toISOString(),
    worktree: m.item.worktreeDir,
    log: info.log ?? '',
  });
  say(ctx, `loop: agent ${m.beads.map(b => b.id).join(', ')} → ${info.id} pid ${info.pid ?? '?'}`);
  ctx.stage = `worker ${info.id} pid=${info.pid ?? '?'}`;
}

/** `<git-common>/bro/agents/<id>.log` for a registry worker — the run
 *  record's silence signal on the detached path. '' when the registry
 *  home can't be named (the record falls back to its own stamp). */
function laneSpawnedCommand(lane: LoopLane, fallback: string): string {
  if (lane.worker?.kind === 'argv') {
    return [...(lane.worker.argv || []), '{promptFile}'].join(' ');
  }
  if (lane.worker?.kind === 'template') {
    return lane.worker.command;
  }
  return fallback;
}

/** Cross-kind session admission: every OTHER session kind the spawned
 *  command starts consumes its cap too (a `devin -p …` payload draws on
 *  devin's budget from a native lane). Each claim runs under that
 *  kind's own host-wide admission mutex — the same lock the connector's
 *  admitSessionSlot holds — so a check-then-reserve here cannot race a
 *  parallel start into overshooting the cap. The quota lane's kind is
 *  skipped: admitSessionSlot covers its full lane, and claiming it
 *  twice would double-reserve one spawn against the same plane.
 *  Claimed paths append to `out` — a refusal mid-way is the caller's
 *  rollback set. */
function admitCrossKindSessions(
  agents: Record<string, Record<string, unknown>>,
  spawnedCmd: string,
  quotaKind: string | undefined,
  key: string,
  molStep: string,
  workerEnv: Record<string, string>,
  out: string[],
  scope: string,
  liveByKind: Map<string, Set<string>>
): void {
  // a pre-flight refusal ahead of any claim; the authoritative count
  // re-runs inside each kind's admission mutex below
  const crossRefusal = sessionCapRefusalFor(spawnedCmd, agents, workerEnv);
  if (crossRefusal !== undefined) {
    throw new SpawnError(crossRefusal, 'cap');
  }
  for (const view of sessionCapViews(spawnedCmd, agents, workerEnv)) {
    if (view.kind === quotaKind) {
      continue;
    }
    const plane = sessionPlane(view.kind);
    if (plane === undefined) {
      continue;
    }
    for (let i = 0; i < view.starts; i++) {
      const claimed = admitSessionSlot(plane, agents, {
        key,
        molStep,
        workerEnv,
        scope,
        liveKeys: liveByKind.get(view.kind) ?? EMPTY_KEYS,
      });
      if (claimed !== undefined) {
        out.push(claimed);
      }
    }
  }
}

/** Raw-template session admission — the same quota the registry spawn
 *  enforces: the lane's own kind via its quota lane, plus every other
 *  session kind the spawned command starts. A refusal hands back every
 *  cross-kind claim already taken; a success leaves the caller holding
 *  the primary reservation + the cross-kind paths to release when the
 *  spawn's verdict lands. */
function admitLaneSessions(
  ctx: Ctx,
  lane: LoopLane,
  spec: { molStep: string; prompt: string; repoRoot: string },
  key: string
): { reservation: string | undefined; crossKind: string[] } {
  const workerEnv = { ...agentEnv(ctx, { BRO_AGENT_ID: key }), [BATCH_MARKER_ENV]: '1' };
  const templateCommand = laneCommand(ctx, lane);
  const templateQuota = sessionQuotaOf(
    ctx.env,
    'native',
    {
      beadsDir: ctx.beadsDir!,
      molStep: spec.molStep,
      prompt: spec.prompt,
      repoRoot: spec.repoRoot,
      env: workerEnv,
      worker: lane.worker,
      provider: lane.provider,
      model: lane.model,
      class: lane.class,
    },
    templateCommand
  );
  const crossKind: string[] = [];
  // the same budget facts the registry spawn derives — a raw-template
  // lane scopes its ledger rows to this repo and prunes dead segments
  // on every admission (codeant #972): an unscoped key would bury the
  // spend under a shared '' scope where nothing can close it
  const scope = projectId(ctx.root);
  const liveByKind = liveSessionKeysByKind(readAgentRegistry(ctx.root));
  try {
    admitCrossKindSessions(
      ctx.env.agents,
      laneSpawnedCommand(lane, templateCommand),
      templateQuota?.plane.kind,
      key,
      spec.molStep,
      workerEnv,
      crossKind,
      scope,
      liveByKind
    );
    const reservation =
      templateQuota === undefined
        ? undefined
        : admitSessionSlot(templateQuota.plane, templateQuota.agents, {
            key,
            molStep: spec.molStep,
            workerEnv,
            scope,
            liveKeys: liveByKind.get(templateQuota.plane.kind) ?? EMPTY_KEYS,
          });
    return { reservation, crossKind };
  } catch (err) {
    // every cross-kind claim this admission holds goes back — the
    // caller never saw them
    releaseSessionStart(crossKind);
    throw err;
  }
}

/** Collect unresolved thread text, write the fix prompt, respawn the
 *  agent. A dead fix agent is logged, not fatal — the next gate poll
 *  decides whether anything landed on the branch. */
function resolveStackSlot(ctx: Ctx, bead: ReadyBead): StackSlot | undefined {
  if (ctx.stack === undefined) {
    return undefined;
  }
  const dflt = defaultBranchName() ?? 'main';
  const existing = stackMemberFor(ctx.root, ctx.stack, loopSlug(bead.id));
  if (existing !== undefined) {
    const edge = readStackEdges().get(existing.branch);
    return { n: existing.n, base: edge ?? dflt, bottom: edge === undefined };
  }
  const dead = mergedBranches(ctx.root, ctx.stack, { repo: ctx.repo, facade: ctx.rev });
  const tip = stackTip(ctx.root, ctx.stack, dead);
  return { n: tip.n, base: tip.base ?? dflt, edge: tip.base, bottom: tip.base === undefined };
}

/** slot + planItem for a bead — the dry-run render and the real
 *  worktree plan share the member-number/shape wiring. */
const laneLabel = (lane: LoopLane): string =>
  `${lane.provider}` + (lane.model !== undefined ? ` · model ${lane.model}` : '');

/** Resolve the bead's stack slot and create its worktree under the same
 *  push lock `stack push` holds — without it a loop and a push racing
 *  one stack read the same tip and both mint position n. A live
 *  competing push can outlast one 20s wait, so transient contention is
 *  retried a few times before flunking the item (flunking parks the
 *  bead unreclaimed for the whole run). */
const HEARTBEAT_MIN_MS = 2_000;

/** The worker stage — a spawned member's FIRST gate, before its PR
 *  gate is even meaningful (spec bro-zpa93). It polls the agents
 *  registry, never the review host: 'running'/'spawned' keeps the
 *  member pending and the tick moves on — the whole fairness fix. A
 *  terminal read clears `m.worker` and settles the way the old awaited
 *  spawn did: a PR joins the gate (same member lifecycle), no PR runs
 *  verdict → crash-window → reopen, and a blocked/stopped worker parks
 *  with its cause named. A respawned same-id entry (spawnedAt moved)
 *  is NOT this worker — 'lost' rather than inherit a foreign
 *  generation's clock. For a fix/rebase worker (`m.pr` already set)
 *  the terminal read is simply 'active': the gate re-polls. */
function labelSelection(argv: string[]): { labels?: string[] } {
  const raw = flag(argv, '--label');
  if (raw === undefined) {
    return {};
  }
  const labels = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
  if (labels.length === 0) {
    console.error('error: --label requires a comma-separated value, e.g. --label debt,ui');
    process.exit(2);
  }
  return { labels };
}

/** `--stack NAME` — must form a git-ref-safe component or the member
 *  branches it plans would fail on creation mid-run. */
function stackNameFlag(argv: string[]): string | undefined {
  const name = flag(argv, '--stack');
  if (name !== undefined && !isStackName(name)) {
    console.error(`bro loop: invalid stack name "${name}" ([a-z0-9_.-])`);
    process.exit(2);
  }
  return name;
}

const LOOP_VALUE_FLAGS = new Set([
  '--agent',
  '--merge-timeout',
  '--parked-wake',
  '--max',
  '--max-open',
  '--max-open-total',
  '--worktree-warn',
  '--disk-min-slots',
  '--batch',
  '--batch-min-priority',
  '--interval',
  '--every',
  '--label',
  '--stack',
  '--provider',
  '--profile',
  '--class',
  '--model',
]);
const LOOP_BOOL_FLAGS = new Set([
  '--json',
  '--dry-run',
  '--help',
  '--auto-approve',
  '--print',
  '--explain',
]);

function runLoopSched(argv: string[], dir: string, loopCfg: LoopConfig): void {
  // install arms and uninstall disarms — both are the orchestrator's
  // own authority over the supervisor cadence; a spawned worker owns
  // neither side of it
  if (!isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never own the supervisor; ' +
        'the orchestrator session owns it'
    );
    process.exit(2);
  }
  // a typo'd flag (`--evry`) or a stray positional must not silently
  // install the configured cadence — whitelist each verb's argv before
  // any mutation
  const installArgv = argv[0] === 'install';
  const stray = positionals(argv.slice(1), installArgv ? new Set(['--every']) : new Set(), {
    boolFlags: installArgv
      ? new Set(['--print', '--dry-run', '--help'])
      : new Set(['--dry-run', '--help']),
    strict: true,
  });
  if (stray.length > 0) {
    console.error(`error: unexpected argument '${stray[0]}'`);
    process.exit(2);
  }
  if (argv[0] === 'uninstall') {
    if (argv.includes('--dry-run')) {
      const marker = readLoopMarker(dir);
      console.log(
        marker === null
          ? 'loop uninstall — no install marker; nothing would be disarmed'
          : `loop uninstall — would disarm the marker (every ${marker.everySec}s) and SIGTERM the loop supervisor`
      );
      return;
    }
    const r = uninstallLoop(dir);
    console.log(r.detail);
    if (r.state === 'error') {
      process.exit(1);
    }
    return;
  }
  const everyRaw = flag(argv, '--every');
  const everySec = everyRaw === undefined ? loopCfg.everySec : Number(everyRaw);
  // the marker cadence bounds are the want-marker's — the same
  // MIN/MAX_INTERVAL_SEC every supervised entrypoint validates against
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    console.error(
      `error: --every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? everySec}"`
    );
    process.exit(2);
  }
  // --dry-run is the preview verb here just like --print: plan, don't arm
  const print = argv.includes('--print') || argv.includes('--dry-run');
  const r = installLoop(dir, { everySec, print });
  console.log(r.detail);
  if (r.state === 'error') {
    process.exit(1);
  }
}

/** Supervised mode — `daemon run --loop` and `loop install` reach
 *  `runLoopCommand` through the marker; `--every` is the outer re-scan
 *  cadence (the queue drains, the pass sleeps, the next pass rescans),
 *  while `--interval` stays the in-run gate poll. The same arming guard
 *  as `bro drive --every` applies — spawned workers never own a
 *  supervisor cadence; the orchestrator session does. */
function everySecArg(argv: string[]): number | undefined {
  const everyRaw = flag(argv, '--every');
  if (everyRaw === undefined) {
    return undefined;
  }
  const everySec = Number(everyRaw);
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    console.error(
      `error: --every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw}"`
    );
    process.exit(2);
  }
  if (!isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never arm supervisors; ' +
        'the orchestrator session owns the cadence'
    );
    process.exit(2);
  }
  return everySec;
}

/** The wall settle's wait clock (spec bro-36bhc) — pure decision, exported
 *  for unit tests. A rate_limited death carrying a parseable resetAt waits
 *  until that reset; a stale reset (provider clock behind the poll) paces
 *  the wait on an escalating floor (30s doubling to a 15m cap) so a lying
 *  provider cannot spin the loop back into the burn. Anything else (quota,
 *  auth, reset-less rate limit, non-rate causes, unparseable reset) is not
 *  a wait — it parks. */
export async function runLoopCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) {
    usage(0);
  }
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim();
  if (!root) {
    console.error('bro loop: not inside a git worktree');
    process.exit(1);
  }
  const broCfg = loadBroConfig(root);
  const loopCfg = broCfg.loop as LoopConfig;
  if (argv[0] === 'install' || argv[0] === 'uninstall') {
    // install validates the configured tasks backend — a github-tasks
    // rig has no beads to check; previews (--print/--dry-run) stay pure
    if (argv[0] === 'install' && !argv.includes('--print') && !argv.includes('--dry-run')) {
      ensureTasksBackend(root, broCfg.connectors);
    }
    runLoopSched(argv, root, loopCfg);
    return;
  }
  rejectStrayArgs(argv);
  const everySec = everySecArg(argv);
  const backend = ensureTasksBackend(root, broCfg.connectors);
  const cfg = broCfg.loop as LoopConfig;
  const run = await resolveRunLane(root, argv, cfg);
  const ctx = buildCtx(root, argv, broCfg, cfg, run, backend);
  const leaseStore = localLeaseStore(projectId(root));
  ctx.leaseStore = leaseStore;
  // the explain slices ride the run — the spawn path prints them when the
  // operator asked for the routing story
  ctx.explain = explainSlicesOrExit(argv);
  if (argv.includes('--dry-run')) {
    await dryRunPlan(ctx);
    return;
  }
  // One loop supervisor per repo: a respawn wrapper's duplicate stands
  // by behind the incumbent's hold and resumes once it exits — the
  // same single-instance contract `bro drive` takes (spec bro-2duu9).
  const abort = new AbortController();
  let roleLease: { release: () => void } | undefined;
  let releaseSupervisor = () => {};
  const releaseAll = (): void => {
    releaseSupervisor();
    roleLease?.release();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    abort.abort();
    releaseAll();
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    process.kill(process.pid, signal);
  };
  const onInt = (): void => onSignal('SIGINT');
  const onTerm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    roleLease = await holdRoleLease(
      leaseStore,
      'loop',
      { host: hostname(), pid: process.pid, rig: basename(root) },
      (ctx.env.fleet?.leases?.roleTtlSeconds ?? 60) * 1000,
      { signal: abort.signal, onLost: () => releaseSupervisor() }
    );
    const loopLock = loopLockPath(root);
    if (loopLock !== null) {
      releaseSupervisor = await awaitFileLock(loopLock, {
        label: 'loop supervisor lock',
        onStandby: pid => {
          const by = pid === null ? '' : ` by pid ${pid}`;
          say(ctx, `loop: already supervised${by} — standing by`);
        },
      });
    }
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    // the outcome outbox reconciles at startup (spec bro-0ykhg.4) —
    // intents a crashed run left undelivered retry here, and the
    // retention sweep rides the same pass. Best-effort: a store that
    // cannot answer costs the retry, never the loop.
    try {
      await reconcileOutcomes(root);
    } catch {
      /* reconciliation is housekeeping */
    }
    if (everySec === undefined) {
      await guardedRun(ctx, releaseAll);
    } else {
      // supervised passes are strictly sequential — a pass drains the
      // queue, then the supervisor sleeps until the next re-scan; the
      // awaits must stay inside the loop, not fan out
      for (;;) {
        ctx.tails.length = 0; // pass N+1's audit must not re-report pass N's cleanup errors
        await guardedRun(ctx, releaseAll); // NOSONAR — sequential supervised passes
        await sleep(everySec * 1000); // NOSONAR — the cadence sleep between passes
      }
    }
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    releaseSupervisor();
    roleLease?.release();
  }
}

/** Strict flag parse — an unquoted `--agent devin -p --prompt-file
 *  {promptFile}` reads as agent='devin' plus a tail of unknown flags,
 *  silently spawning a bare `devin <file>` TUI per bead instead of a
 *  headless worker. */
function rejectStrayArgs(argv: string[]): void {
  const stray = positionals(argv, LOOP_VALUE_FLAGS, {
    boolFlags: LOOP_BOOL_FLAGS,
    strict: true,
  });
  if (stray.length > 0) {
    console.error(
      `bro loop: unexpected argument '${stray[0]}' — quote the agent template ` +
        "as one arg: --agent 'devin -p --prompt-file {promptFile}'"
    );
    process.exit(2);
  }
}

/** The lane picks resolve once, up front — a bad provider name (or a
 *  broken fleet.routing table) is a config error that must fail BEFORE
 *  a bead is claimed, not mid-run with claims held. Returns the flag
 *  sel, the fixed lane (the whole lane when routing is off or a flag
 *  pins it; `resolveBeadLane` re-resolves per bead otherwise), the
 *  effective template (a cli provider's `command` substitutes for
 *  `loop.agent`; a template --agent stays the literal value — provider
 *  names are never templates, resolveLoopLane consumed them), and
 *  whether per-bead fleet.routing is armed. */
async function resolveRunLane(
  root: string,
  argv: string[],
  cfg: LoopConfig
): Promise<{
  env: AgentConnectorEnv;
  sel: LoopLaneSel;
  lane: LoopLane;
  agent: string;
  routing: boolean;
  flagPin: boolean;
}> {
  const env = loadAgentEnv(root);
  const sel = loopLaneSel(argv);
  return { env, sel, ...(await resolveRunLaneInner(env, sel, cfg)) };
}

function loopLaneSel(argv: string[]): LoopLaneSel {
  return {
    agent: flag(argv, '--agent'),
    provider: flag(argv, '--provider'),
    profile: flag(argv, '--profile'),
    model: flag(argv, '--model'),
    autoApprove: argv.includes('--auto-approve') ? true : undefined,
    class: flag(argv, '--class'),
  };
}

/** The flag TIER's provider pick — with routing armed, lane.provider
 *  also carries the fallback class's chain head (the floor), so
 *  "is the provider pinned?" must be read from the picks themselves. */
function flagTierPin(env: AgentConnectorEnv, sel: LoopLaneSel): boolean {
  return (
    sel.provider !== undefined ||
    (sel.agent !== undefined && Object.hasOwn(env.providers ?? {}, sel.agent)) ||
    (sel.profile !== undefined && fleetProfileOf(env, sel.profile).provider !== undefined)
  );
}

/** The template the run expands — a cli provider's `command`
 *  substitutes for `loop.agent`; a template --agent stays the literal
 *  value (provider names are never templates, resolveLoopLane consumed
 *  them); else the config default. */
function effectiveAgent(
  lane: LoopLane,
  sel: LoopLaneSel,
  env: AgentConnectorEnv,
  cfg: LoopConfig
): string {
  if (lane.worker?.kind === 'template') {
    return lane.worker.command;
  }
  const agentFlag = sel.agent;
  if (agentFlag !== undefined && !Object.hasOwn(env.providers ?? {}, agentFlag)) {
    return agentFlag;
  }
  return cfg.agent;
}

async function resolveRunLaneInner(
  env: AgentConnectorEnv,
  sel: LoopLaneSel,
  cfg: LoopConfig
): Promise<{ lane: LoopLane; agent: string; routing: boolean; flagPin: boolean }> {
  // a template --agent bypasses the registry entirely — routing can
  // only arm when the provider lane is in play (templateEscape already
  // warned about the bypass)
  const templateAgent = sel.agent !== undefined && !Object.hasOwn(env.providers ?? {}, sel.agent);
  const routing =
    !templateAgent && env.fleet?.routing !== undefined && Object.keys(env.fleet.routing).length > 0;
  let lane: LoopLane;
  try {
    // preflight the class every bead falls back to — a table whose
    // `default` (or the --class pin) doesn't resolve is a global
    // config error, detected before the first claim. The route feeds
    // the lane preflight too: under routing its chain head is the
    // effective provider floor, so a dead lower-tier pick
    // (loop.provider/loop.profile) can't abort a run every bead routes
    // around. Per-bead `class:` labels still resolve per spawn inside
    // pushItem.
    const preflight = routing
      ? routeStepClass(env.fleet, env.providers ?? {}, undefined, '', sel.class, {})
      : undefined;
    lane = await resolveLoopLane(env, sel, cfg, preflight);
  } catch (err) {
    if (err instanceof SpawnError) {
      console.error(`bro loop: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const flagPin = flagTierPin(env, sel);
  const agent = effectiveAgent(lane, sel, env, cfg);
  if (lane.worker === undefined && agent === '' && !routing) {
    // an armed enforce matrix judges every bead per spawn, but its
    // judge-outage contract fails open to the static lane — with no
    // lane source at all the first judge-down would spawn on an empty
    // template, so preflight refuses the config instead of letting a
    // matrix-only run discover it mid-queue (spec bro-v0pvd.1.1)
    const matrix = env.fleet?.matrix;
    const enforceNeedsFallback =
      matrix !== undefined &&
      matrix.provider !== undefined &&
      matrix.mode === 'enforce' &&
      Object.keys(matrix.models).length > 0;
    console.error(
      enforceNeedsFallback
        ? 'bro loop: fleet.matrix enforce has no fallback lane — a judge outage ' +
            'fails open to the static lane, so configure one alongside the ' +
            'matrix (loop.provider/loop.profile/loop.agent, ' +
            'agents.<backend>.provider, or fleet.routing)'
        : 'bro loop: no agent configured — set loop.agent or loop.provider in bro.config ' +
            '(e.g. "devin --prompt-file {promptFile} -p") or pass --agent/--provider'
    );
    process.exit(2);
  }
  // {promptFile} isn't strictly required — an agent may read
  // BRO_PROMPT_FILE from env instead — but a TUI-capable CLI spawned
  // without it opens an interactive session per bead (the file path
  // lands positionally = the prompt). Warn loudly, don't refuse. An
  // argv worker takes the file as a positional arg by contract — the
  // check would only misfire on it. With fleet.routing armed and no
  // flag-tier pin the base template is inert — each bead's routed lane
  // carries its own command (lane.worker already holds the fallback
  // class's floor, so the pin test is the picks, not the lane).
  if (!(routing && !flagPin) && lane.worker?.kind !== 'argv' && !agent.includes('{promptFile}')) {
    // binary name only — the template may carry inline credentials
    const agentBin = agent.split(/\s+/, 1)[0];
    console.error(
      `bro loop: agent template has no {promptFile} — "${agentBin}". ` +
        'The prompt file appends as a positional arg; interactive CLIs ' +
        '(devin, claude) treat that as a TUI session, not a worker prompt. ' +
        'Intended for env-reading agents (BRO_PROMPT_FILE) only.'
    );
  }
  return { lane, agent, routing, flagPin };
}

function buildCtx(
  root: string,
  argv: string[],
  broCfg: ReturnType<typeof loadBroConfig>,
  cfg: LoopConfig,
  run: {
    env: AgentConnectorEnv;
    sel: LoopLaneSel;
    lane: LoopLane;
    agent: string;
    routing: boolean;
    flagPin: boolean;
  },
  backend: string
): Ctx {
  const { env, sel, lane, agent, routing, flagPin } = run;
  const rev = reviewHost(root, broCfg.connectors);
  // the shared poll floor, not 1: a fractional interval is the e2e's
  // clock — the run polls fast without anyone faking the wall clock
  const intervalS = num(
    flag(argv, '--interval'),
    60,
    MIN_INTERVAL_SEC,
    Math.floor(TIMER_MAX_MS / 1000)
  );
  // hoisted so the ctx fields and the policy's deps surface share the
  // one instance — the FSM reads deps.tasks, the adapter reads
  // ctx.tasks, and they must be the same facade (spec bro-u6fp5.1)
  const tasks = facade('tasks', { dir: root }, { prefer: broCfg.connectors });
  const stateCache = prStateCache(root, {
    ttlMs: Math.min(ACT_STATE_TTL_MS, intervalS * 1000),
  });
  // BEADS_DIR pinning is a beads tail — a non-beads store has no bd
  // to pin and no db that could fork inside the worktree
  const beadsDir = backend === 'beads' ? resolveBeadsDir(root, m => console.error(m)) : undefined;
  const mirror = mirrorStore(root, broCfg, backend);
  const specHas = specProbe(root, broCfg);
  const ctx: Ctx = {
    rev,
    tasks,
    backend,
    repo: rev.resolveRepo([]),
    root,
    cfg: {
      ...cfg,
      mergeTimeoutMin: num(flag(argv, '--merge-timeout'), cfg.mergeTimeoutMin),
      parkedWakeMin: num(flag(argv, '--parked-wake'), cfg.parkedWakeMin, 0),
      maxItems: num(flag(argv, '--max'), cfg.maxItems, 0),
      maxOpen: num(flag(argv, '--max-open'), cfg.maxOpen, 1),
      maxOpenTotal: num(flag(argv, '--max-open-total'), cfg.maxOpenTotal, 0),
      worktreeWarn: num(flag(argv, '--worktree-warn'), cfg.worktreeWarn, 0),
      diskMinSlots: num(flag(argv, '--disk-min-slots'), cfg.diskMinSlots, 0),
      batch: num(flag(argv, '--batch'), cfg.batch, 1),
      batchMinPriority: flag(argv, '--batch-min-priority')
        ? Number(flag(argv, '--batch-min-priority'))
        : cfg.batchMinPriority,
    },
    act: broCfg.act,
    // the feed dedup's freshness contract is "at most one poll window
    // stale" — under a fast tick a full ACT_STATE_TTL_MS window serves
    // a gate's pending snapshot for 30s of polls. Cap it at the run's
    // own cadence; the default interval keeps the production 30s.
    stateCache,
    agent,
    lane,
    env,
    sel,
    routing,
    intervalS,
    json: argv.includes('--json'),
    selection: {
      filters: labelSelection(argv),
      gates: 'forbid' as const,
      order: 'priority' as const,
    },
    beadsDir,
    stack: stackNameFlag(argv),
    tails: [],
    stage: 'startup',
    // the projection target rides the REVIEW host's tasks — a named
    // pick, so github's optInFacades doesn't apply (the operator asked
    // for this connector's reviews already). A rig whose tasks backend
    // IS the review host has nothing to project.
    mirror,
    mirrorPolicy: broCfg.mirror,
    specHas,
    q: freshLoopQueue(),
    // the policy's IO surface attaches next — its closures read the
    // finished ctx (say's json route, the stack name, the queue)
    deps: {} as LoopDeps,
  };
  ctx.deps = loopDeps(ctx);
  // the registry spawn engages when there's a shared store to pin the
  // claim/exit record against — without one the legacy awaited spawn
  // keeps the serial semantics (spec bro-zpa93). A connector that
  // can't even resolve degrades to that same fallback, not a dead loop.
  if (ctx.beadsDir !== undefined) {
    try {
      ctx.agents = resolveAgentConnector({ dir: root }, {}, loadAgentEnv(root));
      ctx.deps.agents = ctx.agents;
    } catch (err) {
      console.error(
        `loop: agent connector failed to resolve — ${err instanceof Error ? err.message : String(err)} — falling back to the awaited spawn`
      );
    }
  }
  sayLaneNotes(ctx, flagPin);
  // the claim-authority advisory: outside the registry path the loop
  // claims through the tasks facade, whose claim() may be best-effort
  // assignment rather than a lease. The registry path claims on the
  // pinned beads store (exclusive) and needs no note; an
  // exclusive-claiming facade needs none either.
  if (ctx.agents === undefined) {
    const note = claimAuthorityNote(ctx.backend, declaredClaimCapability(ctx.tasks));
    if (note !== undefined) {
      say(ctx, note);
    }
  }
  return ctx;
}

/** The policy's IO surface (spec bro-u6fp5.1) — every reach the loop
 *  FSM has into this command's machinery, bound once at ctx build.
 *  Object deps share the ctx's own instances; function deps wrap the
 *  command's spawn/lane/audit helpers so `packages/rig` never imports
 *  back here. Closures read `ctx` lazily — by call time the literal
 *  (queue, stack name, json route) is complete. */
function loopDeps(ctx: Ctx): LoopDeps {
  const { root } = ctx;
  return {
    tasks: ctx.tasks,
    rev: ctx.rev,
    agents: ctx.agents,
    stateCache: ctx.stateCache,
    mirror: ctx.mirror,
    specHas: ctx.specHas,
    say: msg => say(ctx, msg),
    error: msg => console.error(msg),
    out: line => console.log(line),
    emitJson: row => console.log(JSON.stringify(row)),
    now: () => Date.now(),
    sleepMs: sleep,
    reapRuns: () => reapLoopRuns(root),
    beginRun: rec => beginLoopRun(root, rec),
    endRun: slug => endLoopRun(root, slug),
    runLog: slug => loopRunLog(root, slug),
    projectScope: () => loopScope(),
    claimCandidates: (seen, scope) =>
      clumpCandidates(ctx, scope as NonNullable<ReturnType<typeof nextScope>>, seen),
    claimUpTo: (beads, n) => claimUpTo(beads, n, root),
    laneFor: bead => resolveBeadLane(ctx, bead),
    matrixHold: err => err instanceof MatrixHoldError,
    spawnWorker: (m, prompt) => spawnWorker(ctx, m, prompt, m.lane),
    spawnTemplate: (lane, beadIds, title, promptFile, dir, agentId) =>
      spawnAgent(ctx, lane, beadIds, title, promptFile, dir, agentId),
    admitTemplate: (lane, spec, key) => admitLaneSessions(ctx, lane, spec, key),
    providerWall: provider => providerWallsFor(root).find(w => w.provider === provider),
    bootstrap: dir => {
      // operator-configured bootstrap; PATH lookup is the contract
      // (same as git/bd) — the policy names the worktree, this arm
      // owns the spawn
      const cmd = ctx.cfg.bootstrap;
      return /* NOSONAR */ spawnSync('sh', ['-c', cmd ?? ''], {
        cwd: dir,
        env: agentEnv(ctx, {}),
        stdio: ['inherit', ctx.json ? 2 : 'inherit', 'inherit'],
      });
    },
    mergePr: pr => runActCommand(['merge', String(pr)]),
    settleSessions: dir => settleAcpSessions(root, ctx.env, { worktree: dir }),
    reportOutcome: async (beadId, result) => {
      await reportRoutedOutcome({
        dir: root,
        beadId,
        result,
        reporter: 'bro:loop',
        sourceId: 'bro:loop',
      });
    },
    syncStackLines: () => (ctx.stack === undefined ? [] : syncStack(root, ctx.stack)),
    stackSlotFor: bead => resolveStackSlot(ctx, bead),
    stackLockPath: () => (ctx.stack === undefined ? null : stackPushLockPath(ctx.stack)),
    recordStackEdge: (branch, base) => recordStackEdge(branch, base),
    defaultBranch: () => defaultBranchName(),
    worktrees: () => {
      const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain']);
      return wt.code === 0 ? parseWorktreePorcelain(wt.out) : null;
    },
    openFleetPrs: () => listOpenFleetPrs(ctx),
    finishAudit: () => endAudit(ctx, ctx.q.seen, ctx.q.parkedClaims),
  };
}

/** A third-party store whose capability getter throws reads as
 *  undeclared — the advisory must never abort the loop. */
export function declaredClaimCapability(
  store: Pick<TaskStore, 'claimCapability'>
): ClaimCapability | undefined {
  try {
    return store.claimCapability?.();
  } catch {
    return undefined;
  }
}

/** The startup advisory for a claims plane that cannot promise a single
 *  winner (spec specs/bro-l8c4f.12). Returns undefined when the store
 *  declares exclusive claims — or when a third-party store declares
 *  'exclusive' itself (its word is taken at face value; the honesty
 *  burden is the connector's). An UNDECLARED capability still warns:
 *  absent is not a promise either way, and a competitive runner fails
 *  closed on unknowns. The note names the consequence and the remedy —
 *  it is a diagnostic, not an enforcement gate: assignment flows stay
 *  legal on best-effort stores. */
export function claimAuthorityNote(
  backend: string,
  cap: ClaimCapability | undefined
): string | undefined {
  if (cap?.strength === 'exclusive') {
    return undefined;
  }
  const shared =
    cap?.identity === 'viewer'
      ? ' — and every worker behind one credential claims as the same identity'
      : '';
  // undeclared names what is unknown rather than claiming best-effort —
  // the store may be exclusive, the loop just cannot verify it
  const promise =
    cap === undefined
      ? `loop: tasks backend '${backend}' declares no claim capability — ` +
        `exclusivity is unverified, so claim() may be an assignment, not a lease`
      : `loop: tasks backend '${backend}' offers best-effort claims only — ` +
        `claim() is an assignment, not a lease`;
  return (
    `${promise}${shared}. A second issuer ` +
    `(another loop or rig on the same tracker) can seat the same item; ` +
    `keep one loop on this backlog or run on an exclusive-claim store (beads).`
  );
}

// announce the resolved lane once — agents.native.provider picking up
// the run must not be a silent behavior change for template users.
// With routing armed the pin test is the flag TIER, not ctx.lane —
// the preflight route fills lane.provider with the fallback class's
// head, which advertises the floor, not a pin.
function sayLaneNotes(ctx: Ctx, flagPin: boolean): void {
  if (ctx.routing && !flagPin) {
    const pin = ctx.sel.class === undefined ? '' : ` (pinned: ${ctx.sel.class})`;
    say(ctx, `loop: fleet.routing — provider resolves per bead class${pin}`);
  }
  if (ctx.lane.provider === undefined || (ctx.routing && !flagPin)) {
    return;
  }
  const worker = ctx.lane.worker?.kind === 'argv' ? ' (acp worker)' : '';
  const routed = ctx.routing ? ' (pinned — fleet.routing supplies classes only)' : '';
  say(ctx, `loop: provider ${laneLabel(ctx.lane)}${worker}${routed}`);
}

// the projection target rides the REVIEW host's tasks — a named
// pick, so github's optInFacades doesn't apply (the operator asked
// for this connector's reviews already). A rig whose tasks backend
// IS the review host has nothing to project.
function mirrorStore(
  root: string,
  broCfg: ReturnType<typeof loadBroConfig>,
  backend: string
): Ctx['mirror'] {
  try {
    const name = facadeName('reviews', { dir: root }, { prefer: broCfg.connectors });
    if (name === backend) {
      return undefined;
    }
    const s = facade('tasks', { dir: root }, { connector: name });
    return s.publish === undefined ? undefined : s;
  } catch {
    return undefined;
  }
}

function specProbe(root: string, broCfg: ReturnType<typeof loadBroConfig>): Ctx['specHas'] {
  try {
    const specs = specStore(root, broCfg.connectors);
    return (id: string) => specs.hasSpec(id);
  } catch {
    return () => false;
  }
}

async function dryRunPlan(ctx: Ctx): Promise<void> {
  const scope = loopScope();
  if (!scope) {
    return;
  }
  const ready = readyBeads(ctx.root);
  const queue = classify(ready, ctx.selection, scope, epicParentIds(ready, ctx.root)).queue;
  const top = queue[0];
  if (!top) {
    console.log('loop --dry-run: nothing claimable');
    return;
  }
  // dry-run renders the clump the claim would pick — no claims made;
  // --max bounds it exactly as tryClaim's budget does
  const clump =
    ctx.cfg.batch > 1
      ? [
          top,
          ...clumpMembers(top, queue.slice(1), {
            size: ctx.cfg.maxItems > 0 ? Math.min(ctx.cfg.batch, ctx.cfg.maxItems) : ctx.cfg.batch,
            minPriority: ctx.cfg.batchMinPriority,
          }),
        ]
      : [top];
  console.log(`would claim ${clump.map(b => b.id).join(', ')} — ${top.title}`);
  for (const b of clump.slice(1)) {
    console.log(`  + ${b.id} — ${b.title}`);
  }
  if (clump.length > 1) {
    console.log(`  batch: ${clump.length} beads, one worktree, one PR`);
  }
  const { slot, item } = stackPlan(ctx, top);
  console.log(`  worktree ${item.worktreeDir} on ${item.branch}`);
  dryRunDisk(ctx);
  if (slot !== undefined) {
    console.log(`  stack ${ctx.stack} member ${slot.n} — PR base ${slot.base}`);
  }
  const lane = await dryRunLane(ctx, top);
  if (lane === undefined) {
    return;
  }
  if (lane.class !== undefined) {
    console.log(`  class: ${lane.class}`);
  }
  if (lane.provider !== undefined) {
    console.log(`  provider: ${laneLabel(lane)}`);
  }
  const w = lane.worker;
  const argvLine =
    w?.kind === 'argv'
      ? [...w.argv, item.promptFile].map(shRender).join(' ')
      : expandAgentCmd(laneCommand(ctx, lane));
  console.log(`  agent: ${argvLine}`);
}

// the same floor tryClaim enforces — a dry run is exactly where an
// operator sizes maxOpen against real headroom
function dryRunDisk(ctx: Ctx): void {
  const probes = diskProbes(ctx);
  const breach = diskFloorBreach(probes, ctx.cfg);
  for (const p of probes) {
    console.log(`  disk: ${Math.floor(p.freeBytes / MB)}M free on ${p.path}`);
  }
  if (breach !== undefined) {
    console.log(
      `  disk: HOLD — below floor ${Math.floor(diskFloorBytes(ctx.cfg) / MB)}M ` +
        `(${ctx.cfg.diskMinSlots}×${ctx.cfg.worktreeMb}M)`
    );
  }
}

// the render resolves THIS bead's lane — with fleet.routing armed the
// provider differs per bead; a broken route reports the same error a
// claimed run would park on. The judge router is skipped: a dry run
// spends no judge call and journals no shadow verdict — it reports
// the armed router instead.
async function dryRunLane(ctx: Ctx, top: ReadyBead): Promise<LoopLane | undefined> {
  if (!ctx.routing) {
    return ctx.lane;
  }
  let lane: LoopLane;
  try {
    lane = await resolveBeadLane(ctx, top, { router: false });
  } catch (err) {
    console.log(`  route: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const router = ctx.env.fleet?.router;
  if (
    router !== undefined &&
    router.mode !== 'off' &&
    ctx.sel.class === undefined &&
    ctx.beadsDir !== undefined &&
    classLabelOf(top) === undefined
  ) {
    console.log(`  router: ${router.provider} armed (${router.mode}) — a real run may re-class`);
  }
  return lane;
}

/** Project scope for the queue — a failed prefix lookup is reported
 *  once, not thrown into the claim loop. */
function loopScope(): ReturnType<typeof nextScope> | null {
  try {
    return nextScope('project'); // prefix is stable for the run
  } catch (err) {
    console.error(`loop: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Open PRs on local loop/* branches — exact per-branch lookup, so the
 *  audit is bounded by the repo's own tail set, not a global PR cap. */
function openLoopPrs(ctx: Ctx, branches: string[]): string[] {
  const out: string[] = [];
  for (const b of branches) {
    try {
      for (const pr of ctx.rev.prsForBranch(b)) {
        out.push(`${prRef(ctx, pr)} (${b})`);
      }
    } catch {
      out.push(`warning: PR lookup failed for ${b} — host unreachable`);
    }
  }
  return out;
}

interface RefTails {
  worktrees: string[];
  /** branch names riding a loop/* worktree — disjoint from `branches`,
   *  needed so the open-PR audit sees PRs on worktree'd branches too */
  worktreeBranches: string[];
  branches: string[];
  errors: string[];
}

/** Every linked worktree this clone holds — the spec's `worktreeWarn`
 *  mark counts checkouts, and disk/coordination pressure doesn't care
 *  which branch a checkout sits on. The main worktree heads `worktree
 *  list`, so linked = rows − 1. undefined when the listing fails —
 *  an unreadable count warns nothing. */
function linkedWorktreeCount(root: string): number | undefined {
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain']);
  if (wt.code !== 0) {
    return undefined;
  }
  return Math.max(0, parseWorktreePorcelain(wt.out).length - 1);
}

/** loop/* worktrees still checked out + loop/* branches with no
 *  worktree — both are run tails; a `--stack` run owns its `stack/<name>/*`
 *  branches the same way. A failed git probe reports as an error line,
 *  never as a false "clean". */
export function loopRefTails(root: string, prefixes: string[] = ['loop/']): RefTails {
  const errors: string[] = [];
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain']);
  if (wt.code !== 0) {
    errors.push(`worktree list failed — ${wt.err || 'git error'}`);
  }
  const trees = parseWorktreePorcelain(wt.out).filter(w =>
    prefixes.some(p => w.branch?.startsWith(p))
  );
  const onTree = new Set(trees.map(w => w.branch!));
  const bare: string[] = [];
  for (const prefix of prefixes) {
    const bl = gitTry(['-C', root, 'branch', '--list', `${prefix}*`, '--format=%(refname:short)']);
    if (bl.code !== 0) {
      errors.push(`branch list failed — ${bl.err || 'git error'}`);
      continue;
    }
    bare.push(...bl.out.split('\n').filter(b => b && !onTree.has(b)));
  }
  return {
    worktrees: trees.map(w => `${w.path} [${w.branch}]`),
    worktreeBranches: trees.map(w => w.branch!),
    branches: bare,
    errors,
  };
}

/** Beads left in_progress, split by this run's claims vs pre-existing —
 *  a shared store holds other sessions' claims too. */
function claimedTails(tasks: TaskStore, seen: Set<string>): { own: string[]; other: string[] } {
  try {
    const rows = tasks.list({ status: 'in_progress' });
    const fmt = (r: { id: string; title?: string }) =>
      `${r.id} ${(r.title ?? '').replace(/\s+/g, ' ').slice(0, 60)}`.trim();
    return {
      own: rows.filter(r => seen.has(r.id)).map(fmt),
      other: rows.filter(r => !seen.has(r.id)).map(fmt),
    };
  } catch {
    return { own: [], other: ['warning: claimed-task audit failed — store unavailable'] };
  }
}

/** Workers this run saw exit with no learn/retro evidence (spec
 *  bro-xkv42.2) — the durable `learn-miss` journal rows unioned with
 *  the registry verdict: a respawn resets the entry's learnCheck, but
 *  its journal row survives, so the audit can't lose an earlier miss.
 *  Only steps the loop itself worked are this audit's tail; a foreign
 *  lane's miss surfaces on `bro agents status` instead. */
function learnMissTails(root: string, seen: ReadonlySet<string>): string[] {
  const tails = new Map<string, string>();
  const add = (key: string, line: string): void => {
    if (!tails.has(key)) {
      tails.set(key, line);
    }
  };
  try {
    for (const ev of readLifecycle(root, { kind: 'learn-miss' })) {
      if (ev.bead === undefined || !seen.has(ev.bead)) {
        continue;
      }
      const agent = typeof ev.detail?.agent === 'string' ? ev.detail.agent : ev.actor;
      const cause = typeof ev.detail?.cause === 'string' ? ev.detail.cause : undefined;
      const suffix = cause === undefined ? '' : ` (${cause})`;
      add(`${agent}|${ev.bead}`, `${agent} ${ev.bead}${suffix}`);
    }
  } catch {
    // journal unreadable — the registry scan below still reports
  }
  try {
    for (const [step, e] of Object.entries(readAgentRegistry(root))) {
      if (!seen.has(step) || e.learnCheck !== 'miss') {
        continue;
      }
      const cause = e.cause === undefined ? '' : ` (${e.cause})`;
      add(`${e.agentId}|${step}`, `${e.agentId} ${step}${cause}`);
    }
  } catch {
    if (tails.size === 0) {
      return ['warning: learn-miss audit failed — registry unreadable'];
    }
  }
  return [...tails.values()];
}

/** The close-out litter sweep — reap the provably-done leftovers before
 *  the audit names what survived. A sweep failure is a warning line,
 *  never a crash. `sessionClaims` is the prefetched claims leg — the
 *  same union `work prune --loop` threads (bro-izpyk.10); undefined
 *  runs the keep-planes marker-only. */
function sweepLoopLitter(
  ctx: Ctx,
  parkedClaims: ReadonlySet<string>,
  sessionClaims?: ClaimRow[]
): LitterReap | undefined {
  try {
    return reapLoopLitter({
      root: ctx.root,
      tasks: ctx.tasks,
      rev: { repo: ctx.repo, facade: ctx.rev },
      stackPrefix: ctx.stack === undefined ? undefined : `stack/${ctx.stack}/`,
      parkedKeep: ctx.cfg.parkedKeep,
      parkedTtlDays: ctx.cfg.parkedTtlDays,
      keepClaims: parkedClaims,
      sessionClaims,
    });
  } catch (err) {
    say(
      ctx,
      `  warning: litter sweep failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/** The audit's printed report: what the sweep reaped, then every tail
 *  that survived it — 'clean' only when no section has anything left. */
function sayLoopAudit(
  ctx: Ctx,
  reap: LitterReap | undefined,
  sections: [string, string[]][]
): void {
  say(ctx, 'loop audit:');
  for (const r of reap?.released ?? []) {
    say(ctx, `  released claim: ${r}`);
  }
  for (const g of reap?.repaired ?? []) {
    say(ctx, `  re-registered: ${g}`);
  }
  for (const k of reap?.killed ?? []) {
    say(ctx, `  killed: ${k}`);
  }
  for (const r of reap?.reaped ?? []) {
    say(ctx, `  reaped: ${r}`);
  }
  for (const b of reap?.branches ?? []) {
    say(ctx, `  deleted branch: ${b}`);
  }
  for (const e of reap?.errors ?? []) {
    say(ctx, `  reap error: ${e}`);
  }
  if (sections.every(([, items]) => items.length === 0)) {
    say(ctx, '  clean — no loop tails');
    return;
  }
  for (const [label, items] of sections) {
    for (const item of items) {
      say(ctx, `  ${label}: ${item}`);
    }
  }
}

/** The audit's exit-path `bro sync` — fail-open by contract. Sync code
 *  throws its failures (the CLI keeps the same verdict via main's
 *  catch), but a stray process.exit anywhere in the subtree must still
 *  degrade to a warning: an exit here kills the runner mid-write and
 *  drops the audit lines still buffered on stdout (bro-qjbwq). */
export function syncAfterAudit(
  ctx: { json: boolean },
  sync: () => void = () => runSyncCommand([])
): void {
  const realExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`bro sync called process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  try {
    sync();
  } catch (err) {
    say(
      ctx,
      `  warning: bro sync failed — ${err instanceof Error ? err.message : String(err)} ` +
        `— infra; the next run's audit retries`
    );
  } finally {
    process.exit = realExit;
  }
}

/** End-of-run sweep: first reap the provably-done litter (closed-bead or
 *  merged-PR worktrees that are still clean, plus their bare branches —
 *  `bro work prune --loop` runs the same sweep by hand), then name every
 *  tail that survived in the run summary — open loop PRs, kept
 *  worktrees/branches, claimed beads, and cleanup failures collected
 *  during the run. Finished with `bro sync` so artifacts and bead state
 *  travel. Never throws — an audit failure is reported, not raised.
 *  Async for the sweep's claims prefetch (bro-izpyk.10); callers await. */
async function endAudit(
  ctx: Ctx,
  seen: Set<string>,
  parkedClaims: ReadonlySet<string>
): Promise<void> {
  ctx.stage = 'audit';
  // the sweep's git helpers and runSyncCommand narrate via console.log —
  // under --json that corrupts the event stream, so route the whole
  // audit's helper output to stderr (say() already routes its own lines)
  const log = console.log;
  if (ctx.json) {
    console.log = console.error;
  }
  try {
    // the claims leg `work prune --loop` threads — the closeout runs
    // the same sweep in-process, so it prefetches the same union leg;
    // a failed read runs marker-only (litterClaims swallows its own)
    const sessionClaims = await litterClaims(ctx.root);
    // reap before the report — a landed bead's leftover tree is not a
    // tail; the audit describes what survived the sweep
    const reap = sweepLoopLitter(ctx, parkedClaims, sessionClaims);
    const { worktrees, worktreeBranches, branches, errors } = loopRefTails(
      ctx.root,
      ctx.stack === undefined ? ['loop/'] : ['loop/', `stack/${ctx.stack}/`]
    );
    const linked = linkedWorktreeCount(ctx.root);
    if (ctx.cfg.worktreeWarn > 0 && linked !== undefined && linked > ctx.cfg.worktreeWarn) {
      say(
        ctx,
        `loop: linked worktrees ${linked} > ${ctx.cfg.worktreeWarn} (disk/coordination pressure)`
      );
    }
    const claimed = claimedTails(ctx.tasks, seen);
    sayLoopAudit(ctx, reap, [
      // PRs live on branches — worktree'd ones (a parked bead keeps both)
      // are just as much a tail as the bare branches
      ['open PRs', openLoopPrs(ctx, [...branches, ...worktreeBranches])],
      ['worktrees', worktrees],
      ['branches', branches],
      ['claimed beads', claimed.own],
      ['in_progress elsewhere', claimed.other],
      ['learn misses', learnMissTails(ctx.root, seen)],
      ['audit errors', errors],
      ['cleanup errors', ctx.tails],
    ]);
    syncAfterAudit(ctx);
  } catch (err) {
    say(ctx, `  warning: audit failed — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    console.log = log;
  }
}

/** The read side of a pick — classified, ordered, still-unseen
 *  candidates plus the foreign count a dry pick reports. */
function clumpCandidates(
  ctx: Ctx,
  scope: NonNullable<ReturnType<typeof nextScope>>,
  seen: Set<string>
): { candidates: ReadyBead[]; foreign: number } {
  const ready = readyBeads(ctx.root);
  const c = classify(ready, ctx.selection, scope, epicParentIds(ready, ctx.root));
  const candidates = c.queue.filter(b => !seen.has(b.id));
  return {
    candidates:
      ctx.leaseStore === undefined
        ? candidates
        : skipLeasedBeads(
            candidates,
            key => ctx.leaseStore?.read(key),
            line => say(ctx, line)
          ),
    foreign: c.foreign,
  };
}

export function skipLeasedBeads<T extends { id: string }>(
  candidates: T[],
  read: (key: string) => Lease | undefined,
  log: (line: string) => void = line => console.error(line),
  host = hostname(),
  pid = process.pid
): T[] {
  const picked: T[] = [];
  for (const bead of candidates) {
    const lease = read(`bead/${bead.id}`);
    if (lease === undefined) {
      picked.push(bead);
      continue;
    }
    if (lease.holder.host === host && lease.holder.pid === pid) {
      picked.push(bead);
      continue;
    }
    const holder = lease.holder;
    log(`loop: skipping ${bead.id} — leased by ${holder.rig}@${holder.host} pid ${holder.pid}`);
  }
  return picked;
}

/** Read-only drain check for the disk hold — clumpCandidates' pipeline
 *  minus the claims. A breached floor with nothing behind it must
 *  still read as a drained queue: returning before claimClump on every
 *  held tick leaves q.drained unset, and an empty store + low disk
 *  would idle the run forever instead of reporting done. An
 *  unreadable store answers not-drained — a blip never masks work. */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** The run's mutable queue state — the gate stack, the outcome tally,
 *  and the claim bookkeeping the tick helpers share. */
function listOpenFleetPrs(ctx: Ctx): FleetPrRow[] | null {
  const rows: FleetPrRow[] = [];
  try {
    if (typeof ctx.rev.openPrs === 'function') {
      const list = ctx.rev.openPrs(ctx.repo);
      for (const p of list ?? []) {
        if (p?.headRef && isFleetHead(p.headRef)) {
          rows.push({ pr: p.pr, headRef: p.headRef });
        }
      }
      return rows;
    }
  } catch {
    // PR listing failed — cannot produce complete listing
    return null;
  }
  // fallback: scan known branches - if branch discovery fails or is incomplete, treat as unknown.
  // LOCAL refs alone undercount: a pushed head whose local branch was already
  // deleted (land cleanup, another clone's push) is still a live fleet PR, so
  // remote heads join the scan — `ls-remote` answers the authoritative set.
  const prefixes = FLEET_HEAD_PREFIXES;
  try {
    const tails = loopRefTails(ctx.root, prefixes);
    if (tails.errors.length > 0) {
      return null;
    }
    const remote: string[] = [];
    for (const prefix of prefixes) {
      const ls = gitTry(['-C', ctx.root, 'ls-remote', '--heads', 'origin', `${prefix}*`]);
      if (ls.code !== 0) {
        // no origin at all is a complete answer (the fleet is local-only);
        // an unreachable remote is 'unknown'
        if (
          /does not appear to be a git repository|No such remote|not a git command/i.test(ls.err)
        ) {
          continue;
        }
        return null;
      }
      remote.push(
        ...ls.out
          .split('\n')
          .map(l => l.split('\t')[1]?.replace(/^refs\/heads\//, '') ?? '')
          .filter(Boolean)
      );
    }
    const branches = [...new Set([...tails.worktreeBranches, ...tails.branches, ...remote])];
    for (const b of branches) {
      try {
        for (const pr of ctx.rev.prsForBranch(b)) {
          if (isFleetHead(b)) {
            rows.push({ pr, headRef: b });
          }
        }
      } catch {
        // failed to check a branch - listing incomplete
        return null;
      }
    }
    return rows;
  } catch {
    return null;
  }
}

/** `push origin --delete <branch>` as a tails verdict — a remote that
 *  already dropped the ref answers "does not exist", which IS the
 *  end state we want (the host's own merge-time deleteBranch beat us
 *  to it), never a leftover. Every other failure leaves a remote
 *  branch the report should name. */
async function guardedRun(ctx: Ctx, release: () => void = () => {}): Promise<void> {
  let open = true;
  const heartbeat = setInterval(
    () => {
      console.error(`loop: alive — ${ctx.stage}${ctx.bead ? ` on ${ctx.bead}` : ''}`);
    },
    Math.max(ctx.intervalS * 1000, HEARTBEAT_MIN_MS)
  );
  const auditDeath = (why: string): void => {
    try {
      writeSync(
        2,
        `loop: process exiting mid-run — ${ctx.stage}` +
          `${ctx.bead ? ` on ${ctx.bead}` : ''} (${why})\n`
      );
    } catch {
      /* stderr may be gone — the note below still lands */
    }
    if (ctx.bead !== undefined) {
      noteBead(ctx, ctx.bead, `loop: process exited mid-run — ${ctx.stage} (${why})`);
    }
  };
  const onExit = (code: number): void => {
    if (open) {
      auditDeath(`exit code ${code}`);
    }
    release();
  };
  const onSigint = (): void => {
    if (open) {
      auditDeath('signal SIGINT');
    }
    release();
    // restore the default disposition, then re-raise — the parent sees
    // a real signal death, not a clean exit code
    process.removeListener('SIGINT', onSigint);
    process.kill(process.pid, 'SIGINT');
  };
  const onSigterm = (): void => {
    if (open) {
      auditDeath('signal SIGTERM');
    }
    release();
    process.removeListener('SIGTERM', onSigterm);
    process.kill(process.pid, 'SIGTERM');
  };
  process.on('exit', onExit);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    await runLoop(ctx);
  } finally {
    open = false;
    clearInterval(heartbeat);
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
