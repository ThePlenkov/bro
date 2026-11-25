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
  type AgentRegistryEntry,
  admitSessionSlot,
  awaitFileLock,
  BATCH_MARKER_ENV,
  type BrouterModels,
  CLASS_LABEL_PREFIX,
  type ClaimCapability,
  commandCliName,
  type ExplainSlice,
  ensureTasksBackend,
  explainSlicesOrExit,
  facade,
  facadeName,
  gitTry,
  ghTry,
  hasHelpFlag,
  holdRoleLease,
  laneBudgetKey,
  laneBudgetRefund,
  type Lease,
  type LeaseStore,
  localLeaseStore,
  type MirrorPolicy,
  mkdirPrivateSync,
  openPrivateAppendSync,
  procStat,
  projectId,
  readAgentRegistry,
  readLifecycle,
  type ResolvedClass,
  type ReviewFacade,
  releaseSessionSlot,
  releaseSessionStart,
  reviewHost,
  routeStepClass,
  SpawnError,
  type SpawnWorker,
  sessionCapViews,
  specStore,
  stepClassInfo,
  stepParent,
  type TaskStore,
} from '@broject/core';
import {
  clumpMembers,
  diskFloorBreach,
  diskFloorBytes,
  diskFloorFor,
  expandAgentCmd,
  type LoopConfig,
  loopSlug,
  MB,
} from '@broject/loop';
import {
  type AgentConnectorEnv,
  admitProviderGateStarts,
  admitSpawnedCommandStarts,
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
  type ProviderGate,
  providerGateOf,
  providerGatePayload,
  providerGateQuotaStarts,
  providersForSpawnedCommand,
  providerWallsFor,
  resolveAgentConnector,
  resolveSpawnProvider,
  resolveSpawnRoute,
  type SessionQuotaLane,
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
import { listOpenFleetPrs, loopRefTails } from './fleet-prs.ts';
import {
  claimedTails,
  openLoopPrs,
  sayLoopAudit,
  sweepLoopLitter,
  syncAfterAudit,
} from './loop-audit.ts';
import {
  effectiveAgent,
  flagTierPin,
  labelSelection,
  type LoopLaneSel,
  loopLaneSel,
  rejectStrayArgs,
  stackNameFlag,
  usage,
} from './loop-args.ts';
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
import { isOrchestratorSession } from './watch-pulse.ts';
import {
  defaultBranchName,
  litterClaims,
  parseWorktreePorcelain,
  readStackEdges,
  recordStackEdge,
  stackPushLockPath,
} from './work.ts';

// loop.test.ts pins loopRefTails + syncAfterAudit on this module's
// surface — the implementations live in fleet-prs.ts / loop-audit.ts
// now; LoopLaneSel moved with the argv layer to loop-args.ts
export { loopRefTails, syncAfterAudit };
export type { LoopLaneSel };

export interface Ctx {
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

export const num = (v: string | undefined, dflt: number, min = 1, max?: number): number => {
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
export const TIMER_MAX_MS = 2 ** 31 - 1;

/** Progress lines — stderr under --json so stdout stays a clean
 *  event stream. */
export const say = (ctx: Pick<Ctx, 'json'>, msg: string): void => {
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
export function agentEnv(
  ctx: Pick<Ctx, 'beadsDir'>,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
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
export const laneCommand = (ctx: Pick<Ctx, 'agent'>, lane: LoopLane): string =>
  lane.worker?.kind === 'template' ? lane.worker.command : ctx.agent;

/** Commit-provenance pins for the loop's agent (bro-fzot) — the cli the
 *  effective command names (the acp worker's `cliName` on the argv lane),
 *  the provider/model lane labels, and the bead's molecule parent when
 *  the shared store can answer. */
export function provenancePins(ctx: Ctx, beadId: string, lane: LoopLane): Record<string, string> {
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

import {
  classLabelOf,
  resolveBeadLane,
  resolveLoopLane,
  resumeSessionFor,
} from './loop-routing.ts';
export { resolveLoopLane, resumeSessionFor };
/** Dry-run rendering for an argv worker — single-quotes only the args
 *  that need it, so the printed line stays readable. */
const shRender = (s: string): string =>
  /[\s'"\\]/.test(s) ? `'${s.replaceAll("'", String.raw`'\''`)}'` : s;

import { processGroupLive, spawnAgent } from './loop-spawn.ts';
export { processGroupLive, spawnAgent };
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

/** The shared admission facts the three claim passes inside
 *  admitLaneSessions read — derived once so no pass re-resolves them. */
interface LaneAdmit {
  dir: string;
  registry: Record<string, AgentRegistryEntry>;
  env: AgentConnectorEnv;
  liveByKind: Map<string, Set<string>>;
  workerEnv: Record<string, string>;
  molStep: string;
  key: string;
  scope: string;
  spawnedCmd: string;
  startsCommand: string | undefined;
  quotaPlaneKind: string | undefined;
  budgetCharged: (kind: string) => void;
  out: string[];
}

/** The provider lanes a raw-template spawn owes, resolved + pre-flighted
 *  before ANY claim lands — a full account lane refuses before a kind
 *  claim can hold a slot against it. The lane's provider is its own
 *  pick PLUS every OTHER armed provider entry the spawned command
 *  launches — a named `combo` template opening sessions on a second
 *  account lane still owes that lane's cap (the explicit pick heads
 *  the list for alias resolution; discovery adds the rest). With no
 *  named provider the spawned command's launches alone decide — never
 *  the agents.native.provider default a template escape bypassed. */
function laneProviderGates(a: LaneAdmit, pick: string | undefined): ProviderGate[] {
  const providers =
    pick !== undefined
      ? [pick, ...providersForSpawnedCommand(a.env, a.spawnedCmd).filter(p => p !== pick)]
      : providersForSpawnedCommand(a.env, a.spawnedCmd);
  return providers
    .map(provider =>
      providerGateOf({
        dir: a.dir,
        registry: a.registry,
        env: a.env,
        provider,
        agents: a.env.agents,
        workerEnv: a.workerEnv,
        quotaPlaneKind: a.quotaPlaneKind,
        startsCommand: a.startsCommand,
      })
    )
    .filter((gate): gate is ProviderGate => gate !== undefined);
}

/** One start count map folded into another — the union over every
 *  gate (a start claims once, so the counts never overlap). */
function mergeStartCounts(into: Map<string, number>, starts: ReadonlyMap<string, number>): void {
  for (const [kind, n] of starts) {
    into.set(kind, (into.get(kind) ?? 0) + n);
  }
}

/** Starts the provider-cap passes claimed per kind — the union over
 *  every gate; the cross-kind pass subtracts them or one session reads
 *  as two. The map also feeds each pass: overlapping provider entries
 *  (one's command a prefix of another's) share the same planes, and a
 *  start an earlier gate claimed is re-JUDGED under this lane's cap
 *  but never claimed again. */
function claimProviderGateStarts(
  a: LaneAdmit,
  providerGates: readonly ProviderGate[]
): Map<string, number> {
  const claimedStarts = new Map<string, number>();
  for (const providerGate of providerGates) {
    mergeStartCounts(
      claimedStarts,
      admitProviderGateStarts(providerGate, {
        dir: a.dir,
        env: a.env,
        agents: a.env.agents,
        workerEnv: a.workerEnv,
        molStep: a.molStep,
        key: a.key,
        scope: a.scope,
        liveByKind: a.liveByKind,
        budgetCharged: a.budgetCharged,
        startsCommand: a.startsCommand,
        claimedStarts,
        out: a.out,
        ledgerOut: a.out,
      })
    );
  }
  return claimedStarts;
}

/** The lane's own-kind claims via its quota lane — one per session the
 *  spawned command starts on the quota kind (a multi-start command
 *  judged once but claimed once would read one session where two
 *  land, and the provider census would admit on a slot count that
 *  under-counts the lane). Each admit re-judges post-claim: the Nth
 *  claim trips the refusal exactly when headroom cannot seat N.
 *  Returns the primary reservation; later claims ride `a.out` with
 *  the cross-kind set. */
function claimQuotaStarts(
  a: LaneAdmit,
  quota: SessionQuotaLane,
  providerGates: readonly ProviderGate[]
): string | undefined {
  const quotaView = sessionCapViews(a.spawnedCmd, a.env.agents, a.workerEnv).find(
    v => v.kind === quota.plane.kind
  );
  const quotaStarts = Math.max(
    1,
    quotaView?.starts ?? quota.plane.startsSessions?.(a.spawnedCmd) ?? 1,
    // the provider passes skipped this plane — their entry-command
    // count is the quota loop's truth when the spawned command
    // reads zero there (an argv driver's hidden starts)
    ...providerGates.map(g => providerGateQuotaStarts(g, a.startsCommand))
  );
  let reservation: string | undefined;
  try {
    for (let i = 0; i < quotaStarts; i++) {
      const claimed = admitSessionSlot(quota.plane, quota.agents, {
        key: a.key,
        molStep: a.molStep,
        workerEnv: a.workerEnv,
        scope: a.scope,
        liveKeys: a.liveByKind.get(quota.plane.kind) ?? EMPTY_KEYS,
        // a provider gate whose own session plane IS this lane's —
        // its verdict rides the quota admit instead of claiming the
        // lane twice (spec bro-x601l)
        ...providerGatePayload(providerGates, quota.plane.kind),
        budgetCharged: a.budgetCharged,
      });
      if (i === 0) {
        reservation = claimed;
      } else if (claimed !== undefined) {
        a.out.push(claimed);
      }
    }
    return reservation;
  } catch (err) {
    // a later start's refusal strands the primary claim inside this
    // frame — the caller's catch frees the cross-kind claims off a.out
    // but never saw this one
    if (reservation !== undefined) {
      releaseSessionSlot(reservation);
    }
    throw err;
  }
}

/** Raw-template session admission — the same admission the registry
 *  spawn runs: the provider lane's OUTER gate first (spec bro-x601l —
 *  `fleet.providerCaps` judges the aggregate census over every plane
 *  the provider's entry command claims, shared with prepareSpawn
 *  through providerGateOf/admitProviderGateStarts so the wiring cannot
 *  drift per lane — bro-9f78j), then the cross-kind pass, then the
 *  lane's own kind via its quota lane — one claim per session the
 *  spawned command starts (a multi-start command judged once but
 *  claimed once would read one session where two land). A refusal
 *  hands back every claim already taken and refunds every work-budget
 *  segment the claims charged; a success leaves the caller holding
 *  the primary reservation + the cross-kind paths to release when the
 *  spawn's verdict lands. The plane-less provider ledger's claims ride
 *  `crossKind` too — a template worker never lands in the agent
 *  registry, so the claims are the lane's only accounting and must be
 *  held for the whole awaited run. */
export function admitLaneSessions(
  ctx: { agent: string; env: AgentConnectorEnv; beadsDir?: string; root: string },
  lane: LoopLane,
  spec: { molStep: string; prompt: string; repoRoot: string },
  key: string
): { reservation: string | undefined; crossKind: string[] } {
  const workerEnv = { ...agentEnv(ctx, { BRO_AGENT_ID: key }), [BATCH_MARKER_ENV]: '1' };
  const templateCommand = laneCommand(ctx, lane);
  const laneSpec = {
    beadsDir: ctx.beadsDir!,
    molStep: spec.molStep,
    prompt: spec.prompt,
    repoRoot: spec.repoRoot,
    env: workerEnv,
    worker: lane.worker,
    provider: lane.provider,
    model: lane.model,
    class: lane.class,
  };
  const templateQuota = sessionQuotaOf(ctx.env, 'native', laneSpec, templateCommand);
  const crossKind: string[] = [];
  // the same budget facts the registry spawn derives — a raw-template
  // lane scopes its ledger rows to this repo and prunes dead segments
  // on every admission (codeant #972): an unscoped key would bury the
  // spend under a shared '' scope where nothing can close it
  const scope = projectId(ctx.root);
  const registry = readAgentRegistry(ctx.root);
  const liveByKind = liveSessionKeysByKind(registry);
  const spawnedCmd = laneSpawnedCommand(lane, templateCommand);
  // an argv worker's spawned command is the acp DRIVER (`bro acp-worker
  // --command 'devin acp'`) — the provider executable sits behind the
  // driver's --command argument where the planes' grammar reads zero
  // starts. The sessions it opens are the provider ENTRY command's
  // own — left unset, the gate counts those (the startsCommand
  // default), the same resolution the registry spawn runs.
  const providerStartsCommand = lane.worker?.kind === 'argv' ? undefined : spawnedCmd;
  let reservation: string | undefined;
  // every work-budget segment an admit opens registers on
  // budgetChargedKinds — a LATER refusal hands them all back in the
  // catch so a spawn that never ran never meters (the prepareSpawn
  // convention, spec bro-x601l)
  const budgetChargedKinds: string[] = [];
  const budgetCharged = (kind: string): void => {
    budgetChargedKinds.push(kind);
  };
  try {
    const admit: LaneAdmit = {
      dir: ctx.root,
      registry,
      env: ctx.env,
      liveByKind,
      workerEnv,
      molStep: spec.molStep,
      key,
      scope,
      spawnedCmd,
      startsCommand: providerStartsCommand,
      quotaPlaneKind: templateQuota?.plane.kind,
      budgetCharged,
      out: crossKind,
    };
    const providerGates = laneProviderGates(admit, lane.provider);
    const providerClaimedStarts = claimProviderGateStarts(admit, providerGates);
    if (spawnedCmd !== '') {
      admitSpawnedCommandStarts({
        spawnedCommand: spawnedCmd,
        agents: ctx.env.agents,
        workerEnv,
        molStep: spec.molStep,
        agentId: key,
        scope,
        liveByKind,
        providerClaimedStarts,
        providerGates,
        quotaPlaneKind: templateQuota?.plane.kind,
        budgetCharged,
        out: crossKind,
      });
    }
    if (templateQuota !== undefined) {
      reservation = claimQuotaStarts(admit, templateQuota, providerGates);
    }
    return { reservation, crossKind };
  } catch (err) {
    // every claim this admission holds goes back — the caller never
    // saw them (the provider lane's ledger claims ride crossKind too);
    // the quota lane's own claims land per-start, so an early one can
    // be held when a later start's verdict refuses
    if (reservation !== undefined) {
      releaseSessionSlot(reservation);
    }
    releaseSessionStart(crossKind);
    // the work-budget segments the released claims opened refund too —
    // a spawn that never ran must not meter worker-minutes
    for (const kind of budgetChargedKinds) {
      try {
        laneBudgetRefund(kind, laneBudgetKey(scope, key));
      } catch {
        // best-effort — a missed refund closes on the next budget scan
      }
    }
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
  if (argv[0] === 'install' || argv[0] === 'uninstall') {
    runLoopSchedLifecycle(argv, root, broCfg);
    return;
  }
  rejectStrayArgs(argv);
  const everySec = everySecArg(argv);
  const backend = ensureTasksBackend(root, broCfg.connectors);
  const cfg = broCfg.loop as LoopConfig;
  const run = await resolveRunLane(root, argv, cfg);
  const ctx = buildCtx({ root, argv, broCfg, cfg, run, backend });
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
      await supervisedPasses(ctx, everySec, releaseAll);
    }
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    releaseSupervisor();
    roleLease?.release();
  }
}

/** `bro loop install|uninstall` ride the scheduler path — install
 *  validates the configured tasks backend first (a github-tasks rig
 *  has no beads to check; previews --print/--dry-run stay pure). */
function runLoopSchedLifecycle(
  argv: string[],
  root: string,
  broCfg: ReturnType<typeof loadBroConfig>
): void {
  if (argv[0] === 'install' && !argv.includes('--print') && !argv.includes('--dry-run')) {
    ensureTasksBackend(root, broCfg.connectors);
  }
  runLoopSched(argv, root, broCfg.loop as LoopConfig);
}

/** Supervised passes are strictly sequential — a pass drains the
 *  queue, then the supervisor sleeps until the next re-scan; the
 *  awaits must stay inside the loop, not fan out. */
async function supervisedPasses(ctx: Ctx, everySec: number, releaseAll: () => void): Promise<void> {
  for (;;) {
    ctx.tails.length = 0; // pass N+1's audit must not re-report pass N's cleanup errors
    await guardedRun(ctx, releaseAll); // NOSONAR — sequential supervised passes
    await sleep(everySec * 1000); // NOSONAR — the cadence sleep between passes
  }
}

import { buildCtx, resolveRunLane } from './loop-plan.ts';

/** The policy's IO surface (spec bro-u6fp5.1) — every reach the loop
 *  FSM has into this command's machinery, bound once at ctx build.
 *  Object deps share the ctx's own instances; function deps wrap the
 *  command's spawn/lane/audit helpers so `packages/rig` never imports
 *  back here. Closures read `ctx` lazily — by call time the literal
 *  (queue, stack name, json route) is complete. */
export function loopDeps(ctx: Ctx): LoopDeps {
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
    disableAutoMerge: pr => {
      const result = ghTry(['pr', 'merge', String(pr), '--disable-auto', '-R', ctx.repo], root);
      if (result.code !== 0) {
        console.error(`loop: --disable-auto refused for PR ${pr} (${result.err || result.out})`);
      }
    },
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
export function sayLaneNotes(ctx: Ctx, flagPin: boolean): void {
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
export function mirrorStore(
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

export function specProbe(root: string, broCfg: ReturnType<typeof loadBroConfig>): Ctx['specHas'] {
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
    const eff = diskFloorFor(ctx.cfg, breach);
    const slots = diskFloorBytes(ctx.cfg);
    console.log(
      `  disk: HOLD — below floor ${Math.floor(eff / MB)}M ` +
        `(${ctx.cfg.diskMinSlots}×${ctx.cfg.worktreeMb}M${eff === slots ? '' : ' + small-fs half'})`
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

/** First writer wins — the journal row and the registry verdict can
 *  name the same agent+bead, and the audit reports a miss once. */
function putTail(tails: Map<string, string>, key: string, line: string): void {
  if (!tails.has(key)) {
    tails.set(key, line);
  }
}

/** The durable `learn-miss` journal rows for steps this run worked —
 *  a respawn resets the registry entry's learnCheck, but its journal
 *  row survives, so the audit can't lose an earlier miss. */
function learnMissJournalTails(
  root: string,
  seen: ReadonlySet<string>,
  tails: Map<string, string>
): void {
  try {
    for (const ev of readLifecycle(root, { kind: 'learn-miss' })) {
      if (ev.bead === undefined || !seen.has(ev.bead)) {
        continue;
      }
      const agent = typeof ev.detail?.agent === 'string' ? ev.detail.agent : ev.actor;
      const cause = typeof ev.detail?.cause === 'string' ? ev.detail.cause : undefined;
      const suffix = cause === undefined ? '' : ` (${cause})`;
      putTail(tails, `${agent}|${ev.bead}`, `${agent} ${ev.bead}${suffix}`);
    }
  } catch {
    // journal unreadable — the registry scan still reports
  }
}

/** The registry's learnCheck=miss verdict for steps this run worked —
 *  false when the registry itself could not be read. */
function learnMissRegistryTails(
  root: string,
  seen: ReadonlySet<string>,
  tails: Map<string, string>
): boolean {
  try {
    for (const [step, e] of Object.entries(readAgentRegistry(root))) {
      if (!seen.has(step) || e.learnCheck !== 'miss') {
        continue;
      }
      const cause = e.cause === undefined ? '' : ` (${e.cause})`;
      putTail(tails, `${e.agentId}|${step}`, `${e.agentId} ${step}${cause}`);
    }
    return true;
  } catch {
    return false;
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
  learnMissJournalTails(root, seen, tails);
  const registryRead = learnMissRegistryTails(root, seen, tails);
  if (!registryRead && tails.size === 0) {
    return ['warning: learn-miss audit failed — registry unreadable'];
  }
  return [...tails.values()];
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
