import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

/** The built CLI — the surface a user actually touches. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

const scratch = mkdtempSync(join(tmpdir(), 'brouter-route-surface-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the CLI — a real process, so the exit codes are the real ones. The
 *  router's own state is isolated: the ledger is the operator's, not the
 *  test's. */
function run(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, XDG_STATE_HOME: join(scratch, 'state') },
  });
  return { code: proc.status ?? -1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/** A directory with its own config — the declaration the check reads. */
function configDir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'brouter-route-config-'));
  writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(config));
  return dir;
}

/** A route table on disk — the operator's own file. */
function tableFile(body: string): string {
  const file = join(scratch, `routes-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(file, body);
  return file;
}

const TABLE = [
  'kind = "route"',
  'version = 1',
  '',
  '[routes.edit]',
  'match = { type = "edit" }',
  'chain = [{ provider = "devin-acp", model = "swe-2-max" }]',
  'description = "a small edit"',
  '',
  '[routes.fallback]',
  'chain = [{ provider = "kilo-free" }]',
  '',
].join('\n');

test('the routes surface lists the declared routes', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run(['routes', 'list', '--routes', tableFile(TABLE)]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /edit\s+type=edit/);
});

test('a broken table exits with the problems', t => {
  if (!existsSync(CLI)) return t.skip();
  const file = tableFile('kind = "route"\n\n[routes.edit]\nchain = []\n');
  const out = run(['routes', 'validate', '--routes', file]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /at least one provider/);
});

test('the store surface migrates and then reports up to date', t => {
  if (!existsSync(CLI)) return t.skip();
  const db = join(scratch, 'ledger.db');
  const first = run(['store', 'migrate', '--path', db]);
  const second = run(['store', 'migrate', '--path', db]);
  assert.equal(first.code, 0);
  assert.match(second.stdout, /up to date/);
});

test('the store surface reports where the ledger lives', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run(['store', 'path']);
  assert.equal(out.code, 0);
  assert.match(out.stdout.trim(), /router\.db$/);
});

test('the health surface answers with a snapshot', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run(['health', '--json', '--path', join(scratch, 'health.db')]);
  assert.equal(out.code, 0);
  assert.deepEqual(JSON.parse(out.stdout), {});
});

test('the route surface resolves a task against the table', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run([
    'route',
    'fix',
    'a',
    'typo',
    '--type',
    'edit',
    '--routes',
    tableFile(TABLE),
    '--json',
  ]);
  assert.equal(out.code, 0);
  const decision = JSON.parse(out.stdout);
  assert.equal(decision.route.name, 'edit');
  assert.equal(decision.picked, 'static');
});

test('a route that pins a field needs that field on the task', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run(['route', 'fix', 'a', 'typo', '--routes', tableFile(TABLE), '--json']);
  assert.equal(out.code, 0);
  const decision = JSON.parse(out.stdout);
  assert.equal(decision.route.name, 'fallback');
  const rejected = decision.rejected.find(
    (r: { route: { name: string } }) => r.route.name === 'edit'
  );
  assert.match(rejected.reason, /carries no type/);
});

test('a route naming a model the declaration contradicts is a config error', t => {
  if (!existsSync(CLI)) return t.skip();
  // the operator declared devin-acp for the swe-2 family
  const dir = configDir({
    brouter: { models: { 'swe-2-max': [{ provider: 'devin-acp' }] } },
  });
  const table = tableFile(
    [
      'kind = "route"',
      'version = 1',
      '',
      '[routes.edit]',
      'chain = [{ provider = "devin-acp", model = "claude-opus-5" }]',
      '',
    ].join('\n')
  );
  const out = run(['routes', 'validate', '--routes', table], dir);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /does not serve/);
  assert.match(out.stderr, /swe-2-max/);
  rmSync(dir, { recursive: true, force: true });
});

test('a declaration that agrees leaves the table valid', t => {
  if (!existsSync(CLI)) return t.skip();
  const dir = configDir({
    brouter: { models: { 'swe-2-max': [{ provider: 'devin-acp' }] } },
  });
  const out = run(['routes', 'validate', '--routes', tableFile(TABLE)], dir);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /the table is valid/);
  rmSync(dir, { recursive: true, force: true });
});

test('the explain surface answers the questions — route, model, health, cost', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run([
    'route',
    'fix',
    'a',
    'typo',
    '--type',
    'edit',
    '--routes',
    tableFile(TABLE),
    '--explain',
  ]);
  assert.equal(out.code, 0);
  for (const slice of ['route', 'model', 'health', 'cost']) {
    assert.match(out.stdout, new RegExp(`^${slice}$`, 'm'));
  }
  assert.match(out.stdout, /route: edit — the table's own order/);
  assert.match(out.stdout, /model: swe-2-max — the route "edit" pins it/);
});

test('the explain surface takes a subset of the slices', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run(['route', 'fix', 'a', 'typo', '--routes', tableFile(TABLE), '--explain=model']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^model$/m);
  assert.doesNotMatch(out.stdout, /^health$/m);
});

test('an unknown slice is an error naming the known ones', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run(['route', 'fix', 'a', 'typo', '--routes', tableFile(TABLE), '--explain=nope']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /unknown explain slice "nope"/);
  assert.match(out.stderr, /route, model, health, cost/);
});

test('a malformed --timeout is a usage error — the deadline would never fire', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run(['ask', 'ping', '--timeout', 'soon']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /--timeout must be a whole number of milliseconds/);
});

test('the explain surface speaks JSON when asked', t => {
  if (!existsSync(CLI)) return t.skip();
  const out = run([
    'route',
    'fix',
    'a',
    'typo',
    '--type',
    'edit',
    '--routes',
    tableFile(TABLE),
    '--explain',
    '--json',
  ]);
  assert.equal(out.code, 0);
  const explanation = JSON.parse(out.stdout);
  assert.equal(explanation.slices.model[0].value, 'devin-acp');
  assert.ok(explanation.slices.route.length > 0);
});
