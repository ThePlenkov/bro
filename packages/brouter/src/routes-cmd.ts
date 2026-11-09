/**
 * `brouter routes` — the route table: what is declared, and whether it
 * holds together.
 *
 * The table is the operator's own file (TOML, `kind = "route"`). The
 * command reads it the way the resolver does, so what `routes list`
 * prints is exactly what a task resolves against.
 */
import { flag, loadConfig } from '@broject/core';
import { readRouteTable, unservedChains } from '@broject/router-routes';
import type { RouteTable, ServedDeclaration, UnservedChain } from '@broject/router-routes';

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

/** The table — read, or the problems printed and fatal. */
function readTable(path: string): RouteTable {
  try {
    return readRouteTable(path);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** What the operator declared the router serves — the served universe. */
function declaredModels(dir: string): ServedDeclaration {
  return loadConfig(dir).brouter?.models ?? {};
}

/** The served-universe problems — printed and fatal.
 *
 *  A route whose chain contradicts the declaration is a config error,
 *  never a skipped route: the operator has already spoken about that
 *  provider, and the table says otherwise. */
export function reportUnserved(unserved: UnservedChain[]): void {
  if (unserved.length === 0) {
    return;
  }
  console.error('the table names models the router does not serve:');
  for (const entry of unserved) {
    console.error(`  routes.${entry.route}: ${entry.reason}`);
  }
  process.exit(1);
}

/** `routes validate` — the table's problems, or the green light.
 *
 *  Two questions, in this order: does the table hold together (its own
 *  schema), and does it name models the router actually serves (the
 *  declaration in `brouter.models`). */
function validate(table: RouteTable, declared: ServedDeclaration): void {
  reportUnserved(unservedChains(table, declared));
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
  const table = readTable(path);
  if (verb === 'validate') {
    validate(table, declaredModels(process.cwd()));
    return;
  }
  list(table);
}
