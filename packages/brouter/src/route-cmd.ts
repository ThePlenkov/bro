/**
 * `brouter route` — which route serves this task, and why.
 *
 * The surface reads the table, the health (the router's own ledger) and
 * the decision model (a judge), and prints the verdict with its reasons:
 * the route, the chain, the candidates, and every route that did not
 * make it. The "why" is the product — a route nobody can explain is a
 * route nobody can fix.
 */
import { flag, loadConfig, positionals } from '@broject/core';
import type { FleetRouter } from '@broject/core';
import { healthSnapshot, migrateStore, openStore, routerStorePath } from '@broject/router-store';
import { candidates, resolveRoute } from '@broject/router-routes';
import type { RouteCandidate, RouteDecision, RouteTask } from '@broject/router-routes';
import { decisionProvider, requireTypedGrade } from './decision-model.ts';
import { routeTablePath } from './routes-cmd.ts';

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

/** The health — the router's own ledger. No ledger, no walls: the
 *  decision degrades to "everything is available", never to a guess. */
async function healthOf(
  dir: string
): Promise<{ snapshot: Awaited<ReturnType<typeof healthSnapshot>>; known: boolean }> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return { snapshot: {}, known: false };
  }
  try {
    await migrateStore(handle.db);
    return { snapshot: await healthSnapshot(handle.db), known: true };
  } finally {
    handle.close();
  }
}

/** The decision model's pick — the judge over the candidate routes.
 *  Fail-open: no judge, no verdict, the table's own order stands. */
async function modelPick(opts: {
  /** the working dir — the journal and the config anchor here */
  dir: string;
  /** the decision model's provider + mode */
  router: FleetRouter;
  /** the candidate routes the table and the health left standing */
  found: RouteCandidate[];
  /** the task text the model reads */
  task: string;
  /** the statically resolved route — journaled beside the model's opinion */
  resolved: string;
}): Promise<string | undefined> {
  const { dir, router, found, task, resolved } = opts;
  const { chainedJudge, judgeConfig, providerJudge, routePick } = await import('@broject/judge');
  const provider = decisionProvider(dir, router);
  if (router.mode === 'enforce') {
    requireTypedGrade(provider);
  }
  const jcfg = judgeConfig(dir).judge;
  const judge = chainedJudge(
    providerJudge(provider.name, provider.entry, jcfg, {
      keyField:
        provider.kind === 'lane'
          ? `providers.${provider.name}.apiKeyEnv`
          : 'brouter.router.provider',
    }),
    undefined,
    { confidence: jcfg.confidence, timeoutMs: jcfg.timeoutMs }
  );
  const options = found.map(c => ({
    name: c.route.name,
    description: c.route.description ?? `chain: ${c.route.chain.map(e => e.provider).join(' → ')}`,
  }));
  try {
    return await routePick({
      dir,
      judge,
      options,
      state: { task },
      subject: task.slice(0, 80),
      resolved,
      mode: router.mode,
    });
  } catch (err) {
    console.error(
      `warning: brouter.router.provider "${router.provider}" — ` +
        `${err instanceof Error ? err.message : String(err)}; the table's own order stands`
    );
    return undefined;
  }
}

/** The decision, rendered. */
function render(decision: RouteDecision, known: boolean): void {
  console.log(`route: ${decision.route?.name ?? '(none)'}`);
  console.log(
    `chain: ${decision.chain.map(e => `${e.provider}/${e.model ?? ''}`).join(' → ') || '(empty)'}`
  );
  console.log(`picked: ${decision.picked} — ${decision.reason}`);
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

/** The route surface — `brouter route "<task>"`. */
export async function runRouteCommand(argv: string[]): Promise<void> {
  const dir = process.cwd();
  const task = positionals(argv, new Set(['--routes', '--type', '--complexity', '--priority']))
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
  const { snapshot, known } = await healthOf(dir);
  const shape = taskShape(argv);
  const found = candidates(table, shape, snapshot);
  const router = loadConfig(dir).brouter?.router;
  const resolved = found.candidates[0]?.route.name ?? '';
  const named =
    router === undefined || found.candidates.length === 0
      ? undefined
      : await modelPick({
          dir,
          router,
          found: found.candidates,
          task,
          resolved,
        });
  const decision = resolveRoute(table, shape, snapshot, () => named);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(decision, null, 2));
    return;
  }
  render(decision, known);
}
