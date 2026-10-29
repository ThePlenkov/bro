import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { otelEvent, otelJournal, postDetached } from './otel.ts';

describe('otel journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-otel-'));
  afterEach(() => {
    otelJournal(undefined);
    for (const f of ['turns.jsonl']) {
      try {
        rmSync(join(dir, f));
      } catch {}
    }
  });

  it('appends one JSONL row per emitted event', () => {
    const path = join(dir, 'turns.jsonl');
    otelJournal(path);
    otelEvent('conductor.turn', { backend: 'devin', model: 'swe-2-max', session_reused: true });
    otelEvent('conductor.error', { status: 429 });
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.event, 'conductor.turn');
    assert.equal(rows[0]!.model, 'swe-2-max');
    assert.equal(rows[0]!.session_reused, true);
    assert.equal(rows[1]!.event, 'conductor.error');
    assert.match(String(rows[0]!.ts), /^\d{4}-/);
  });

  it('stays silent with no journal pinned', () => {
    otelJournal(undefined);
    otelEvent('conductor.turn', { backend: 'x' });
    assert.throws(() => readFileSync(join(dir, 'turns.jsonl'), 'utf8'));
  });
});

describe('BRO_TELEMETRY kill switch', () => {
  it('an explicit endpoint cannot post past BRO_TELEMETRY=0', async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push(req.url ?? '');
        res.end();
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const ep = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // proof the channel works — explicit endpoint reaches the collector
      postDetached('/v1/logs', { probe: 1 }, ep);
      const deadline = Date.now() + 10_000;
      while (hits.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(hits.length, 1);
      // the kill switch gates the post boundary itself, not ENDPOINT()
      process.env.BRO_TELEMETRY = '0';
      postDetached('/v1/logs', { probe: 2 }, ep);
      await new Promise(r => setTimeout(r, 500));
      assert.equal(hits.length, 1);
    } finally {
      delete process.env.BRO_TELEMETRY;
      server.close();
    }
  });
});
