/**
 * `bro acp proxy` e2e (specs/bro-bhyo1.md §verify) — a real `client()`
 * app drives the proxy over one memory-stream pair; the proxy's
 * downstream is a real `agent()` app (`fakeAcpAgent` or bespoke) over
 * the paired stream. Same wire shape `ndJsonStream` produces, minus
 * the byte encoding — the pump moves message objects, so the seam is
 * the forwarding logic, not the codec.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node --test runs each file in its own process — blanking the
// telemetry endpoint here keeps otelSpan ends from POSTing to the
// operator's real collector (a pending connect there would also hold
// the process alive past the assertions)
process.env.BRO_TELEMETRY = '0';

import { agent, client, RequestError } from '@agentclientprotocol/sdk';
import type {
  AgentConnection,
  AnyMessage,
  ClientConnection,
  ClientContext,
  JsonRpcId,
  PermissionOption,
  SessionUpdate,
  Stream,
} from '@agentclientprotocol/sdk';
import { gitCommonDir, testGit } from '@broject/core';
import {
  ACP_PROXY_READ_HIGH_WATER,
  ACP_PROXY_WRITE_HIGH_WATER,
  acpProxy,
  type AcpAgentOverlay,
  type AcpProxyPermissionCall,
  type AcpProxySeam,
  type AcpProxyToolCall,
} from './acp-proxy.ts';
import { fakeAcpAgent, type FakeAcpAgent } from './testkit.ts';

/** In-process Stream pair — the object-message shape the pump and the
 *  SDK apps both consume. `a` writes into `b`'s readable and vv. */
function streamPair(): [Stream, Stream] {
  const ab = new TransformStream<AnyMessage>();
  const ba = new TransformStream<AnyMessage>();
  return [
    { writable: ab.writable, readable: ba.readable },
    { writable: ba.writable, readable: ab.readable },
  ];
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
} as const;

interface Rig {
  fake: FakeAcpAgent;
  conn: ClientConnection;
  agentConn: AgentConnection;
  acp: ClientContext;
  proxyDone: Promise<number>;
  /** session/update notifications the client leg received — verbatim
   *  forwarding assertions read this, not just the agent's emit. */
  updates: unknown[];
  /** session/request_permission asks that reached the CLIENT — a
   *  proxy-decided ask never lands here. */
  permAsks: unknown[];
  /** The process ends the test rig — closing a stream's WRITABLE is the
   *  stdin-EOF the real proxy sees (conn.close() only cancels its own
   *  receive reader; it leaves the outgoing side open). */
  clientSide: Stream;
  agentSide: Stream;
}

/** client → proxy → fake agent — all in-process. `fakeOpts` carries
 *  the same option bag fakeAcpAgent takes (replyText, askPermission,
 *  failPrompt, …); `clientAnswer` scripts the client's permission
 *  response — default: select the first offered option; `agent` is
 *  the bro-tegz2 overlay (slash commands, bro's initialize identity). */
function rig(
  fakeOpts: Parameters<typeof fakeAcpAgent>[0],
  seam?: AcpProxySeam,
  log: (line: string) => void = () => {},
  agent?: AcpAgentOverlay,
  clientAnswer?: (params: { options: Array<{ optionId: string }> }) => unknown
): Rig {
  const fake = fakeAcpAgent(fakeOpts);
  const updates: unknown[] = [];
  const permAsks: unknown[] = [];
  const [clientSide, proxyUp] = streamPair();
  const [proxyDown, agentSide] = streamPair();
  const agentConn = fake.app.connect(agentSide);
  const conn = client({ name: 'test-client' })
    .onRequest('session/request_permission', ctx => {
      permAsks.push(ctx.params);
      return (clientAnswer?.(ctx.params) ?? {
        outcome: { outcome: 'selected', optionId: ctx.params.options[0]!.optionId },
      }) as { outcome: { outcome: 'selected'; optionId: string } };
    })
    .onNotification('session/update', ctx => {
      updates.push(ctx.params);
    })
    .connect(clientSide);
  const proxyDone = acpProxy(proxyUp, proxyDown, { seam, log, agent });
  return {
    fake,
    conn,
    agentConn,
    acp: conn.agent,
    proxyDone,
    updates,
    permAsks,
    clientSide,
    agentSide,
  };
}

/** Client hangup — EOF on the wire the proxy reads. */
async function hangupClient(r: Rig): Promise<void> {
  r.conn.close();
  await r.clientSide.writable
    .getWriter()
    .close()
    .catch(() => {});
}

/** Agent death — EOF on the wire the proxy reads downstream. */
async function hangupAgent(r: Rig): Promise<void> {
  r.agentConn.close();
  await r.agentSide.writable
    .getWriter()
    .close()
    .catch(() => {});
}

async function close(r: Rig): Promise<number> {
  await hangupClient(r);
  const code = await r.proxyDone;
  await hangupAgent(r);
  return code;
}

/** initialize + session/new — returns the session id. */
async function openSession(acp: ClientContext, cwd = '/tmp/proxy-repo'): Promise<string> {
  const init = await acp.request('initialize', INIT_PARAMS);
  assert.equal(typeof (init as { protocolVersion?: number }).protocolVersion, 'number');
  const ses = (await acp.request('session/new', { cwd, mcpServers: [] })) as {
    sessionId: string;
  };
  return ses.sessionId;
}

/** A bespoke typed `agent()` for the _-methods test — serves the
 *  standard open methods plus `_acpx/echo`, and probes the client back
 *  over `_acpx/client-probe` inside session/prompt. */
function bespokeAgent(stream: Stream, seen: { clientProbe?: unknown; echoParams?: unknown }) {
  return agent({ name: 'bespoke' })
    .onRequest('initialize', ctx => ({
      protocolVersion: ctx.params.protocolVersion,
      authMethods: [],
    }))
    .onRequest('session/new', () => ({ sessionId: 's-custom' }))
    .onRequest<{ q: number }, { echoed: unknown }>(
      '_acpx/echo',
      p => p as { q: number },
      ctx => {
        seen.echoParams = ctx.params;
        return { echoed: ctx.params };
      }
    )
    .onRequest('session/prompt', async ctx => {
      seen.clientProbe = await ctx.client.request('_acpx/client-probe', { n: 1 });
      return { stopReason: 'end_turn' };
    })
    .connect(stream);
}

/** A raw object-level responder — the wire's echo agent minus schema
 *  narrowing: answers by method shape, records each prompt's params.
 *  Used where a typed agent() app's inbound validation would reject
 *  the wire shape under test before the pump's behavior is even
 *  observable (a cwd-less session/new). */
function rawEchoAgent(stream: Stream, seen: { prompts?: unknown }): Promise<void> {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const answer = (id: JsonRpcId | undefined, result: unknown) =>
    writer.write({ jsonrpc: '2.0', id, result } as AnyMessage);
  return (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        await writer.close().catch(() => {});
        return;
      }
      const m = value as { id?: JsonRpcId; method?: string; params?: { prompt?: unknown } };
      if (m.method === 'initialize') {
        await answer(m.id, { protocolVersion: 1 });
      } else if (m.method === 'session/new') {
        await answer(m.id, { sessionId: 's-nc' });
      } else if (m.method === 'session/prompt') {
        seen.prompts = m.params?.prompt;
        await answer(m.id, { stopReason: 'end_turn' });
      }
    }
  })();
}

describe('acpProxy — verbatim forwarding', () => {
  test('initialize/session/new/session/prompt round-trip with no seam — byte-identical params', async () => {
    const r = rig({ replyText: 'hello' });
    try {
      const init = (await r.acp.request('initialize', INIT_PARAMS)) as {
        protocolVersion: number;
        agentInfo?: { name?: string };
      };
      assert.equal(init.agentInfo?.name, 'fake-acp');
      const sessionId = await openSession(r.acp, '/tmp/repo-one');
      assert.equal(sessionId, 'sess-1');
      assert.deepEqual(r.fake.sessions, [{ cwd: '/tmp/repo-one' }]);
      assert.equal(r.fake.clientCapabilities !== undefined, true);

      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'ping' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      // no seam → the prompt crossed untouched
      assert.equal(r.fake.prompts.length, 1);
      assert.deepEqual(
        r.fake.blocks[0]!.map(b => b.type),
        ['text']
      );
      assert.equal(r.fake.prompts[0], 'ping');
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('session/update and session/request_permission cross verbatim agent→client', async () => {
    const r = rig({
      replyText: 'chunk',
      askPermission: [{ optionId: 'allow-once', kind: 'allow_once', name: 'allow' }],
    });
    try {
      await openSession(r.acp);
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      // the scripted permission ask reached the real client handler and
      // its answer crossed back to the agent
      assert.deepEqual(r.fake.permissionOutcome, {
        outcome: 'selected',
        optionId: 'allow-once',
      });
      // the agent's session/update chunk crossed verbatim — captured
      // client-side, not just emitted downstream
      assert.deepEqual(r.updates, [
        {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'chunk' },
          },
        },
      ]);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('unknown _-methods forward both ways, responses and errors verbatim', async () => {
    const seen: { clientProbe?: unknown; echoParams?: unknown } = {};
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const agentConn = bespokeAgent(agentSide, seen);
    const conn = client({ name: 'test-client' })
      .onRequest<{ n: number }, { ok: boolean; got: unknown }>(
        '_acpx/client-probe',
        p => p as { n: number },
        ctx => ({ ok: true, got: ctx.params })
      )
      .connect(clientSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    try {
      await conn.agent.request('initialize', INIT_PARAMS);
      const echoed = await conn.agent.request<{ echoed: unknown }>('_acpx/echo', { q: 42 });
      assert.deepEqual(echoed, { echoed: { q: 42 } });
      await conn.agent.request('session/new', { cwd: '/x', mcpServers: [] });
      await conn.agent.request('session/prompt', {
        sessionId: 's-custom',
        prompt: [{ type: 'text', text: 'go' }],
      });
      // the agent's outbound _-method reached the client verbatim
      assert.deepEqual(seen.clientProbe, { ok: true, got: { n: 1 } });
      // an unknown method the agent does NOT serve crosses an error back
      await assert.rejects(
        conn.agent.request('_acpx/missing', {}),
        (e: unknown) => e instanceof RequestError && e.code === -32601
      );
    } finally {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await proxyDone, 0);
      agentConn.close();
      await agentSide.writable
        .getWriter()
        .close()
        .catch(() => {});
    }
  });

  test('a downstream error crosses verbatim — code and message, no rewrite', async () => {
    const r = rig({ failPrompt: 'auth-gateway-504' });
    try {
      await openSession(r.acp);
      await assert.rejects(
        r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'x' }],
        }),
        (e: unknown) =>
          e instanceof RequestError &&
          e.code === -32603 &&
          e.message === 'auth gateway returned HTTP 504'
      );
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('downstream dead mid-turn → pending prompt fails visibly, verdict 1', async () => {
    const r = rig({ holdEnd: () => new Promise(() => {}) });
    const sessionId = await openSession(r.acp);
    const promptP = r.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'x' }],
    });
    // let the prompt land downstream, then kill the agent leg
    await new Promise(r2 => setTimeout(r2, 50));
    await hangupAgent(r);
    await assert.rejects(
      promptP,
      (e: unknown) =>
        e instanceof RequestError &&
        e.code === -32603 &&
        e.message === 'acp proxy: downstream agent closed'
    );
    assert.equal(await r.proxyDone, 1);
    await hangupClient(r);
  });
});

describe('acpProxy — context injection seam', () => {
  const seam = (sessionCtx?: string, promptCtx?: string): AcpProxySeam => ({
    sessionContext: async () => ({ text: sessionCtx, settled: true }),
    promptContext: async () => promptCtx,
  });

  test('first prompt gets ONE prepended block (session + prompt context); later prompts get prompt context only', async () => {
    const calls: Array<{ cwd: string; sessionId: string }> = [];
    const r = rig(
      { replyText: 'ok' },
      {
        sessionContext: async (cwd, sessionId) => {
          calls.push({ cwd, sessionId });
          return { text: 'SESSION CTX', settled: true };
        },
        promptContext: async () => 'PROMPT CTX',
      }
    );
    try {
      const sessionId = await openSession(r.acp, '/tmp/session-repo');
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'one' }],
      });
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      });
      assert.equal(r.fake.prompts.length, 2);
      // first prompt: session ctx + prompt ctx in one block, original intact
      const first = r.fake.blocks[0]!;
      assert.equal(first.length, 2);
      assert.deepEqual(first[0], { type: 'text', text: 'SESSION CTX\nPROMPT CTX' });
      assert.deepEqual(first[1], { type: 'text', text: 'one' });
      // second prompt: prompt ctx only — no re-injection of session start
      const second = r.fake.blocks[1]!;
      assert.equal(second.length, 2);
      assert.deepEqual(second[0], { type: 'text', text: 'PROMPT CTX' });
      assert.deepEqual(second[1], { type: 'text', text: 'two' });
      // the seam saw the session/new cwd, not the proxy's process cwd
      assert.deepEqual(calls, [{ cwd: '/tmp/session-repo', sessionId: 'sess-1' }]);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('each session injects session context on ITS first prompt — state is per session, not global', async () => {
    const sessionCalls: string[] = [];
    const r = rig(
      { replyText: 'ok', uniqueSessions: true },
      {
        sessionContext: async (_cwd, sessionId) => {
          sessionCalls.push(sessionId);
          return { text: `S(${sessionId})`, settled: true };
        },
        promptContext: async () => 'P',
      }
    );
    try {
      const a = await openSession(r.acp);
      const b = await openSession(r.acp);
      assert.notEqual(a, b);
      await r.acp.request('session/prompt', {
        sessionId: a,
        prompt: [{ type: 'text', text: 'p1' }],
      });
      await r.acp.request('session/prompt', {
        sessionId: b,
        prompt: [{ type: 'text', text: 'p2' }],
      });
      // both sessions' first prompts got their own session block —
      // a session-keyed flag, not a global "already injected" one
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: `S(${a})\nP` });
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: `S(${b})\nP` });
      assert.deepEqual(sessionCalls, [a, b]);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('absent seam stays byte-identical', async () => {
    const bare = rig({ replyText: 'ok' });
    try {
      await openSession(bare.acp);
      await bare.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'p1' }],
      });
      assert.equal(bare.fake.blocks[0]!.length, 1);
      assert.deepEqual(bare.fake.blocks[0]![0], { type: 'text', text: 'p1' });
    } finally {
      assert.equal(await close(bare), 0);
    }
  });

  test('an unsettled session collection injects nothing and retries on the next prompt', async () => {
    let calls = 0;
    const r = rig(
      { replyText: 'ok' },
      {
        sessionContext: async () => {
          calls++;
          // first attempt times out partial — unsettled; the retry settles
          return calls === 1
            ? { text: 'PARTIAL', settled: false }
            : { text: 'SETTLED', settled: true };
        },
        promptContext: async () => 'P',
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'one' }],
      });
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      });
      // prompt 1: unsettled → partial text rides (the hook emits
      // partial output the same way) but the slot stays open
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'PARTIAL\nP' });
      // prompt 2: the retry settled → full session ctx lands and the
      // slot closes
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: 'SETTLED\nP' });
      assert.equal(calls, 2);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a cancelled held first prompt yields the slot — the retry gets session context', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r2 => {
      release = r2;
    });
    const r = rig(
      { replyText: 'ok' },
      {
        sessionContext: async () => {
          await gate;
          return { text: 'S', settled: true };
        },
        promptContext: async () => 'P',
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      const a = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'a' }],
      });
      // cancel while A's seam collection is held → answered upstream,
      // never crosses, and does NOT burn the session's first-prompt slot
      await new Promise(r2 => setTimeout(r2, 50));
      await r.acp.notify('session/cancel', { sessionId });
      release();
      assert.equal((await a).stopReason, 'cancelled');
      assert.equal(r.fake.prompts.length, 0);
      // the next prompt IS the first to cross — session ctx must ride it
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'b' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'S\nP' });
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('session/fork registers the fork by its RESPONSE id — prompts on it get the seam', async () => {
    const r = rig({ replyText: 'ok' }, seam('S', 'P'));
    try {
      const a = await openSession(r.acp);
      const fork = (await r.acp.request('session/fork', {
        sessionId: a,
        cwd: '/tmp/proxy-repo',
        mcpServers: [],
      })) as { sessionId: string };
      assert.equal(fork.sessionId, 'sess-fork-1');
      assert.deepEqual(r.fake.forks, [a]);
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: fork.sessionId,
        prompt: [{ type: 'text', text: 'x' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      // stamped by the response id → the fork is a real session with
      // its own first-prompt slot, not a bypass around the seam
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'S\nP' });
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('session/close releases the session — a later prompt on the id skips the seam', async () => {
    const promptCalls: string[] = [];
    const r = rig(
      { replyText: 'ok' },
      {
        sessionContext: async () => ({ text: 'S', settled: true }),
        promptContext: async (cwd, sessionId) => {
          promptCalls.push(sessionId);
          return 'P';
        },
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'one' }],
      });
      assert.deepEqual(promptCalls, [sessionId]);
      await r.acp.request('session/close', { sessionId });
      assert.deepEqual(r.fake.closes, [sessionId]);
      // after close the session entry is gone — this prompt takes the
      // un-stamped path: verbatim forward, no seam calls, no injection
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      });
      assert.deepEqual(promptCalls, [sessionId]);
      assert.equal(r.fake.blocks[1]!.length, 1);
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: 'two' });
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('empty seam output injects nothing; a seam that throws stays fail-open', async () => {
    const r = rig(
      { replyText: 'ok' },
      {
        sessionContext: async () => {
          throw new Error('probe died');
        },
        promptContext: async () => '',
      }
    );
    try {
      await openSession(r.acp);
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'x' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      assert.equal(r.fake.blocks[0]!.length, 1);
      assert.deepEqual(r.fake.blocks[0]![0], { type: 'text', text: 'x' });
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('session/cancel while the seam collects → held prompt answers cancelled, downstream never sees it', async () => {
    let entered!: () => void;
    let release!: () => void;
    const gateEntered = new Promise<void>(r2 => {
      entered = r2;
    });
    const gate = new Promise<void>(r2 => {
      release = r2;
    });
    const r = rig(
      { replyText: 'ok' },
      {
        sessionContext: async () => {
          entered();
          await gate;
          return { text: 'LATE CTX', settled: true };
        },
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      const promptP = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'x' }],
      });
      await gateEntered;
      await r.acp.notify('session/cancel', { sessionId });
      release();
      const res = await promptP;
      assert.equal(res.stopReason, 'cancelled');
      // the prompt was answered by the proxy — the downstream wire
      // never carried it (the wire never shows a prompt after its cancel)
      assert.equal(r.fake.prompts.length, 0);
      // and the cancel itself never crossed either — its whole target
      // set was held prompts the proxy already answered
      assert.deepEqual(r.fake.cancels, []);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('cancel crosses while crossed work still runs — held sibling aborted, in-flight prompt keeps its own answer', async () => {
    let releaseTurn!: () => void;
    let releaseSeam!: () => void;
    let seamEntered!: () => void;
    const turnGate = new Promise<void>(r2 => {
      releaseTurn = r2;
    });
    const seamGate = new Promise<void>(r2 => {
      releaseSeam = r2;
    });
    const entered = new Promise<void>(r2 => {
      seamEntered = r2;
    });
    const r = rig(
      { replyText: 'ok', holdEnd: () => turnGate },
      {
        sessionContext: async () => ({ text: 'S', settled: true }),
        promptContext: async (_c, _s, text) => {
          if (text === 'b-text') {
            seamEntered();
            await seamGate;
          }
          return 'P';
        },
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      // A crosses (fast seam) and runs — the fake's holdEnd keeps its
      // turn open downstream
      const a = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'a-text' }],
      });
      await new Promise(r2 => setTimeout(r2, 50));
      assert.equal(r.fake.prompts.length, 1);
      // B queues behind its gated prompt-submit collection — held
      const b = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'b-text' }],
      });
      await entered;
      await r.acp.notify('session/cancel', { sessionId });
      releaseSeam();
      releaseTurn();
      // B was held → the proxy answered it; A was crossed → the
      // agent's own answer still lands (no duplicate/forked response)
      assert.equal((await b).stopReason, 'cancelled');
      assert.equal((await a).stopReason, 'end_turn');
      // the cancel's downstream write settles a few microtasks behind
      // A's upstream answer — give the wire a tick, then assert: the
      // cancel crossed exactly once, A was its real target
      await new Promise(r2 => setTimeout(r2, 30));
      assert.deepEqual(r.fake.cancels, ['sess-1']);
      assert.equal(r.fake.prompts.length, 1);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('two prompts held behind one collection are both aborted — the second never crosses after its upstream answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r2 => {
      release = r2;
    });
    const r = rig(
      { replyText: 'ok' },
      {
        sessionContext: async () => {
          await gate;
          return { text: 'S', settled: true };
        },
        promptContext: async () => 'P',
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      const a = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'a' }],
      });
      // B arrives while A is still held — it is held too, not just
      // tracked by a single-slot injecting flag
      const b = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'b' }],
      });
      await new Promise(r2 => setTimeout(r2, 50));
      await r.acp.notify('session/cancel', { sessionId });
      release();
      assert.equal((await a).stopReason, 'cancelled');
      assert.equal((await b).stopReason, 'cancelled');
      assert.equal(r.fake.prompts.length, 0);
      assert.deepEqual(r.fake.cancels, []);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a session without a cwd skips the seam — byte-identical forwarding, no proxy-cwd fallback', async () => {
    const calls: string[] = [];
    const seen: { prompts?: unknown } = {};
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    // bespoke downstream as a RAW responder — a typed agent() app
    // schema-validates inbound and rejects a cwd-less session before
    // the wire question is even asked
    const responder = rawEchoAgent(agentSide, seen);
    const conn = client({ name: 'test-client' }).connect(clientSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      seam: {
        sessionContext: async cwd => {
          calls.push(cwd);
          return { text: 'S', settled: true };
        },
        promptContext: async cwd => {
          calls.push(cwd);
          return 'P';
        },
      },
      log: () => {},
    });
    try {
      await conn.agent.request('initialize', INIT_PARAMS);
      const ses = (await conn.agent.request('session/new', { mcpServers: [] } as never)) as {
        sessionId: string;
      };
      assert.equal(ses.sessionId, 's-nc');
      const res = await conn.agent.request<{ stopReason: string }>('session/prompt', {
        sessionId: 's-nc',
        prompt: [{ type: 'text', text: 'x' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      assert.deepEqual(seen.prompts, [{ type: 'text', text: 'x' }]);
      // the seam never ran — cwd-less session, not the proxy's cwd
      assert.deepEqual(calls, []);
    } finally {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await proxyDone, 0);
      await responder;
    }
  });
});

describe('acpProxy — latency', () => {
  test('per-turn overhead vs the direct leg (in-process floor, printed)', async () => {
    const TURNS = 25;
    const directAgent = fakeAcpAgent({ replyText: 'x' });
    const directConn = client({ name: 'direct' }).connect(directAgent.app);
    const t0 = Date.now();
    {
      const a = directConn.agent;
      await a.request('initialize', INIT_PARAMS);
      const ses = (await a.request('session/new', { cwd: '/x', mcpServers: [] })) as {
        sessionId: string;
      };
      for (let i = 0; i < TURNS; i++) {
        await a.request('session/prompt', {
          sessionId: ses.sessionId,
          prompt: [{ type: 'text', text: 'p' }],
        });
      }
    }
    const directMs = (Date.now() - t0) / TURNS;
    directConn.close();

    const r = rig({ replyText: 'x' });
    const t1 = Date.now();
    {
      await openSession(r.acp, '/x');
      for (let i = 0; i < TURNS; i++) {
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'p' }],
        });
      }
    }
    const proxyMs = (Date.now() - t1) / TURNS;
    await close(r);
    console.error(
      `acp proxy overhead: direct ${directMs.toFixed(2)}ms → proxied ${proxyMs.toFixed(2)}ms per turn (in-process floor)`
    );
    // a sane bound, not a flaky one — real-agent turns are dominated by
    // the agent; the assertion exists to catch a serialization bug
    assert.ok(proxyMs - directMs < 50, `proxy overhead ${proxyMs - directMs}ms/turn`);
  });
});

describe('acpProxy — tool_call guards + turn-end stop gate (bro-u2eps)', () => {
  /** The scripted tool-call update sequence — announcement, a progress
   *  delta (must NOT fire the seam), and the terminal completion. */
  const TOOL_CALL_UPDATES: SessionUpdate[] = [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'run gh',
      name: 'Bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'gh pr view 42' },
    },
    { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
  ];

  test('tool_call + terminal tool_call_update run the seam in-process — advisory lines ride the next prompt injection', async () => {
    const calls: Array<AcpProxyToolCall & { cwd: string; sessionId: string }> = [];
    const r = rig(
      { replyText: 'ok', updates: [...TOOL_CALL_UPDATES] },
      {
        toolCall: async (cwd, sessionId, call) => {
          calls.push({ ...call, cwd, sessionId });
          // say lines come back on the terminal event — the announce's
          // return is the arming side-effect, not text (guard sweeps see
          // the repo AFTER the call, so 'end' is where they run)
          return call.phase === 'end' ? ['GUARD SAY line'] : [];
        },
      }
    );
    try {
      await openSession(r.acp, '/tmp/guard-repo');
      await r.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'one' }],
      });
      // the seam is the in-process hook channel — a real call with the
      // session's own cwd, not a spawned run.sh (there is no subprocess
      // in the proxy path: the seam IS the boundary)
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map(c => c.phase),
        ['start', 'end']
      );
      assert.equal(calls[0]!.cwd, '/tmp/guard-repo');
      assert.equal(calls[0]!.sessionId, 'sess-1');
      assert.equal(calls[0]!.toolCallId, 'tc-1');
      assert.deepEqual(calls[0]!.input, { command: 'gh pr view 42' });
      assert.equal(calls[1]!.status, 'completed');
      // say lines buffered per session → the NEXT crossed prompt
      // carries them as the injected block (the advisory seam that
      // already exists — never a fabricated wire message)
      await r.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'two' }],
      });
      assert.equal(r.fake.blocks.length, 2);
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: 'GUARD SAY line' });
      assert.deepEqual(r.fake.blocks[1]![1], { type: 'text', text: 'two' });
      // and the session/update notifications crossed verbatim meanwhile
      // (the fake replays its scripted updates per prompt — 2 turns)
      assert.equal(r.updates.length, 6);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a blocking stop gate holds the response and issues exactly ONE gate re-prompt — the gate turn ends unconditionally', async () => {
    const seen: { prompts: string[]; ids: JsonRpcId[] } = { prompts: [], ids: [] };
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    // raw responder — 'end_turn' on the client prompt, 'refusal' on the
    // gate re-prompt: the forwarded answer proves WHICH turn's response
    // crossed under the client's id
    const responder = (async () => {
      const reader = agentSide.readable.getReader();
      const writer = agentSide.writable.getWriter();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          await writer.close().catch(() => {});
          return;
        }
        const m = value as {
          id?: JsonRpcId;
          method?: string;
          params?: { prompt?: Array<{ text?: string }> };
        };
        if (m.method === 'initialize') {
          await writer.write({
            jsonrpc: '2.0',
            id: m.id,
            result: { protocolVersion: 1 },
          } as AnyMessage);
        } else if (m.method === 'session/new') {
          await writer.write({
            jsonrpc: '2.0',
            id: m.id,
            result: { sessionId: 's-nc' },
          } as AnyMessage);
        } else if (m.method === 'session/prompt') {
          const n = seen.prompts.length;
          seen.prompts.push((m.params?.prompt ?? []).map(b => b.text ?? '').join(''));
          seen.ids.push(m.id!);
          await writer.write({
            jsonrpc: '2.0',
            id: m.id,
            result: { stopReason: n === 0 ? 'end_turn' : 'refusal' },
          } as AnyMessage);
        }
      }
    })();
    let gateCalls = 0;
    const conn = client({ name: 'test-client' }).connect(clientSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      seam: {
        stopGate: async (cwd, sessionId) => {
          gateCalls++;
          assert.equal(cwd, '/gate-repo');
          assert.equal(sessionId, 's-nc');
          return { block: 'finish the review threads first' };
        },
      },
      log: () => {},
    });
    try {
      await conn.agent.request('initialize', INIT_PARAMS);
      await conn.agent.request('session/new', { cwd: '/gate-repo', mcpServers: [] });
      const res = await conn.agent.request<{ stopReason: string }>('session/prompt', {
        sessionId: 's-nc',
        prompt: [{ type: 'text', text: 'x' }],
      });
      // exactly one re-prompt, carrying the gate's message verbatim —
      // the second end-of-turn passed without a second evaluation
      assert.deepEqual(seen.prompts, ['x', 'finish the review threads first']);
      assert.equal(gateCalls, 1);
      // the client's request resolves ONCE — with the last turn's
      // outcome under its own id (the held end_turn never crossed)
      assert.equal(res.stopReason, 'refusal');
      // the gate prompt was proxy-originated — a namespaced string id,
      // never a client id collision
      assert.equal(seen.prompts.length, 2);
      assert.notEqual(seen.ids[1], seen.ids[0]);
      assert.match(String(seen.ids[1]), /^bro-gate-/);
    } finally {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await proxyDone, 0);
      await responder;
    }
  });

  test('no block → the response forwards verbatim; hints ride the next prompt', async () => {
    let gateCalls = 0;
    const r = rig(
      { replyText: 'ok' },
      {
        stopGate: async () => {
          gateCalls++;
          return { hints: ['queue is watching'] };
        },
      }
    );
    try {
      await openSession(r.acp);
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'one' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      assert.equal(r.fake.prompts.length, 1);
      assert.equal(gateCalls, 1);
      await r.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'two' }],
      });
      assert.deepEqual(r.fake.blocks[1]![0], { type: 'text', text: 'queue is watching' });
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('BRO_HOOKS=0 makes the proxy a pure transport — neither hook half fires', async () => {
    const prev = process.env.BRO_HOOKS;
    process.env.BRO_HOOKS = '0';
    try {
      let toolCalls = 0;
      let gates = 0;
      const r = rig(
        { replyText: 'ok', updates: [...TOOL_CALL_UPDATES] },
        {
          toolCall: async () => {
            toolCalls++;
            return ['x'];
          },
          stopGate: async () => {
            gates++;
            return { block: 'x' };
          },
        }
      );
      try {
        await openSession(r.acp);
        const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'one' }],
        });
        assert.equal(res.stopReason, 'end_turn');
        assert.equal(r.fake.prompts.length, 1);
        assert.equal(toolCalls, 0);
        assert.equal(gates, 0);
        assert.equal(r.updates.length, 3);
      } finally {
        assert.equal(await close(r), 0);
      }
    } finally {
      if (prev === undefined) delete process.env.BRO_HOOKS;
      else process.env.BRO_HOOKS = prev;
    }
  });

  test('a throwing stopGate seam passes the held response verbatim — fail-open, logged', async () => {
    const logs: string[] = [];
    const r = rig(
      { replyText: 'ok' },
      {
        stopGate: async () => {
          throw new Error('gate probe died');
        },
      },
      l => logs.push(l)
    );
    try {
      await openSession(r.acp);
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'one' }],
      });
      // a crashed eval never corrupts the wire — the turn's own
      // response crosses verbatim and no gate prompt was sent
      assert.equal(res.stopReason, 'end_turn');
      assert.equal(r.fake.prompts.length, 1);
      await new Promise(r2 => setTimeout(r2, 30));
      assert.equal(
        logs.some(l => l.includes('stop gate')),
        true
      );
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a throwing toolCall seam never breaks the wire — the update still crosses', async () => {
    const logs: string[] = [];
    const fake = fakeAcpAgent({ replyText: 'ok', updates: [...TOOL_CALL_UPDATES] });
    const updates: unknown[] = [];
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const agentConn = fake.app.connect(agentSide);
    const conn = client({ name: 'test-client' })
      .onNotification('session/update', ctx => {
        updates.push(ctx.params);
      })
      .connect(clientSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      seam: {
        toolCall: async () => {
          throw new Error('guard engine died');
        },
      },
      log: l => logs.push(l),
    });
    try {
      await conn.agent.request('initialize', INIT_PARAMS);
      await conn.agent.request('session/new', { cwd: '/x', mcpServers: [] });
      const res = await conn.agent.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'one' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      assert.equal(updates.length, 3);
      // a crashed eval is a log line, never a wire break
      await new Promise(r2 => setTimeout(r2, 30));
      assert.equal(logs.filter(l => l.includes('tool_call')).length >= 1, true);
    } finally {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await proxyDone, 0);
      agentConn.close();
      await agentSide.writable
        .getWriter()
        .close()
        .catch(() => {});
    }
  });

  test('a prompt queued during gate eval never races the gate turn — it crosses only after discharge', async () => {
    const seen: string[] = [];
    let releaseEval!: () => void;
    let releaseGateTurn!: () => void;
    const evalLatch = new Promise<void>(r2 => {
      releaseEval = r2;
    });
    const gateTurnLatch = new Promise<void>(r2 => {
      releaseGateTurn = r2;
    });
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const responder = (async () => {
      const reader = agentSide.readable.getReader();
      const writer = agentSide.writable.getWriter();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          await writer.close().catch(() => {});
          return;
        }
        const m = value as {
          id?: JsonRpcId;
          method?: string;
          params?: { prompt?: Array<{ text?: string }> };
        };
        if (m.method === 'initialize') {
          await writer.write({
            jsonrpc: '2.0',
            id: m.id,
            result: { protocolVersion: 1 },
          } as AnyMessage);
        } else if (m.method === 'session/new') {
          await writer.write({
            jsonrpc: '2.0',
            id: m.id,
            result: { sessionId: 's-rq' },
          } as AnyMessage);
        } else if (m.method === 'session/prompt') {
          seen.push((m.params?.prompt ?? []).map(b => b.text ?? '').join(''));
          if (seen.length === 2) {
            // the gate re-prompt — its response parks until released so
            // the gate turn is provably still in flight while we check
            // the wire for the queued client prompt
            void gateTurnLatch.then(() =>
              writer.write({
                jsonrpc: '2.0',
                id: m.id,
                result: { stopReason: 'refusal' },
              } as AnyMessage)
            );
          } else {
            await writer.write({
              jsonrpc: '2.0',
              id: m.id,
              result: { stopReason: 'end_turn' },
            } as AnyMessage);
          }
        }
      }
    })();
    const conn = client({ name: 'test-client' }).connect(clientSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      seam: {
        stopGate: async () => {
          await evalLatch;
          return { block: 'gate msg' };
        },
      },
      log: () => {},
    });
    try {
      await conn.agent.request('initialize', INIT_PARAMS);
      await conn.agent.request('session/new', { cwd: '/gate-repo', mcpServers: [] });
      const firstP = conn.agent.request<{ stopReason: string }>('session/prompt', {
        sessionId: 's-rq',
        prompt: [{ type: 'text', text: 'one' }],
      });
      // let 'one' cross, its end_turn land, and the eval park on the latch
      while (seen.length < 1) {
        await new Promise(r2 => setTimeout(r2, 5));
      }
      await new Promise(r2 => setTimeout(r2, 60));
      // the client's next prompt enqueues DURING the gate eval — the
      // window the chained-.then() barrier leaked through (PR #1067)
      const secondP = conn.agent.request<{ stopReason: string }>('session/prompt', {
        sessionId: 's-rq',
        prompt: [{ type: 'text', text: 'two' }],
      });
      await new Promise(r2 => setTimeout(r2, 30));
      releaseEval();
      while (seen.length < 2) {
        await new Promise(r2 => setTimeout(r2, 5));
      }
      assert.equal(seen[1], 'gate msg');
      // 'two' must wait out the whole gate turn — give any leaked write
      // room to show itself before discharging the gate response
      await new Promise(r2 => setTimeout(r2, 80));
      assert.equal(seen.length, 2);
      releaseGateTurn();
      while (seen.length < 3) {
        await new Promise(r2 => setTimeout(r2, 5));
      }
      assert.equal(seen[2], 'two');
      const [r1, r2res] = await Promise.all([firstP, secondP]);
      assert.equal(r1.stopReason, 'refusal');
      assert.equal(r2res.stopReason, 'end_turn');
    } finally {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await proxyDone, 0);
      await responder;
    }
  });

  test('session/cancel during an in-flight gate turn crosses immediately — a stalled turn still receives it', async () => {
    const seen: string[] = [];
    const cancels: string[] = [];
    let releaseGateTurn!: () => void;
    const gateTurnLatch = new Promise<void>(r2 => {
      releaseGateTurn = r2;
    });
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const responder = (async () => {
      const reader = agentSide.readable.getReader();
      const writer = agentSide.writable.getWriter();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          await writer.close().catch(() => {});
          return;
        }
        const m = value as {
          id?: JsonRpcId;
          method?: string;
          params?: { prompt?: Array<{ text?: string }>; sessionId?: string };
        };
        if (m.method === 'initialize') {
          await writer.write({
            jsonrpc: '2.0',
            id: m.id,
            result: { protocolVersion: 1 },
          } as AnyMessage);
        } else if (m.method === 'session/new') {
          await writer.write({
            jsonrpc: '2.0',
            id: m.id,
            result: { sessionId: 's-cx' },
          } as AnyMessage);
        } else if (m.method === 'session/cancel') {
          cancels.push(m.params?.sessionId ?? '');
        } else if (m.method === 'session/prompt') {
          seen.push((m.params?.prompt ?? []).map(b => b.text ?? '').join(''));
          if (seen.length === 2) {
            // the gate re-prompt — parked until released: any cancel that
            // arrives below lands while the turn is provably in flight
            void gateTurnLatch.then(() =>
              writer.write({
                jsonrpc: '2.0',
                id: m.id,
                result: { stopReason: 'cancelled' },
              } as AnyMessage)
            );
          } else {
            await writer.write({
              jsonrpc: '2.0',
              id: m.id,
              result: { stopReason: 'end_turn' },
            } as AnyMessage);
          }
        }
      }
    })();
    const conn = client({ name: 'test-client' }).connect(clientSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      seam: { stopGate: async () => ({ block: 'gate msg' }) },
      log: () => {},
    });
    try {
      await conn.agent.request('initialize', INIT_PARAMS);
      await conn.agent.request('session/new', { cwd: '/gate-repo', mcpServers: [] });
      const firstP = conn.agent.request<{ stopReason: string }>('session/prompt', {
        sessionId: 's-cx',
        prompt: [{ type: 'text', text: 'one' }],
      });
      // wait for the gate turn to start — its response is parked
      while (seen.length < 2) {
        await new Promise(r2 => setTimeout(r2, 5));
      }
      // the cancel's real target is the in-flight gate turn — it must
      // reach the wire now, not after the discharge it exists to cause
      await conn.agent.notify('session/cancel', { sessionId: 's-cx' });
      await new Promise(r2 => setTimeout(r2, 60));
      assert.deepEqual(cancels, ['s-cx']);
      // the held client request is already answered upstream; the gate
      // turn's late response lands on an empty slot
      assert.equal((await firstP).stopReason, 'cancelled');
      releaseGateTurn();
      await new Promise(r2 => setTimeout(r2, 40));
      assert.equal(seen.length, 2);
    } finally {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await proxyDone, 0);
      await responder;
    }
  });

  test('session/cancel while the gate verdict is pending answers the held prompt cancelled — no gate prompt ever crosses', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>(r2 => {
      releaseGate = r2;
    });
    let gateCalls = 0;
    const r = rig(
      { replyText: 'ok' },
      {
        stopGate: async () => {
          gateCalls++;
          await gate;
          return { block: 'too late — cancelled' };
        },
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      const promptP = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'x' }],
      });
      // let the response land + the eval park on the gate
      await new Promise(r2 => setTimeout(r2, 60));
      assert.equal(gateCalls, 1);
      await r.acp.notify('session/cancel', { sessionId });
      releaseGate();
      assert.equal((await promptP).stopReason, 'cancelled');
      // the cancel settled the held prompt upstream — the gate prompt
      // the block would have sent never crossed downstream
      await new Promise(r2 => setTimeout(r2, 30));
      assert.equal(r.fake.prompts.length, 1);
    } finally {
      assert.equal(await close(r), 0);
    }
  });
});

describe('acpProxy — agent overlay (bro-tegz2)', () => {
  const COMMANDS = [
    { name: 'act', description: 'Open-PR loop', input: { hint: 'status|threads' } },
    { name: 'next', description: 'claim the top bead', input: { hint: 'args' } },
  ];

  /** The available_commands_update notifications the client leg saw. */
  const cmdsUpdate = (updates: unknown[]) =>
    updates.filter(
      u =>
        (u as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ===
        'available_commands_update'
    );

  /** The agent_message_chunk texts the client leg saw, in order. */
  const chunks = (updates: unknown[]) =>
    updates
      .map(u => (u as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update)
      .filter(u => u?.sessionUpdate === 'agent_message_chunk')
      .map(u => u?.content?.text);

  /** The announce rides the same stream right after the open response —
   *  poll for it rather than racing its write. */
  async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) {
        throw new Error('until: timed out');
      }
      await new Promise(r => setTimeout(r, 10));
    }
  }

  test('a stamped session announces the overlay commands once — right after its open response', async () => {
    const r = rig({ replyText: 'ok' }, undefined, () => {}, { commands: COMMANDS });
    try {
      const sessionId = await openSession(r.acp);
      await until(() => cmdsUpdate(r.updates).length === 1);
      const u = cmdsUpdate(r.updates)[0] as {
        sessionId: string;
        update: { availableCommands: unknown[] };
      };
      assert.equal(u.sessionId, sessionId);
      assert.deepEqual(u.update.availableCommands, COMMANDS);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('each stamped session announces — a second session gets its own available_commands_update', async () => {
    const r = rig({ replyText: 'ok', uniqueSessions: true }, undefined, () => {}, {
      commands: COMMANDS,
    });
    try {
      const s1 = await openSession(r.acp);
      const s2 = await openSession(r.acp);
      assert.notEqual(s1, s2);
      await until(() => cmdsUpdate(r.updates).length === 2);
      assert.deepEqual(
        cmdsUpdate(r.updates).map(u => (u as { sessionId: string }).sessionId),
        [s1, s2]
      );
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('no overlay → no announcement (verbatim stays verbatim)', async () => {
    const r = rig({ replyText: 'ok' });
    try {
      await openSession(r.acp);
      await new Promise(r2 => setTimeout(r2, 60));
      assert.equal(cmdsUpdate(r.updates).length, 0);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a handled prompt answers upstream with streamed updates — the downstream never sees it', async () => {
    const seen: string[] = [];
    const r = rig({ replyText: 'DOWNSTREAM' }, undefined, () => {}, {
      prompt: async turn => {
        seen.push(turn.text);
        turn.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'LOCAL-1 ' },
        });
        turn.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'LOCAL-2' },
        });
        return { stopReason: 'end_turn' };
      },
    });
    try {
      const sessionId = await openSession(r.acp);
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '/act status' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      assert.deepEqual(seen, ['/act status']);
      assert.deepEqual(r.fake.prompts, []);
      assert.deepEqual(chunks(r.updates), ['LOCAL-1 ', 'LOCAL-2']);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('an unhandled prompt falls through to verbatim forwarding — seam injection included', async () => {
    const r = rig(
      { replyText: 'ok' },
      { sessionContext: async () => ({ text: 'CTX', settled: true }) },
      () => {},
      { prompt: async () => undefined }
    );
    try {
      const sessionId = await openSession(r.acp);
      const res = await r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hello agent' }],
      });
      assert.equal(res.stopReason, 'end_turn');
      assert.equal(r.fake.prompts.length, 1);
      // the session-start context still injected — the first block is CTX
      const first = r.fake.blocks[0]![0]!;
      assert.equal(first.type === 'text' ? first.text : '', 'CTX');
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a locally handled prompt does not consume the first-prompt injection slot', async () => {
    const r = rig(
      { replyText: 'ok' },
      { sessionContext: async () => ({ text: 'CTX', settled: true }) },
      () => {},
      {
        prompt: async turn => (turn.text.startsWith('/') ? { stopReason: 'end_turn' } : undefined),
      }
    );
    try {
      const sessionId = await openSession(r.acp);
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '/act status' }],
      });
      assert.deepEqual(r.fake.prompts, []);
      // the FIRST crossed prompt still carries the session context —
      // a local turn never claimed the slot
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'real question' }],
      });
      assert.equal(r.fake.prompts.length, 1);
      const first = r.fake.blocks[0]![0]!;
      assert.equal(first.type === 'text' ? first.text : '', 'CTX');
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('session/cancel mid-local-turn answers cancelled, fires the abort signal, and never crosses', async () => {
    let aborted = false;
    let emitsAfter = 0;
    const r = rig({ replyText: 'ok' }, undefined, () => {}, {
      prompt: turn =>
        new Promise<{ stopReason: string } | undefined>(resolve => {
          turn.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              // a late emit after the cancel must not reach the wire
              turn.emit({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'LATE' },
              });
              resolve({ stopReason: 'end_turn' });
            },
            { once: true }
          );
        }),
    });
    try {
      const sessionId = await openSession(r.acp);
      const p = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '/watch' }],
      });
      await new Promise(r2 => setTimeout(r2, 50));
      await r.acp.notify('session/cancel', { sessionId });
      assert.equal((await p).stopReason, 'cancelled');
      assert.equal(aborted, true);
      await new Promise(r2 => setTimeout(r2, 30));
      assert.deepEqual(r.fake.prompts, []);
      // no crossed work → the cancel never crossed downstream, and the
      // late 'LATE' emit never reached the client
      assert.deepEqual(r.fake.cancels, []);
      emitsAfter = chunks(r.updates).filter(t => t === 'LATE').length;
      assert.equal(emitsAfter, 0);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a thrown handler answers -32603 — never a synthesized success', async () => {
    const r = rig({ replyText: 'ok' }, undefined, () => {}, {
      prompt: async () => {
        throw new Error('slash runner exploded');
      },
    });
    try {
      const sessionId = await openSession(r.acp);
      await assert.rejects(
        r.acp.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: '/x' }],
        }),
        (e: unknown) =>
          e instanceof RequestError && e.code === -32603 && /slash runner exploded/.test(e.message)
      );
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test("initialize reports the overlay's agentInfo — the downstream's survives under _meta.bro.downstreamAgent", async () => {
    const r = rig({ replyText: 'ok' }, undefined, () => {}, {
      agentInfo: { name: 'bro', version: '9.9.9', title: 'bro agent mode' },
    });
    try {
      const init = (await r.acp.request('initialize', INIT_PARAMS)) as {
        agentInfo?: { name?: string; version?: string; title?: string };
        _meta?: { bro?: { downstreamAgent?: { name?: string } } };
      };
      assert.equal(init.agentInfo?.name, 'bro');
      assert.equal(init.agentInfo?.version, '9.9.9');
      assert.equal(init._meta?.bro?.downstreamAgent?.name, 'fake-acp');
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a handler that throws undefined still answers -32603 — never a declined-prompt fallthrough', async () => {
    const r = rig({ replyText: 'ok' }, undefined, () => {}, {
      prompt: async () => {
        throw undefined;
      },
    });
    try {
      const sessionId = await openSession(r.acp);
      await assert.rejects(
        r.acp.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: '/x' }],
        }),
        (e: unknown) => e instanceof RequestError && e.code === -32603
      );
      // a crashed handler is a wire error — the prompt never crossed
      assert.deepEqual(r.fake.prompts, []);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a client close mid-local-turn fires the abort — the turn dies with the wire', async () => {
    let aborted = false;
    const r = rig({ replyText: 'ok' }, undefined, () => {}, {
      prompt: turn =>
        new Promise<{ stopReason: string } | undefined>(resolve => {
          turn.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve({ stopReason: 'end_turn' });
            },
            { once: true }
          );
        }),
    });
    const sessionId = await openSession(r.acp);
    const p = r.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/watch' }],
    });
    void p.catch(() => {}); // the client is about to die — its request never resolves
    await new Promise(r2 => setTimeout(r2, 50));
    await hangupClient(r);
    assert.equal(await r.proxyDone, 0);
    assert.equal(aborted, true);
    await hangupAgent(r);
  });

  test('a downstream close mid-local-turn fires the abort too', async () => {
    let aborted = false;
    const r = rig({ replyText: 'ok' }, undefined, () => {}, {
      prompt: turn =>
        new Promise<{ stopReason: string } | undefined>(resolve => {
          turn.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve({ stopReason: 'end_turn' });
            },
            { once: true }
          );
        }),
    });
    const sessionId = await openSession(r.acp);
    const p = r.acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/watch' }],
    });
    void p.catch(() => {});
    await new Promise(r2 => setTimeout(r2, 50));
    await hangupAgent(r);
    assert.equal(await r.proxyDone, 1);
    assert.equal(aborted, true);
    await hangupClient(r);
  });

  test("the downstream's command list merges with the overlay's — local names shadow", async () => {
    const DOWN_COMMANDS = [
      { name: 'zed-cmd', description: 'downstream command', input: { hint: 'args' } },
      { name: 'act', description: 'downstream shadow of a local name', input: { hint: 'x' } },
    ];
    const r = rig(
      {
        replyText: 'ok',
        // the agent announces its own surface mid-turn — the update
        // carries a stamped session, so the merge path applies
        updates: [
          {
            sessionUpdate: 'available_commands_update',
            availableCommands: DOWN_COMMANDS,
          },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        ],
      },
      undefined,
      () => {},
      { commands: COMMANDS }
    );
    try {
      const sessionId = await openSession(r.acp);
      // the stamp announce is the local list (nothing cached yet)
      await until(() => cmdsUpdate(r.updates).length === 1);
      await r.acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      // the downstream's announce re-publishes merged, not verbatim
      await until(() => cmdsUpdate(r.updates).length === 2);
      const last = cmdsUpdate(r.updates).at(-1) as {
        update: { availableCommands: { name: string; description: string }[] };
      };
      assert.deepEqual(
        last.update.availableCommands.map(c => c.name),
        ['act', 'next', 'zed-cmd']
      );
      // local dispatch precedence — bro's 'act' shadows the downstream's
      assert.equal(
        last.update.availableCommands.find(c => c.name === 'act')?.description,
        'Open-PR loop'
      );
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a cancelled request id reused by a new prompt keeps ownership — the stale turn cannot answer or emit for it', async () => {
    // raw client — request-id reuse is a wire-level shape the typed
    // client() app cannot produce (it owns its id space)
    const fake = fakeAcpAgent({ replyText: 'DOWNSTREAM-B' });
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const agentConn = fake.app.connect(agentSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      agent: {
        prompt: turn => {
          if (!turn.text.startsWith('/local')) {
            return Promise.resolve(undefined);
          }
          return new Promise<{ stopReason: string } | undefined>(resolve => {
            turn.signal.addEventListener(
              'abort',
              () => {
                // resolve LATE — after a new request may own the id
                setTimeout(() => {
                  turn.emit({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'A-LATE' },
                  });
                  resolve({ stopReason: 'end_turn' });
                }, 120);
              },
              { once: true }
            );
          });
        },
      },
      log: () => {},
    });
    const w = clientSide.writable.getWriter();
    const rd = clientSide.readable.getReader();
    const responses: { id?: unknown; result?: unknown; error?: unknown }[] = [];
    const updates: { update?: { content?: { text?: string } } }[] = [];
    const reader = (async () => {
      for (;;) {
        const { value, done } = await rd.read();
        if (done) return;
        const m = value as { id?: unknown; method?: string; params?: { update?: unknown } };
        if (m.method === 'session/update') {
          updates.push(m.params as (typeof updates)[number]);
        } else if (m.id !== undefined) {
          responses.push(m);
        }
      }
    })();
    const send = (m: Record<string, unknown>) => w.write(m as AnyMessage);
    try {
      await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS });
      await until(() => responses.some(r => r.id === 1));
      await send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: '/tmp/x', mcpServers: [] },
      });
      await until(() => responses.some(r => r.id === 2));
      // request A: id 9 runs a local turn that only its abort releases
      await send({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: '/local a' }] },
      });
      await new Promise(r2 => setTimeout(r2, 50));
      await send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess-1' } });
      await until(() => responses.some(r => r.id === 9));
      assert.equal(
        (responses.find(r => r.id === 9)?.result as { stopReason?: string })?.stopReason,
        'cancelled'
      );
      // request B reuses id 9 while A's local turn still unwinds
      await send({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hello b' }] },
      });
      await until(() => responses.filter(r => r.id === 9).length === 2);
      await new Promise(r2 => setTimeout(r2, 80));
      // B's prompt crossed and got the downstream's own answer
      assert.deepEqual(fake.prompts, ['hello b']);
      // A's post-cancel emit never reached the wire under B's id
      assert.equal(
        updates.some(u => u.update?.content?.text === 'A-LATE'),
        false
      );
    } finally {
      await w.close().catch(() => {});
      agentConn.close();
      await agentSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      await reader;
      await proxyDone;
    }
  });

  test('a prompt queued behind a local turn never starts after the client died', async () => {
    // raw client — B's prompt sits in the session writeQ while A's
    // local turn is still in flight; upstream EOF must gate B's
    // handler, not just abort A's (wireDone, not aborts alone)
    const calls: string[] = [];
    const fake = fakeAcpAgent({ replyText: 'DOWN' });
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const agentConn = fake.app.connect(agentSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, {
      agent: {
        prompt: turn => {
          calls.push(turn.text);
          if (!turn.text.startsWith('/local')) {
            return Promise.resolve(undefined);
          }
          // A parks until the wire's teardown abort releases it —
          // the same late-resolve shape the ownership test uses
          return new Promise<{ stopReason: string } | undefined>(resolve => {
            turn.signal.addEventListener(
              'abort',
              () => setTimeout(() => resolve({ stopReason: 'end_turn' }), 80),
              { once: true }
            );
          });
        },
      },
      log: () => {},
    });
    const w = clientSide.writable.getWriter();
    const rd = clientSide.readable.getReader();
    const responses: { id?: unknown }[] = [];
    const reader = (async () => {
      for (;;) {
        const { value, done } = await rd.read();
        if (done) return;
        const m = value as { id?: unknown };
        if (m.id !== undefined) responses.push(m);
      }
    })();
    const send = (m: Record<string, unknown>) => w.write(m as AnyMessage);
    try {
      await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS });
      await until(() => responses.some(r => r.id === 1));
      await send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: '/tmp/x', mcpServers: [] },
      });
      await until(() => responses.some(r => r.id === 2));
      // A runs locally and parks; B queues behind it in the writeQ
      await send({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: '/local a' }] },
      });
      await until(() => calls.length === 1);
      await send({
        jsonrpc: '2.0',
        id: 10,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: '/local b' }] },
      });
      await new Promise(r2 => setTimeout(r2, 40));
      // the client dies mid-A — wireDone must stop B's handler from
      // ever spawning when the writeQ reaches it
      await w.close().catch(() => {});
      await new Promise(r2 => setTimeout(r2, 200));
      assert.deepEqual(calls, ['/local a']);
    } finally {
      agentConn.close();
      await agentSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      await reader;
      await proxyDone;
    }
  });
});
describe('acpProxy — permission policy seam (bro-9qopj)', () => {
  const ALLOW_REJECT: PermissionOption[] = [
    { optionId: 'allow-once', kind: 'allow_once', name: 'allow once' },
    { optionId: 'reject-once', kind: 'reject_once', name: 'reject once' },
  ];

  /** mkdtemp + git init — the events journal anchors on the repo's
   *  common dir; the fake /tmp dirs the other suites use resolve no
   *  archive at all. */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bro-acpperm-'));
    testGit(['init', '-q', dir]);
    return dir;
  }

  /** Every journaled row under the repo's proxy archive dir
   *  (`bro/proxy/acp-<sid>-p<pid>.events.jsonl` — one file per proxy
   *  run; the tests read them all). */
  function proxyJournal(dir: string): Array<Record<string, unknown>> {
    const pdir = join(gitCommonDir(dir)!, 'bro', 'proxy');
    if (!existsSync(pdir)) {
      return [];
    }
    return readdirSync(pdir)
      .flatMap(f => readFileSync(join(pdir, f), 'utf8').split('\n'))
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  const permissionRows = (dir: string) => proxyJournal(dir).filter(r => r['kind'] === 'permission');

  test('allow verdict answers downstream allow_once — the client never sees the ask, the decision journals', async () => {
    const dir = repo();
    try {
      const calls: Array<AcpProxyPermissionCall & { cwd: string; sessionId: string }> = [];
      const r = rig(
        {
          replyText: 'ok',
          askPermission: {
            options: ALLOW_REJECT,
            toolCall: {
              toolCallId: 'tc-9',
              title: 'Bash: bd ready',
              name: 'Bash',
              kind: 'execute',
              rawInput: { command: 'bd ready' },
            },
          },
        },
        {
          permission: async (cwd, sessionId, call) => {
            calls.push({ ...call, cwd, sessionId });
            return { verdict: 'allow' };
          },
        }
      );
      try {
        await openSession(r.acp, dir);
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        // the proxy's own answer reached the agent — the ask never
        // crossed upstream
        assert.deepEqual(r.fake.permissionOutcome, {
          outcome: 'selected',
          optionId: 'allow-once',
        });
        assert.equal(r.permAsks.length, 0);
        // the seam saw the session's cwd and the wire's toolCall —
        // rawInput normalized as the tool_input analog
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.cwd, dir);
        assert.equal(calls[0]!.sessionId, 'sess-1');
        assert.equal(calls[0]!.toolCallId, 'tc-9');
        assert.deepEqual(calls[0]!.input, { command: 'bd ready' });
        const rows = permissionRows(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.decidedBy, 'proxy');
        assert.equal(rows[0]!.verdict, 'approved');
        assert.equal(rows[0]!.optionId, 'allow-once');
        assert.equal(rows[0]!.toolCallId, 'tc-9');
      } finally {
        assert.equal(await close(r), 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('deny verdict answers reject_once — cancelled when no reject is offered', async () => {
    const dir = repo();
    try {
      const r = rig(
        { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
        { permission: async () => ({ verdict: 'deny' as const, reason: 'guard: blocked' }) }
      );
      try {
        await openSession(r.acp, dir);
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        assert.deepEqual(r.fake.permissionOutcome, {
          outcome: 'selected',
          optionId: 'reject-once',
        });
        assert.equal(r.permAsks.length, 0);
        const rows = permissionRows(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.verdict, 'denied');
        assert.equal(rows[0]!.reason, 'guard: blocked');
      } finally {
        assert.equal(await close(r), 0);
      }

      // no reject option offered → the deny lands as a cancellation —
      // the denyPermission/autoApprove shape, never an invented reject
      const dir2 = repo();
      const r2 = rig(
        {
          replyText: 'ok',
          askPermission: {
            options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'allow' }],
          },
        },
        { permission: async () => ({ verdict: 'deny' as const }) }
      );
      try {
        await openSession(r2.acp, dir2);
        await r2.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        assert.deepEqual(r2.fake.permissionOutcome, { outcome: 'cancelled' });
        const rows2 = permissionRows(dir2);
        assert.equal(rows2.length, 1);
        assert.equal(rows2[0]!.verdict, 'cancelled');
      } finally {
        assert.equal(await close(r2), 0);
        rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('option selection — allow_once preferred over allow_always; allow_always taken as the polarity\u2019s sole variant', async () => {
    // both polarities offered in both variants → the *_once wins even
    // when the *_always lists first
    const r = rig(
      {
        replyText: 'ok',
        askPermission: {
          options: [
            { optionId: 'allow-always', kind: 'allow_always', name: 'always allow' },
            { optionId: 'allow-once', kind: 'allow_once', name: 'allow once' },
          ],
        },
      },
      { permission: async () => ({ verdict: 'allow' as const }) }
    );
    try {
      await openSession(r.acp);
      await r.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      assert.deepEqual(r.fake.permissionOutcome, {
        outcome: 'selected',
        optionId: 'allow-once',
      });
    } finally {
      assert.equal(await close(r), 0);
    }

    // only allow_always on the allow side → selecting it beats failing
    // an answerable request (the agent's own choice space)
    const r2 = rig(
      {
        replyText: 'ok',
        askPermission: {
          options: [
            { optionId: 'allow-always', kind: 'allow_always', name: 'always allow' },
            { optionId: 'reject-once', kind: 'reject_once', name: 'reject' },
          ],
        },
      },
      { permission: async () => ({ verdict: 'allow' as const }) }
    );
    try {
      await openSession(r2.acp);
      await r2.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      assert.deepEqual(r2.fake.permissionOutcome, {
        outcome: 'selected',
        optionId: 'allow-always',
      });
    } finally {
      assert.equal(await close(r2), 0);
    }
  });

  test('allow verdict with no allow option offered falls to deny — never an invented approval', async () => {
    const dir = repo();
    try {
      const r = rig(
        {
          replyText: 'ok',
          askPermission: {
            options: [{ optionId: 'reject-once', kind: 'reject_once', name: 'reject' }],
          },
        },
        { permission: async () => ({ verdict: 'allow' as const }) }
      );
      try {
        await openSession(r.acp, dir);
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        // the acp-worker autoApprove rule: an agent offering no allow
        // option still gets denied
        assert.deepEqual(r.fake.permissionOutcome, {
          outcome: 'selected',
          optionId: 'reject-once',
        });
        const rows = permissionRows(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.verdict, 'denied');
      } finally {
        assert.equal(await close(r), 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('ask verdict forwards verbatim — the client\u2019s own answer relays and journals by:client', async () => {
    const dir = repo();
    try {
      const r = rig(
        { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
        { permission: async () => ({ verdict: 'ask' as const }) }
      );
      try {
        await openSession(r.acp, dir);
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        // the human answered — the default handler picks option[0]
        assert.equal(r.permAsks.length, 1);
        assert.deepEqual(r.fake.permissionOutcome, {
          outcome: 'selected',
          optionId: 'allow-once',
        });
        const rows = permissionRows(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.decidedBy, 'client');
        assert.equal(rows[0]!.verdict, 'approved');
        assert.equal(rows[0]!.optionId, 'allow-once');
      } finally {
        assert.equal(await close(r), 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('no seam leg and a throwing eval both fail open — the ask crosses, the client answers', async () => {
    const dir = repo();
    try {
      // no permission leg at all → pure passthrough (a cancelled
      // client answer relays verbatim and journals cancelled)
      const bare = rig(
        { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
        undefined,
        () => {},
        undefined,
        () => ({ outcome: { outcome: 'cancelled' } })
      );
      try {
        await openSession(bare.acp, dir);
        await bare.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        assert.equal(bare.permAsks.length, 1);
        assert.deepEqual(bare.fake.permissionOutcome, { outcome: 'cancelled' });
        const rows = permissionRows(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.decidedBy, 'client');
        assert.equal(rows[0]!.verdict, 'cancelled');
      } finally {
        assert.equal(await close(bare), 0);
      }

      // a throwing eval → the ask still crosses (fail-open, logged)
      const logs: string[] = [];
      const r = rig(
        { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
        {
          permission: async () => {
            throw new Error('policy engine died');
          },
        },
        l => logs.push(l)
      );
      try {
        await openSession(r.acp);
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        assert.equal(r.permAsks.length, 1);
        assert.deepEqual(r.fake.permissionOutcome, {
          outcome: 'selected',
          optionId: 'allow-once',
        });
        await new Promise(r2 => setTimeout(r2, 30));
        assert.equal(
          logs.some(l => l.includes('permission')),
          true
        );
      } finally {
        assert.equal(await close(r), 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('BRO_HOOKS=0 makes the proxy a transport — the seam never runs, the ask crosses', async () => {
    const prev = process.env.BRO_HOOKS;
    process.env.BRO_HOOKS = '0';
    try {
      let evals = 0;
      const r = rig(
        { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
        {
          permission: async () => {
            evals++;
            return { verdict: 'deny' as const };
          },
        }
      );
      try {
        await openSession(r.acp);
        await r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        assert.equal(evals, 0);
        assert.equal(r.permAsks.length, 1);
        assert.deepEqual(r.fake.permissionOutcome, {
          outcome: 'selected',
          optionId: 'allow-once',
        });
      } finally {
        assert.equal(await close(r), 0);
      }
    } finally {
      if (prev === undefined) delete process.env.BRO_HOOKS;
      else process.env.BRO_HOOKS = prev;
    }
  });

  test('session/cancel during the eval settles the held ask cancelled — the ask never crosses upstream', async () => {
    let entered!: () => void;
    let release!: () => void;
    const evalEntered = new Promise<void>(r2 => {
      entered = r2;
    });
    const evalGate = new Promise<void>(r2 => {
      release = r2;
    });
    const r = rig(
      { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
      {
        permission: async () => {
          entered();
          await evalGate;
          return { verdict: 'allow' as const };
        },
      }
    );
    try {
      await openSession(r.acp);
      const promptP = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      // the fake's ask is inside its prompt handler — wait for the
      // eval to park, then cancel the session
      await evalEntered;
      await r.acp.notify('session/cancel', { sessionId: 'sess-1' });
      release();
      // the held ask answered downstream cancelled — it never reached
      // the client (the wire never shows an ask after its cancel)
      await new Promise(r2 => setTimeout(r2, 50));
      assert.deepEqual(r.fake.permissionOutcome, { outcome: 'cancelled' });
      assert.equal(r.permAsks.length, 0);
      // the cancel itself still crossed — the in-flight prompt was
      // its real target
      assert.deepEqual(r.fake.cancels, ['sess-1']);
      assert.equal((await promptP).stopReason, 'end_turn');
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('upstream death answers the held ask cancelled downstream — a dead client stalls nothing', async () => {
    const r = rig(
      { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
      // the eval never resolves — the ask stays held until teardown
      { permission: async () => new Promise<never>(() => {}) }
    );
    await openSession(r.acp);
    const promptP = r.acp.request('session/prompt', {
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'go' }],
    });
    // let the ask land + the eval park
    await new Promise(r2 => setTimeout(r2, 60));
    await hangupClient(r);
    assert.equal(await r.proxyDone, 0);
    // the agent's ask resolved cancelled — the wire answers every
    // request exactly once even when the asker is gone
    await new Promise(r2 => setTimeout(r2, 50));
    assert.deepEqual(r.fake.permissionOutcome, { outcome: 'cancelled' });
    await hangupAgent(r);
    await promptP.catch(() => {});
  });

  test('upstream death errors a non-permission a2c request downstream — the relay invariant holds for every method', async () => {
    const fake = fakeAcpAgent({
      replyText: 'ok',
      // a hanging client-bound probe — the client registers a
      // never-resolving fs handler so the request is still in flight
      // when the upstream leg dies
      probeClient: async (client, sid) => {
        try {
          return await client.request('fs/read_text_file', { sessionId: sid, path: '/x' });
        } catch (e) {
          return { code: e instanceof RequestError ? e.code : String(e) };
        }
      },
    });
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const agentConn = fake.app.connect(agentSide);
    const conn = client({ name: 'test-client' })
      .onRequest('fs/read_text_file', () => new Promise<never>(() => {}))
      .connect(clientSide);
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    try {
      await conn.agent.request('initialize', INIT_PARAMS);
      await conn.agent.request('session/new', { cwd: '/tmp/proxy-repo', mcpServers: [] });
      const promptP = conn.agent.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      // let the probe land + park on the hanging handler
      await new Promise(r2 => setTimeout(r2, 60));
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await proxyDone, 0);
      await new Promise(r2 => setTimeout(r2, 50));
      // the proxy answered the request itself — a dead client leaves
      // no agent waiting on a question that can never resolve
      assert.deepEqual(fake.probeResult, {
        code: -32603,
      });
      agentConn.close();
      await agentSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      await promptP.catch(() => {});
    } finally {
      conn.close();
      agentConn.close();
    }
  });

  test('an eval rejecting with null still fails open — the catch logs, the ask crosses', async () => {
    const logs: string[] = [];
    const r = rig(
      { replyText: 'ok', askPermission: { options: ALLOW_REJECT } },
      // a hook can reject with ANYTHING — a nullish rejection must not
      // throw a second error inside the catch (e.message on null)
      { permission: () => Promise.reject(null) },
      l => logs.push(l)
    );
    try {
      await openSession(r.acp);
      await r.acp.request('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      // fail-open like a throwing eval: the ask crossed, the human
      // answered, and the crash-free log line carries 'null'
      assert.equal(r.permAsks.length, 1);
      assert.deepEqual(r.fake.permissionOutcome, {
        outcome: 'selected',
        optionId: 'allow-once',
      });
      await new Promise(r2 => setTimeout(r2, 30));
      assert.equal(
        logs.some(l => l.includes('permission eval failed') && l.includes('null')),
        true
      );
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('session/close settles EVERY held ask cancelled — and the journal says closed, not cancelled', async () => {
    const dir = repo();
    try {
      const r = rig(
        {
          replyText: 'ok',
          // two permission asks in flight at once — the abort walk
          // must settle all of them, not just the first
          probeClient: async (client, sid) => {
            const ask = (tc: string) =>
              client.request('session/request_permission', {
                sessionId: sid,
                toolCall: { toolCallId: tc, title: `call ${tc}` },
                options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'allow' }],
              }) as Promise<{ outcome: unknown }>;
            const [a, b] = await Promise.all([ask('tc-a'), ask('tc-b')]);
            return [a.outcome, b.outcome];
          },
        },
        // the eval never resolves — both asks stay held until the
        // close settles them
        { permission: async () => new Promise<never>(() => {}) }
      );
      try {
        await openSession(r.acp, dir);
        const promptP = r.acp.request('session/prompt', {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'go' }],
        });
        // let both asks land + park on the held eval
        await new Promise(r2 => setTimeout(r2, 80));
        await r.acp.request('session/close', { sessionId: 'sess-1' });
        await new Promise(r2 => setTimeout(r2, 50));
        // every held entry settled — none skipped mid-iteration, none
        // crossed upstream
        assert.deepEqual(r.fake.probeResult, [{ outcome: 'cancelled' }, { outcome: 'cancelled' }]);
        assert.equal(r.permAsks.length, 0);
        const rows = permissionRows(dir);
        assert.equal(rows.length, 2);
        assert.equal(
          rows.every(row => row.verdict === 'cancelled'),
          true
        );
        // a clean close is not a cancel — the journal says which it was
        assert.equal(
          rows.every(row => row.reason === 'session closed while the policy evaluated'),
          true
        );
        await promptP;
      } finally {
        assert.equal(await close(r), 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('acpProxy — outbound backpressure (bro-0w2tg)', () => {
  /** A leg nobody reads IS the stalled-peer shape: TransformStream
   *  backpressure keeps every writer.write() pending, exactly like a
   *  peer that stopped draining its stdin. These tests drive the
   *  proxy raw — no SDK app on either side — so the wire's own
   *  queueing is the only thing under test. */
  const settle = (ms: number): Promise<void> => new Promise(r2 => setTimeout(r2, ms));

  /** A proxy that never settles must fail the test, not hang the
   *  runner — teardown-while-stalled regressions surface as assertion
   *  failures, not suite timeouts. */
  const hangGuard = <T>(p: Promise<T>, ms = 3000): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('acpProxy did not settle — teardown hung')), ms)
      ),
    ]);

  /** Fire `n` raw requests into a wire — unawaited, like a flooding
   *  peer: once the proxy stops reading, backpressure simply holds
   *  the rest inside the transform. */
  const fire = (
    w: WritableStreamDefaultWriter<AnyMessage>,
    method: string,
    params: Record<string, unknown>,
    n: number
  ): void => {
    for (let i = 0; i < n; i++) {
      void w.write({ jsonrpc: '2.0', id: i + 1, method, params } as AnyMessage).catch(() => {});
    }
  };

  /** Drain a readable into `into` in the background — the swept-answer
   *  counts are read after each test's own settle. */
  const collect = (reader: ReadableStreamDefaultReader<AnyMessage>, into: AnyMessage[]): void => {
    void (async () => {
      for (;;) {
        const { value, done } = await reader
          .read()
          .catch(() => ({ value: undefined, done: true }) as const);
        if (done) return;
        if (value !== undefined) into.push(value);
      }
    })();
  };

  const idOf = (m: AnyMessage): unknown => (m as { id?: unknown }).id;
  const errorOf = (m: AnyMessage): unknown => (m as { error?: unknown }).error;

  test('a stalled downstream pauses the c→a pump at the high-water mark — the death sweep answers everything the wire accepted', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const clientW = clientSide.writable.getWriter();
    const clientR = clientSide.readable.getReader();
    const got: AnyMessage[] = [];
    collect(clientR, got);
    // nobody reads agentSide.readable — the agent's stdin is stalled.
    // Flood past the mark; writes pause at the bound while intake
    // keeps consuming into the pump's hold — a consumed request is
    // never dropped unrouted, so the sweep answers all of them
    const total = ACP_PROXY_WRITE_HIGH_WATER + 10;
    fire(clientW, 'session/prompt', { sessionId: 'none', prompt: [] }, total);
    await settle(80);
    // agent death runs the 'down' sweep over the pending table — the
    // parked pump drained its hold into it first, so every request
    // the client wrote earns its error, not just the crossed prefix
    await agentSide.writable
      .getWriter()
      .close()
      .catch(() => {});
    assert.equal(await hangGuard(proxyDone), 1);
    await settle(30);
    assert.equal(got.filter(m => errorOf(m) !== undefined).length, total);
    await clientW.abort().catch(() => {});
  });

  test('drain resumes the paused pump — every queued write lands in order, nothing dropped', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const clientW = clientSide.writable.getWriter();
    const total = ACP_PROXY_WRITE_HIGH_WATER + 10;
    fire(clientW, 'session/prompt', { sessionId: 'none', prompt: [] }, total);
    await settle(80); // parked at the high-water mark
    // the agent starts reading — writes drain, the pump resumes, and
    // the held-back prefix lands in wire order (ACP drops nothing)
    const agentR = agentSide.readable.getReader();
    const ids: unknown[] = [];
    while (ids.length < total) {
      const { value, done } = await agentR.read();
      assert.equal(done, false, 'downstream leg closed before the queue drained');
      ids.push(idOf(value));
    }
    assert.deepEqual(
      ids,
      Array.from({ length: total }, (_v, i) => i + 1)
    );
    await clientW.close().catch(() => {});
    assert.equal(await hangGuard(proxyDone), 0);
    await agentSide.writable
      .getWriter()
      .close()
      .catch(() => {});
  });

  test('a client EOF while the c→a pump is paused still ends the wire — the stall cannot hide it', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const clientW = clientSide.writable.getWriter();
    // exactly the high-water mark: the pump routes every one, then
    // parks on room() with an EMPTY intake — the client's EOF must
    // still surface (the parked read is issued before the wait
    // precisely so this close resolves it)
    fire(clientW, 'session/prompt', { sessionId: 'none', prompt: [] }, ACP_PROXY_WRITE_HIGH_WATER);
    await settle(80);
    await clientW.close().catch(() => {});
    // 'up' verdict — and the stalled down leg's close is abandoned at
    // its flush grace rather than pended on
    assert.equal(await hangGuard(proxyDone), 0);
  });

  test('a client EOF behind held intake still ends the wire — buffered messages cannot hide the close', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const clientW = clientSide.writable.getWriter();
    // past the mark AND then some — the pump holds consumed intake it
    // cannot route yet, and the close sits behind all of it in the
    // stream queue. Only reading on surfaces it; a verdict by stall
    // would cost writeStallMs and misreport the clean client end.
    fire(
      clientW,
      'session/prompt',
      { sessionId: 'none', prompt: [] },
      ACP_PROXY_WRITE_HIGH_WATER + 5
    );
    await settle(80);
    await clientW.close().catch(() => {});
    assert.equal(await hangGuard(proxyDone), 0);
  });

  test('a leg with no write progress is declared dead — the in-flight prompts sweep upstream, verdict 1', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {}, writeStallMs: 150 });
    const clientW = clientSide.writable.getWriter();
    const clientR = clientSide.readable.getReader();
    const got: AnyMessage[] = [];
    collect(clientR, got);
    fire(clientW, 'session/prompt', { sessionId: 'none', prompt: [] }, 5);
    // the down leg accepts nothing — writeStallMs after the last
    // progress the stall bound declares it dead, and the existing
    // 'down' teardown answers what was in flight
    assert.equal(await hangGuard(proxyDone), 1);
    await settle(30);
    assert.equal(got.filter(m => errorOf(m) !== undefined).length, 5);
    await clientW.abort().catch(() => {});
  });

  test('a stalled upstream bounds the a→c intake symmetrically — the up-sweep answers everything the wire accepted', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const agentW = agentSide.writable.getWriter();
    const agentR = agentSide.readable.getReader();
    const got: AnyMessage[] = [];
    collect(agentR, got);
    // agent floods a2c requests while the client never reads — the up
    // leg stalls and the a→c pump parks at its own high-water mark,
    // holding (never dropping) the intake it cannot route yet
    const total = ACP_PROXY_WRITE_HIGH_WATER + 10;
    fire(agentW, 'fs/read_text_file', { sessionId: 'none', path: '/x' }, total);
    await settle(80);
    // client death runs the 'up' sweep: every accepted a2c request is
    // answered downstream — the hold drained into the table first
    await clientSide.writable
      .getWriter()
      .close()
      .catch(() => {});
    assert.equal(await hangGuard(proxyDone), 0);
    await settle(30);
    assert.equal(got.filter(m => errorOf(m) !== undefined).length, total);
    await agentW.abort().catch(() => {});
  });

  test('a fast sender hits the intake bound — the hold saturates and the read side pauses', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const clientW = clientSide.writable.getWriter();
    const clientR = clientSide.readable.getReader();
    const got: AnyMessage[] = [];
    collect(clientR, got);
    // flood past BOTH marks — the transform's own backpressure keeps a
    // write() pending until the proxy's reader takes it, so a resolved
    // write IS a consumed message: the count the intake must bound
    const total = ACP_PROXY_WRITE_HIGH_WATER + ACP_PROXY_READ_HIGH_WATER + 10;
    let consumed = 0;
    for (let i = 0; i < total; i++) {
      void clientW
        .write({
          jsonrpc: '2.0',
          id: i + 1,
          method: 'session/prompt',
          params: { sessionId: 'none', prompt: [] },
        } as AnyMessage)
        .then(
          () => {
            consumed++;
          },
          () => {}
        );
    }
    await settle(80);
    // routed ≤ the write mark + held ≤ the read mark + the one
    // in-flight read — without the read bound the whole flood would
    // already be consumed into `held`
    assert.ok(
      consumed <= ACP_PROXY_WRITE_HIGH_WATER + ACP_PROXY_READ_HIGH_WATER + 2,
      `intake outran the read bound — consumed ${consumed} of ${total}`
    );
    assert.ok(consumed >= ACP_PROXY_WRITE_HIGH_WATER, `nothing routed — consumed ${consumed}`);
    // agent death runs the 'down' sweep — every message the pump DID
    // accept (routed or held) earns its error; the paused tail dies
    // with the stream it was never read from
    await agentSide.writable
      .getWriter()
      .close()
      .catch(() => {});
    assert.equal(await hangGuard(proxyDone), 1);
    await settle(30);
    assert.ok(
      got.filter(m => errorOf(m) !== undefined).length >= ACP_PROXY_WRITE_HIGH_WATER,
      'the accepted prefix was not answered'
    );
    await clientW.abort().catch(() => {});
  });

  test('alternating data and $/cancel_request cannot flush the hold — the intake bound holds', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const clientW = clientSide.writable.getWriter();
    const clientR = clientSide.readable.getReader();
    const got: AnyMessage[] = [];
    collect(clientR, got);
    // nobody reads agentSide — the down ledger fills and stays full.
    // Alternating data with control was the amplifier: every cancel
    // used to dump the whole hold into the ledger, the read refilled
    // it, the next cancel flushed again — the pair stream outran the
    // bound for as long as the client kept alternating.
    const total = ACP_PROXY_WRITE_HIGH_WATER + ACP_PROXY_READ_HIGH_WATER + 10;
    let consumedData = 0;
    let consumedCtrl = 0;
    for (let i = 0; i < total; i++) {
      if (i % 8 === 0) {
        void clientW
          .write({
            jsonrpc: '2.0',
            method: '$/cancel_request',
            params: { id: 'no-such-request' },
          } as AnyMessage)
          .then(
            () => {
              consumedCtrl++;
            },
            () => {}
          );
      }
      void clientW
        .write({
          jsonrpc: '2.0',
          id: i + 1,
          method: 'session/prompt',
          params: { sessionId: 'none', prompt: [] },
        } as AnyMessage)
        .then(
          () => {
            consumedData++;
          },
          () => {}
        );
    }
    await settle(80);
    // data intake bounded exactly like the plain flood — while the
    // control messages themselves still routed past the gate
    assert.ok(
      consumedData <= ACP_PROXY_WRITE_HIGH_WATER + ACP_PROXY_READ_HIGH_WATER + 2,
      `control flushes let intake outrun the bound — consumed ${consumedData} data of ${total}`
    );
    assert.ok(
      consumedData >= ACP_PROXY_WRITE_HIGH_WATER,
      `nothing routed — consumed ${consumedData}`
    );
    assert.ok(consumedCtrl >= 1, 'a control message never routed');
    // agent death runs the 'down' sweep — every accepted message earns
    // its error, the paused tail dies with the stream
    await agentSide.writable
      .getWriter()
      .close()
      .catch(() => {});
    assert.equal(await hangGuard(proxyDone), 1);
    await settle(30);
    assert.ok(
      got.filter(m => errorOf(m) !== undefined).length >= ACP_PROXY_WRITE_HIGH_WATER,
      'the accepted prefix was not answered'
    );
    await clientW.abort().catch(() => {});
  });

  test('a $/cancel_request settles a held request out of the intake — answered cancelled, never crossed', async () => {
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const proxyDone = acpProxy(proxyUp, proxyDown, { log: () => {} });
    const clientW = clientSide.writable.getWriter();
    const clientR = clientSide.readable.getReader();
    const got: AnyMessage[] = [];
    collect(clientR, got);
    const total = ACP_PROXY_WRITE_HIGH_WATER + 10;
    fire(clientW, 'session/prompt', { sessionId: 'none', prompt: [] }, total - 2);
    // awaited writes: resolution IS consumption — once they land, the
    // pair sits consumed in the pump's held tail (ids 73, 74 > 64)
    await clientW
      .write({
        jsonrpc: '2.0',
        id: total - 1,
        method: 'fs/read_text_file',
        params: { sessionId: 'none', path: '/x' },
      } as AnyMessage)
      .catch(() => {});
    await clientW
      .write({
        jsonrpc: '2.0',
        id: total,
        method: 'session/prompt',
        params: { sessionId: 'none', prompt: [] },
      } as AnyMessage)
      .catch(() => {});
    // a leapfrogged cancel must still reach the requests queued ahead
    // of it — the wire never shows work after its cancel
    void clientW
      .write({
        jsonrpc: '2.0',
        method: '$/cancel_request',
        params: { id: total - 1 },
      } as AnyMessage)
      .catch(() => {});
    void clientW
      .write({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: total } } as AnyMessage)
      .catch(() => {});
    await settle(60);
    // a prompt gets the wire's cancelled outcome; any other request
    // gets the JSON-RPC -32800 the SDK's own abort path emits
    const fsAnswer = got.find(m => idOf(m) === total - 1);
    assert.ok(fsAnswer !== undefined, 'the held fs request was never answered');
    assert.equal((fsAnswer as { error?: { code?: number } }).error?.code, -32800);
    const promptAnswer = got.find(m => idOf(m) === total);
    assert.ok(promptAnswer !== undefined, 'the held prompt was never answered');
    assert.equal(
      (promptAnswer as { result?: { stopReason?: string } }).result?.stopReason,
      'cancelled'
    );
    // the cancelled pair left the hold already — teardown answers
    // every remaining accepted message exactly once
    await agentSide.writable
      .getWriter()
      .close()
      .catch(() => {});
    assert.equal(await hangGuard(proxyDone), 1);
    await settle(30);
    assert.equal(got.length, total, `expected exactly ${total} answers, got ${got.length}`);
    await clientW.abort().catch(() => {});
  });
});

describe('acpProxy — control plane bypass (bro-0w2tg)', () => {
  const settle = (ms: number): Promise<void> => new Promise(r2 => setTimeout(r2, ms));

  /** A proxy that never settles must fail the test, not hang the
   *  runner — a bypass regression IS the deadlock it prevents. */
  const hangGuard = <T>(p: Promise<T>, ms = 3000): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('control message did not route — the gate held it')), ms)
      ),
    ]);

  /** A stamped session plus a first prompt parked in the overlay's
   *  local turn — the writeQ slot that makes every following prompt a
   *  charged hold on the down leg. WRITE_HIGH_WATER + slack prompts
   *  fill the ledger, then spill into the pump's hold — the exact
   *  queue a gated intake would park a cancel behind. */
  const floodedLocalTurn = async (
    overlayPrompt: NonNullable<AcpAgentOverlay['prompt']>
  ): Promise<{ r: Rig; sessionId: string; prompts: Promise<{ stopReason: string }>[] }> => {
    const r = rig({ replyText: 'ok' }, undefined, () => {}, { prompt: overlayPrompt });
    const sessionId = await openSession(r.acp);
    const prompts: Promise<{ stopReason: string }>[] = [];
    const total = ACP_PROXY_WRITE_HIGH_WATER + 10;
    for (let i = 0; i < total; i++) {
      prompts.push(
        r.acp.request<{ stopReason: string }>('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: `/w${i}` }],
        })
      );
    }
    await settle(60);
    return { r, sessionId, prompts };
  };

  test('session/cancel behind a saturated ledger still aborts — every held prompt answers cancelled, the local turn dies', async () => {
    let aborted = false;
    const { r, sessionId, prompts } = await floodedLocalTurn(
      turn =>
        new Promise<{ stopReason: string } | undefined>(resolve => {
          // the running local turn ends ONLY on its abort signal —
          // the deadlock the bypass exists to break: the holds it
          // backs up can never release while its cancel waits (the
          // queued siblings' handlers are never invoked — abortHeld
          // discharges them before their writeQ slot runs)
          turn.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve({ stopReason: 'end_turn' });
            },
            { once: true }
          );
        })
    );
    try {
      await r.acp.notify('session/cancel', { sessionId });
      const answers = await hangGuard(Promise.all(prompts));
      assert.ok(
        answers.every(a => a.stopReason === 'cancelled'),
        'a held prompt answered something other than cancelled'
      );
      assert.equal(aborted, true);
      // every prompt was held — nothing crossed, and the cancel's
      // whole target set was proxy-answered so it never crossed either
      assert.deepEqual(r.fake.prompts, []);
      assert.deepEqual(r.fake.cancels, []);
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('a client response behind a saturated ledger still relays — the agent ask resolves instead of parking', async () => {
    let releaseTurn!: () => void;
    let parked = true;
    const { r, sessionId, prompts } = await floodedLocalTurn(
      () =>
        new Promise<{ stopReason: string } | undefined>(resolve => {
          if (!parked) {
            resolve({ stopReason: 'end_turn' });
            return;
          }
          parked = false;
          releaseTurn = () => resolve({ stopReason: 'end_turn' });
        })
    );
    try {
      // the up leg is free so the ask crosses — its ANSWER is the c2a
      // traffic a gated intake would park behind the flooded hold.
      // The test client serves no fs/* method — the SDK's own -32601
      // error response is the relay proof: it settles only if the
      // response routed through the saturated intake.
      const ask = r.agentConn.client.request('fs/read_text_file', {
        sessionId,
        path: '/x',
      }) as Promise<unknown>;
      await assert.rejects(hangGuard(ask), RequestError);
      releaseTurn();
      await Promise.allSettled(prompts);
    } finally {
      assert.equal(await close(r), 0);
    }
  });
});

describe('acpProxy — held-ask ledger slots (bro-0w2tg)', () => {
  const settle = (ms: number): Promise<void> => new Promise(r2 => setTimeout(r2, ms));

  /** Poll a live condition — counts that only grow (routed evals,
   *  landed updates) settle faster than any fixed sleep guesses. */
  const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) return;
      await settle(10);
    }
  };

  const ALLOW_ONCE = [{ optionId: 'allow-once', kind: 'allow_once', name: 'allow' }];

  /** Marker text carried by a session/update — the client's verbatim
   *  notifications land here as `{sessionId, update}` params. */
  const updateTexts = (updates: unknown[]): string[] =>
    updates.map(u => {
      const upd = (u as { update?: { content?: { text?: unknown } } }).update;
      return typeof upd?.content?.text === 'string' ? upd.content.text : '';
    });

  test('a cancelled held ask frees its ledger slot at settle — the parked a2c pump resumes and held traffic crosses', async () => {
    const evalResolvers: Array<() => void> = [];
    const r = rig(
      {
        replyText: 'ok',
        probeClient: (client, sid) => {
          const asks = Array.from(
            { length: ACP_PROXY_WRITE_HIGH_WATER },
            (_v, i) =>
              client.request('session/request_permission', {
                sessionId: sid,
                toolCall: { toolCallId: `tc-${i}`, title: `call ${i}` },
                options: ALLOW_ONCE,
              }) as Promise<{ outcome?: { outcome?: string } }>
          );
          // queued BEHIND the asks on the a2c stream — it reaches the
          // client only if the cancelled asks' slots actually freed:
          // under the old code the holds outlived their asks and the
          // parked pump never found room for it
          void client.notify('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'after-asks' },
            },
          });
          return Promise.all(asks).then(rs => rs.map(a => a.outcome));
        },
      },
      {
        // a stuck policy — every ask parks mid-eval, holding its slot
        permission: async () => {
          await new Promise<void>(res => {
            evalResolvers.push(res);
          });
          return { verdict: 'ask' as const };
        },
      }
    );
    try {
      await openSession(r.acp);
      const promptP = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      await until(() => evalResolvers.length === ACP_PROXY_WRITE_HIGH_WATER);
      assert.equal(evalResolvers.length, ACP_PROXY_WRITE_HIGH_WATER);
      // the asks fill the up leg's ledger with held-eval slots — the
      // marker sits behind them in the a2c intake hold
      await settle(40);
      assert.equal(updateTexts(r.updates).includes('after-asks'), false);
      await r.acp.notify('session/cancel', { sessionId: 'sess-1' });
      // every ask settled cancelled AND released — the parked pump
      // found room and the held marker crossed
      await until(() => updateTexts(r.updates).includes('after-asks'));
      assert.equal(updateTexts(r.updates).includes('after-asks'), true);
      // the cancelled asks' outcomes still reached the agent — the
      // settle itself was never in question, the slot was
      assert.equal((await promptP).stopReason, 'end_turn');
      assert.deepEqual(
        (r.fake.probeResult as Array<{ outcome?: string }>).map(o => o?.outcome),
        Array.from({ length: ACP_PROXY_WRITE_HIGH_WATER }, () => 'cancelled')
      );
      // the parked evals finish before close — their own releases are
      // no-ops now, never a double-free
      evalResolvers.splice(0).forEach(res => res());
    } finally {
      assert.equal(await close(r), 0);
    }
  });

  test('the slot frees exactly once — a refilled ledger parks at the same mark', async () => {
    const evalResolvers: Array<() => void> = [];
    let evals = 0;
    const r = rig(
      {
        replyText: 'ok',
        probeClient: async (client, sid) => {
          const asks = (tag: string) =>
            Array.from(
              { length: ACP_PROXY_WRITE_HIGH_WATER },
              (_v, i) =>
                client.request('session/request_permission', {
                  sessionId: sid,
                  toolCall: { toolCallId: `${tag}-${i}`, title: `${tag} ${i}` },
                  options: ALLOW_ONCE,
                }) as Promise<{ outcome?: { outcome?: string } }>
            );
          const wave1 = asks('w1');
          await Promise.all(wave1); // resolves at the first cancel
          const wave2 = asks('w2');
          void client.notify('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'w2-marker' },
            },
          });
          const outcomes = await Promise.all(wave2);
          return outcomes.map(o => o.outcome);
        },
      },
      {
        permission: async () => {
          evals++;
          await new Promise<void>(res => {
            evalResolvers.push(res);
          });
          return { verdict: 'ask' as const };
        },
      }
    );
    try {
      await openSession(r.acp);
      const promptP = r.acp.request<{ stopReason: string }>('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'go' }],
      });
      await until(() => evals === ACP_PROXY_WRITE_HIGH_WATER);
      await r.acp.notify('session/cancel', { sessionId: 'sess-1' });
      await until(() => evals === 2 * ACP_PROXY_WRITE_HIGH_WATER);
      // wave1's asks settled and wave2's re-charged — now the parked
      // wave1 evals finish: their releases must be no-ops. Had the
      // settle-time release double-fired, the ledger would read room
      // at the mark and the marker would already have crossed
      evalResolvers.splice(0, ACP_PROXY_WRITE_HIGH_WATER).forEach(res => res());
      await settle(60);
      assert.equal(evals, 2 * ACP_PROXY_WRITE_HIGH_WATER);
      assert.equal(updateTexts(r.updates).includes('w2-marker'), false);
      await r.acp.notify('session/cancel', { sessionId: 'sess-1' });
      await until(() => updateTexts(r.updates).includes('w2-marker'));
      assert.equal(updateTexts(r.updates).includes('w2-marker'), true);
      evalResolvers.splice(0).forEach(res => res());
      assert.equal((await promptP).stopReason, 'end_turn');
      assert.deepEqual(
        (r.fake.probeResult as Array<{ outcome?: string }>).map(o => o?.outcome),
        Array.from({ length: ACP_PROXY_WRITE_HIGH_WATER }, () => 'cancelled')
      );
    } finally {
      assert.equal(await close(r), 0);
    }
  });
});
