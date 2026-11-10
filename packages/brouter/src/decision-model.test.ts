import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { decisionProvider } from './decision-model.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A directory with a router's state file — the `.git` DIRECTORY is
 *  enough: the router's state lives in the git common dir, and a plain
 *  directory answers the same way a repo's `.git` does. */
function routerDir(url: string, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'brouter-decision-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.git', 'bro'), { recursive: true });
  writeFileSync(join(dir, '.git', 'bro', 'serve.json'), JSON.stringify({ url, token }));
  return dir;
}

/** The proxied entry's key — the runtime field, not the env. */
function keyOf(provider: { entry: unknown }): string | undefined {
  return (provider.entry as { apiKey?: string }).apiKey;
}

describe('the decision provider', () => {
  test('a served model carries the router token — the env never sees it', () => {
    const dir = routerDir('http://127.0.0.1:44927', 'tok-a');
    const provider = decisionProvider(dir, { provider: 'opencode-acp/x', mode: 'off' });
    assert.equal(provider.kind, 'served');
    assert.equal(provider.entry.type, 'api');
    assert.equal(keyOf(provider), 'tok-a');
    assert.equal((provider.entry as { apiKeyEnv?: string }).apiKeyEnv, undefined);
  });

  test('two routers in one process hold two keys — neither reads the other', () => {
    const a = routerDir('http://127.0.0.1:1111', 'tok-a');
    const b = routerDir('http://127.0.0.1:2222', 'tok-b');
    const pa = decisionProvider(a, { provider: 'opencode-acp/x', mode: 'off' });
    const pb = decisionProvider(b, { provider: 'opencode-acp/x', mode: 'off' });
    assert.equal(keyOf(pa), 'tok-a');
    assert.equal(keyOf(pb), 'tok-b');
  });
});
