/**
 * `bro acp` agent mode (specs/bro-tegz2.md) — argv parsing, provider
 * resolution (fleet.routing class → chain head), the advertised
 * slash-command set, and the in-process e2e: a typed `client()` app
 * over a stream pair in front of `fakeAcpAgent`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node --test runs each file in its own process — keep the telemetry
// endpoint off so spans never POST to a real collector mid-test
process.env.BRO_TELEMETRY = '0';

// bro-eajeu — the e2e opens sessions with cwd = this checkout, which is
// REALISTIC (a client's session cwd is its repo) but must never touch
// the checkout's live <git-common>/bro: the pin redirects every
// runtime-state surface (proxy archive, bus socket) into a sandbox.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'bro-acp-state-'));
process.env.BRO_STATE_DIR = STATE_DIR;

import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  AnyMessage,
  InitializeRequest,
  SessionUpdate,
  Stream,
} from '@agentclientprotocol/sdk';
import type { ProviderEntry, RoutingTable } from '@broject/core';
import { fakeAcpAgent } from '@broject/providers/testkit';
import {
  acpAgentFlags,
  advertisedCommands,
  matchSlash,
  resolveAcpAgentProvider,
  runAcpAgent,
  runSlash,
  slashPrompt,
  slashTurnBlocked,
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

  test('--class with no routing table is a config error, not a silent first-acp pick', () => {
    const providers = { a: ACP(), b: ACP() };
    assert.throws(
      () => resolveAcpAgentProvider(providers, undefined, { class: 'work' }),
      /--class work — no fleet\.routing table/
    );
    // an empty table is undeclared — same rule
    assert.throws(
      () => resolveAcpAgentProvider(providers, {}, { class: 'work' }),
      /no fleet\.routing table/
    );
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
      'wait',
      'watch',
      'watchdog',
      'loop',
    ]) {
      assert.equal(SLASH_BLOCKLIST.has(name), true, `${name} must be blocklisted`);
    }
  });
});

describe('bro acp — slashTurnBlocked (argv shapes that cannot end)', () => {
  test('sub-level waits and repaint loops refuse; bounded shapes pass', () => {
    assert.equal(slashTurnBlocked('convoy', ['wait', 'mol-1']), 'convoy wait');
    assert.equal(slashTurnBlocked('mesh', ['wait', 'external:x:1']), 'mesh wait');
    assert.equal(slashTurnBlocked('drive', ['--every', '60']), 'drive --every');
    assert.equal(slashTurnBlocked('drive', ['--every=60']), 'drive --every=60');
    assert.equal(slashTurnBlocked('fleet', ['--live']), 'fleet --live');
    assert.equal(slashTurnBlocked('fleet', ['--every', '10']), 'fleet --every');
    // bounded siblings stay runnable
    assert.equal(slashTurnBlocked('convoy', ['status']), undefined);
    assert.equal(slashTurnBlocked('convoy', []), undefined);
    assert.equal(slashTurnBlocked('mesh', ['peers']), undefined);
    assert.equal(slashTurnBlocked('drive', []), undefined);
    assert.equal(slashTurnBlocked('drive', ['--once']), undefined);
    assert.equal(slashTurnBlocked('fleet', ['--json']), undefined);
    assert.equal(slashTurnBlocked('act', ['wait']), undefined);
  });
});

describe('bro acp — the local-turn handler (slashPrompt)', () => {
  const ACT = [{ name: 'act', description: 'Open-PR loop', input: { hint: 'status|threads' } }];
  const CONVOY = [{ name: 'convoy', description: 'mol queues', input: { hint: 'run|wait' } }];

  function turn(text: string, cwd: string | undefined, emitted: string[]) {
    return {
      sessionId: 's-1',
      cwd,
      text,
      emit: (u: SessionUpdate) => {
        const content = (u as { content?: { text?: string } }).content;
        emitted.push(content?.text ?? '');
      },
      signal: new AbortController().signal,
    };
  }

  test('a blocked argv shape refuses in-band — the child never spawns', async () => {
    const spawned: string[][] = [];
    const handler = slashPrompt(CONVOY, {
      cliArgv: argv => {
        spawned.push(argv);
        return argv;
      },
    });
    const emitted: string[] = [];
    const res = await handler(turn('/convoy wait mol-1', '/tmp/repo', emitted));
    assert.equal(res?.stopReason, 'end_turn');
    assert.deepEqual(spawned, []);
    assert.ok(
      emitted.some(t => t.includes('unbounded wait/loop')),
      `expected an in-band refusal, got: ${emitted.join()}`
    );
  });

  test('a cwd-less session refuses in-band rather than run in the wrong repo', async () => {
    const spawned: string[][] = [];
    const handler = slashPrompt(ACT, {
      cliArgv: argv => {
        spawned.push(argv);
        return argv;
      },
    });
    const emitted: string[] = [];
    const res = await handler(turn('/act status', undefined, emitted));
    assert.equal(res?.stopReason, 'end_turn');
    assert.deepEqual(spawned, []);
    assert.ok(
      emitted.some(t => t.includes('no working directory')),
      `expected an in-band refusal, got: ${emitted.join()}`
    );
  });

  test('an unadvertised /name falls through — undefined forwards downstream', async () => {
    const handler = slashPrompt(ACT, {});
    const res = await handler(turn('/ghost sub', '/tmp/repo', []));
    assert.equal(res, undefined);
    assert.equal(await handler(turn('plain text', '/tmp/repo', [])), undefined);
  });
});

describe('bro acp — runSlash', () => {
  test('an already-aborted signal still kills the child immediately', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const texts: string[] = [];
    const t0 = Date.now();
    await runSlash(
      [process.execPath, '-e', 'setInterval(() => {}, 1e9)'],
      process.cwd(),
      30_000, // a stuck child would hold the turn this long without the kill
      ctrl.signal,
      t => texts.push(t)
    );
    assert.ok(Date.now() - t0 < 15_000, 'a cancel that already landed must still kill the child');
    assert.ok(
      texts.some(t => t.includes('SIGTERM')),
      texts.join()
    );
  });

  test("the child's stdin is closed — a command reading stdin to EOF does not hang", async () => {
    const texts: string[] = [];
    await runSlash(
      [
        process.execPath,
        '-e',
        'let n=0;process.stdin.on("data",d=>{n+=d.length});process.stdin.on("end",()=>process.stdout.write("EOF>"+n))',
      ],
      process.cwd(),
      20_000,
      new AbortController().signal,
      t => texts.push(t)
    );
    assert.ok(
      texts.some(t => t.includes('EOF>0')),
      texts.join()
    );
  });

  test('a signal death outside the cancel/timeout paths reports in-band', async () => {
    const texts: string[] = [];
    await runSlash(
      [process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'],
      process.cwd(),
      20_000,
      new AbortController().signal,
      t => texts.push(t)
    );
    assert.ok(
      texts.some(t => t.includes('killed by SIGKILL')),
      texts.join()
    );
  });

  test('a child that ignores SIGTERM is SIGKILLed after the grace window', async () => {
    const ctrl = new AbortController();
    const texts: string[] = [];
    const t0 = Date.now();
    const run = runSlash(
      // traps SIGTERM and parks — without escalation 'close' would
      // wait the whole 60s timeout and jam the writeQ behind it
      [
        process.execPath,
        '-e',
        'process.stdout.write("READY\\n");process.on("SIGTERM",()=>{});setInterval(()=>{},1e9)',
      ],
      process.cwd(),
      60_000,
      ctrl.signal,
      t => texts.push(t)
    );
    const deadline = Date.now() + 10_000;
    while (!texts.some(t => t.includes('READY'))) {
      if (Date.now() >= deadline) {
        ctrl.abort();
        throw new Error(`SIGTERM test child never reached the ready barrier: ${texts.join()}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    ctrl.abort();
    await run;
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < 30_000,
      `a SIGTERM-ignoring child held the turn ${elapsed}ms — no escalation`
    );
    assert.ok(
      texts.some(t => t.includes('killed by SIGKILL')),
      texts.join()
    );
  });

  test('cancel kills the whole process group — a shell descendant dies too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-slashpg-'));
    try {
      const pidFile = join(dir, 'grandchild.pid');
      const ctrl = new AbortController();
      const run = runSlash(
        // a `bro exec`-shaped tree: sh spawns a descendant that
        // outlives nothing but shares the pipes — a direct-child
        // SIGTERM would leave it running
        ['/bin/sh', '-c', `sleep 300 & echo $! > '${pidFile}'; sleep 300`],
        process.cwd(),
        60_000,
        ctrl.signal,
        () => {}
      );
      setTimeout(() => ctrl.abort(), 150);
      await run;
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      assert.ok(pid > 0, `expected a grandchild pid, got ${readFileSync(pidFile, 'utf8')}`);
      // group-killed already — ESRCH (or EPERM-free throw) proves the
      // descendant is gone, not just the sh that forked it.
      //
      // The kill is ASYNCHRONOUS: the descendant can still answer
      // kill(0) for a moment after the group signal (dying, not yet
      // reaped). Poll briefly — the question is whether the descendant
      // is gone, not whether it was gone the instant the shell exited.
      // (This test was red on main under load — the check was a
      // single-shot race, not a defect in the group kill.)
      let alive = true;
      const deadline = Date.now() + 5_000;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(alive, false, `grandchild pid ${pid} survived the group kill`);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('a multibyte sequence split across stdout chunks decodes whole — no U+FFFD', async () => {
    const texts: string[] = [];
    await runSlash(
      [
        process.execPath,
        '-e',
        // a 4-byte emoji split mid-sequence: two writes 80ms apart
        // land as two 'data' events; a per-chunk toString would
        // stream a replacement pair mid-character
        'const b=Buffer.from("🚀","utf8");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),80);setTimeout(()=>{},160)',
      ],
      process.cwd(),
      20_000,
      new AbortController().signal,
      t => texts.push(t)
    );
    const out = texts.join('');
    assert.ok(out.includes('🚀'), `expected the emoji whole, got: ${out}`);
    assert.ok(!out.includes('�'), `replacement char leaked: ${out}`);
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

  /** client → `bro acp` (runAcpAgent, in-process streams) → fake agent. */
  function e2eRig() {
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
    /** teardown — client EOF settles the pump, then the agent side. */
    const finish = async (): Promise<number> => {
      conn.close();
      await clientSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      const code = await done;
      agentConn.close();
      await agentSide.writable
        .getWriter()
        .close()
        .catch(() => {});
      return code;
    };
    return { fake, conn, updates, finish };
  }

  /** initialize + session/new — asserts bro's identity and returns
   *  the stamped session once its command announce landed. */
  async function openE2eSession(r: ReturnType<typeof e2eRig>): Promise<string> {
    const init = (await r.conn.agent.request('initialize', INIT)) as {
      agentInfo?: { name?: string };
    };
    // bro IS the agent — the downstream's name is not what the client sees
    assert.equal(init.agentInfo?.name, 'bro');
    const { sessionId } = (await r.conn.agent.request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })) as { sessionId: string };
    await until(() => r.updates.some(u => updateKind(u) === 'available_commands_update'));
    return sessionId;
  }

  test('a fake client lists bro slash commands and runs /act status locally — the downstream never sees it', async () => {
    const r = e2eRig();
    try {
      const sessionId = await openE2eSession(r);
      const announced = r.updates.find(u => updateKind(u) === 'available_commands_update') as {
        update: { availableCommands: { name: string }[] };
      };
      assert.deepEqual(
        announced.update.availableCommands.map(c => c.name),
        ['act']
      );

      // /act status runs on bro's side — the downstream never sees it
      const res = (await r.conn.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '/act status' }],
      })) as { stopReason: string };
      assert.equal(res.stopReason, 'end_turn');
      assert.deepEqual(r.fake.prompts, []);
      await until(() =>
        r.updates.some(
          u => updateKind(u) === 'agent_message_chunk' && chunkText(u)?.includes('SLASH>act status')
        )
      );
    } finally {
      assert.equal(await r.finish(), 0);
    }
  });

  test('a free-form prompt forwards downstream and the agent reply streams back verbatim', async () => {
    const r = e2eRig();
    try {
      const sessionId = await openE2eSession(r);
      const res = (await r.conn.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hello agent' }],
      })) as { stopReason: string };
      assert.equal(res.stopReason, 'end_turn');
      assert.deepEqual(r.fake.prompts, ['hello agent']);
      // the proxy-scope archive journals under the state pin — the
      // session's real cwd (this checkout) keeps a pristine bro/ tree
      const proxyFiles = readdirSync(join(STATE_DIR, 'bro', 'proxy')).filter(f =>
        f.startsWith(`acp-${sessionId}-`)
      );
      assert.equal(proxyFiles.length, 1, 'the proxy archive lands under BRO_STATE_DIR');
      assert.equal(
        r.updates.some(
          u => updateKind(u) === 'agent_message_chunk' && chunkText(u) === 'AGENT-SAYS-HI'
        ),
        true
      );
    } finally {
      assert.equal(await r.finish(), 0);
    }
  });
});
