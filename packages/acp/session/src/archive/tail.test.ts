import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { eventsFile, logStem, promptFile, proxyEventsFile } from './paths.ts';
import { parseArchiveRows, readTailSlice, TAIL_BYTES, tailArchive, tailWindow } from './tail.ts';

const file = (name: string, content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'tail-')), name);
  writeFileSync(path, content);
  return path;
};

describe('parseArchiveRows', () => {
  test('skips blanks and drops a torn tail row', () => {
    const rows = parseArchiveRows('{"kind":"turn"}\n\n{"kind":"upd');
    assert.deepEqual(rows, [{ kind: 'turn' }]);
  });
});

describe('readTailSlice', () => {
  test('reads from the offset through EOF', () => {
    const path = file('a.events.jsonl', '0123456789');
    assert.deepEqual(readTailSlice(path, 4), { text: '456789', size: 10 });
    assert.equal(readTailSlice(path, 50)?.text, '');
    assert.equal(readTailSlice(join(tmpdir(), 'no-such', 'f'), 0), undefined);
  });
});

describe('tailWindow', () => {
  test('caps the window and drops the partial first line', () => {
    const path = file('b.events.jsonl', 'first\nsecond\nthird\n');
    const w = tailWindow(path, 12);
    assert.equal(w?.text, 'third\n');
    assert.equal(w?.offset, 19);
  });
  test('a small file reads whole; cap <= 0 reads everything', () => {
    const path = file('c.events.jsonl', 'only\nrow\n');
    assert.equal(tailWindow(path)?.text, 'only\nrow\n');
    assert.equal(tailWindow(path, 0)?.text, 'only\nrow\n');
  });
  test('an unreadable file yields undefined', () => {
    assert.equal(tailWindow(join(tmpdir(), 'no-such', 'f')), undefined);
  });
});

describe('tailArchive', () => {
  test('parses complete rows and lands the offset at EOF', () => {
    const path = file('d.events.jsonl', '{"kind":"prompt","text":"hi"}\n{"kind":"turn"}\n');
    const tail = tailArchive(path);
    assert.equal(tail?.rows.length, 2);
    assert.equal(tail?.rows[0]?.kind, 'prompt');
    assert.ok((tail?.offset ?? 0) > 0);
  });
  test('the default cap is the shared TAIL_BYTES', () => {
    assert.equal(TAIL_BYTES, 64 * 1024);
  });
});

describe('the path contract', () => {
  test('agent, proxy, prompt, and log paths derive in one place', () => {
    const ev = eventsFile('/common', 'agent-1');
    assert.equal(ev, '/common/bro/agents/agent-1.events.jsonl');
    assert.equal(
      proxyEventsFile('/common', 'sess/slash', 42),
      '/common/bro/proxy/acp-sess_slash-p42.events.jsonl'
    );
    assert.equal(promptFile(ev), '/common/bro/agents/agent-1.prompt.md');
    assert.equal(logStem(ev), '/common/bro/agents/agent-1');
  });
});
