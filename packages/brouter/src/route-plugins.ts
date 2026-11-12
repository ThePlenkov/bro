/**
 * The route surface — the table, the health, and the decision.
 *
 * Four commands, one theme: what the router serves NEXT. The ledger
 * (the store), the table (the routes), the health it reads, and the
 * verdict a task gets (the route).
 */
import { definePlugin, type CommandPlugin } from '@broject/command';
import { runHealthCommand } from './health-cmd.ts';
import { runOutcomeCommand } from './outcome-cmd.ts';
import { runRouteCommand } from './route-cmd.ts';
import { runRoutesCommand } from './routes-cmd.ts';
import { runStatsOutcomesCommand } from './stats-cmd.ts';
import { runStoreCommand } from './store-cmd.ts';

/** The route surface — store, routes, health, route, outcome, stats. */
export function routePlugins(): CommandPlugin[] {
  const store = definePlugin({
    name: 'store',
    summary: "The router's own ledger — path | migrate | stats",
    run: argv => runStoreCommand(argv),
  });

  const routes = definePlugin({
    name: 'routes',
    summary: 'The route table — list | validate',
    run: argv => runRoutesCommand(argv),
  });

  const health = definePlugin({
    name: 'health',
    summary: 'What can serve right now — the walls and the open sessions',
    run: argv => runHealthCommand(argv),
  });

  const route = definePlugin({
    name: 'route',
    summary: 'Which route serves this task — the route, the chain, and the why',
    run: argv => runRouteCommand(argv),
  });

  const outcome = definePlugin({
    name: 'outcome',
    summary: "Report a routed decision's terminal verdict — merged|failed|abandoned|parked",
    run: argv => runOutcomeCommand(argv),
  });

  const stats = definePlugin({
    name: 'stats',
    summary: "The router's numbers — outcomes: P(success | route, features)",
    run: argv => {
      const [sub, ...rest] = argv;
      if (sub === 'outcomes') {
        return runStatsOutcomesCommand(rest);
      }
      console.error(`brouter stats: unknown subject "${sub ?? ''}" — outcomes`);
      process.exit(2);
    },
  });

  return [store, routes, health, route, outcome, stats];
}
