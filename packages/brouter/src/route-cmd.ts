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
import { unservedChains } from '@broject/router-routes';
import type { RouteTask } from '@broject/router-routes';
import { chainModelFacts, costFacts, healthFacts, routeFacts } from './explain.ts';
import { windowCounters } from './ledger.ts';
import { decideRoute } from './route-decide.ts';
import { formulaPath, reportUnserved, routeTablePath } from './routes-cmd.ts';

/** The verdict's own shape — the resolver's decision. */
type RouteDecisionView = Awaited<ReturnType<typeof decideRoute>>['decision'];

/** The health's shape — the snapshot the verdict read. */
type HealthSnapshotView = Awaited<ReturnType<typeof decideRoute>>['snapshot'];

/** The task's shape — the flags beside the text. */
function taskShape(argv: string[]): RouteTask {
  const type = flag(argv, '--type');
  const complexity = flag(argv, '--complexity');
  const priority = flag(argv, '--priority');
  return {
    ...(type === undefined ? {} : { type }),
    ...(complexity === undefined ? {} : { complexity }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/** The decision, rendered. */
function render(decision: RouteDecisionView, known: boolean): void {
  console.log(`route: ${decision.route?.name ?? '(none)'}`);
  const chain = decision.chain.map(e => `${e.provider}/${e.model ?? ''}`).join(' → ');
  console.log(`chain: ${chain || '(empty)'}`);
  console.log(`picked: ${decision.picked} — ${decision.reason}`);
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
    new Set(['--routes', '--type', '--complexity', '--priority', '--formula'])
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
  const { decision, snapshot, healthKnown } = await decideRoute({
    dir,
    table,
    task: shape,
    text: task,
    ...(router === undefined ? {} : { router }),
    ...(formula === undefined ? {} : { formula }),
  });
  const slices = explainSlicesOrExit(argv);
  if (slices !== undefined) {
    const explanation = await explainPlan({ decision, snapshot, healthKnown });
    if (argv.includes('--json')) {
      console.log(JSON.stringify(explanation, null, 2));
      return;
    }
    console.log(renderExplanation(explanation, slices));
    return;
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(decision, null, 2));
    return;
  }
  render(decision, healthKnown);
}
