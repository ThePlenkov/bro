import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { eventsFile, logStem, promptFile, proxyEventsFile } from './paths.ts';
import {
  parseArchiveRows,
  readTailSlice,
  TAIL_BYTES,
  tailArchive,
  tailWindow,
  utf8End,
} from './tail.ts';

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
    const s = readTailSlice(path, 4);
    assert.equal(s?.text, '456789');
    assert.equal(s?.size, 10);
    assert.equal(s?.buf.toString('utf8'), '456789');
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
  test('offsets count bytes, not code units — multi-byte rows resume correctly', () => {
    const path = file('mb.events.jsonl', '✓ one\n→ two\n✗ three\n');
    const w = tailWindow(path, 14);
    assert.equal(w?.text, '✗ three\n');
    // resume from the returned offset — a byte position — lands on a
    // real boundary and re-reads nothing
    const s = readTailSlice(path, w?.offset ?? -1);
    assert.equal(s?.text, '');
    // and a whole-file window's offset is exactly the byte length
    const whole = tailWindow(path);
    assert.equal(whole?.offset, Buffer.byteLength('✓ one\n→ two\n✗ three\n'));
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
  test('eventsFile sanitizes the registry-provided agent id', () => {
    const ev = eventsFile('/common', '../escape');
    assert.ok(ev.startsWith('/common/bro/agents/'));
    // `.._escape` is a filename, not a `..` path segment — no traversal
    assert.ok(!ev.split('/').includes('..'));
  });
});

describe('utf8End — the pump holds back an incomplete UTF-8 tail', () => {
  test('ascii and complete sequences consume everything', () => {
    assert.equal(utf8End(Buffer.from('CLI-LOG-LINE')), 12);
    assert.equal(utf8End(Buffer.from('a ✓ b')), Buffer.from('a ✓ b').length);
    assert.equal(utf8End(Buffer.from('emoji 🎉')), Buffer.from('emoji 🎉').length);
  });
  test('a truncated multi-byte tail waits for its missing bytes', () => {
    const full = Buffer.from('done ✓');
    const cut = full.subarray(0, full.length - 1); // drop the last ✓ byte
    assert.equal(utf8End(cut), full.length - 3); // 'done ' survives, ✓ waits
    const cut2 = full.subarray(0, full.length - 2);
    assert.equal(utf8End(cut2), full.length - 3);
  });
  test('a lead byte alone at the tail is incomplete, not consumed', () => {
    const b = Buffer.concat([Buffer.from('ok '), Buffer.from([0xe2])]);
    assert.equal(utf8End(b), 3);
  });
});
