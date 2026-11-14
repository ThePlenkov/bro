import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, initRepo, git } from './testrepo.ts';
import { runAcpCommand } from './acp.ts';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  AnyMessage,
  InitializeRequest,
  SessionUpdate,
  Stream,
} from '@agentclientprotocol/sdk';
import { acpProxy, type AcpProxySeam } from '@broject/providers';
import { fakeAcpAgent } from '@broject/providers/testkit';
import { registerConnector, unregisterConnector } from '@broject/core';
import { collectStopGate, collectToolCallGuards, readArmed } from './hooks.ts';

const acp = (argv: string[]) => capture(() => runAcpCommand(argv));

describe('bro acp — usage', () => {
  test('unknown subcommand, missing --, empty tail → usage exit 2', async () => {
    // bare `bro acp` is the agent-mode server (bro-tegz2) — it serves
    // stdin/stdout, so only the usage shapes are exercised here
    const bad = await acp(['bogus']);
    assert.equal(bad.code, 2);

    // `--` is mandatory — without it a downstream flag could be
    // misread as ours
    const noSep = await acp(['proxy', 'devin', 'acp']);
    assert.equal(noSep.code, 2);
    assert.match(noSep.err.join('\n'), /requires `--`/);

    const empty = await acp(['proxy', '--']);
    assert.equal(empty.code, 2);
    assert.match(empty.err.join('\n'), /empty agent command/);
  });
});

describe('bro acp proxy — seam-wired e2e (bro-u2eps)', () => {
  /** In-process Stream pair — the object-message shape the pump and the
   *  SDK apps both consume (same helper shape as the providers suite). */
  function streamPair(): [Stream, Stream] {
    const aToB = new TransformStream<AnyMessage, AnyMessage>();
    const bToA = new TransformStream<AnyMessage, AnyMessage>();
    return [
      { readable: aToB.readable, writable: bToA.writable },
      { readable: bToA.readable, writable: aToB.writable },
    ];
  }

  const INIT: InitializeRequest = {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'e2e-client', version: '0' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  };

  /** The `gh pr` tool call that arms `act` — announce plus the terminal
   *  completion, the pair the proxy feeds the seam. */
  const GH_PR_UPDATES: SessionUpdate[] = [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'gh pr',
      name: 'Bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'gh pr view 42' },
    },
    { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
  ];

  test('a tool call arms the act marker in the session repo; the armed gate holds the turn end for exactly one re-prompt, then lets through', async () => {
    const { root, main } = initRepo('bro-acp-e2e-', m => {
      writeFileSync(join(m, 'bro.config.json'), '{}');
    });
    const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim());
    const prevHooks = process.env.BRO_HOOKS;
    const prevTele = process.env.BRO_TELEMETRY;
    delete process.env.BRO_HOOKS;
    process.env.BRO_TELEMETRY = '0';
    try {
      registerConnector({
        name: 'u2eps-e2e-gate',
        hooks: () => ({
          stopGate: () => [{ aspect: 'act', block: 'finish the review threads' }],
        }),
      });
      try {
        // what acp.ts injects — the real collectors, no stub between
        // the wire and the gate
        const seam: AcpProxySeam = {
          toolCall: async (cwd, sid, call) => {
            const r = await collectToolCallGuards(cwd, sid, call);
            return r.lines.length === 0 ? undefined : r.lines;
          },
          stopGate: async (cwd, sid) => {
            const r = await collectStopGate(cwd, sid);
            return r.block === undefined && r.hints.length === 0 ? undefined : r;
          },
        };
        const fake = fakeAcpAgent({ updates: GH_PR_UPDATES });
        const [clientSide, proxyUp] = streamPair();
        const [proxyDown, agentSide] = streamPair();
        const agentConn = fake.app.connect(agentSide);
        const conn = client({ name: 'e2e-client' }).connect(clientSide);
        const proxyDone = acpProxy(proxyUp, proxyDown, { seam, log: () => {} });
        try {
          await conn.agent.request('initialize', INIT);
          const { sessionId } = await conn.agent.request<{ sessionId: string }>('session/new', {
            cwd: main,
            mcpServers: [],
          });
          const res1 = await conn.agent.request<{ stopReason: string }>('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'x' }],
          });
          // the tool call the agent reported armed `act` in the session's
          // own repo — marker file under its git common dir
          assert.equal(readArmed(sessionId, main).has('act'), true);
          // the gate held the end-of-turn: exactly ONE proxy follow-up
          // carried the gate's message; the gate turn's own end let
          // through unconditionally and answered the client
          assert.deepEqual(fake.prompts, ['x', 'finish the review threads']);
          assert.equal(res1.stopReason, 'end_turn');
          // the marker is durable state — the one-shot block budget is
          // spent now, so the NEXT turn end passes verbatim with no
          // third prompt downstream (the demoted hint waits for a
          // later prompt to ride — there is none, and nothing loops)
          const res2 = await conn.agent.request<{ stopReason: string }>('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'y' }],
          });
          assert.equal(res2.stopReason, 'end_turn');
          assert.deepEqual(fake.prompts, ['x', 'finish the review threads', 'y']);
          // the journaled trace proves the in-process post-tool pass
          // ran — <common>/bro/hooks/trace/<session>.jsonl
          const trace = join(
            common,
            'bro',
            'hooks',
            'trace',
            `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`
          );
          assert.match(readFileSync(trace, 'utf8'), /"command":"gh pr view 42"/);
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
      } finally {
        unregisterConnector('u2eps-e2e-gate');
      }
    } finally {
      if (prevHooks === undefined) delete process.env.BRO_HOOKS;
      else process.env.BRO_HOOKS = prevHooks;
      if (prevTele === undefined) delete process.env.BRO_TELEMETRY;
      else process.env.BRO_TELEMETRY = prevTele;
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
