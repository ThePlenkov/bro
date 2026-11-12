/**
 * `brouter route` — which route serves this task, and why.
 *
 * The surface reads the table, the health (the router's own ledger) and
 * the decision model (a judge), and prints the verdict with its reasons:
 * the route, the chain, the candidates, and every route that did not
 * make it. The "why" is the product — a route nobody can explain is a
 * route nobody can fix.
 *
 * `--explain` replaces the plain verdict with the EXPLANATION — the same
 * facts, in the router's slice vocabulary (route, model, health, cost),
 * with the reasons attached. The plain verdict stays the default: the
 * explanation is asked for, not imposed.
 */
import {
  explainSlicesOrExit,
  flag,
  healthKey,
  loadConfig,
  positionals,
  renderExplanation,
  withSlice,
} from '@broject/core';
import type { Explanation } from '@broject/core';
import { unservedChains, isRepoRelativePath } from '@broject/router-routes';
import type { FeatureValue, RouteTask } from '@broject/router-routes';
import { chainModelFacts, costFacts, healthFacts, routeFacts } from './explain.ts';
import { windowCounters } from './ledger.ts';
import { decideRoute } from './route-decide.ts';
import { formulaPath, reportUnserved, routeTablePath } from './routes-cmd.ts';

/** The verdict's own shape — the resolver's decision. */
type RouteDecisionView = Awaited<ReturnType<typeof decideRoute>>['decision'];

/** The health's shape — the snapshot the verdict read. */
type HealthSnapshotView = Awaited<ReturnType<typeof decideRoute>>['snapshot'];

/** A comma-separated flag's list — empty entries drop, the rest trim. */
function listFlag(argv: string[], name: string): string[] | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) {
    return undefined;
  }
  const out = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
  return out.length === 0 ? undefined : out;
}

/** Invalid task input fails loud — a silently dropped field would turn a
 *  restriction into a no-op (the same rule the plan schemas keep). */
function badInput(msg: string): never {
  console.error(`brouter route: ${msg}`);
  process.exit(1);
}

/** The `--features` JSON — a flat object of scalar values; anything
 *  else is a usage error, never a silent drop. */
function featuresFlag(argv: string[]): Record<string, FeatureValue> | undefined {
  const raw = flag(argv, '--features');
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    badInput('--features must be a JSON object — {"key": "value"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    badInput('--features must be a JSON object — {"key": "value"}');
  }
  const out: Record<string, FeatureValue> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const ok = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!ok) {
      badInput(`--features.${key} must be a string, number, or boolean`);
    }
    Object.defineProperty(out, key, {
      value: value as FeatureValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The task's shape — the flags beside the text. The cascade's carried
 *  fields (bro-0ykhg.2): labels, repo-relative paths, the repo id, and
 *  the typed features map. */
function taskShape(argv: string[]): RouteTask {
  const type = flag(argv, '--type');
  const complexity = flag(argv, '--complexity');
  const priority = flag(argv, '--priority');
  const labels = listFlag(argv, '--labels');
  const paths = listFlag(argv, '--paths');
  const repo = flag(argv, '--repo');
  const features = featuresFlag(argv);
  if (paths !== undefined) {
    for (const p of paths) {
      if (!isRepoRelativePath(p)) {
        badInput(`--paths entry "${p}" must be repo-relative (no leading /, no ..)`);
      }
    }
  }
  return {
    ...(type === undefined ? {} : { type }),
    ...(complexity === undefined ? {} : { complexity }),
    ...(priority === undefined ? {} : { priority }),
    ...(labels === undefined ? {} : { labels }),
    ...(paths === undefined ? {} : { paths }),
    ...(repo === undefined ? {} : { repo }),
    ...(features === undefined ? {} : { features }),
  };
}

/** The decision-id line every surface prints — `brouter outcome` joins
 *  on it, so an unjournaled id says so up front (its report fails
 *  unknown at the store) instead of looking usable. */
function decisionLine(meta: { decisionId: string; journaled: boolean }): string {
  return meta.journaled
    ? `decision: ${meta.decisionId}`
    : `decision: ${meta.decisionId} (not journaled — an outcome report will fail unknown)`;
}

/** The decision, rendered. */
function render(
  decision: RouteDecisionView,
  known: boolean,
  meta: { decisionId: string; contextId: string; journaled: boolean }
): void {
  console.log(decisionLine(meta));
  console.log(`route: ${decision.route?.name ?? '(none)'}`);
  const chain = decision.chain.map(e => `${e.provider}/${e.model ?? ''}`).join(' → ');
  console.log(`chain: ${chain || '(empty)'}`);
  console.log(`picked: ${decision.picked} — ${decision.reason}`);
  // the cascade's verdict — which rung decided, and each stage's
  // before/after (bro-0ykhg.2)
  const cascade = decision.cascade;
  if (cascade !== undefined) {
    console.log(`decided by: ${cascade.decidedBy ?? 'rules'}`);
    for (const s of cascade.stages) {
      const moved =
        s.before.length === s.after.length && s.before.every((n, i) => n === s.after[i])
          ? ''
          : ` — ${s.before.length}→${s.after.length}`;
      console.log(
        `  ${s.stage}: ${s.before.length} in, ${s.after.length} out${moved} (${s.latencyMs}ms)${s.decided !== undefined ? ` decided ${s.decided}` : ''}${s.note !== undefined ? ` — ${s.note}` : ''}`
      );
    }
  }
  const formula = decision.formula;
  if (formula !== undefined) {
    const answers =
      formula.answers.length === 0 ? 'no answers' : `${formula.answers.length} answer(s)`;
    const fired =
      formula.filtered.length === 0 ? '' : `, ${formula.filtered.length} filter(s) fired`;
    console.log(`formula: ${formula.shape} — ${answers}${fired}`);
    for (const firedFilter of formula.filtered) {
      console.log(`  filtered: ${firedFilter.route} — ${firedFilter.reason}`);
    }
    if (formula.note !== undefined) {
      console.log(`  note: ${formula.note}`);
    }
  }
  if (!known) {
    console.log('health: unknown — the ledger is unavailable, no wall was applied');
  }
  for (const candidate of decision.candidates) {
    console.log(`candidate: ${candidate.route.name} (${candidate.score})`);
  }
  for (const rejected of decision.rejected) {
    console.log(`rejected: ${rejected.route.name} — ${rejected.reason}`);
  }
}

/** The explanation of a plan — the route, the model, the health, the cost
 *  the ledger knows about this model. */
async function explainPlan(input: {
  decision: RouteDecisionView;
  snapshot: HealthSnapshotView;
  healthKnown: boolean;
}): Promise<Explanation> {
  let explanation: Explanation = { slices: {} };
  explanation = withSlice(explanation, 'route', routeFacts(input.decision));
  explanation = withSlice(
    explanation,
    'model',
    chainModelFacts(input.decision.chain, input.decision.route?.name)
  );
  const keys = input.decision.chain.map(e => healthKey(e.provider, e.model));
  explanation = withSlice(explanation, 'health', healthFacts(input.snapshot, keys));
  explanation = withSlice(
    explanation,
    'cost',
    await planCostFacts({ decision: input.decision, healthKnown: input.healthKnown })
  );
  return explanation;
}

/** The cost slice of a plan — the ledger's window for the chain's head. */
async function planCostFacts(input: {
  decision: RouteDecisionView;
  healthKnown: boolean;
}): Promise<ReturnType<typeof costFacts>> {
  const head = input.decision.chain[0];
  const window =
    head === undefined
      ? undefined
      : await windowCounters({ provider: head.provider, model: head.model ?? '' });
  return costFacts({
    ...(window === undefined
      ? {}
      : {
          window: {
            ...window,
            provider: head?.provider ?? '',
            model: head?.model ?? '',
          },
        }),
    ledgerKnown: input.healthKnown,
  });
}

/** The route surface — `brouter route "<task>"`. */
export async function runRouteCommand(argv: string[]): Promise<void> {
  const dir = process.cwd();
  const task = positionals(
    argv,
    new Set([
      '--routes',
      '--type',
      '--complexity',
      '--priority',
      '--formula',
      '--labels',
      '--paths',
      '--repo',
      '--features',
    ])
  )
    .join(' ')
    .trim();
  const path = routeTablePath(dir, argv);
  if (path === undefined) {
    console.error(
      'brouter route: no route table — pass --routes <file> or set brouter.routes in bro.config.json'
    );
    process.exit(1);
  }
  const { readRouteTable } = await import('@broject/router-routes');
  const table = readRouteTable(path);
  const config = loadConfig(dir).brouter;
  reportUnserved(unservedChains(table, config?.models ?? {}));
  const shape = taskShape(argv);
  const router = config?.router;
  const formula = formulaPath(dir, argv);
  const { decision, snapshot, healthKnown, decisionId, contextId, journaled } = await decideRoute({
    dir,
    table,
    tablePath: path,
    task: shape,
    text: task,
    kind: 'route',
    ...(router === undefined ? {} : { router }),
    ...(formula === undefined ? {} : { formula }),
  });
  const slices = explainSlicesOrExit(argv);
  if (slices !== undefined) {
    const explanation = await explainPlan({ decision, snapshot, healthKnown });
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ ...explanation, decisionId, contextId }, null, 2));
      return;
    }
    // the plain explanation names the decision too — same join key the
    // verdict render prints, so --explain never hides it
    console.log(decisionLine({ decisionId, journaled }));
    console.log(renderExplanation(explanation, slices));
    return;
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...decision, decisionId, contextId, journaled }, null, 2));
    return;
  }
  render(decision, healthKnown, { decisionId, contextId, journaled });
}
