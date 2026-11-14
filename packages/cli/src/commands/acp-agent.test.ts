/**
 * `bro acp` agent mode (specs/bro-tegz2.md) — argv parsing, provider
 * resolution (fleet.routing class → chain head), the advertised
 * slash-command set, and the in-process e2e: a typed `client()` app
 * over a stream pair in front of `fakeAcpAgent`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// node --test runs each file in its own process — keep the telemetry
// endpoint off so spans never POST to a real collector mid-test
process.env.BRO_TELEMETRY = '0';

import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AnyMessage, InitializeRequest, Stream } from '@agentclientprotocol/sdk';
import type { ProviderEntry, RoutingTable } from '@broject/core';
import { fakeAcpAgent } from '@broject/providers/testkit';
import {
  acpAgentFlags,
  advertisedCommands,
  matchSlash,
  resolveAcpAgentProvider,
  runAcpAgent,
  SLASH_BLOCKLIST,
} from './acp-agent.ts';
import type { ContractCommandRow, ContractDump } from './contract-dump.ts';

const ACP = (command = 'fake acp'): ProviderEntry => ({ type: 'acp', command });
const API = (): ProviderEntry => ({ type: 'api', baseUrl: 'http://x', models: {} });
const CLI = (): ProviderEntry => ({ type: 'cli', command: 'x' });

describe('bro acp — agent flags', () => {
  test('bare is agent mode; --provider/--class parse both spellings', () => {
    assert.deepEqual(acpAgentFlags([]), {});
    assert.deepEqual(acpAgentFlags(['--provider', 'devin']), { provider: 'devin' });
    assert.deepEqual(acpAgentFlags(['--provider=devin']), { provider: 'devin' });
    assert.deepEqual(acpAgentFlags(['--class', 'sweep']), { class: 'sweep' });
  });

  test('--provider + --class are mutually exclusive; anything else → usage', () => {
    assert.throws(() => acpAgentFlags(['--provider', 'a', '--class', 'b']), /mutually exclusive/);
    assert.throws(() => acpAgentFlags(['bogus']), /unknown subcommand/);
    assert.throws(() => acpAgentFlags(['--model', 'm']), /unknown option|usage/);
    assert.throws(() => acpAgentFlags(['--provider']), /requires a value|usage/);
  });
});

describe('bro acp — provider selection (fleet.routing class → chain head)', () => {
  test('--provider pins an acp entry; a wrong kind or unknown name is a config error', () => {
    const providers = { a: ACP(), b: API() };
    assert.equal(resolveAcpAgentProvider(providers, {}, { provider: 'a' }).name, 'a');
    assert.throws(() => resolveAcpAgentProvider(providers, {}, { provider: 'b' }), /api entry/);
    assert.throws(
      () => resolveAcpAgentProvider(providers, {}, { provider: 'ghost' }),
      /not configured/
    );
  });

  test('routing declared → the class chain head; --class picks the lane', () => {
    const providers = { head: ACP(), second: ACP(), cli: CLI() };
    const routing: RoutingTable = {
      default: { chain: [{ provider: 'head' }, { provider: 'second' }] },
      work: { chain: [{ provider: 'second' }] },
    };
    assert.equal(resolveAcpAgentProvider(providers, routing, {}).name, 'head');
    assert.equal(resolveAcpAgentProvider(providers, routing, { class: 'work' }).name, 'second');
  });

  test('a non-acp chain head and an undeclared class are config errors', () => {
    const providers = { cli: CLI() };
    assert.throws(
      () =>
        resolveAcpAgentProvider(
          providers,
          { bad: { chain: [{ provider: 'cli' }] } },
          { class: 'bad' }
        ),
      /cli entry/
    );
    assert.throws(
      () =>
        resolveAcpAgentProvider(
          providers,
          { default: { chain: [{ provider: 'cli' }] } },
          { class: 'ghost' }
        ),
      /fleet\.routing has no class "ghost"/
    );
  });

  test('no routing → the first acp entry in config order; none → a config error', () => {
    const providers = { a: API(), b: ACP(), c: ACP() };
    assert.equal(resolveAcpAgentProvider(providers, undefined, {}).name, 'b');
    // an empty table is undeclared — the same fallback
    assert.equal(resolveAcpAgentProvider({ b: ACP() }, {}, {}).name, 'b');
    assert.throws(() => resolveAcpAgentProvider({ a: API() }, undefined, {}), /no acp provider/);
    assert.throws(() => resolveAcpAgentProvider({}, undefined, {}), /no acp provider/);
  });
});

function dump(...rows: Partial<ContractCommandRow>[]): ContractDump {
  const base: ContractCommandRow = {
    name: '',
    summary: '',
    spellings: [],
    aliases: [],
    hidden: false,
    plan: false,
    external: false,
  };
  return {
    version: 1,
    groups: {},
    commands: Object.fromEntries(rows.map((r, i) => [r.name ?? `c${i}`, { ...base, ...r }])),
  };
}

describe('bro acp — the advertised slash set', () => {
  test('hidden and serving/loop commands stay off the wire; the rest carry name/summary/hint', () => {
    const d = dump(
      { name: 'act', summary: 'Open-PR loop', contract: { subs: { status: {}, threads: {} } } },
      { name: 'next', summary: 'claim the top bead' },
      { name: 'acp', summary: 'ACP edge' },
      { name: 'mcp', summary: 'stdio MCP server' },
      { name: 'serve', summary: 'facade host' },
      { name: 'secret', summary: 'hidden', hidden: true }
    );
    const cmds = advertisedCommands(d);
    assert.deepEqual(
      cmds.map(c => c.name),
      ['act', 'next']
    );
    assert.equal(cmds[0]!.description, 'Open-PR loop');
    assert.equal(cmds[0]!.input?.hint, 'status|threads');
    assert.equal(cmds[1]!.input?.hint, 'args');
    // the blocklist is explicit — a wire-serving or never-ending turn
    // can never be a session turn
    for (const name of [
      'acp',
      'acp-worker',
      'herdr',
      'mcp',
      'serve',
      'daemon',
      'watch',
      'watchdog',
      'loop',
    ]) {
      assert.equal(SLASH_BLOCKLIST.has(name), true, `${name} must be blocklisted`);
    }
  });
});

describe('bro acp — matchSlash', () => {
  test('a leading /name parses with its raw args; plain text is not a command', () => {
    assert.deepEqual(matchSlash('/act status'), { name: 'act', args: 'status' });
    assert.deepEqual(matchSlash('/act'), { name: 'act', args: '' });
    assert.deepEqual(matchSlash('/act --claim now'), { name: 'act', args: '--claim now' });
    assert.equal(matchSlash('act status'), undefined);
    assert.equal(matchSlash('  /act'), undefined);
    assert.equal(matchSlash('/'), undefined);
    assert.equal(matchSlash(''), undefined);
  });
});

describe('bro acp — agent mode e2e (specs/bro-tegz2.md §acceptance)', () => {
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
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  };

  const updateKind = (u: unknown): string | undefined =>
    (u as { update?: { sessionUpdate?: string } }).update?.sessionUpdate;
  const chunkText = (u: unknown): string | undefined =>
    (u as { update?: { content?: { text?: string } } }).update?.content?.text;

  async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) {
        throw new Error('until: timed out');
      }
      await new Promise(r => setTimeout(r, 10));
    }
  }

  test('a fake client lists bro slash commands, runs /act status locally, and a free-form prompt forwards downstream', async () => {
    const fake = fakeAcpAgent({ replyText: 'AGENT-SAYS-HI' });
    const [clientSide, proxyUp] = streamPair();
    const [proxyDown, agentSide] = streamPair();
    const agentConn = fake.app.connect(agentSide);
    const updates: unknown[] = [];
    const conn = client({ name: 'e2e-client' })
      .onNotification('session/update', ctx => {
        updates.push(ctx.params);
      })
      .connect(clientSide);
    const done = runAcpAgent(
      {},
      {
        streams: { upstream: proxyUp, downstream: proxyDown },
        commands: [{ name: 'act', description: 'Open-PR loop', input: { hint: 'status|threads' } }],
        // the slash child is a stub binary — the spawn/stream path is
        // real, the command itself is an echo
        cliArgv: argv => [
          process.execPath,
          '-e',
          `process.stdout.write(${JSON.stringify(`SLASH>${argv.join(' ')}`)})`,
        ],
        seam: {},
        log: () => {},
      }
    );
    try {
      const init = (await conn.agent.request('initialize', INIT)) as {
        agentInfo?: { name?: string };
      };
      // bro IS the agent — the downstream's name is not what the client sees
      assert.equal(init.agentInfo?.name, 'bro');

      const { sessionId } = (await conn.agent.request('session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      })) as { sessionId: string };
      // the slash list announced as an available_commands_update
      await until(() => updates.some(u => updateKind(u) === 'available_commands_update'));
      const announced = updates.find(u => updateKind(u) === 'available_commands_update') as {
        update: { availableCommands: { name: string }[] };
      };
      assert.deepEqual(
        announced.update.availableCommands.map(c => c.name),
        ['act']
      );

      // /act status runs on bro's side — the downstream never sees it
      const res = (await conn.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '/act status' }],
      })) as { stopReason: string };
      assert.equal(res.stopReason, 'end_turn');
      assert.deepEqual(fake.prompts, []);
      await until(() =>
        updates.some(
          u => updateKind(u) === 'agent_message_chunk' && chunkText(u)?.includes('SLASH>act status')
        )
      );

      // a free-form prompt forwards — the agent's reply streams back
      const res2 = (await conn.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hello agent' }],
      })) as { stopReason: string };
      assert.equal(res2.stopReason, 'end_turn');
      assert.deepEqual(fake.prompts, ['hello agent']);
      assert.equal(
        updates.some(
          u => updateKind(u) === 'agent_message_chunk' && chunkText(u) === 'AGENT-SAYS-HI'
        ),
        true
      );
    } finally {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      assert.equal(await done, 0);
      agentConn.close();
      await agentSide.writable
        .getWriter()
        .close()
        .catch(() => {});
    }
  });
});
