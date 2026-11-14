import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, initRepo, git } from './testrepo.ts';
import { runAcpCommand } from './acp.ts';
import { existsSync, readdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
import { gitCommonDir, registerConnector, unregisterConnector } from '@broject/core';
import { collectPermission, collectStopGate, collectToolCallGuards, readArmed } from './hooks.ts';

const acp = (argv: string[]) => capture(() => runAcpCommand(argv));

describe('bro acp — usage', () => {
  test('missing subcommand, unknown subcommand, missing --, empty tail → usage exit 2', async () => {
    const bare = await acp([]);
    assert.equal(bare.code, 2);
    assert.match(bare.err.join('\n'), /usage: bro acp proxy/);

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

describe('bro acp proxy — permission seam e2e (bro-9qopj)', () => {
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

  const OPTIONS = [
    { optionId: 'allow-once', kind: 'allow_once' as const, name: 'allow once' },
    { optionId: 'reject-once', kind: 'reject_once' as const, name: 'reject once' },
  ];

  /** Every row across the repo's proxy archives
   *  (`bro/proxy/acp-<sid>-p<pid>.events.jsonl`). */
  function proxyRows(common: string): Array<Record<string, unknown>> {
    const pdir = join(common, 'bro', 'proxy');
    if (!existsSync(pdir)) {
      return [];
    }
    return readdirSync(pdir)
      .flatMap(f => readFileSync(join(pdir, f), 'utf8').split('\n'))
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  test('the real collector decides on the wire — block denies, self-tool approves, the rest forwards; every decision journals', async () => {
    const { root, main } = initRepo('bro-acp-perm-e2e-', m => {
      writeFileSync(join(m, 'bro.config.json'), '{}');
    });
    const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim());
    const prevHooks = process.env.BRO_HOOKS;
    const prevTele = process.env.BRO_TELEMETRY;
    delete process.env.BRO_HOOKS;
    process.env.BRO_TELEMETRY = '0';
    try {
      registerConnector({
        name: 'perm-e2e-guard',
        hooks: () => ({
          preTool: (_ctx, input) =>
            typeof input.input['command'] === 'string' && input.input['command'].includes('rm -rf')
              ? [{ block: 'destructive command vetoed by guard' }]
              : [],
        }),
      });
      try {
        // what acp.ts injects — the real collectors, no stub between
        // the wire and the policy
        const seam: AcpProxySeam = {
          permission: async (cwd, sid, call) => collectPermission(cwd, sid, call),
        };
        const clientAsks: unknown[] = [];
        const runTurn = async (command: string) => {
          const fake = fakeAcpAgent({
            askPermission: {
              options: OPTIONS,
              toolCall: {
                toolCallId: 'tc-1',
                title: `Bash: ${command}`,
                name: 'Bash',
                kind: 'execute',
                rawInput: { command },
              },
            },
          });
          const [clientSide, proxyUp] = streamPair();
          const [proxyDown, agentSide] = streamPair();
          const agentConn = fake.app.connect(agentSide);
          const conn = client({ name: 'e2e-client' })
            .onRequest('session/request_permission', ctx => {
              clientAsks.push(ctx.params);
              return {
                outcome: { outcome: 'selected', optionId: ctx.params.options[0]!.optionId },
              };
            })
            .connect(clientSide);
          const proxyDone = acpProxy(proxyUp, proxyDown, { seam, log: () => {} });
          try {
            await conn.agent.request('initialize', INIT);
            const { sessionId } = await conn.agent.request<{ sessionId: string }>('session/new', {
              cwd: main,
              mcpServers: [],
            });
            await conn.agent.request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text: 'x' }],
            });
            return fake;
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
        };

        // a guard-blocked command: the proxy denies on the wire — the
        // client never sees the ask and the reject option is what the
        // agent reads back
        const blocked = await runTurn('rm -rf /');
        assert.deepEqual(blocked.permissionOutcome, {
          outcome: 'selected',
          optionId: 'reject-once',
        });
        assert.equal(clientAsks.length, 0);

        // a self-tool command: bro's own tools approve outright, same
        // as the PermissionRequest hook
        const selfTool = await runTurn('bd ready');
        assert.deepEqual(selfTool.permissionOutcome, {
          outcome: 'selected',
          optionId: 'allow-once',
        });
        assert.equal(clientAsks.length, 0);

        // an ordinary command: no verdict — the human answers, the
        // ask crosses verbatim and so does the answer
        const asked = await runTurn('git status');
        assert.deepEqual(asked.permissionOutcome, {
          outcome: 'selected',
          optionId: 'allow-once',
        });
        assert.equal(clientAsks.length, 1);

        // the events journal carries one permission row per ask —
        // proxy-decided rows by:'proxy', the forwarded one by:'client'
        const perms = proxyRows(common).filter(r => r.kind === 'permission');
        assert.deepEqual(
          perms.map(r => `${r.decidedBy}:${r.verdict}`),
          ['proxy:denied', 'proxy:approved', 'client:approved']
        );
        assert.equal(perms[0]!.reason, 'destructive command vetoed by guard');
      } finally {
        unregisterConnector('perm-e2e-guard');
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
