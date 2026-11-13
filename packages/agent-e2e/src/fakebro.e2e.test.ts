/** FakeBro e2e — the scripted `bro` executable replaces the real CLI on
 *  the fixture PATH, so host-plugin behavior is tested against controlled
 *  hook replies instead of bro's live state. Assertions read BOTH
 *  journals: FakeBro's (which hooks fired, with what payload) and
 *  aimock's (what the model actually saw — injected context, reprompts,
 *  vetoed tool results). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, type JournalEntry } from './mock.ts';
import { makeEnv, which } from './env.ts';
import {
  installOpencodePlugin,
  opencodeApi,
  runOpencode,
  startOpencodeServer,
  writeOpencodeConfig,
} from './hosts/opencode.ts';
import { FakeBro } from './mocks/bro.ts';

const hasTools = (b: { tools?: unknown[] }): boolean =>
  Array.isArray(b.tools) && b.tools.length > 0;

const agentRequests = (journal: JournalEntry[]) =>
  journal.map(en => en.body as { messages?: unknown[]; tools?: unknown[] }).filter(hasTools);

test('S1: session-start context reaches the model request', {
  skip: which('opencode') === null && 'opencode binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'mock says hi' });
  const e = makeEnv();
  installOpencodePlugin(e);
  writeOpencodeConfig(e, mock.url);
  const fake = new FakeBro({
    hookRules: {
      'session-start': [{ reply: { context: 'BRO-CTX-MARKER-7f3a' } }],
    },
  }).install(e);

  const res = await runOpencode(e, 'say hi');
  assert.equal(res.code, 0, `opencode exited ${res.code}\nstderr: ${res.stderr.slice(-2000)}`);

  // the hook fired with the session payload the adapter contract defines
  const hooks = fake.journal().filter(en => en.kind === 'hook');
  const sessionStart = hooks.find(en => en.event === 'session-start');
  assert.ok(sessionStart, `no session-start hook in journal: ${JSON.stringify(hooks)}`);
  assert.ok(
    typeof (sessionStart.payload as { session_id?: unknown })?.session_id === 'string',
    'session-start payload lacks session_id'
  );

  // and the context it answered actually reached the model — the plugin
  // pushes additionalContext into the request's system messages
  const bodies = agentRequests(await mock.journal());
  assert.ok(bodies.length >= 1, 'no agent request reached the mock');
  const saw = bodies.some(b => JSON.stringify(b).includes('BRO-CTX-MARKER-7f3a'));
  assert.ok(saw, 'session-start context never reached the model request body');
});

test('S3: stop gate blocks once, reprompts, then passes', {
  skip: which('opencode') === null && 'opencode binary not on PATH',
}, async () => {
  await using mock = await startMock();
  mock.mock.on({ predicate: () => true }, { content: 'mock says hi' });
  const e = makeEnv();
  installOpencodePlugin(e);
  writeOpencodeConfig(e, mock.url);
  const fake = new FakeBro({
    hookSeq: {
      // first idle → block with a reason; every later idle → no opinion
      stop: [{ decision: 'block', reason: 'BRO-GATE-FINISH-THE-BEAD' }, {}],
    },
  }).install(e);
  // `opencode run` exits with the turn — session.idle never reaches the
  // plugin. serve mode keeps the processor alive so the gate can fire.
  const srv = await startOpencodeServer(e);
  try {
    const created = (await opencodeApi(e, srv.url, 'session.create', { data: {} })) as {
      id?: string;
      data?: { id?: string };
    };
    const sessionID = created.id ?? created.data?.id;
    assert.ok(sessionID, `session.create returned no id: ${JSON.stringify(created)}`);
    await opencodeApi(e, srv.url, 'session.prompt', {
      params: { sessionID },
      data: { text: 'say hi' },
    });

    // the gate chain: turn → idle → block → reprompt → turn → idle → pass
    const deadline = Date.now() + 90_000;
    let stops: ReturnType<FakeBro['journal']> = [];
    while (Date.now() < deadline) {
      stops = fake.journal().filter(en => en.kind === 'hook' && en.event === 'stop');
      if (stops.length >= 2) {
        break;
      }
      await new Promise(r => setTimeout(r, 700));
    }
    assert.equal(stops.length, 2, `expected 2 stop probes, got ${stops.length}`);
    // the reprompt armed the one-shot flag — the second probe says so
    assert.equal(
      (stops[1].payload as { stop_hook_active?: boolean })?.stop_hook_active,
      true,
      'second stop probe did not carry stop_hook_active'
    );

    // the block reason became a real reprompt: a second agent request
    // whose body carries the gate text as the new user message
    const bodies = agentRequests(await mock.journal());
    assert.ok(bodies.length >= 2, `expected a reprompt turn, got ${bodies.length} agent requests`);
    const reprompted = bodies
      .slice(1)
      .some(b => JSON.stringify(b).includes('BRO-GATE-FINISH-THE-BEAD'));
    assert.ok(reprompted, 'gate reason never reached the model as a reprompt');

    // and the session itself recorded the gate message
    const msgs = await opencodeApi(e, srv.url, 'session.message.list', {
      params: { sessionID },
    });
    assert.ok(
      JSON.stringify(msgs).includes('BRO-GATE-FINISH-THE-BEAD'),
      'gate reason missing from session messages'
    );
  } finally {
    await srv.stop();
  }
});

test('S2: pre-tool guard vetoes a tool call and the veto reaches the model', {
  skip: which('opencode') === null && 'opencode binary not on PATH',
}, async () => {
  await using mock = await startMock();
  const hasToolMsg = (b: { messages?: { role?: string }[] }): boolean =>
    (b.messages ?? []).some(m => m.role === 'tool');
  // leg 1: agent request with no tool result yet → ask for bash
  mock.mock.on(
    {
      predicate: (req: { tools?: unknown[]; messages?: { role?: string }[] }) =>
        hasTools(req) && !hasToolMsg(req),
    },
    {
      content: 'running the command',
      toolCalls: [{ name: 'shell', arguments: '{"command":"echo hi"}' }],
    }
  );
  // leg 2: the tool result came back (vetoed) → wrap up
  mock.mock.on(
    {
      predicate: (req: { tools?: unknown[]; messages?: { role?: string }[] }) =>
        hasTools(req) && hasToolMsg(req),
    },
    { content: 'veto observed, done' }
  );
  mock.mock.on({ predicate: () => true }, { content: 'mock says hi' });
  const e = makeEnv();
  installOpencodePlugin(e);
  writeOpencodeConfig(e, mock.url);
  const fake = new FakeBro({
    hookRules: {
      'pre-tool': [{ reply: { decision: 'block', reason: 'BRO-VETO-NO-SHELL' } }],
    },
  }).install(e);

  const res = await runOpencode(e, 'run echo hi');
  assert.equal(res.code, 0, `opencode exited ${res.code}\nstderr: ${res.stderr.slice(-2000)}`);

  const preTool = fake.journal().find(en => en.kind === 'hook' && en.event === 'pre-tool');
  assert.ok(preTool, 'pre-tool hook never fired for the bash call');
  const payload = preTool.payload as { tool_name?: string; tool_input?: { command?: string } };
  assert.equal(payload.tool_name, 'shell');
  assert.equal(payload.tool_input?.command, 'echo hi');

  // the veto error is what the model saw as the tool result on leg 2
  const bodies = agentRequests(await mock.journal());
  const leg2 = bodies.find(b => hasToolMsg(b as { messages?: { role?: string }[] }));
  assert.ok(leg2, 'no follow-up request carrying the tool result');
  assert.ok(
    JSON.stringify(leg2).includes('BRO-VETO-NO-SHELL'),
    'veto reason never reached the model as the tool result'
  );
});
