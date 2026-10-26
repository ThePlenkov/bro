/** OTLP emit transport (bro-uwoss): emissions queue and ride out on ONE
 *  bounded detached `node -e` child — never an in-process socket. A dead
 *  endpoint must cost the caller nothing: nothing awaited, nothing held
 *  open, and the emitting process exits at its own pace. These tests run
 *  a real loopback collector and observe the wire. */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { otelEvent, otelSpan, postDetached } from './otel.ts';

const OTEL_TS = fileURLToPath(new URL('./otel.ts', import.meta.url));

interface Hit {
  path: string;
  body: string;
  contentType: string | undefined;
}

/** Loopback sink collecting raw POSTs; tests read `hits` after polling. */
function collector(): Promise<{ server: Server; port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body, contentType: req.headers['content-type'] });
      res.writeHead(200).end('{}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (a === null || typeof a === 'string') {
        reject(new Error('collector has no port'));
        return;
      }
      resolve({ server, port: a.port, hits });
    });
  });
}

async function until(pred: () => boolean, what: string, ms = 6_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

const setEp = (v: string | undefined): void => {
  if (v === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = v;
};

describe('otel emit transport', () => {
  let server: Server;
  let hits: Hit[];
  let ep: string;
  let savedEp: string | undefined;

  before(async () => {
    savedEp = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const c = await collector();
    server = c.server;
    hits = c.hits;
    ep = `http://127.0.0.1:${c.port}`;
    setEp(ep);
  });

  after(async () => {
    setEp(savedEp);
    await new Promise(r => server.close(r));
  });

  test('span end + event reach the collector on the flush', async () => {
    otelSpan('emit.test.span', { 'emit.key': 'span-value' }).end();
    otelEvent('emit.test.event', { 'emit.key': 'event-value' });
    // the unref'd 2s flush timer drains the queue — the test's own
    // polling keeps the loop alive long enough to see it
    await until(
      () =>
        hits.some(h => h.path === '/v1/traces' && h.body.includes('emit.test.span')) &&
        hits.some(h => h.path === '/v1/logs' && h.body.includes('emit.test.event')),
      'queued spans + events on the wire'
    );
    const trace = hits.find(h => h.path === '/v1/traces' && h.body.includes('emit.test.span'))!;
    assert.equal(trace.contentType, 'application/json');
    const body = JSON.parse(trace.body) as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
    };
    assert.equal(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name, 'emit.test.span');
  });

  test('postDetached drains without waiting for the timer', async () => {
    otelSpan('emit.test.detached').endDetached();
    await until(
      () => hits.some(h => h.body.includes('emit.test.detached')),
      'detached span on the wire'
    );
  });

  test('a queued batch rides out together when postDetached drains', async () => {
    otelSpan('emit.test.batch.a').end();
    otelSpan('emit.test.batch.b').end();
    postDetached('/v1/traces', {
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'emit.test.batch.c' }] }] }],
    });
    await until(
      () =>
        hits.some(h => h.body.includes('emit.test.batch.a')) &&
        hits.some(h => h.body.includes('emit.test.batch.b')) &&
        hits.some(h => h.body.includes('emit.test.batch.c')),
      'all three batched spans on the wire'
    );
  });

  test('BRO_TELEMETRY=0 emits nothing and spawns nothing', async () => {
    const n0 = hits.length;
    const saved = process.env.BRO_TELEMETRY;
    process.env.BRO_TELEMETRY = '0';
    try {
      otelSpan('emit.test.muted').end();
      postDetached('/v1/traces', { muted: true });
      // outwait the flush lag — anything emitted would have landed by now
      await new Promise(r => setTimeout(r, 2_500));
    } finally {
      if (saved === undefined) delete process.env.BRO_TELEMETRY;
      else process.env.BRO_TELEMETRY = saved;
    }
    assert.equal(hits.length, n0);
  });

  test('a dead endpoint never throws and never holds the caller', () => {
    setEp('http://127.0.0.1:1'); // port 1 — nothing listens on any host
    try {
      otelSpan('emit.test.dead').end();
      postDetached('/v1/traces', { dead: true }); // drains into a bounded child
    } finally {
      setEp(ep);
    }
    // reaching here is the contract — no throw, no awaited socket
  });
});

/** The regression: an emitting process must exit at its own pace even
 *  while its emit child wrestles an unreachable endpoint. Unroutable
 *  10.255.255.1 leaves the child's connect hanging like a WSL2 dead
 *  loopback port — the parent must not feel it. */
test('emitting process exits promptly against an unreachable endpoint', () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://10.255.255.1:4318',
  };
  delete env.BRO_TELEMETRY;
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      `import('${OTEL_TS}').then((m) => { m.otelSpan('emit.test.exit').end(); m.otelEvent('emit.test.exit', {}) })`,
    ],
    { env, timeout: 20_000, encoding: 'utf8' }
  );
  const elapsed = Date.now() - t0;
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  // new: exits <1s (emissions ride a detached child); the old in-process
  // fetch pinned the loop ~10s — assert well under that
  assert.ok(elapsed < 5_000, `emitting process held ${elapsed}ms — the loop-pin is back`);
});
