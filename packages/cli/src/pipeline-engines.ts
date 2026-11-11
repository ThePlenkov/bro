/**
 * The production engine map for `bro pipeline run`
 * (specs/bro-qjji2.10.md §the production engine map).
 *
 * `@broject/pipeline` stays provider-agnostic — every host seam is
 * injected. This module is the CLI-side binder: it resolves the repo's
 * agent env (`loadAgentEnv`), the task store, the judge facade, the
 * fleet spawn boundary (`spawnStepAgent`), and the customer channels,
 * then binds all seven engine slots the contract formula uses. The
 * result is an `EngineMap` — or a `(dir) => EngineMap` factory — the
 * same shape `--engines <module>` loads, so an operator can replace the
 * WHOLE map (a real e2e runner, a different emit transport) without a
 * per-slot merge.
 *
 * Boundary honesty: seams with no production implementation yet bind an
 * adapter that refuses loudly rather than faking a verdict — verify's
 * `e2e` throws (a `fail` would loop `work` forever, a `pass` would fake
 * verification), so the pending intent becomes the crash marker and the
 * run parks `attempts-exhausted` for an operator. The accept `emit`
 * transport proper is bro-qjji2.11's; this binds the seam to an
 * idempotent mailbox drop. The resume/wake path is bro-v0pvd.3's — this
 * map only serves FRESH `runPipeline` invocations.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentInfo,
  type AgentRegistryEntry,
  type DecideResult,
  deriveProviderWalls,
  dropMailbox,
  type JudgeFacade,
  loadConfig,
  notifyDir,
  pidAlive,
  type PrTarget,
  type ProviderEntry,
  type ProviderWall,
  readAgentRegistry,
  type ReviewFacade,
  reviewHost,
  type RoutingTable,
  taskSpecFacade,
  taskStore,
} from '@broject/core';
import {
  type ActGateObservation,
  type ActGatePrRef,
  type CaptureOutcome,
  type EngineMap,
  type FleetDeps,
  type FleetSpawnRequest,
  type IntakeOutcome,
  type LandContext,
  type RetroReceipt,
  type ReviewDiff,
  type StageCall,
  acceptStage,
  actGateStage,
  captureStage,
  classifyStage,
  fileAnswerFeed,
  fileVerdictStore,
  intakeStage,
  pipelineDir,
  reviewStage,
  routeStage,
  stageDispatch,
  taskBacklog,
  verifyStage,
  workStage,
} from '@broject/pipeline';
import {
  type ExitGate,
  type PrActState,
  evaluateExitGate,
  fetchPrActState,
  gatePending,
} from '@broject/act';
import { judgeFacade } from '@broject/judge';
import { captureLessons } from '@broject/learn';
import { fleetCapOf, fleetOccupancyFor, loadAgentEnv } from './agent-connectors.ts';
import { type StepSpawnRequest, spawnStepAgent } from './commands/agents.ts';

/** The pipeline plane dir — where run journals, customer channels, and
 *  the formula sidecars live (`<git-common>/bro/pipeline`). Reused for
 *  the emit/retro idempotence sentinels; `null` outside a git repo (the
 *  run itself needs the plane, so a null here means the sentinel
 *  degrades to the mailbox's own uniqueness — still safe). */
function pipelinePlaneDir(dir: string): string | null {
  return pipelineDir({ dir });
}

/** A JudgeFacade that resolves the real `judgeFacade(dir)` on first
 *  `decide` — building the engine map must not require a configured
 *  judge connector (a bare checkout still gets a runnable pipeline;
 *  only a stage that actually judges needs the backend). */
function lazyJudge(dir: string): JudgeFacade {
  let inner: JudgeFacade | undefined;
  const real = (): JudgeFacade => {
    inner ??= judgeFacade(dir);
    return inner;
  };
  return {
    decide: (state, questions) => real().decide(state, questions),
  };
}

// --- judge engine (classify / route / review) -------------------------------

/** The git seam review's `diff` reads — the worker's recorded worktree
 *  and the base/head the work stage journaled. Returns undefined when no
 *  worktree is on the ctx (review then judges without a diff — the
 *  stage's own contract for an absent artifact). */
function gitDiff(call: StageCall): ReviewDiff | undefined {
  const ctx = call.ctx;
  const work =
    typeof ctx.work === 'object' && ctx.work !== null
      ? (ctx.work as Record<string, unknown>)
      : undefined;
  const diffRec =
    typeof ctx.diff === 'object' && ctx.diff !== null
      ? (ctx.diff as Record<string, unknown>)
      : work !== undefined && typeof work.diff === 'object' && work.diff !== null
        ? (work.diff as Record<string, unknown>)
        : undefined;
  const worktree =
    (typeof ctx.worktree === 'string' ? ctx.worktree : undefined) ??
    (work !== undefined && typeof work.worktree === 'string' ? work.worktree : undefined) ??
    (diffRec !== undefined && typeof diffRec.worktree === 'string' ? diffRec.worktree : undefined);
  if (worktree === undefined || worktree === '') {
    return undefined;
  }
  const base =
    (diffRec !== undefined && typeof diffRec.base === 'string' ? diffRec.base : undefined) ??
    'HEAD~1';
  const head =
    (diffRec !== undefined && typeof diffRec.head === 'string' ? diffRec.head : undefined) ??
    'HEAD';
  const files =
    diffRec !== undefined && Array.isArray(diffRec.files)
      ? diffRec.files.filter((f): f is string => typeof f === 'string')
      : undefined;
  let diff = '';
  try {
    diff = execFileSync('git', ['-C', worktree, 'diff', `${base}...${head}`], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // an unresolvable ref range still yields the working diff — the
    // review judges what it can see rather than nothing
    try {
      diff = execFileSync('git', ['-C', worktree, 'diff', 'HEAD'], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      return undefined;
    }
  }
  return {
    diff,
    ...(files !== undefined ? { files } : {}),
    worktree,
    base,
    head,
  };
}

/** Build the `judge` engine handler — `stageDispatch` over the three
 *  judge-driven stages so classify/route/review share one bound
 *  handler with the safe recheck (spawn-like intents park, read intents
 *  re-fire bounded). `admitIntents` MUST be the same set the run's
 *  `admit` option got — stageDispatch's recheck consults it. */
function judgeEngine(
  dir: string,
  env: ReturnType<typeof loadAgentEnv>,
  store: ReturnType<typeof taskStore>,
  judge: JudgeFacade,
  admitIntents: readonly string[]
): EngineMap['judge'] {
  const backlog = taskBacklog(store);
  const routing: RoutingTable = env.fleet?.routing ?? {};
  const providers: Record<string, ProviderEntry> = env.providers ?? {};
  const occupancy = () => {
    const live = fleetOccupancyFor(dir, env);
    return { live, cap: fleetCapOf(env) };
  };
  const walls = (): ProviderWall[] =>
    deriveProviderWalls(readAgentRegistry(dir), Date.now(), env.providers);
  return stageDispatch(
    {
      classify: classifyStage({ judge, backlog }),
      route: routeStage({ judge, backlog, routing, providers, occupancy, walls }),
      review: reviewStage({ judge, backlog, routing, providers, diff: gitDiff, walls }),
    },
    admitIntents
  );
}

// --- intake engine ----------------------------------------------------------

/** The DoR judgment — a `judge.decide` choice over the spec's shape:
 *  `accepted` (ready), `questions` (needs customer input), or
 *  `declined` (fails requirements). The spec fingerprint + answer feed
 *  are intakeStage's own concern; this seam only returns the verdict. */
function intakeJudgment(judge: JudgeFacade) {
  return async (_call: StageCall, spec: { acceptance?: unknown[] }): Promise<IntakeOutcome> => {
    const state = {
      acceptanceCount: spec.acceptance?.length ?? 0,
      hasAcceptance: (spec.acceptance?.length ?? 0) > 0,
    };
    const res: DecideResult = await judge.decide(state, {
      dor: {
        type: 'choice',
        instructions:
          'Judge whether this work item is ready to enter the pipeline. ' +
          'Choose accepted when the spec is complete enough to execute, ' +
          'questions when it needs customer clarification first, declined ' +
          'when it fails requirements and should not proceed.',
        criteria: {
          accepted: 'the spec is complete — acceptance criteria present and unambiguous',
          questions: 'the spec needs customer answers before work can start',
          declined: 'the spec fails requirements — it should not be worked',
        },
      },
    });
    const answer = res.answers.dor;
    const choice = answer !== undefined && answer.type === 'choice' ? answer.choice : 'questions';
    if (choice === 'accepted') {
      return { verdict: 'accepted' };
    }
    if (choice === 'declined') {
      return { verdict: 'declined', feedback: 'the spec fails definition-of-ready' };
    }
    return {
      verdict: 'questions',
      questions: ['which acceptance criteria apply to this work?'],
    };
  };
}

// --- fleet engine (work) -----------------------------------------------------

/** Read the exit record for a registry entry — `<agents>/<agentId>.<runId>.exit`
 *  holds the worker's exit code; its presence means the spawn settled. */
function exitRecordFor(dir: string, entry: AgentRegistryEntry): { code?: number } | undefined {
  const common = gitCommonFor(dir);
  if (common === null) {
    return undefined;
  }
  const runId = entry.runId ?? entry.session_id;
  const name = `${entry.agentId}${runId !== undefined ? `.${runId}` : ''}.exit`;
  const file = join(common, 'bro', 'agents', name);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const text = readFileSync(file, 'utf8').trim();
    const code = Number(text.split(/\s+/)[0]);
    return { code: Number.isFinite(code) ? code : undefined };
  } catch {
    return {};
  }
}

function gitCommonFor(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/** Synthesize the AgentInfo `observe` reports from the agent registry —
 *  the registry is keyed by molStep (= the pipeline item). State is
 *  derived conservatively: a recorded exit → 'exited' (cause from the
 *  exit code), a live pid → 'running', a fresh spawn-handoff → 'spawned',
 *  a dead pid with no exit record → 'lost'. No entry → undefined (the
 *  spawn never landed → the runner's bounded re-fire). */
function observeAgent(dir: string) {
  return (call: StageCall): AgentInfo | undefined => {
    const registry = readAgentRegistry(dir);
    const entry = registry[call.item] ?? Object.values(registry).find(e => e.agentId === call.item);
    if (entry === undefined) {
      return undefined;
    }
    const rec = exitRecordFor(dir, entry);
    // pid/pidStart ride the registry row but aren't on the public entry
    // type — read them defensively off the raw record
    const raw = entry as unknown as Record<string, unknown>;
    const pid = typeof raw.pid === 'number' ? raw.pid : undefined;
    const pidStart = typeof raw.pidStart === 'string' ? raw.pidStart : undefined;
    let state: AgentInfo['state'];
    let cause: AgentInfo['cause'];
    if (rec !== undefined) {
      state = 'exited';
      cause = rec.code === 0 ? 'ok' : 'crash';
    } else if (pid !== undefined && pidAlive(pid, pidStart)) {
      state = 'running';
    } else if (
      entry.spawnedAt !== undefined &&
      Date.now() - Date.parse(entry.spawnedAt) < 5 * 60 * 1000
    ) {
      state = 'spawned';
    } else {
      state = 'lost';
      cause = 'crash';
    }
    return {
      id: entry.agentId,
      molStep: call.item,
      backend: entry.backend,
      state,
      ...(entry.spawnedAt !== undefined ? { spawnedAt: entry.spawnedAt } : {}),
      ...(entry.runId !== undefined ? { runId: entry.runId } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.class !== undefined ? { class: entry.class } : {}),
      ...(cause !== undefined ? { cause } : {}),
    };
  };
}

/** Adapt the work stage's FleetSpawnRequest onto spawnStepAgent's
 *  StepSpawnRequest — molStep/lane/provider/model/class carry over;
 *  the prompt is molStep-derived inside spawnStepAgent (the bead IS the
 *  worker's instruction). Returns the AgentInfo the stage journals. */
async function spawnWorker(
  dir: string,
  env: ReturnType<typeof loadAgentEnv>,
  call: StageCall,
  req: FleetSpawnRequest
): Promise<AgentInfo> {
  const stepReq: StepSpawnRequest = {
    lane: req.lane,
    molStep: req.molStep,
    ...(req.provider !== undefined ? { provider: req.provider } : {}),
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.class !== undefined ? { class: req.class } : {}),
    claimRequired: true,
  };
  return spawnStepAgent(dir, env, stepReq);
}

function fleetEngine(
  dir: string,
  env: ReturnType<typeof loadAgentEnv>,
  formulaName: string,
  formulaSha: string | undefined
): FleetDeps {
  return {
    spawn: (call, req) => spawnWorker(dir, env, call, req),
    observe: observeAgent(dir),
    pipeline: { formula: formulaName, ...(formulaSha !== undefined ? { formulaSha } : {}) },
    lane: 'batch',
  };
}

// --- accept engine -----------------------------------------------------------

/** Idempotent emit — surfaces the evidence bundle on the customer
 *  channel (the notify mailbox for a human customer) keyed by
 *  (runId, stage) so the stage's recheck never double-notifies. The full
 *  emit TRANSPORT (A2A surface, rich notify) is bro-qjji2.11; this binds
 *  the seam. Dedup rides a sentinel beside the pipeline plane. */
function acceptEmit(dir: string) {
  return (call: StageCall, bundle: unknown): void => {
    const plane = pipelinePlaneDir(dir);
    const sentinel =
      plane !== null
        ? join(plane, `.emit-${call.runId}-${call.stage.name}`)
        : join(notifyDir(dir), `.emit-${call.runId}-${call.stage.name}`);
    if (existsSync(sentinel)) {
      return;
    }
    const text =
      `pipeline run ${call.runId} reached the accept gate for ${call.item}.\n\n` +
      `Evidence bundle:\n${JSON.stringify(bundle, null, 2)}\n\n` +
      `Record the customer's verdict: bro pipeline accept ${call.item} <accepted|rejected|abandon>`;
    dropMailbox(notifyDir(dir), text, `pipeline-accept-${call.runId}`);
    try {
      writeFileSync(sentinel, new Date().toISOString());
    } catch {
      // a sentinel write failure degrades to re-notify on recheck —
      // noisy but never wrong
    }
  };
}

function acceptEngine(dir: string): EngineMap['accept'] {
  return acceptStage({
    emit: acceptEmit(dir),
    verdictStore: fileVerdictStore(dir),
  });
}

// --- act-gate engine (merge) -------------------------------------------------

/** Normalize the stage's PR ref (number | string | record) onto the
 *  host's PrTarget — number → bound repo's PR; string → the facade's
 *  own ref parser; record → {repo, pr|number} fields. Undefined when the
 *  ref names no PR the facade can resolve. */
function prTargetFor(rev: ReviewFacade, ref: ActGatePrRef): PrTarget | undefined {
  if (typeof ref === 'number') {
    return { repo: rev.resolveRepo(), pr: ref };
  }
  if (typeof ref === 'string') {
    const parsed = rev.parsePrRef(ref);
    if (parsed !== null) {
      return parsed;
    }
    const n = Number(ref.replace(/^#/, ''));
    if (Number.isInteger(n) && n > 0) {
      return { repo: rev.resolveRepo(), pr: n };
    }
    return undefined;
  }
  const rec = ref as Record<string, unknown>;
  const pr =
    typeof rec.pr === 'number' ? rec.pr : typeof rec.number === 'number' ? rec.number : undefined;
  const repo = typeof rec.repo === 'string' ? rec.repo : rev.resolveRepo();
  if (pr === undefined || !Number.isInteger(pr) || pr <= 0) {
    return undefined;
  }
  return { repo, pr };
}

/** The act-gate probe — fetchPrActState + evaluateExitGate + gatePending
 *  normalized onto ActGateObservation. Read-only and idempotent;
 *  undefined only when the ref names no resolvable PR. The review host
 *  resolves LAZILY on first probe — building the map must not require a
 *  configured review connector (a bare checkout still gets a runnable
 *  pipeline; only the merge stage's probe needs the host). */
function actGateProbe(dir: string) {
  let rev: ReviewFacade | undefined;
  const host = (): ReviewFacade => {
    rev ??= reviewHost(dir, loadConfig(dir).connectors);
    return rev;
  };
  return async (_call: StageCall, pr: ActGatePrRef): Promise<ActGateObservation | undefined> => {
    const facade = host();
    const target = prTargetFor(facade, pr);
    if (target === undefined) {
      return undefined;
    }
    const state: PrActState = await fetchPrActState(facade, target);
    const lifecycle = state.state.toUpperCase();
    const obsState =
      lifecycle === 'OPEN' || lifecycle === 'MERGED' || lifecycle === 'CLOSED' ? lifecycle : 'OPEN';
    const gate: ExitGate = evaluateExitGate(state);
    const settling = gatePending(state);
    return {
      state: obsState,
      ...(state.headSha !== '' ? { headSha: state.headSha } : {}),
      ...(state.url !== '' ? { url: state.url } : {}),
      ...(state.mergedBy !== undefined ? { mergedBy: state.mergedBy } : {}),
      gate: {
        ok: gate.ok,
        settling,
        ...(gate.blockers.length > 0 ? { blockers: gate.blockers } : {}),
        ...(state.ciPending > 0 ? { ciPending: state.ciPending } : {}),
        ...(state.reviewersPending > 0 ? { reviewersPending: state.reviewersPending } : {}),
        ...(state.ciFailing > 0 ? { ciFailing: state.ciFailing } : {}),
        ...(state.openThreads > 0 ? { openThreads: state.openThreads } : {}),
      },
    };
  };
}

function actGateEngine(dir: string): EngineMap['act-gate'] {
  return actGateStage({ probe: actGateProbe(dir) });
}

// --- learn engine (capture) ---------------------------------------------------

/** captureLessons → CaptureOutcome. The report's plan carries the
 *  harvested/applied lesson counts; followups/skipped map through. */
function captureOutcome(report: ReturnType<typeof captureLessons>): CaptureOutcome {
  const plan = report.plan as {
    lessons?: number;
    applied?: number;
    skipped?: { origin: string; reason: string }[];
    followups?: string[];
  };
  const lessons = plan.applied ?? plan.lessons ?? 0;
  return {
    lessons,
    ...(plan.followups !== undefined ? { followups: plan.followups } : {}),
    ...(plan.skipped !== undefined ? { skipped: plan.skipped } : {}),
  };
}

/** The batched-retro intent — records that a retro SHOULD run for this
 *  landed item, never executes it (the spec forbids a per-item
 *  heavyweight retro inside the stage). The marker is a file the retro
 *  sweeper drains; captureStage only needs the receipt. */
function retroReceipt(dir: string, call: StageCall, _ctx: LandContext): RetroReceipt {
  const plane = pipelinePlaneDir(dir) ?? notifyDir(dir);
  const marker = join(plane, `.retro-${call.runId}-${call.item}`);
  try {
    writeFileSync(marker, `${call.item}\n${new Date().toISOString()}\n`);
  } catch {
    // best-effort — the receipt still reports the intent
  }
  return { batch: `retro-${call.item}` };
}

function learnEngine(dir: string): EngineMap['learn'] {
  return captureStage({
    capture: (_call, ctx) => captureOutcome(captureLessons({ dir })),
    retro: (call, ctx) => retroReceipt(dir, call, ctx),
  });
}

// --- the map -----------------------------------------------------------------

export interface ProductionEnginesOptions {
  /** the formula's name — stamped into fleet worker provenance. The
   *  CLI passes the loaded formula's identity; absent → 'pipeline'. */
  formula?: string;
  /** the formula's sha — same provenance channel. */
  formulaSha?: string;
  /** the run's admit-intent set — stageDispatch's recheck consults it;
   *  MUST match the admitIntents the run's RunOptions got. Defaults to
   *  the runner's DEFAULT_ADMIT_INTENTS (['spawn']). */
  admitIntents?: readonly string[];
}

/** `(dir) => EngineMap` — the `--engines` module contract AND the
 *  `bro pipeline run` default. Binds all seven slots; provider seams
 *  resolve per-dir so one factory serves any checkout. */
export function engines(dir: string, opts: ProductionEnginesOptions = {}): EngineMap {
  const env = loadAgentEnv(dir);
  const store = taskStore(dir);
  const judge = lazyJudge(dir);
  const admitIntents = opts.admitIntents ?? ['spawn'];
  const formulaName = opts.formula ?? 'pipeline';
  const formulaSha = opts.formulaSha;
  return {
    judge: judgeEngine(dir, env, store, judge, admitIntents),
    intake: intakeStage({
      taskSpec: taskSpecFacade(store),
      answers: fileAnswerFeed(dir),
      intake: intakeJudgment(judge),
    }),
    fleet: workStage(fleetEngine(dir, env, formulaName, formulaSha)),
    e2e: verifyStageWithDir(dir),
    accept: acceptEngine(dir),
    'act-gate': actGateEngine(dir),
    learn: learnEngine(dir),
  };
}

/** verifyStage bound to THIS dir's taskSpec — kept separate so the
 *  throwing e2e seam closes over the right store (the bare e2eEngine
 *  helper used process.cwd() for tests that never reach it). */
function verifyStageWithDir(dir: string): EngineMap['e2e'] {
  return verifyStage({
    taskSpec: taskSpecFacade(taskStore(dir)),
    e2e: () => {
      throw new Error('no e2e runner bound — inject engines via --engines');
    },
  });
}
