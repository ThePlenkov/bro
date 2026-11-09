/**
 * The route surface — the table, the health, and the decision.
 *
 * Four commands, one theme: what the router serves NEXT. The ledger
 * (the store), the table (the routes), the health it reads, and the
 * verdict a task gets (the route).
 */
import { definePlugin, type CommandPlugin } from '@broject/command';
import { runHealthCommand } from './health-cmd.ts';
import { runRouteCommand } from './route-cmd.ts';
import { runRoutesCommand } from './routes-cmd.ts';
import { runStoreCommand } from './store-cmd.ts';

/** The route surface — store, routes, health, route. */
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

  return [store, routes, health, route];
}
