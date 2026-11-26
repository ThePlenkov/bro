import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { materializeDevinSubagents } from './subagents.ts';

test('materializes profiles and the default model', () => {
  const home = mkdtempSync(join(tmpdir(), 'bro-devin-'));
  const configPath = join(home, '.config', 'devin', 'config.json');
  mkdirSync(join(home, '.config', 'devin'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ agent: { other: true }, keep: 'yes' }));
  const written = materializeDevinSubagents({
    home,
    config: {
      subagent_model: 'swe-2-max',
      profiles: {
        worker: { model: 'swe-2-max', tools: ['shell'], prompt: 'Work carefully.' },
      },
    },
  });
  assert.equal(written.length, 2);
  assert.match(
    readFileSync(join(home, '.config', 'devin', 'agents', 'worker.md'), 'utf8'),
    /model: swe-2-max[\s\S]*tools:\n {2}- shell[\s\S]*Work carefully\./
  );
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    agent: { other: true, subagent_model: 'swe-2-max' },
    keep: 'yes',
  });
});

test('does not create Devin files when no settings are declared', () => {
  const home = mkdtempSync(join(tmpdir(), 'bro-devin-'));
  assert.deepEqual(materializeDevinSubagents({ home, config: {} }), []);
});

test('rejects unsafe profile names', () => {
  assert.throws(
    () =>
      materializeDevinSubagents({
        home: mkdtempSync(join(tmpdir(), 'bro-devin-')),
        config: { profiles: { '../worker': { model: 'm' } } },
      }),
    /invalid Devin subagent profile/
  );
});

test('rejects non-string prompts', () => {
  assert.throws(
    () =>
      materializeDevinSubagents({
        home: mkdtempSync(join(tmpdir(), 'bro-devin-')),
        config: { profiles: { worker: { model: 'm', prompt: {} as unknown as string } } },
      }),
    /invalid Devin subagent profile/
  );
});

test('rejects malformed profile objects', () => {
  assert.throws(
    () =>
      materializeDevinSubagents({
        home: mkdtempSync(join(tmpdir(), 'bro-devin-')),
        config: { profiles: { worker: null as never } },
      }),
    /invalid Devin subagent profile/
  );
});
