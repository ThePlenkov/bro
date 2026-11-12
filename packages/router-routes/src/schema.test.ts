import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readRouteTable, routeTable, RouteTableError, ROUTE_VERSION } from './schema.ts';

const scratch = mkdtempSync(join(tmpdir(), 'router-routes-schema-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The problems a document carries — the validator throws them all. */
function problems(doc: unknown): string[] {
  try {
    routeTable(doc as Record<string, unknown>);
    return [];
  } catch (err) {
    assert.ok(err instanceof RouteTableError, 'expected a RouteTableError');
    return err.problems;
  }
}

/** A valid table — the shape every mutation starts from. */
const VALID = {
  kind: 'route',
  version: 1,
  routes: {
    edit: {
      match: { type: 'edit' },
      chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
      onWall: 'fallthrough',
    },
  },
};

test('a valid table parses into routes', () => {
  const table = routeTable(VALID);
  assert.equal(table.kind, 'route');
  assert.equal(table.routes.length, 1);
  assert.equal(table.routes[0]?.chain[0]?.provider, 'devin-acp');
});

test('a wrong kind is an error naming both values', () => {
  const found = problems({ ...VALID, kind: 'plan' });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /kind: expected "route"/);
});

test('a version above the schema is an error naming both versions', () => {
  const found = problems({ ...VALID, version: ROUTE_VERSION + 1 });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /newer than this router understands/);
});

test('an unknown top-level key is an error', () => {
  const found = problems({ ...VALID, extra: 1 });
  assert.deepEqual(found, ['extra: unknown top-level key']);
});

test('a route with no chain is an error', () => {
  const found = problems({ ...VALID, routes: { edit: { match: { type: 'edit' } } } });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /routes\.edit\.chain/);
});

test('an empty chain is an error', () => {
  const found = problems({ ...VALID, routes: { edit: { chain: [] } } });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /at least one provider/);
});

test('a chain entry without a provider is an error naming the entry', () => {
  const found = problems({ ...VALID, routes: { edit: { chain: [{ model: 'm' }] } } });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /routes\.edit\.chain\[0\]\.provider/);
});

test('a bare provider name is a chain entry', () => {
  const table = routeTable({ ...VALID, routes: { edit: { chain: ['devin-acp'] } } });
  assert.deepEqual(table.routes[0]?.chain, [{ provider: 'devin-acp' }]);
});

test('a chain entry with a bad model is an error — the entry is dropped, not degraded', () => {
  const found = problems({
    ...VALID,
    routes: { edit: { chain: [{ provider: 'p', model: 42 }] } },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /routes\.edit\.chain\[0\]\.model/);
});

test('an unknown onWall is an error naming the two words', () => {
  const found = problems({ ...VALID, routes: { edit: { chain: ['p'], onWall: 'skip' } } });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /onWall: must be one of park\|fallthrough/);
});

test('an unknown key inside a route is an error naming the route', () => {
  const found = problems({ ...VALID, routes: { edit: { chain: ['p'], nope: 1 } } });
  assert.deepEqual(found, ['routes.edit.nope: unknown key']);
});

test('a non-string match value is an error', () => {
  const found = problems({ ...VALID, routes: { edit: { match: { type: 7 }, chain: ['p'] } } });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /routes\.edit\.match\.type/);
});

test('every problem is listed at once', () => {
  const found = problems({
    kind: 'plan',
    routes: { edit: { chain: [] }, other: { chain: [{ model: 'm' }] } },
  });
  assert.ok(found.length >= 3, `expected several problems, got ${found.length}`);
});

test('a file that is not there names itself', () => {
  const missing = join(scratch, 'nope.toml');
  assert.throws(() => readRouteTable(missing), /nope\.toml/);
});

test('a written table reads back from the disk', () => {
  const file = join(scratch, 'routes.toml');
  writeFileSync(
    file,
    [
      'kind = "route"',
      'version = 1',
      '',
      '[routes.edit]',
      'chain = [{ provider = "devin-acp" }]',
    ].join('\n')
  );
  const table = readRouteTable(file);
  assert.equal(table.routes.length, 1);
  assert.equal(table.routes[0]?.name, 'edit');
});

test('match.features parses scalars and lists into the features namespace', () => {
  const table = routeTable({
    ...VALID,
    routes: {
      edit: {
        match: { features: { mode: 'coding', tier: ['low', 'mid'], needs_ui: true, effort: 2 } },
        chain: ['p'],
      },
    },
  });
  assert.deepEqual(table.routes[0]?.match.features, {
    mode: 'coding',
    tier: ['low', 'mid'],
    needs_ui: true,
    effort: 2,
  });
});

test('a match.features value that is not a scalar or list is an error', () => {
  const found = problems({
    ...VALID,
    routes: { edit: { match: { features: { mode: { nested: 1 } } }, chain: ['p'] } },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /routes\.edit\.match\.features\.mode/);
});

test('an empty match.features list is an error', () => {
  const found = problems({
    ...VALID,
    routes: { edit: { match: { features: { mode: [] } }, chain: ['p'] } },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /routes\.edit\.match\.features\.mode/);
});

test('match.labels/paths/repo parse into the carried-field pins', () => {
  const table = routeTable({
    ...VALID,
    routes: {
      edit: {
        match: {
          labels: ['bug', 'ui'],
          paths: ['packages/cli/**', 'web/**'],
          repo: 'ThePlenkov/bro',
        },
        chain: ['p'],
      },
    },
  });
  assert.deepEqual(table.routes[0]?.match.labels, ['bug', 'ui']);
  assert.deepEqual(table.routes[0]?.match.paths, ['packages/cli/**', 'web/**']);
  assert.equal(table.routes[0]?.match.repo, 'ThePlenkov/bro');
});

test('a non-string labels/paths entry or non-string repo is an error', () => {
  const badLabels = problems({
    ...VALID,
    routes: { edit: { match: { labels: ['bug', 7] }, chain: ['p'] } },
  });
  assert.ok(badLabels.some(p => /routes\.edit\.match\.labels/.test(p)));
  const badPaths = problems({
    ...VALID,
    routes: { edit: { match: { paths: 'web/**' }, chain: ['p'] } },
  });
  assert.ok(badPaths.some(p => /routes\.edit\.match\.paths/.test(p)));
  const badRepo = problems({
    ...VALID,
    routes: { edit: { match: { repo: 42 }, chain: ['p'] } },
  });
  assert.ok(badRepo.some(p => /routes\.edit\.match\.repo/.test(p)));
});

test('an empty labels/paths list pins nothing — an error, write no key', () => {
  const found = problems({
    ...VALID,
    routes: { edit: { match: { labels: [] }, chain: ['p'] } },
  });
  assert.ok(found.some(p => /routes\.edit\.match\.labels/.test(p)));
});

test('a paths glob that is not repo-relative is an error', () => {
  const found = problems({
    ...VALID,
    routes: { edit: { match: { paths: ['/packages/cli/**', 'web/**'] }, chain: ['p'] } },
  });
  assert.ok(found.some(p => /routes\.edit\.match\.paths/.test(p)));
  // '..' escapes reject too
  const escape = problems({
    ...VALID,
    routes: { edit: { match: { paths: ['../outside/**'] }, chain: ['p'] } },
  });
  assert.ok(escape.some(p => /routes\.edit\.match\.paths/.test(p)));
});
