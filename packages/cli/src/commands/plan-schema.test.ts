/**
 * Plan-schema drift gate (spec bro-hp0su).
 *
 * schemas/plans/<kind>.schema.json is the published authoring contract
 * for each plan kind; the plugin's planSchema function is the single
 * validation pipeline `bro plan validate`/`bro run` execute. This suite
 * proves the two cannot drift apart on the structural slice:
 *
 *   - every schema compiles under Ajv2020 and names its kind via
 *     `kind.const` + caps `version` at the plugin's planVersion;
 *   - the example embedded in each schema validates AND passes the real
 *     parser — "CLI returns a resolver-passing example" (audit AC);
 *   - every per-kind fixture passes/fails BOTH layers — a field the
 *     parser checks but the schema forgot (or vice versa) fails here;
 *   - "$schema" is an envelope key: every kind's parser tolerates it.
 *
 * No runtime ajv — validation runs inside `tsx --test` only (same rule
 * as contract-schema.test.ts).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { BroPlugin } from '@broject/core';
import { PLUGINS } from '../plugins.ts';

const PKG_DIR = join(import.meta.dirname, '..', '..');
const PLANS_DIR = join(PKG_DIR, 'schemas', 'plans');

const ajv = new Ajv2020({ allErrors: true });

interface PlanSchemaDoc {
  properties?: Record<string, { const?: unknown; maximum?: number }>;
  examples?: unknown[];
}

interface InvalidFixture {
  doc: Record<string, unknown>;
  /** field name the rejection must point at — checked inside the schema
   *  error JSON and inside the parser's error message. */
  field: string;
}

interface KindFixtures {
  /** Every doc passes the JSON Schema AND the real planSchema parser.
   *  At least one carries "$schema" — the envelope key must not be an
   *  unknown-top-level-key rejection. */
  valid: Record<string, unknown>[];
  /** Every doc fails BOTH layers, with the field named. */
  invalid: InvalidFixture[];
}

const FIXTURES: Record<string, KindFixtures> = {
  act: {
    valid: [
      { kind: 'act', threads: [{ thread_id: 't1', action: 'resolve' }] },
      {
        $schema: 'https://unpkg.com/@broject/bro/schemas/plans/act.schema.json',
        kind: 'act',
        version: 1,
        pr: 5,
        threads: [
          { thread_id: 't1', action: 'reply', comment: 'done differently' },
          { thread_id: 't2', action: 'defer', title: 'follow-up' },
        ],
      },
    ],
    invalid: [
      {
        doc: { kind: 'act', threads: [{ thread_id: 't1', action: 'bogus' }] },
        field: 'action',
      },
      { doc: { kind: 'act' }, field: 'threads' },
      { doc: { kind: 'act', threads: [] }, field: 'threads' },
      {
        doc: { kind: 'act', bogus: 1, threads: [{ thread_id: 't', action: 'resolve' }] },
        field: 'bogus',
      },
    ],
  },
  convoy: {
    valid: [
      { kind: 'convoy', molecules: [{ formula: 'debt-pipeline' }] },
      {
        $schema: 'https://unpkg.com/@broject/bro/schemas/plans/convoy.schema.json',
        kind: 'convoy',
        version: 1,
        gates: 'forbid',
        molecules: [
          {
            title: 'ship it',
            steps: [
              { id: 'a', title: 'first', priority: 2 },
              { id: 'b', title: 'second', needs: ['a'] },
            ],
          },
        ],
      },
    ],
    invalid: [
      {
        doc: { kind: 'convoy', molecules: [{ formula: 'x', title: 'mixes both arms' }] },
        field: 'title',
      },
      { doc: { kind: 'convoy', molecules: [] }, field: 'molecules' },
      { doc: { kind: 'convoy', gates: 'bogus', molecules: [{ formula: 'x' }] }, field: 'gates' },
    ],
  },
  debt: {
    valid: [
      {
        $schema: 'https://unpkg.com/@broject/bro/schemas/plans/debt.schema.json',
        kind: 'debt',
        verdicts: [{ thread_id: 't1', status: 'done', fix_pr: 3 }],
      },
    ],
    invalid: [
      {
        doc: { kind: 'debt', verdicts: [{ thread_id: 't1', status: 'bogus' }] },
        field: 'status',
      },
      { doc: { kind: 'debt', verdicts: [{ thread_id: 't1' }] }, field: 'status' },
    ],
  },
  drill: {
    valid: [
      { kind: 'drill', title: 'root frame' },
      {
        $schema: 'https://unpkg.com/@broject/bro/schemas/plans/drill.schema.json',
        kind: 'drill',
        version: 1,
        title: 'why',
        steps: [{ title: 'a' }, { title: 'b', under: 0, priority: 2, ephemeral: true }],
      },
    ],
    invalid: [
      { doc: { kind: 'drill' }, field: 'title' },
      { doc: { kind: 'drill', title: 't', steps: [{ title: 'a', under: 'x' }] }, field: 'under' },
    ],
  },
  next: {
    valid: [
      { kind: 'next' },
      {
        $schema: 'https://unpkg.com/@broject/bro/schemas/plans/next.schema.json',
        kind: 'next',
        version: 1,
        limit: 2,
        order: 'oldest',
        claim: false,
        gates: 'allow',
        scope: 'global',
        json: true,
        filters: { types: ['task'], max_priority: 1, match: 'x', labels: ['l'] },
      },
    ],
    invalid: [
      { doc: { kind: 'next', order: 'bogus' }, field: 'order' },
      { doc: { kind: 'next', filters: { bogus: 1 } }, field: 'bogus' },
    ],
  },
  query: {
    valid: [
      { kind: 'query', steps: [{ id: 's', graphql: '{ a }' }] },
      {
        $schema: 'https://unpkg.com/@broject/bro/schemas/plans/query.schema.json',
        kind: 'query',
        version: 1,
        concurrency: 2,
        steps: [
          {
            id: 's',
            provider: 'github',
            graphql: 'query { a }',
            vars: { x: '1' },
            env: { GITLAB_HOST: 'gl.example' },
          },
        ],
      },
    ],
    invalid: [
      { doc: { kind: 'query' }, field: 'steps' },
      {
        doc: {
          kind: 'query',
          steps: [{ id: 's', graphql: '{ a }', env: { PATH: '/x' } }],
        },
        field: 'PATH',
      },
    ],
  },
  retrospect: {
    valid: [
      { kind: 'retrospect', retro: { what: 'w', why: 'y' } },
      {
        $schema: 'https://unpkg.com/@broject/bro/schemas/plans/retrospect.schema.json',
        kind: 'retrospect',
        version: 1,
        retro: { what: 'w', why: 'y', scope: 'user', wtf: 'bro-x', evidence: ['e'] },
        actions: [{ title: 't', sink: 'memory', scope: 'agent', detail: 'd' }],
      },
    ],
    invalid: [
      { doc: { kind: 'retrospect', retro: { what: 'w' } }, field: 'why' },
      {
        doc: {
          kind: 'retrospect',
          retro: { what: 'w', why: 'y' },
          actions: [{ title: 't', sink: 'bogus' }],
        },
        field: 'sink',
      },
    ],
  },
};

const planPlugins = PLUGINS.filter(
  p => p.planSchema !== undefined && p.runPlan !== undefined && p.external !== true
);

function schemaPath(kind: string): string {
  return join(PLANS_DIR, `${kind}.schema.json`);
}

const compiled = new Map<string, { schema: PlanSchemaDoc; validate: ValidateFunction }>();

function loadSchema(kind: string): { schema: PlanSchemaDoc; validate: ValidateFunction } {
  const hit = compiled.get(kind);
  if (hit !== undefined) {
    return hit;
  }
  const file = schemaPath(kind);
  assert.ok(existsSync(file), `${kind}: no shipped schema at schemas/plans/${kind}.schema.json`);
  const schema = JSON.parse(readFileSync(file, 'utf8')) as PlanSchemaDoc;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw new Error(
      `${kind}.schema.json did not compile — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const entry = { schema, validate };
  compiled.set(kind, entry);
  return entry;
}

function schemaErrors(validate: ValidateFunction, doc: unknown): ErrorObject[] {
  return validate(doc) ? [] : [...(validate.errors ?? [])];
}

function parseOk(plugin: BroPlugin, doc: unknown): boolean {
  try {
    plugin.planSchema!(doc, 'fixture');
    return true;
  } catch {
    return false;
  }
}

describe('plan schemas — coverage', () => {
  test('every plan-accepting plugin has a schema file, and no orphans ship', () => {
    const kinds = planPlugins.map(p => p.name).sort();
    // non-vacuity: the known seven — a new plan kind lands here first
    assert.deepEqual(kinds, ['act', 'convoy', 'debt', 'drill', 'next', 'query', 'retrospect']);
    const files = readdirSync(PLANS_DIR).sort();
    assert.deepEqual(
      files,
      kinds.map(k => `${k}.schema.json`),
      'a schemas/plans file without a plan kind (or a kind without a file) is drift'
    );
  });

  for (const plugin of planPlugins) {
    test(`${plugin.name}: schema compiles, names its kind, caps version`, () => {
      const { schema } = loadSchema(plugin.name);
      assert.equal(
        schema.properties?.kind?.const,
        plugin.name,
        `${plugin.name}: kind.const must name the plan kind`
      );
      assert.equal(
        schema.properties?.version?.maximum,
        plugin.planVersion ?? 1,
        `${plugin.name}: version.maximum must equal PLAN_VERSION — bump both together`
      );
    });

    test(`${plugin.name}: the embedded example passes its schema AND the real parser`, () => {
      const { schema, validate } = loadSchema(plugin.name);
      assert.ok(
        Array.isArray(schema.examples) && schema.examples.length > 0,
        `${plugin.name}: schema must embed a canonical example`
      );
      for (const example of schema.examples!) {
        assert.deepEqual(
          schemaErrors(validate, example),
          [],
          `${plugin.name}: schema rejected its own example`
        );
        assert.equal(
          parseOk(plugin, example),
          true,
          `${plugin.name}: the published example fails the real planSchema parser`
        );
      }
    });

    test(`${plugin.name}: fixtures agree across both layers`, () => {
      const { validate } = loadSchema(plugin.name);
      const fx = FIXTURES[plugin.name];
      assert.ok(fx !== undefined, `${plugin.name}: no fixtures registered`);
      for (const doc of fx.valid) {
        assert.deepEqual(
          schemaErrors(validate, doc),
          [],
          `${plugin.name}: schema rejected a doc the parser accepts — ${JSON.stringify(doc)}`
        );
        assert.equal(
          parseOk(plugin, doc),
          true,
          `${plugin.name}: parser rejected a doc the schema accepts — ${JSON.stringify(doc)}`
        );
      }
      for (const { doc, field } of fx.invalid) {
        const errors = schemaErrors(validate, doc);
        assert.ok(errors.length > 0, `${plugin.name}: schema accepted ${JSON.stringify(doc)}`);
        assert.ok(
          JSON.stringify(errors).includes(field),
          `${plugin.name}: schema rejection does not point at "${field}" — ` +
            JSON.stringify(errors.slice(0, 3))
        );
        assert.throws(
          () => plugin.planSchema!(doc, 'fixture'),
          new RegExp(field.replace(/[$]/g, '\\$')),
          `${plugin.name}: parser rejection must name "${field}"`
        );
      }
    });
  }

  test('a version pin above the kind fails both layers', () => {
    const plugin = planPlugins.find(p => p.name === 'act')!;
    const { validate } = loadSchema('act');
    const doc = { kind: 'act', version: 2, threads: [{ thread_id: 't', action: 'resolve' }] };
    assert.ok(schemaErrors(validate, doc).length > 0, 'schema must reject version > maximum');
    assert.throws(() => plugin.planSchema!(doc, 'fixture'), /newer than this bro understands/);
  });
});
