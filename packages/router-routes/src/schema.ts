/**
 * The route table's schema — the TOML contract and its validator.
 *
 * The table is a plan-like artifact: a `kind` envelope, a version pin,
 * and one table of routes. The validator lists EVERY problem and throws
 * once, so the operator fixes the file in one pass — the same contract
 * the plan schemas keep.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { ON_WALL } from '@broject/core';
import type { ChainEntry, OnWall } from '@broject/core';
import type { Route, RouteMatch, RouteTable } from './types.ts';

/** The envelope's kind — the router's tables say what they are. */
export const ROUTE_KIND = 'route';

/** The schema version this parser speaks. */
export const ROUTE_VERSION = 1;

/** The keys a route may carry. */
const ROUTE_KEYS = new Set(['match', 'chain', 'onWall', 'prompt', 'description']);

/** The keys the envelope may carry. */
const TABLE_KEYS = new Set(['kind', 'version', 'routes']);

/** The match fields — the task's shape, as the operator spells it. */
const MATCH_KEYS = new Set(['type', 'complexity', 'priority']);

/** Every problem the table carries — thrown once, listed once. */
export class RouteTableError extends Error {
  constructor(
    readonly problems: string[],
    source?: string
  ) {
    super(
      `${source === undefined ? 'route table' : source}: ${problems.length} problem(s)\n` +
        problems.map(p => `  ${p}`).join('\n')
    );
    this.name = 'RouteTableError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads + TOML-parses a route table file. The error carries the path. */
export function parseRouteDoc(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}: cannot read route table — ${msg}`);
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid TOML — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc)) {
    throw new Error(`${file}: route table must be a TOML table`);
  }
  return doc;
}

/** The envelope — the kind and the version pin. */
function envelope(doc: Record<string, unknown>, problems: string[]): number {
  if (doc.kind !== ROUTE_KIND) {
    problems.push(`kind: expected "${ROUTE_KIND}", got ${JSON.stringify(doc.kind)}`);
  }
  const version = doc.version;
  if (version === undefined) {
    return ROUTE_VERSION;
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    problems.push('version: must be a positive integer');
    return ROUTE_VERSION;
  }
  if (version > ROUTE_VERSION) {
    problems.push(
      `version: route schema v${version} is newer than this router understands (latest v${ROUTE_VERSION})`
    );
  }
  return version;
}

/** The match — the task's shape. An absent field matches any value. */
function match(raw: unknown, at: string, problems: string[]): RouteMatch {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    problems.push(`${at}.match: must be a table`);
    return {};
  }
  const out: RouteMatch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!MATCH_KEYS.has(key)) {
      problems.push(`${at}.match.${key}: unknown key`);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${at}.match.${key}: must be a non-empty string`);
      continue;
    }
    out[key as keyof RouteMatch] = value.trim();
  }
  return out;
}

/** One chain entry — a bare provider, or a table with the model. */
function chainEntry(raw: unknown, at: string, problems: string[]): ChainEntry | undefined {
  if (typeof raw === 'string') {
    const provider = raw.trim();
    if (provider === '') {
      problems.push(`${at}: must name a provider`);
      return undefined;
    }
    return { provider };
  }
  if (!isRecord(raw)) {
    problems.push(`${at}: must be a provider name or a table`);
    return undefined;
  }
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  if (provider === '') {
    problems.push(`${at}.provider: must be a non-empty string`);
    return undefined;
  }
  const model = raw.model;
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    problems.push(`${at}.model: must be a non-empty string`);
    return undefined;
  }
  return model === undefined ? { provider } : { provider, model: (model as string).trim() };
}

/** The chain — the models a request on this route lands on, in order. */
function chain(raw: unknown, at: string, problems: string[]): ChainEntry[] {
  if (!Array.isArray(raw)) {
    problems.push(`${at}.chain: must be an array`);
    return [];
  }
  if (raw.length === 0) {
    problems.push(`${at}.chain: must name at least one provider`);
    return [];
  }
  const out: ChainEntry[] = [];
  raw.forEach((entry, i) => {
    const parsed = chainEntry(entry, `${at}.chain[${i}]`, problems);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  });
  return out;
}

/** The wall policy — the fleet's vocabulary, the same two words. */
function onWall(raw: unknown, at: string, problems: string[]): OnWall | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = (ON_WALL as readonly unknown[]).includes(raw) ? (raw as OnWall) : undefined;
  if (value === undefined) {
    problems.push(`${at}.onWall: must be one of ${ON_WALL.join('|')}`);
  }
  return value;
}

/** One route — its match, its chain, and the prose beside it. */
function route(name: string, raw: unknown, problems: string[]): Route | undefined {
  const at = `routes.${name}`;
  if (!isRecord(raw)) {
    problems.push(`${at}: must be a table`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!ROUTE_KEYS.has(key)) {
      problems.push(`${at}.${key}: unknown key`);
    }
  }
  const chainRows = chain(raw.chain, at, problems);
  const wall = onWall(raw.onWall, at, problems);
  const out: Route = {
    name,
    match: match(raw.match, at, problems),
    chain: chainRows,
    ...(wall === undefined ? {} : { onWall: wall }),
    ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  };
  if (raw.prompt !== undefined && typeof raw.prompt !== 'string') {
    problems.push(`${at}.prompt: must be a path`);
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    problems.push(`${at}.description: must be a string`);
  }
  return out;
}

/** The routes — the table's body. */
function routes(raw: unknown, problems: string[]): Route[] {
  if (!isRecord(raw)) {
    problems.push('routes: must be a table');
    return [];
  }
  const out: Route[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const parsed = route(name, value, problems);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  }
  return out;
}

/** Validates a parsed table — every problem, one throw. */
export function routeTable(doc: Record<string, unknown>, source?: string): RouteTable {
  const problems: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!TABLE_KEYS.has(key)) {
      problems.push(`${key}: unknown top-level key`);
    }
  }
  const version = envelope(doc, problems);
  const parsed = routes(doc.routes, problems);
  if (problems.length > 0) {
    throw new RouteTableError(problems, source);
  }
  return { kind: ROUTE_KIND, version, routes: parsed };
}

/** Reads + validates a route table file. */
export function readRouteTable(file: string): RouteTable {
  return routeTable(parseRouteDoc(file), file);
}
