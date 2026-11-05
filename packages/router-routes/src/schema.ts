/**
 * The route table's schema — the TOML contract and its validator.
 *
 * The table is a plan-like artifact: a `kind` envelope, a version pin,
 * and one table of routes. The validator lists EVERY problem and throws
 * once, so the operator fixes the file in one pass — the same contract
 * the plan schemas keep.
 *
 * The path a problem names and the collector that keeps them are domain
 * objects, not bare strings: a validator that threads `at: string` and
 * `problems: string[]` through every function is a validator whose
 * signature says nothing about where it is.
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

/** Where a value sits in the table — the path every problem names. */
export class TablePath {
  /** the path as the operator reads it */
  readonly text: string;

  private constructor(text: string) {
    this.text = text;
  }

  /** The table's root — the path of the envelope itself. */
  static root(): TablePath {
    return new TablePath('');
  }

  /** A named child of this path — `routes`, `routes.edit`, `match.type`. */
  child(key: string): TablePath {
    return new TablePath(this.text === '' ? key : `${this.text}.${key}`);
  }

  /** An indexed child of this path — `chain[0]`. */
  index(i: number): TablePath {
    return new TablePath(`${this.text}[${i}]`);
  }

  /** The path as the operator reads it. */
  toString(): string {
    return this.text;
  }
}

/** The problems one table carries — collected, then thrown once. */
export class RouteProblems {
  /** every problem, in the order they were found */
  readonly list: string[] = [];

  /** One problem — where it sits and what is wrong with it. */
  add(at: TablePath, problem: string): void {
    this.list.push(at.text === '' ? problem : `${at.text}: ${problem}`);
  }

  /** No problems at all. */
  get empty(): boolean {
    return this.list.length === 0;
  }
}

/** Every problem the table carries — thrown once, listed once. */
export class RouteTableError extends Error {
  /** every problem, in the order they were found */
  readonly problems: string[];

  constructor(problems: string[], source?: string) {
    super(
      `${source === undefined ? 'route table' : source}: ${problems.length} problem(s)\n` +
        problems.map(p => `  ${p}`).join('\n')
    );
    this.name = 'RouteTableError';
    this.problems = problems;
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

/** The version — a positive integer. */
function isVersionNumber(version: unknown): version is number {
  if (typeof version !== 'number') {
    return false;
  }
  if (!Number.isInteger(version)) {
    return false;
  }
  return version >= 1;
}

/** The envelope — the kind and the version pin. */
function envelope(doc: Record<string, unknown>, problems: RouteProblems): number {
  if (doc.kind !== ROUTE_KIND) {
    problems.add(
      TablePath.root().child('kind'),
      `expected "${ROUTE_KIND}", got ${JSON.stringify(doc.kind)}`
    );
  }
  const version = doc.version;
  if (version === undefined) {
    return ROUTE_VERSION;
  }
  if (!isVersionNumber(version)) {
    problems.add(TablePath.root().child('version'), 'must be a positive integer');
    return ROUTE_VERSION;
  }
  if (version > ROUTE_VERSION) {
    problems.add(
      TablePath.root().child('version'),
      `route schema v${version} is newer than this router understands (latest v${ROUTE_VERSION})`
    );
  }
  return version;
}

/** One match field — unknown key, empty value, or the pinned text. */
function matchField(
  key: string,
  value: unknown,
  at: TablePath,
  problems: RouteProblems
): string | undefined {
  const atKey = at.child(key);
  if (!MATCH_KEYS.has(key)) {
    problems.add(atKey, 'unknown key');
    return undefined;
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    problems.add(atKey, 'must be a non-empty string');
    return undefined;
  }
  return text;
}

/** The match — the task's shape. An absent field matches any value. */
function match(raw: unknown, at: TablePath, problems: RouteProblems): RouteMatch {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    problems.add(at.child('match'), 'must be a table');
    return {};
  }
  const atMatch = at.child('match');
  const out: RouteMatch = {};
  for (const [key, value] of Object.entries(raw)) {
    const text = matchField(key, value, atMatch, problems);
    if (text !== undefined) {
      out[key as keyof RouteMatch] = text;
    }
  }
  return out;
}

/** The optional model of a chain entry — a present-but-bad model drops
 *  the entry. */
function chainModel(raw: unknown, at: TablePath, problems: RouteProblems): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    problems.add(at.child('model'), 'must be a non-empty string');
    return undefined;
  }
  const model = raw.trim();
  if (model === '') {
    problems.add(at.child('model'), 'must be a non-empty string');
    return undefined;
  }
  return model;
}

/** One chain entry — a bare provider, or a table with the model. */
function chainEntry(raw: unknown, at: TablePath, problems: RouteProblems): ChainEntry | undefined {
  if (typeof raw === 'string') {
    const provider = raw.trim();
    if (provider === '') {
      problems.add(at, 'must name a provider');
      return undefined;
    }
    return { provider };
  }
  if (!isRecord(raw)) {
    problems.add(at, 'must be a provider name or a table');
    return undefined;
  }
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  if (provider === '') {
    problems.add(at.child('provider'), 'must be a non-empty string');
    return undefined;
  }
  const model = chainModel(raw.model, at, problems);
  return model === undefined ? { provider } : { provider, model };
}

/** The chain — the models a request on this route lands on, in order. */
function chain(raw: unknown, at: TablePath, problems: RouteProblems): ChainEntry[] {
  if (!Array.isArray(raw)) {
    problems.add(at.child('chain'), 'must be an array');
    return [];
  }
  if (raw.length === 0) {
    problems.add(at.child('chain'), 'must name at least one provider');
    return [];
  }
  const out: ChainEntry[] = [];
  raw.forEach((entry, i) => {
    const parsed = chainEntry(entry, at.child('chain').index(i), problems);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  });
  return out;
}

/** The wall policy — the fleet's vocabulary, the same two words. */
function onWall(raw: unknown, at: TablePath, problems: RouteProblems): OnWall | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = (ON_WALL as readonly unknown[]).includes(raw) ? (raw as OnWall) : undefined;
  if (value === undefined) {
    problems.add(at.child('onWall'), `must be one of ${ON_WALL.join('|')}`);
  }
  return value;
}

/** The prose file a route points at — a path, or nothing. */
function routePrompt(
  raw: Record<string, unknown>,
  at: TablePath,
  problems: RouteProblems
): string | undefined {
  if (raw.prompt === undefined) {
    return undefined;
  }
  if (typeof raw.prompt !== 'string') {
    problems.add(at.child('prompt'), 'must be a path');
    return undefined;
  }
  return raw.prompt;
}

/** The one-liner the decision model sees as the criterion. */
function routeDescription(
  raw: Record<string, unknown>,
  at: TablePath,
  problems: RouteProblems
): string | undefined {
  if (raw.description === undefined) {
    return undefined;
  }
  if (typeof raw.description !== 'string') {
    problems.add(at.child('description'), 'must be a string');
    return undefined;
  }
  return raw.description;
}

/** One route — its match, its chain, and the prose beside it. */
function route(
  name: string,
  raw: unknown,
  at: TablePath,
  problems: RouteProblems
): Route | undefined {
  if (!isRecord(raw)) {
    problems.add(at, 'must be a table');
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!ROUTE_KEYS.has(key)) {
      problems.add(at.child(key), 'unknown key');
    }
  }
  const out: Route = {
    name,
    match: match(raw.match, at, problems),
    chain: chain(raw.chain, at, problems),
  };
  const wall = onWall(raw.onWall, at, problems);
  if (wall !== undefined) {
    out.onWall = wall;
  }
  const prompt = routePrompt(raw, at, problems);
  if (prompt !== undefined) {
    out.prompt = prompt;
  }
  const description = routeDescription(raw, at, problems);
  if (description !== undefined) {
    out.description = description;
  }
  return out;
}

/** The routes — the table's body. */
function routes(raw: unknown, at: TablePath, problems: RouteProblems): Route[] {
  if (!isRecord(raw)) {
    problems.add(at.child('routes'), 'must be a table');
    return [];
  }
  const atRoutes = at.child('routes');
  const out: Route[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const parsed = route(name, value, atRoutes.child(name), problems);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  }
  return out;
}

/** Validates a parsed table — every problem, one throw. */
export function routeTable(doc: Record<string, unknown>, source?: string): RouteTable {
  const problems = new RouteProblems();
  for (const key of Object.keys(doc)) {
    if (!TABLE_KEYS.has(key)) {
      problems.add(TablePath.root().child(key), 'unknown top-level key');
    }
  }
  const version = envelope(doc, problems);
  const parsed = routes(doc.routes, TablePath.root(), problems);
  if (!problems.empty) {
    throw new RouteTableError(problems.list, source);
  }
  return { kind: ROUTE_KIND, version, routes: parsed };
}

/** Reads + validates a route table file. */
export function readRouteTable(file: string): RouteTable {
  return routeTable(parseRouteDoc(file), file);
}
