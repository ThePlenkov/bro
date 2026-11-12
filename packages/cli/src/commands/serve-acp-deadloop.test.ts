/** serve `/api/v1/acp` — the dead-loop refusal (spec bro-b961a). The
 *  churn accounting is client-independent: a connection that opens
 *  sessions without a completed turn is refused BEFORE the next session
 *  opens, so the refusal costs no quota — and the refusal reaches the
 *  client as a JSON-RPC error it can read, not a transport failure. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ClientConnection, ClientContext, InitializeRequest } from '@agentclientprotocol/sdk';
import { client, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client';
import { type FakeAcpAgent, fakeAcpAgent } from '@broject/providers/testkit';
import { acpTransport } from './serve-acp.ts';
import type { ConductorConfig } from './serve-conductor.ts';
import { authHeaders, serveDeps as deps, listen } from './serve-testkit.ts';

const CFG: ConductorConfig = {
  backend: 'dv-acp',
  entry: { type: 'acp', command: 'dv acp' },
  cwd: '/repo',
  timeoutMs: 10_000,
  agents: {},
};

const INIT_PARAMS: InitializeRequest = {
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: 'test-client', version: '0' },
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
};

interface TestClient {
  conn: ClientConnection;
  agent: ClientContext;
}

function openClient(url: string): TestClient {
  const app = client({ name: 'test-client' }).onRequest('fs/read_text_file', () => ({
    content: 'contents',
  }));
  const conn = app.connect(createHttpStream(`${url}/api/v1/acp`, { headers: authHeaders }));
  return { conn, agent: conn.agent };
}

const listenAcp = (fake: FakeAcpAgent, over: Partial<ConductorConfig> = {}) =>
  listen(deps({ acp: acpTransport({ ...CFG, ...over }, { acp: { peer: fake.app } }) }));

describe('serve /api/v1/acp — the dead-loop refusal (bro-b961a)', () => {
  test('a connection that opens sessions without a completed turn is refused — no session is opened for it', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listenAcp(fake, { acpMaxOpens: 1 });
    const c = openClient(url);
    try {
      await c.agent.request('initialize', INIT_PARAMS);
      const s = (await c.agent.request('session/new', { cwd: '/work', mcpServers: [] })) as {
        sessionId: string;
      };
      assert.equal(s.sessionId, 'sess-1');
      assert.equal(fake.sessions.length, 1);
      // the second open on the same connection crosses the churn budget —
      // the refusal is a JSON-RPC error naming the scope, and NO session
      // is opened for it: the session count is the proof it cost no quota
      await assert.rejects(
        c.agent.request('session/new', { cwd: '/work', mcpServers: [] }),
        (e: unknown) =>
          e instanceof RequestError && e.code === -32003 && /dead loop/.test(e.message)
      );
      assert.equal(fake.sessions.length, 1);
    } finally {
      await c.conn.close();
      await close();
    }
  });

  test('a connection whose turns complete is never refused — the churn measure is opens minus completions', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', uniqueSessions: true });
    const { url, close } = await listenAcp(fake, { acpMaxOpens: 1 });
    const c = openClient(url);
    try {
      await c.agent.request('initialize', INIT_PARAMS);
      // a budget of ONE open would refuse a second session/new if the
      // first turn never settled — every prompt here completes, so the
      // measure stays at zero however many turns the connection takes
      for (let i = 0; i < 3; i++) {
        const s = (await c.agent.request('session/new', {
          cwd: '/work',
          mcpServers: [],
        })) as { sessionId: string };
        await c.agent.request('session/prompt', {
          sessionId: s.sessionId,
          prompt: [{ type: 'text', text: 'x' }],
        });
      }
      assert.equal(fake.sessions.length, 3);
    } finally {
      await c.conn.close();
      await close();
    }
  });

  test('the refusal is the connection’s own — a second connection is not implicated', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', uniqueSessions: true });
    const { url, close } = await listenAcp(fake, { acpMaxOpens: 1 });
    const a = openClient(url);
    const b = openClient(url);
    try {
      await a.agent.request('initialize', INIT_PARAMS);
      await a.agent.request('session/new', { cwd: '/work', mcpServers: [] });
      // connection A trips its own churn budget
      await assert.rejects(
        a.agent.request('session/new', { cwd: '/work', mcpServers: [] }),
        (e: unknown) => e instanceof RequestError && e.code === -32003
      );
      // connection B carries its own scope — its first open is admitted
      await b.agent.request('initialize', INIT_PARAMS);
      const s = (await b.agent.request('session/new', { cwd: '/work', mcpServers: [] })) as {
        sessionId: string;
      };
      assert.equal(s.sessionId, 'sess-2');
      assert.equal(fake.sessions.length, 2);
    } finally {
      await a.conn.close();
      await b.conn.close();
      await close();
    }
  });
});
