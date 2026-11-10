/**
 * The client's own read-back — what the client will read.
 *
 * Writing the block is the easy half: it lands in a settings file. The
 * half that matters is what the CLIENT reads back — the rows it offers,
 * the ids it sends, the handling it borrows. This test writes the block
 * into a scratch settings file and reads it back the way the client
 * does: the file, parsed, the block taken out of it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runClient } from './commands.ts';
import { readSettings } from './settings.ts';
import { formatSettingsDiff, settingsDiff } from './settings-diff.ts';

const scratch = mkdtempSync(join(tmpdir(), 'brouter-roundtrip-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The rows the router serves — three families, one honest id each. */
const SERVED = [
  {
    type: 'model',
    id: 'devin-acp/claude-opus-5-5-medium',
    display_name: 'devin-acp/Claude Opus 5.5',
  },
  {
    type: 'model',
    id: 'devin-acp/claude-sonnet-5-5-medium',
    display_name: 'devin-acp/Claude Sonnet 5.5',
  },
  { type: 'model', id: 'devin-acp/swe-2-high', display_name: 'devin-acp/SWE-2' },
];

/** A router that serves the catalog — the client's block comes from it. */
async function servingCatalog(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: SERVED }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

test('the written block round-trips — the client reads the served models back', async () => {
  const { server, url } = await servingCatalog();
  const path = join(scratch, 'settings.json');
  writeFileSync(path, JSON.stringify({ theme: 'auto' }));
  try {
    const outcome = await runClient(
      { client: 'claude-code', write: true, settings: path, wire: false, json: false },
      { url, token: 'tok' }
    );
    assert.equal(outcome.written, path);
    // the file, read back the way the client reads it
    const settings = readSettings(path);
    const block = settings.modelPicker as {
      options?: Array<{ model: string; behavesAs?: string; label?: string }>;
      replaceBuiltInOptions?: boolean;
    };
    assert.equal(block.replaceBuiltInOptions, true);
    const options = block.options ?? [];
    // the client's model list IS the served catalog — one row per model,
    // the honest id, in the served order
    assert.deepEqual(
      options.map(o => o.model),
      SERVED.map(m => m.id)
    );
    // every row borrows a handling the client knows — without it the
    // client warns "isn't recognized · context assumed to be 200k tokens"
    for (const option of options) {
      assert.ok(option.behavesAs, `${option.model} borrows no handling`);
    }
    assert.equal(options[0]?.behavesAs, 'claude-opus-5-5');
    assert.equal(options[1]?.behavesAs, 'claude-sonnet-5-5');
    assert.equal(options[2]?.behavesAs, 'claude-sonnet-5-5');
    // the file's own keys survive the write
    assert.equal(settings.theme, 'auto');
  } finally {
    server.close();
  }
});

test('the dry run writes nothing and says what the write would change', async () => {
  const { server, url } = await servingCatalog();
  const path = join(scratch, 'dry-run.json');
  writeFileSync(path, JSON.stringify({ theme: 'auto' }));
  const before = readFileSync(path, 'utf8');
  try {
    const outcome = await runClient(
      { client: 'claude-code', write: false, settings: path, wire: false, json: false },
      { url, token: 'tok' }
    );
    assert.equal(outcome.written, undefined);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(outcome.changes.length, 1);
    assert.equal(outcome.changes[0]?.key, 'modelPicker');
    assert.equal(outcome.changes[0]?.kind, 'added');
    assert.equal(outcome.changes[0]?.detail, '3 model row(s)');
  } finally {
    server.close();
  }
});

test('the diff names the change — the rows it holds, before and after', () => {
  const changes = settingsDiff(
    { theme: 'auto', modelPicker: { options: [{ model: 'a' }] } },
    { theme: 'auto', modelPicker: { options: [{ model: 'a' }, { model: 'b' }] } }
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'changed');
  assert.equal(changes[0]?.detail, '1 model row(s) → 2 model row(s)');
  const text = formatSettingsDiff('/tmp/settings.json', changes);
  assert.match(text, /modelPicker: changed — 1 model row\(s\) → 2 model row\(s\)/);
});

test('a key the write does not own is never in the diff', () => {
  const changes = settingsDiff({ theme: 'auto' }, { theme: 'auto' });
  assert.deepEqual(changes, []);
  assert.equal(formatSettingsDiff('/tmp/settings.json', changes), '/tmp/settings.json: no change');
});
