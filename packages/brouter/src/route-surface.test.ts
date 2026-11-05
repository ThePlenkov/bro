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

/** Run the CLI — a real process, so the exit codes are the real ones. */
function run(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
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

test('the routes surface lists the declared routes', () => {
  if (!existsSync(CLI)) return;
  const out = run(['routes', 'list', '--routes', tableFile(TABLE)]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /edit\s+type=edit/);
});

test('a broken table exits with the problems', () => {
  if (!existsSync(CLI)) return;
  const file = tableFile('kind = "route"\n\n[routes.edit]\nchain = []\n');
  const out = run(['routes', 'validate', '--routes', file]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /at least one provider/);
});

test('the store surface migrates and then reports up to date', () => {
  if (!existsSync(CLI)) return;
  const db = join(scratch, 'ledger.db');
  const first = run(['store', 'migrate', '--path', db]);
  const second = run(['store', 'migrate', '--path', db]);
  assert.equal(first.code, 0);
  assert.match(second.stdout, /up to date/);
});

test('the store surface reports where the ledger lives', () => {
  if (!existsSync(CLI)) return;
  const out = run(['store', 'path']);
  assert.equal(out.code, 0);
  assert.match(out.stdout.trim(), /router\.db$/);
});

test('the health surface answers with a snapshot', () => {
  if (!existsSync(CLI)) return;
  const out = run(['health', '--json', '--path', join(scratch, 'health.db')]);
  assert.equal(out.code, 0);
  assert.deepEqual(JSON.parse(out.stdout), {});
});

test('the route surface resolves a task against the table', () => {
  if (!existsSync(CLI)) return;
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

test('a route that pins a field needs that field on the task', () => {
  if (!existsSync(CLI)) return;
  const out = run(['route', 'fix', 'a', 'typo', '--routes', tableFile(TABLE), '--json']);
  assert.equal(out.code, 0);
  const decision = JSON.parse(out.stdout);
  assert.equal(decision.route.name, 'fallback');
  const rejected = decision.rejected.find(
    (r: { route: { name: string } }) => r.route.name === 'edit'
  );
  assert.match(rejected.reason, /carries no type/);
});

test('a route naming a model the declaration contradicts is a config error', () => {
  if (!existsSync(CLI)) return;
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

test('a declaration that agrees leaves the table valid', () => {
  if (!existsSync(CLI)) return;
  const dir = configDir({
    brouter: { models: { 'swe-2-max': [{ provider: 'devin-acp' }] } },
  });
  const out = run(['routes', 'validate', '--routes', tableFile(TABLE)], dir);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /the table is valid/);
  rmSync(dir, { recursive: true, force: true });
});
