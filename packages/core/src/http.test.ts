/** getJson — the bounded loopback probe (bro-uwoss). A dead or mute
 *  endpoint resolves `undefined` AT the deadline; unlike an aborted
 *  fetch the transport frees the pending connect at destroy(), not
 *  ~10s later. */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getJson } from './http.ts';

describe('getJson', () => {
  let server: Server;
  let port: number;
  /** handler swapped per test */
  let handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ) => void;

  before(async () => {
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    };
  });

  after(() => new Promise(r => server.close(r)));

  test('parses a 2xx JSON body', async () => {
    assert.deepEqual(await getJson(`http://127.0.0.1:${port}/x`, 1_000), { ok: true });
  });

  test('non-2xx resolves undefined', async () => {
    handler = (_req, res) => res.writeHead(503).end();
    assert.equal(await getJson(`http://127.0.0.1:${port}/x`, 1_000), undefined);
  });

  test('invalid JSON resolves undefined', async () => {
    handler = (_req, res) => res.writeHead(200).end('not json');
    assert.equal(await getJson(`http://127.0.0.1:${port}/x`, 1_000), undefined);
  });

  test('a closed port resolves undefined at the deadline', async () => {
    // on healthy Linux this is ECONNREFUSED in <5ms; on a WSL2 host with
    // the dead-loopback defect it is the 2s deadline — either way bounded
    const t0 = Date.now();
    assert.equal(await getJson('http://127.0.0.1:1', 2_000), undefined);
    assert.ok(Date.now() - t0 < 4_000);
  });

  test('a mute endpoint resolves undefined at the deadline', async () => {
    handler = () => {}; // holds the socket open, never answers
    const t0 = Date.now();
    assert.equal(await getJson(`http://127.0.0.1:${port}/mute`, 300), undefined);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 280 && elapsed < 2_000, `elapsed ${elapsed}ms`);
  });

  test('an unroutable endpoint resolves undefined at the deadline', async () => {
    // 10.255.255.1 hangs connect like a WSL2 dead loopback port — the
    // destroy() deadline is the only bound it honors
    const t0 = Date.now();
    assert.equal(await getJson('http://10.255.255.1:4318/health', 500), undefined);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 480 && elapsed < 5_000, `elapsed ${elapsed}ms`);
  });
});
