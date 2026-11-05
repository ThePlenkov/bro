import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// the router's own layers stay out of the way — the global config and the
// ledger are the operator's, not the test's
const scratch = mkdtempSync(join(tmpdir(), 'brouter-ask-'));
process.env['XDG_CONFIG_HOME'] = join(scratch, 'config');
process.env['XDG_STATE_HOME'] = join(scratch, 'state');
after(() => rmSync(scratch, { recursive: true, force: true }));

const { modelPin, resolveLane } = await import('./ask.ts');

/** A directory with its own config — the providers the ask may pick. */
function configDir(config: unknown): string {
  const dir = mkdtempSync(join(scratch, 'repo-'));
  writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(config));
  return dir;
}

/** A route table on disk — the operator's own file. */
function tableFile(body: string): string {
  const file = join(scratch, `routes-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(file, body);
  return file;
}

const PROVIDERS = {
  providers: {
    'devin-acp': { type: 'acp', command: 'devin acp' },
    'kilo-cli': { type: 'acp', command: 'kilo acp' },
    gateway: {
      type: 'api',
      baseUrl: 'http://localhost:1',
      models: { 'served-model': null },
    },
  },
};

const TABLE = [
  'kind = "route"',
  'version = 1',
  '',
  '[routes.edit]',
  'chain = [{ provider = "devin-acp", model = "swe-2-max" }]',
  '',
].join('\n');

test('the operator names the lane — the table does not argue', async () => {
  const dir = configDir(PROVIDERS);
  const lane = await resolveLane(dir, { question: 'ping', provider: 'kilo-cli' });
  assert.equal(lane.provider, 'kilo-cli');
  assert.equal(lane.rule, 'you named it');
  assert.equal(lane.ruleSource, 'you');
});

test("the table's chain picks the lane — and says so", async () => {
  const dir = configDir(PROVIDERS);
  const lane = await resolveLane(dir, { question: 'ping', routes: tableFile(TABLE) });
  assert.equal(lane.provider, 'devin-acp');
  assert.equal(lane.model, 'swe-2-max');
  assert.equal(lane.pinnedBy, 'the route');
  assert.match(lane.rule, /the route "edit" — its first acp entry/);
  assert.equal(lane.ruleSource, 'the table');
});

test('no table means the first acp provider — and the rule says it', async () => {
  const dir = configDir(PROVIDERS);
  const lane = await resolveLane(dir, { question: 'ping' });
  assert.equal(lane.provider, 'devin-acp');
  assert.equal(lane.rule, 'the first acp provider in the config');
  assert.equal(lane.ruleSource, 'the config');
});

test('a chain with no acp entry falls back — and says which route failed', async () => {
  const dir = configDir(PROVIDERS);
  const table = tableFile(
    [
      'kind = "route"',
      'version = 1',
      '',
      '[routes.edit]',
      'chain = [{ provider = "gateway" }]',
      '',
    ].join('\n')
  );
  const lane = await resolveLane(dir, { question: 'ping', routes: table });
  assert.equal(lane.provider, 'devin-acp');
  assert.match(lane.rule, /the route "edit" has no acp entry/);
  assert.equal(lane.ruleSource, 'the table');
});

test('the lane carries the health the decision read', async () => {
  const dir = configDir(PROVIDERS);
  const lane = await resolveLane(dir, { question: 'ping', routes: tableFile(TABLE) });
  assert.notEqual(lane.snapshot, undefined, 'the decision read the health');
  assert.equal(lane.healthKnown, true);
});

test('a lane nobody decided carries no snapshot — the ledger is read then', async () => {
  const dir = configDir(PROVIDERS);
  const lane = await resolveLane(dir, { question: 'ping', provider: 'kilo-cli' });
  assert.equal(lane.snapshot, undefined);
});

test("the operator's model outranks the route's pin", () => {
  const pinned = modelPin(
    { question: 'ping', model: 'my-model' },
    {
      provider: 'devin-acp',
      entry: { type: 'acp', command: 'devin acp' },
      model: 'swe-2-max',
      pinnedBy: 'the route',
      rule: 'the route "edit" — its first acp entry',
      ruleSource: 'the table',
    }
  );
  assert.equal(pinned.model, 'my-model');
  assert.equal(pinned.pinnedBy, 'you');
});

test('nothing pinned means the agent reports its own model', () => {
  const pinned = modelPin(
    { question: 'ping' },
    {
      provider: 'devin-acp',
      entry: { type: 'acp', command: 'devin acp' },
      pinnedBy: 'the provider entry',
      rule: 'the first acp provider in the config',
      ruleSource: 'the config',
    }
  );
  assert.equal(pinned.model, undefined);
  assert.equal(pinned.pinnedBy, 'the agent');
});
