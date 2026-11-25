/**
 * The daemon-owned fleet-status projector (spec bro-u19mq) — the ONE
 * writer of `[state·#PR]` workspace labels, the `status` metadata
 * token, and the per-worktree fleet-state file the `bro: status` pane
 * renders and self-reports (spec bro-idsat). The herdr session plugins
 * keep only spawn/attach lifecycle (`worktree open`, mirrors,
 * renderers, status panes, the reaper); they never write fleet labels —
 * this tick does, so a dead
 * session can't leave a stale `[working]` on a crashed run.
 *
 * `projectFleet` is the tick (called from driveOnce). The classification
 * and every herdr-facing write live in `@broject/herdr-kit`
 * (`fleet/classify.ts` + `fleet/projector.ts`); what stays here is the
 * bro-plane read side — act cache, loop runs, beads, proc probes, config
 * — assembled into the `Planes` the tick injects into the kit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  gitCommonDir,
  gitTry,
  type ProviderEntry,
  readAgentRegistry,
  stateCommonDir,
} from '@broject/core';
import {
  type ActEntry,
  type AgentRow,
  agentOfCommand,
  agentSilentMs,
  type HerdrWorktree,
  type ProjectResult,
  parseTs,
  providerCommand,
  runFleetPass,
  TERMINAL,
  type TreeInput,
} from '@broject/herdr-kit';
import { loopSection } from '@broject/loop';
import { loadBroConfig } from '../plugins.ts';
import { collectLoopRuns } from './loop-state.ts';
import { detailMatches, hooksDirOf, liveWorkEntries, registryEntryState } from '@broject/rig';
import { readBeads } from './status.ts';
import { parseWorktreePorcelain, worktreeClaim } from './work.ts';

// the kit's classifier + projector surface, re-exported at the cli
// path the tests and neighbors already import
export {
  type ActEntry,
  type AgentRow,
  agentOfCommand,
  type GateState,
  gateFrag,
  type HerdrPaneRow,
  labelFor,
  type ProjectResult,
  paneLed,
  pluginLedgerDirs,
  prFor,
  projectTree,
  prToken,
  type RunRow,
  silentBucketMin,
  statusPaneLive,
  statusString,
  type TreeInput,
  type TreeProjection,
  type WorkerCand,
  workerState,
  workerToken,
} from '@broject/herdr-kit';

/** `<state>/bro/act-state/*.json` — the last gate each real poller
 *  observed (the cache writes through stateCommonDir, so the read must
 *  resolve the same root or a pinned rig's rows are invisible). A label
 *  reads the freshest observation; it never pays a gh call itself. */
function actStates(ctx: Pick<PassCtx, 'state'>): ActEntry[] {
  if (ctx.state === null) return [];
  const dir = join(ctx.state, 'bro', 'act-state');
  let names: string[];
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ActEntry[] = [];
  for (const f of names) {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<ActEntry>;
      if (typeof v.fetchedAt === 'number' && typeof v.state?.pr === 'number') {
        out.push(v as ActEntry);
      }
    } catch {
      // a corrupt entry is a miss
    }
  }
  // freshest-first — a `find` anywhere downstream picks the latest
  // observation on a headRef/PR collision, not whichever file readdir
  // happened to return first
  return out.sort((a, b) => b.fetchedAt - a.fetchedAt);
}

/** Branch per worktree from `git worktree list --porcelain` — the
 *  headRef join when herdr's list row doesn't carry it. */
function gitBranches(ctx: Pick<PassCtx, 'root'>): Map<string, string> {
  const r = gitTry(['-C', ctx.root, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) return new Map();
  return new Map(parseWorktreePorcelain(r.out).map(t => [t.path, t.branch ?? ''] as const));
}

/** The stall window for silence bucketing — `loop.stallMin`, 0 when
 *  the config can't be read (no stall semantics, every live run is
 *  'working'). */
function stallMin(ctx: Pick<PassCtx, 'root'>): number {
  try {
    return loopSection(loadBroConfig(ctx.root).loop).stallMin;
  } catch {
    return 0;
  }
}

/** One projection pass's shared context — the repo root, its git
 *  common dir, the runtime-state root, and the observation instant,
 *  threaded through the internals so every helper reads the same
 *  snapshot coordinates. `common` and `state` diverge only under a
 *  BRO_STATE_DIR pin: the plugin-ledger scope hash must stay on the
 *  REAL common dir (the external herdr plugin resolves gitCommonDir
 *  and never sees the pin), while bro's own runtime-state rows —
 *  act-state, archives, fleet-status — follow the pin. */
interface PassCtx {
  root: string;
  common: string | null;
  state: string | null;
  now: number;
}

/** The bro-plane bundle a pass reads once — assembled after the
 *  managed∩open set proves at least one workspace is ours to label. */
interface Planes {
  agentsHome: string | null;
  /** `<state>/bro/agents` — the .events.jsonl archives the acp writers
   *  pin; distinct from agentsHome because the spawn-side artifacts
   *  (.exit/.handle/.go) still resolve the real common dir. */
  eventsHome: string | null;
  registry: ReturnType<typeof readAgentRegistry>;
  branches: Map<string, string>;
  runs: ReturnType<typeof collectLoopRuns>;
  act: ActEntry[];
  beads: ReturnType<typeof readBeads>['inProgress'];
  details: ReturnType<typeof liveWorkEntries>;
  stall: number;
  /** `providers` section — resolves a registry entry's `provider` to
   *  the agent binary name its command spawns. */
  providers: Record<string, ProviderEntry>;
}

/** The registry read, split honest: a corrupt/unreadable agents.json
 *  is degradation, NOT emptiness (bro-u0yjy). An empty {} would strip
 *  every worker row from the projection and the pass would write
 *  dead-looking titles/meta over workspaces whose only live evidence
 *  is the registry — the exact corruption-as-emptiness doctrine
 *  readAgentRegistryFile itself refuses. */
/** One registry read per pass — memoized on the ctx object. A second
 *  read could observe the file mid-corruption AFTER the gate check
 *  passed, and the projection would treat every registry worker as
 *  absent: the exact corruption-as-emptiness the gate exists to kill
 *  (kody + cubic on #1239). */
const regCache = new WeakMap<
  object,
  { reg: ReturnType<typeof readAgentRegistry>; failed: boolean }
>();

function tryRegistry(ctx: Pick<PassCtx, 'root'>): {
  reg: ReturnType<typeof readAgentRegistry>;
  failed: boolean;
} {
  const hit = regCache.get(ctx);
  if (hit !== undefined) {
    return hit;
  }
  let out: { reg: ReturnType<typeof readAgentRegistry>; failed: boolean };
  try {
    out = { reg: readAgentRegistry(ctx.root), failed: false };
  } catch {
    out = { reg: {}, failed: true };
  }
  regCache.set(ctx, out);
  return out;
}

function readPlanes(ctx: PassCtx): Planes {
  const hooks = hooksDirOf(ctx.root);
  return {
    agentsHome: ctx.common === null ? null : join(ctx.common, 'bro', 'agents'),
    eventsHome: ctx.state === null ? null : join(ctx.state, 'bro', 'agents'),
    registry: tryRegistry(ctx).reg,
    branches: gitBranches(ctx),
    runs: collectLoopRuns(ctx.root, ctx.now),
    act: actStates(ctx),
    beads: readBeads(ctx.root).inProgress,
    details: hooks === null ? [] : liveWorkEntries(hooks, ['.work'], ctx.now),
    stall: stallMin(ctx),
    providers: loadBroConfig(ctx.root).providers ?? {},
  };
}

/** Registry entries on one worktree, pre-classified — the pid/handle
 *  probes (registryEntryState) run here, at the boundary. */
function agentRows(t: HerdrWorktree, p: Planes, ctx: PassCtx): AgentRow[] {
  return Object.entries(p.registry)
    .filter(([, e]) => e.worktree === t.path)
    .map(([key, e]) => {
      const st = registryEntryState(p.agentsHome, e);
      const live = st === 'running' || st === 'spawned';
      // the entry's own evidence outranks the config lookup: a worker
      // spawned through an acp provider that was since REMOVED from the
      // config still carries its acpSessionId — it is an acp lane
      // whatever the current config says (bro-iik6m)
      // empty string is no evidence — drive.ts/acp-settle.ts/learn-evidence.ts
      // all exclude it; the lane pin must not disagree with them
      const hasAcpSession = typeof e.acpSessionId === 'string' && e.acpSessionId !== '';
      const acp =
        (e.provider !== undefined && p.providers[e.provider]?.type === 'acp') || hasAcpSession;
      return {
        key,
        live,
        ...(live ? {} : { terminal: TERMINAL[st] }),
        silentMs: live ? agentSilentMs(e, ctx) : null,
        ...(e.provider !== undefined
          ? {
              agent: agentOfCommand(providerCommand(p.providers[e.provider])) ?? e.provider,
              provider: e.provider,
            }
          : {}),
        ...(typeof e.model === 'string' ? { model: e.model } : {}),
        ...(hasAcpSession ? { acpSessionId: e.acpSessionId } : {}),
        ...(typeof e.log === 'string' ? { log: e.log } : {}),
        ...(acp ? { acp: true } : {}),
        ...(acp && p.eventsHome !== null && typeof e.agentId === 'string' && e.agentId !== ''
          ? { events: join(p.eventsHome, `${e.agentId}.events.jsonl`) }
          : {}),
        at: parseTs(e.spawnedAt),
      };
    });
}

/** One worktree's projection input — herdr's branch when it carries
 *  one, the git porcelain join otherwise; the claim and marker arm
 *  read the same files the plugin's arm scan does. */
function treeInput(t: HerdrWorktree, p: Planes, ctx: PassCtx): TreeInput {
  const branch = t.branch ?? p.branches.get(t.path) ?? undefined;
  const claim = worktreeClaim(t.path, ctx.now);
  return {
    path: t.path,
    ...(branch !== undefined ? { branch } : {}),
    ...(claim !== undefined ? { claim } : {}),
    markerArmed: p.details.some(e =>
      detailMatches(e.detail, { branch: branch ?? '', slug: claim ?? '', worktree: t.path })
    ),
    runs: p.runs
      .filter(r => r.worktree === t.path)
      .map(r => ({
        state: r.state,
        ...(r.beadId !== '' ? { beadId: r.beadId } : {}),
        silentMs: r.silentMs,
        at: parseTs(r.startedAt),
      })),
    agents: agentRows(t, p, ctx),
    beads: p.beads,
    act: p.act,
    now: ctx.now,
    stallMin: p.stall,
  };
}

/** One projection pass over every plugin-managed open workspace of the
 *  repo — the kit runs the herdr probes and every write surface; this
 *  wrapper only assembles the bro planes and the TreeInput builder. */
export function projectFleet(mainRoot: string, now = Date.now()): ProjectResult {
  const common = gitCommonDir(mainRoot);
  const state = stateCommonDir(mainRoot);
  const ctx: PassCtx = { root: mainRoot, common, state, now };
  // a degraded registry read means no write is safe: the projection
  // cannot tell a dead workspace from one whose only live evidence is
  // the file it just failed to read. Skip the pass, name the cause —
  // the next pass with a healed file resumes writes (bro-u0yjy).
  if (tryRegistry(ctx).failed) {
    return {
      reachable: true,
      workspaces: 0,
      writes: 0,
      files: 0,
      leds: 0,
      degraded: 'registry read',
    };
  }
  return runFleetPass(ctx, {
    planes: () => readPlanes(ctx),
    input: (t, planes) => treeInput(t, planes, ctx),
  });
}
