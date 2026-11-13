import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { mergeSettings } from './adapter.ts';
import { runClient } from './commands.ts';
import { claudeCodeAdapter, claudeCodeRows } from './clients/claude-code.ts';
import { clientById, clientIds } from './registry.ts';
import { expandHome, readSettings, writeSettings } from './settings.ts';

const scratch = mkdtempSync(join(tmpdir(), 'client-adapters-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

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
