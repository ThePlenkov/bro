/**
 * `brouter routes` — the route table: what is declared, and whether it
 * holds together.
 *
 * The table is the operator's own file (TOML, `kind = "route"`). The
 * command reads it the way the resolver does, so what `routes list`
 * prints is exactly what a task resolves against.
 */
import { flag, loadConfig } from '@broject/core';
import { readRouteTable, RouteTableError } from '@broject/router-routes';
import type { RouteTable } from '@broject/router-routes';

/** Where the table lives — the flag wins over the declared path. */
export function routeTablePath(dir: string, argv: string[]): string | undefined {
  const declared = flag(argv, '--routes');
  if (declared !== undefined) {
    return declared;
  }
  return loadConfig(dir).brouter?.routes;
}

/** One route, as the table renders it. */
function row(route: RouteTable['routes'][number]): string {
  const match = Object.entries(route.match)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const chain = route.chain
    .map(entry => (entry.model === undefined ? entry.provider : `${entry.provider}/${entry.model}`))
    .join(' → ');
  const wall = route.onWall === undefined ? '' : `\t${route.onWall}`;
  return `${route.name}\t${match === '' ? '(any task)' : match}\t${chain}${wall}`;
}

/** `routes list` — the declared routes. */
function list(table: RouteTable): void {
  for (const route of table.routes) {
    console.log(row(route));
  }
  if (table.routes.length === 0) {
    console.log('the table declares no routes');
  }
}

/** `routes validate` — the table's problems, or the green light. */
function validate(table: RouteTable): void {
  console.log(`the table is valid — ${table.routes.length} route(s), schema v${table.version}`);
}

/** The routes surface — `brouter routes list|validate`. */
export function runRoutesCommand(argv: string[]): void {
  const verb = argv[0] ?? 'list';
  if (verb !== 'list' && verb !== 'validate') {
    console.error(`brouter routes: unknown verb "${verb}" — list | validate`);
    process.exit(2);
  }
  const path = routeTablePath(process.cwd(), argv);
  if (path === undefined) {
    console.error(
      'brouter routes: no route table — pass --routes <file> or set brouter.routes in bro.config.json'
    );
    process.exit(1);
  }
  let table: RouteTable;
  try {
    table = readRouteTable(path);
  } catch (err) {
    if (err instanceof RouteTableError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (verb === 'validate') {
    validate(table);
    return;
  }
  list(table);
}
