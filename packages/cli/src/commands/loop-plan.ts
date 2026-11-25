import {
  type Ctx,
  claimAuthorityNote,
  declaredClaimCapability,
  loopDeps,
  mirrorStore,
  num,
  resolveBeadsDir,
  say,
  sayLaneNotes,
  specProbe,
  TIMER_MAX_MS,
  resolveLoopLane,
} from './loop.ts';
import { type LoopConfig } from '@broject/loop';
import { freshLoopQueue, type LoopDeps, type LoopLane } from '@broject/rig';
import {
  type AgentConnectorEnv,
  loadAgentEnv,
  resolveAgentConnector,
  routeStepClass,
} from '../agent-connectors.ts';
import {
  type LoopLaneSel,
  effectiveAgent,
  flagTierPin,
  labelSelection,
  loopLaneSel,
  stackNameFlag,
} from './loop-args.ts';
import { flag } from './args.ts';
import { facade, reviewHost, type TaskStore } from '@broject/core';
import { prStateCache, ACT_STATE_TTL_MS } from '@broject/act';
import { SpawnError } from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import { MIN_INTERVAL_SEC } from './drive-config.ts';
import { type MirrorPolicy } from '@broject/core';

/** The lane picks resolve once, up front — a bad provider name (or a
 *  broken fleet.routing table) is a config error that must fail BEFORE
 *  a bead is claimed, not mid-run with claims held. Returns the flag
 *  sel, the fixed lane (the whole lane when routing is off or a flag
 *  pins it; `resolveBeadLane` re-resolves per bead otherwise), the
 *  effective template (a cli provider's `command` substitutes for
 *  `loop.agent`; a template --agent stays the literal value — provider
 *  names are never templates, resolveLoopLane consumed them), and
 *  whether per-bead fleet.routing is armed. */
export async function resolveRunLane(
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

async function resolveRunLaneInner(
  env: AgentConnectorEnv,
  sel: LoopLaneSel,
  cfg: LoopConfig
): Promise<{ lane: LoopLane; agent: string; routing: boolean; flagPin: boolean }> {
  // a template --agent bypasses the registry entirely — routing can
  // only arm when the provider lane is in play (templateEscape already
  // warned about the bypass)
  const templateAgent = sel.agent !== undefined && !Object.hasOwn(env.providers ?? {}, sel.agent);
  const routing = hasFleetRouting(env, templateAgent);
  const lane = await resolveLane(env, sel, cfg, routing);
  const flagPin = flagTierPin(env, sel);
  const agent = effectiveAgent(lane, sel, env, cfg);
  rejectEmptyLane(lane, agent, routing, env);
  // {promptFile} isn't strictly required — an agent may read
  // BRO_PROMPT_FILE from env instead — but a TUI-capable CLI spawned
  // without it opens an interactive session per bead (the file path
  // lands positionally = the prompt). Warn loudly, don't refuse. An
  // argv worker takes the file as a positional arg by contract — the
  // check would only misfire on it. With fleet.routing armed and no
  // flag-tier pin the base template is inert — each bead's routed lane
  // carries its own command (lane.worker already holds the fallback
  // class's floor, so the pin test is the picks, not the lane).
  warnMissingPromptFile(lane, agent, routing, flagPin);
  return { lane, agent, routing, flagPin };
}

function hasFleetRouting(env: AgentConnectorEnv, templateAgent: boolean): boolean {
  return (
    !templateAgent && env.fleet?.routing !== undefined && Object.keys(env.fleet.routing).length > 0
  );
}

async function resolveLane(
  env: AgentConnectorEnv,
  sel: LoopLaneSel,
  cfg: LoopConfig,
  routing: boolean
): Promise<LoopLane> {
  try {
    const preflight = routing
      ? routeStepClass(env.fleet, env.providers ?? {}, undefined, '', sel.class, {})
      : undefined;
    return await resolveLoopLane(env, sel, cfg, preflight);
  } catch (err) {
    if (err instanceof SpawnError) {
      console.error(`bro loop: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

function rejectEmptyLane(
  lane: LoopLane,
  agent: string,
  routing: boolean,
  env: AgentConnectorEnv
): void {
  if (lane.worker !== undefined) return;
  if (agent !== '') return;
  if (routing) return;
  console.error(emptyLaneMessage(env));
  process.exit(2);
}

function emptyLaneMessage(env: AgentConnectorEnv): string {
  return hasEnforcedMatrix(env)
    ? 'bro loop: fleet.matrix enforce has no fallback lane — a judge outage ' +
        'fails open to the static lane, so configure one alongside the ' +
        'matrix (loop.provider/loop.profile/loop.agent, ' +
        'agents.<backend>.provider, or fleet.routing)'
    : 'bro loop: no agent configured — set loop.agent or loop.provider in bro.config ' +
        '(e.g. "devin --prompt-file {promptFile} -p") or pass --agent/--provider';
}

function hasEnforcedMatrix(env: AgentConnectorEnv): boolean {
  const matrix = env.fleet?.matrix;
  if (matrix === undefined || matrix.provider === undefined) return false;
  if (matrix.mode !== 'enforce') return false;
  return Object.keys(matrix.models).length > 0;
}

function warnMissingPromptFile(
  lane: LoopLane,
  agent: string,
  routing: boolean,
  flagPin: boolean
): void {
  if (routing && !flagPin) return;
  if (lane.worker?.kind === 'argv') return;
  if (agent.includes('{promptFile}')) return;
  const agentBin = agent.split(/\s+/, 1)[0];
  console.error(
    `bro loop: agent template has no {promptFile} — "${agentBin}". ` +
      'The prompt file appends as a positional arg; interactive CLIs ' +
      '(devin, claude) treat that as a TUI session, not a worker prompt. ' +
      'Intended for env-reading agents (BRO_PROMPT_FILE) only.'
  );
}

export interface BuildCtxInput {
  root: string;
  argv: string[];
  broCfg: ReturnType<typeof loadBroConfig>;
  cfg: LoopConfig;
  run: {
    env: AgentConnectorEnv;
    sel: LoopLaneSel;
    lane: LoopLane;
    agent: string;
    routing: boolean;
    flagPin: boolean;
  };
  backend: string;
}

export function buildCtx(input: BuildCtxInput): Ctx {
  const { root, argv, broCfg, cfg, run, backend } = input;
  const rev = reviewHost(root, broCfg.connectors);
  // hoisted so the ctx fields and the policy's deps surface share the
  // one instance — the FSM reads deps.tasks, the adapter reads
  // ctx.tasks, and they must be the same facade (spec bro-u6fp5.1)
  const ctx = createCtx({
    root,
    argv,
    broCfg,
    cfg,
    backend,
    run,
    rev,
  });
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
  sayLaneNotes(ctx, run.flagPin);
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

interface CtxResources {
  root: string;
  argv: string[];
  broCfg: ReturnType<typeof loadBroConfig>;
  cfg: LoopConfig;
  backend: string;
  run: BuildCtxInput['run'];
  rev: Ctx['rev'];
}

function createCtx(resources: CtxResources): Ctx {
  const { root, argv, broCfg, cfg, backend, run, rev } = resources;
  const tasks = facade('tasks', { dir: root }, { prefer: broCfg.connectors });
  const intervalS = num(
    flag(argv, '--interval'),
    60,
    MIN_INTERVAL_SEC,
    Math.floor(TIMER_MAX_MS / 1000)
  );
  const stateCache = prStateCache(root, {
    ttlMs: Math.min(ACT_STATE_TTL_MS, intervalS * 1000),
  });
  const beadsDir = backend === 'beads' ? resolveBeadsDir(root, m => console.error(m)) : undefined;
  const ctx: Ctx = {
    rev,
    tasks,
    backend,
    repo: rev.resolveRepo([]),
    root,
    cfg: effectiveLoopConfig(cfg, argv),
    act: broCfg.act,
    stateCache,
    agent: resources.run.agent,
    lane: resources.run.lane,
    env: resources.run.env,
    sel: resources.run.sel,
    routing: resources.run.routing,
    intervalS,
    json: argv.includes('--json'),
    selection: { filters: labelSelection(argv), gates: 'forbid', order: 'priority' },
    beadsDir,
    stack: stackNameFlag(argv),
    tails: [],
    stage: 'startup',
    mirror: mirrorStore(root, broCfg, backend),
    mirrorPolicy: broCfg.mirror,
    specHas: specProbe(root, broCfg),
    q: freshLoopQueue(),
    deps: {} as LoopDeps,
  };
  return ctx;
}

function effectiveLoopConfig(cfg: LoopConfig, argv: string[]): LoopConfig {
  return {
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
  };
}
