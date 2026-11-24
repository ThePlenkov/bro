import type { AcpSeam, FetchFn } from '@broject/providers';
import {
  projectId,
  routeStepClass,
  SpawnError,
  stepClassInfo,
  CLASS_LABEL_PREFIX,
  readAgentRegistry,
  type BrouterModels,
  type ResolvedClass,
  type SpawnWorker,
} from '@broject/core';
import {
  applyFleetMatrix,
  applyFleetRouter,
  fleetProfileOf,
  matrixLanePick,
  profileModelFor,
  resolveSpawnProvider,
  resolveSpawnRoute,
  type AgentConnectorEnv,
  type MatrixLanePick,
  type SpawnProviderPick,
} from '../agent-connectors.ts';
import type { LoopConfig } from '@broject/loop';
import { type LoopLaneSel } from './loop-args.ts';
import { explainSpawn } from './loop-explain.ts';
import { routeTableLane, type RouteTableLane } from './loop-routes.ts';
import type { ReadyBead } from './next.ts';
import type { Ctx } from './loop.ts';
import type { LoopLane } from '@broject/rig';

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
  ...routing: [route?: ResolvedClass, matrix?: MatrixLanePick]
): Promise<LoopLane> {
  const [route, matrix] = routing;
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
  return resolveProviderLane({ env, sel, cfg, route, matrix, agentIsProvider });
}

async function resolveProviderLane(args: {
  env: AgentConnectorEnv;
  sel: LoopLaneSel;
  cfg: LoopConfig;
  route?: ResolvedClass;
  matrix?: MatrixLanePick;
  agentIsProvider: boolean;
}): Promise<LoopLane> {
  const { env, sel, cfg, route, matrix, agentIsProvider } = args;
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
  const routeSpec = await resolveRouteSpec({
    env,
    sel,
    route,
    matrix,
    agentIsProvider,
    flagProvider,
    provider,
    model,
    autoApprove,
    profileSourced,
  });
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

async function resolveRouteSpec(args: {
  env: AgentConnectorEnv;
  sel: LoopLaneSel;
  route?: ResolvedClass;
  matrix?: MatrixLanePick;
  agentIsProvider: boolean;
  flagProvider?: string;
  provider?: string;
  model?: string;
  autoApprove?: boolean;
  profileSourced: boolean;
}): Promise<LoopLane['route']> {
  const {
    env,
    sel,
    route,
    matrix,
    agentIsProvider,
    flagProvider,
    provider,
    model,
    autoApprove,
    profileSourced,
  } = args;
  if (
    route === undefined ||
    matrix !== undefined ||
    sel.provider !== undefined ||
    agentIsProvider ||
    flagProvider !== undefined ||
    provider !== route.provider
  ) {
    return undefined;
  }
  return resolveSpawnRoute(
    env,
    'native',
    route,
    {
      model:
        sel.model ??
        (sel.profile === undefined ? undefined : fleetProfileOf(env, sel.profile)?.model),
      modelFallback: model,
      autoApprove,
    },
    pickTier(sel, agentIsProvider, profileSourced)
  );
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
    return resumableSessionId(reg[molStep], lane);
  } catch {
    return undefined;
  }
}

function resumableSessionId(
  entry: ReturnType<typeof readAgentRegistry>[string] | undefined,
  lane: { provider?: string; worker?: SpawnWorker } | undefined
): string | undefined {
  const id = entry?.acpSessionId;
  const sameProvider = lane?.provider !== undefined && entry?.provider === lane.provider;
  const isAcpWorker = lane?.worker?.kind === 'argv';
  return typeof id === 'string' && id !== '' && sameProvider && isAcpWorker ? id : undefined;
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
  const routerMayFire = classRouterNeedsDetails(ctx, info.label, routerEnabled, router);
  // the matrix router (bro-v0pvd.1) judges every bead's task text — no
  // class/label exemptions — and wants the description the ready row
  // may not carry, so it earns the same extra `bd show` the class
  // router does (still gated on routerEnabled: dry runs never pay it)
  const matrixMayFire = matrixRouterNeedsDetails(ctx, routerEnabled, matrix);
  return routerMayFire || matrixMayFire
    ? { ...info, ...stepClassInfo(ctx.beadsDir!, bead.id) }
    : info;
}

function classRouterNeedsDetails(
  ctx: Ctx,
  label: string | undefined,
  enabled: boolean,
  router: NonNullable<Ctx['env']['fleet']>['router']
): boolean {
  return (
    enabled &&
    router !== undefined &&
    router.mode !== 'off' &&
    ctx.sel.class === undefined &&
    label === undefined &&
    ctx.beadsDir !== undefined
  );
}

function matrixRouterNeedsDetails(
  ctx: Ctx,
  enabled: boolean,
  matrix: NonNullable<Ctx['env']['fleet']>['matrix']
): boolean {
  return (
    enabled &&
    matrix !== undefined &&
    matrix.provider !== undefined &&
    matrix.mode !== 'off' &&
    Object.keys(matrix.models).length > 0 &&
    ctx.beadsDir !== undefined
  );
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

export { classLabelOf, resolveBeadLane };
