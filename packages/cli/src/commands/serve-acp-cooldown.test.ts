/** serve `/api/v1/acp` — the wall cooldown (spec bro-i6811). The
 *  brokered transport rides the SAME account as the conductor, so a wall
 *  that closed the conductor's lane closes this one too: the refusal is
 *  spoken before the session opens and costs no quota. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { client, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type { ClientConnection, ClientContext, InitializeRequest } from '@agentclientprotocol/sdk';
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client';
import { fakeAcpAgent, type FakeAcpAgent } from '@broject/providers/testkit';
import { acpTransport } from './serve-acp.ts';
import { authHeaders, listen, serveDeps as deps } from './serve-testkit.ts';

const CFG = {
  backend: 'dv-acp',
  entry: { type: 'acp' as const, command: 'dv acp' },
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

const listenAcp = (fake: FakeAcpAgent) =>
  listen(deps({ acp: acpTransport(CFG, { acp: { peer: fake.app } }) }));

describe('serve /api/v1/acp — the wall cooldown (bro-i6811)', () => {
  test('the wall closes the transport — the next session/new opens NO session', async () => {
    const fake = fakeAcpAgent({ failPrompt: 'rate-limit' });
    const { url, close } = await listenAcp(fake);
    const c = openClient(url);
    try {
      await c.agent.request('initialize', INIT_PARAMS);
      const s = (await c.agent.request('session/new', { cwd: '/work', mcpServers: [] })) as {
        sessionId: string;
      };
      assert.equal(s.sessionId, 'sess-1');
      // the account says no on the turn — the lane closes
      await assert.rejects(
        c.agent.request('session/prompt', {
          sessionId: s.sessionId,
          prompt: [{ type: 'text', text: 'x' }],
        })
      );
      assert.equal(fake.sessions.length, 1);
      // the next session/new is refused BEFORE the spawn — the session
      // count is the proof: no session, no quota
      await assert.rejects(
        c.agent.request('session/new', { cwd: '/work', mcpServers: [] }),
        (e: unknown) => e instanceof RequestError && e.code === -32004
      );
      assert.equal(fake.sessions.length, 1);
    } finally {
      await c.conn.close();
      await close();
    }
  });

  test('a healthy transport opens its sessions as before', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok' });
    const { url, close } = await listenAcp(fake);
    const c = openClient(url);
    try {
      await c.agent.request('initialize', INIT_PARAMS);
      await c.agent.request('session/new', { cwd: '/work', mcpServers: [] });
      await c.agent.request('session/new', { cwd: '/work', mcpServers: [] });
      assert.equal(fake.sessions.length, 2);
    } finally {
      await c.conn.close();
      await close();
    }
  });
});
