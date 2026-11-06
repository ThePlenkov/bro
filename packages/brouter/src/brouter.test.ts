import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { mergeSettings } from './adapter.ts';
import { runClient } from './commands.ts';
import { modelFamily, modelSource, servedModels } from './catalog.ts';
import { claudeCodeAdapter, claudeCodeRows } from './clients/claude-code.ts';
import { readCatalog, readRouterEndpoint, routerStatePath } from './gateway.ts';
import { routerUrl } from './endpoint.ts';
import { clientById, clientIds } from './registry.ts';
import { configuredProviders } from './providers.ts';
import { clientInventory, connectorInventory, isInstalled } from './agents.ts';
import { expandHome, readSettings, writeSettings } from './settings.ts';

const scratch = mkdtempSync(join(tmpdir(), 'brouter-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('the family is read off the id text, never off the prefix', () => {
  assert.equal(modelFamily('opencode-acp/claude-opus-5-5-medium'), 'opus');
  assert.equal(modelFamily('opencode-acp/claude-sonnet-4-6'), 'sonnet');
  assert.equal(modelFamily('devin-acp/claude-haiku-4-5'), 'haiku');
  assert.equal(modelFamily('devin-acp/claude-fable-5-1'), 'fable');
  assert.equal(modelFamily('devin-acp/gpt-6-astra-medium'), 'other');
});

test('a family name inside another segment names no family', () => {
  assert.equal(modelFamily('devin-acp/sonnetizer-1'), 'other');
  assert.equal(modelFamily('devin-acp/haikuish-2'), 'other');
});

test('the source is the id head', () => {
  assert.equal(modelSource('devin-acp/swe-2-high'), 'devin-acp');
  assert.equal(modelSource('bare-model'), undefined);
});

test('a catalog row without an id is not a model — and the drop is counted', () => {
  const { models, dropped } = servedModels({
    data: [
      { id: 'devin-acp/swe-2-high', display_name: 'devin-acp/SWE-2', description: 'devin-acp' },
      { id: '  ' },
      { display_name: 'no id' },
      null,
    ],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, 'devin-acp/swe-2-high');
  assert.equal(models[0]?.label, 'devin-acp/SWE-2');
  assert.equal(models[0]?.source, 'devin-acp');
  assert.equal(dropped, 3);
});

test('a payload that is not a list is an empty catalog, not a crash', () => {
  assert.deepEqual(servedModels({}), { models: [], dropped: 0 });
  assert.deepEqual(servedModels(null), { models: [], dropped: 0 });
});

test('the merge never eats the other keys', () => {
  const merged = mergeSettings({ theme: 'auto', env: { A: '1' } }, 'modelPicker', {
    options: [],
  });
  assert.deepEqual(merged, {
    theme: 'auto',
    env: { A: '1' },
    modelPicker: { options: [] },
  });
});

test('the claude-code row keeps the honest id and borrows a family handling', () => {
  const rows = claudeCodeRows([
    { id: 'devin-acp/swe-2-high', label: 'devin-acp/SWE-2', description: 'devin-acp' },
    { id: 'opencode-acp/claude-opus-5-5-medium' },
  ]);
  assert.equal(rows[0]?.model, 'devin-acp/swe-2-high');
  assert.equal(rows[0]?.label, 'devin-acp/SWE-2');
  assert.equal(rows[0]?.description, 'devin-acp');
  assert.equal(rows[0]?.behavesAs, 'claude-sonnet-5-5');
  assert.equal(rows[1]?.behavesAs, 'claude-opus-5-5');
  assert.equal(rows[1]?.label, undefined);
});

test('the claude-code block replaces the built-in lineup', () => {
  const block = claudeCodeAdapter.renderModelBlock([{ id: 'devin-acp/swe-2-high' }]);
  assert.equal(block.replaceBuiltInOptions, true);
  const options = block.options as Array<{ model: string }>;
  assert.equal(options[0]?.model, 'devin-acp/swe-2-high');
});

test('the wiring is env — never a credential', () => {
  const wiring = claudeCodeAdapter.wire({ url: 'http://127.0.0.1:44927', token: 'secret' });
  assert.deepEqual(wiring, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:44927' } });
  assert.equal(JSON.stringify(wiring).includes('secret'), false);
});

test('the registry answers an unknown client with the known ids', () => {
  assert.equal(clientById('claude-code')?.id, 'claude-code');
  assert.equal(clientById('nope'), undefined);
  assert.deepEqual(clientIds(), ['claude-code']);
});

test('the router state file is the discovery — and a torn record is not a router', () => {
  const gitDir = join(scratch, 'repo', '.git');
  mkdirSync(join(gitDir, 'bro'), { recursive: true });
  writeFileSync(
    join(gitDir, 'bro', 'serve.json'),
    JSON.stringify({ pid: 1, url: 'http://127.0.0.1:44927/', dir: scratch, token: 'tok' })
  );
  const repo = join(scratch, 'repo');
  assert.equal(routerStatePath(repo), join(gitDir, 'bro', 'serve.json'));
  const endpoint = readRouterEndpoint(repo);
  assert.equal(endpoint?.url, 'http://127.0.0.1:44927');
  assert.equal(endpoint?.token, 'tok');
  writeFileSync(join(gitDir, 'bro', 'serve.json'), '{ torn');
  assert.equal(readRouterEndpoint(repo), undefined);
});

test('the token crosses over https or to this machine — nowhere else', () => {
  assert.equal(routerUrl('http://127.0.0.1:44927'), 'http://127.0.0.1:44927');
  assert.equal(routerUrl('http://localhost:44927/'), 'http://localhost:44927');
  assert.equal(routerUrl('https://router.example.com'), 'https://router.example.com');
  assert.throws(() => routerUrl('http://router.example.com'), /cannot carry the session token/);
  assert.throws(() => routerUrl('ftp://router.example.com'), /cannot carry the session token/);
  assert.throws(() => routerUrl('not a url'), /not a valid URL/);
});

test('a router bro refuses is not a router bro did not find', () => {
  const gitDir = join(scratch, 'remote', '.git');
  mkdirSync(join(gitDir, 'bro'), { recursive: true });
  writeFileSync(
    join(gitDir, 'bro', 'serve.json'),
    JSON.stringify({ pid: 1, url: 'http://router.example.com', dir: scratch, token: 'tok' })
  );
  assert.throws(() => readRouterEndpoint(join(scratch, 'remote')), /cannot carry the session token/);
});

test('the catalog is not fetched over cleartext to a remote host', async () => {
  await assert.rejects(
    () => readCatalog({ url: 'http://router.example.com', token: 'tok' }),
    /cannot carry the session token/
  );
});

test('the catalog is read from the router with the credential', async () => {
  const seen: Array<Record<string, string | undefined>> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'] as string });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ type: 'model', id: 'devin-acp/swe-2-high', display_name: 'devin-acp/SWE-2' }],
      })
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const { models } = await readCatalog({ url: `http://127.0.0.1:${port}`, token: 'tok' });
    assert.equal(models.length, 1);
    assert.equal(models[0]?.id, 'devin-acp/swe-2-high');
    assert.equal(seen[0]?.key, 'tok');
    assert.match(String(seen[0]?.url), /\/v1\/models\?limit=1000$/);
  } finally {
    server.close();
  }
});

test('a router that is not up is an error, not an empty catalog', async () => {
  await assert.rejects(
    () => readCatalog({ url: 'http://127.0.0.1:1', token: 'tok' }),
    /the router answered|fetch failed/
  );
});

test('the settings write is atomic and keeps the other keys', () => {
  const path = join(scratch, 'settings.json');
  writeFileSync(path, JSON.stringify({ theme: 'auto' }));
  const merged = mergeSettings(readSettings(path), 'modelPicker', { options: [] });
  writeSettings(path, merged);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.theme, 'auto');
  assert.deepEqual(written.modelPicker, { options: [] });
});

test('an absent settings file reads as empty; a malformed one is an error', () => {
  assert.deepEqual(readSettings(join(scratch, 'absent.json')), {});
  const broken = join(scratch, 'broken.json');
  writeFileSync(broken, '{ nope');
  assert.throws(() => readSettings(broken), /not valid JSON/);
});

test('a settings path may be written the way the operator says it', () => {
  assert.equal(expandHome('/abs/settings.json'), '/abs/settings.json');
  assert.ok(expandHome('~/.claude/settings.json').endsWith('/.claude/settings.json'));
});

test('the client command writes the block and keeps the other keys', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ type: 'model', id: 'devin-acp/swe-2-high', display_name: 'devin-acp/SWE-2' }],
      })
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const path = join(scratch, 'client-settings.json');
  writeFileSync(path, JSON.stringify({ theme: 'auto' }));
  try {
    const outcome = await runClient(
      { client: 'claude-code', write: true, settings: path, wire: false, json: false },
      { url: `http://127.0.0.1:${port}`, token: 'tok' }
    );
    assert.equal(outcome.written, path);
    assert.equal(outcome.models.length, 1);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.theme, 'auto');
    assert.equal(written.modelPicker.options[0].model, 'devin-acp/swe-2-high');
    assert.equal(written.modelPicker.replaceBuiltInOptions, true);
  } finally {
    server.close();
  }
});

test('an unknown client is an error naming the known ones', async () => {
  await assert.rejects(
    () =>
      runClient(
        { client: 'nope', write: false, wire: false, json: false },
        { url: 'http://127.0.0.1:1', token: 'tok' }
      ),
    /unknown client "nope" — known: claude-code/
  );
});

test('the provider inventory reads the configured entries', () => {
  const dir = join(scratch, 'providers-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bro.config.json'),
    JSON.stringify({
      providers: {
        'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-high' },
        orcarouter: {
          type: 'api',
          baseUrl: 'https://api.orcarouter.ai',
          apiKeyEnv: 'ORAROUTER_KEY',
          models: { 'typesafe/jev-1.13': 'systemone' },
        },
      },
    })
  );
  const rows = configuredProviders(dir);
  const devin = rows.find(r => r.name === 'devin-acp');
  assert.equal(devin?.type, 'acp');
  assert.equal(devin?.target, 'devin acp --model swe-2-high');
  const api = rows.find(r => r.name === 'orcarouter');
  assert.equal(api?.type, 'api');
  assert.equal(api?.models, 1);
});

test('the client inventory separates installed from configured', () => {
  const dir = join(scratch, 'clients-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bro.config.json'),
    JSON.stringify({
      providers: {
        'claude-cli': { type: 'cli', command: 'claude -p --output-format stream-json' },
        'devin-acp': { type: 'acp', command: 'devin acp --model swe-2-high' },
      },
    })
  );
  // a PATH with a fake `claude` on it and no `codex`
  const bin = join(scratch, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
  const env = { PATH: bin };
  const rows = clientInventory(dir, env);
  const claude = rows.find(r => r.id === 'claude');
  assert.equal(claude?.installed, true);
  assert.equal(claude?.configured, 'claude-cli');
  assert.equal(claude?.ready, true);
  const devin = rows.find(r => r.id === 'devin');
  assert.equal(devin?.installed, false);
  assert.equal(devin?.configured, 'devin-acp');
  assert.equal(devin?.ready, false);
  assert.equal(isInstalled('claude', env), true);
  assert.equal(isInstalled('codex', env), false);
});

test('the connector registry groups the entries by kind', () => {
  const dir = join(scratch, 'clients-repo');
  const connectors = connectorInventory(dir);
  assert.deepEqual(
    connectors.map(c => c.kind),
    ['acp', 'cli']
  );
  // the operator's global layer counts too — assert containment, not equality
  assert.ok(
    connectorInventory(dir)
      .find(c => c.kind === 'acp')
      ?.entries.includes('devin-acp')
  );
  assert.ok(
    connectorInventory(dir)
      .find(c => c.kind === 'cli')
      ?.entries.includes('claude-cli')
  );
});
