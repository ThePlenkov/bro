import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AcpClient,
  type ClientRow,
  type PermissionAsk,
  splitArgv,
  splitArgvDetailed,
} from '../src/index.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE = join(HERE, 'fixtures', 'fake-agent.ts');

/** The fake agent's command — node runs the fixture's TS natively. */
const cmd = (): string[] => [process.execPath, FAKE];

/** Wait for a condition — the wire is async, the tests are not. */
const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

interface Harness {
  client: AcpClient;
  rows: ClientRow[];
  asks: PermissionAsk[];
  notes: string[];
}

/** A client wired to the fake agent with a script. */
const harness = (script: Record<string, unknown> = {}): Harness => {
  const rows: ClientRow[] = [];
  const asks: PermissionAsk[] = [];
  const notes: string[] = [];
  const client = new AcpClient({
    command: cmd(),
    env: { FAKE_AGENT: JSON.stringify(script) },
    onRow: row => rows.push(row),
    onPermission: ask => asks.push(ask),
    onNote: line => notes.push(line),
  });
  return { client, rows, asks, notes };
};

const promptRows = (rows: ClientRow[]): string[] =>
  rows
    .filter((r): r is Extract<ClientRow, { kind: 'prompt' }> => r.kind === 'prompt')
    .map(r => r.text);

describe('argv — the config is the trust boundary', () => {
  test('words split on whitespace, quotes group them', () => {
    assert.deepEqual(splitArgv('devin acp'), ['devin', 'acp']);
    assert.deepEqual(splitArgv('kilo acp --flag "a b"'), ['kilo', 'acp', '--flag', 'a b']);
    assert.deepEqual(splitArgv("kilo acp --flag 'a b'"), ['kilo', 'acp', '--flag', 'a b']);
    assert.deepEqual(splitArgv('  spaced   out  '), ['spaced', 'out']);
  });

  test('NO expansion — the text never becomes another program', () => {
    assert.deepEqual(splitArgv('echo $HOME'), ['echo', '$HOME']);
    assert.deepEqual(splitArgv('echo `id`'), ['echo', '`id`']);
    assert.deepEqual(splitArgv('ls *.ts'), ['ls', '*.ts']);
    assert.deepEqual(splitArgv('a; rm -rf /'), ['a;', 'rm', '-rf', '/']);
    assert.deepEqual(splitArgv('echo one|two'), ['echo', 'one|two']);
  });

  test('an escaped space is a space, an escaped backslash is a backslash', () => {
    assert.deepEqual(splitArgv('a\\ b'), ['a b']);
    assert.deepEqual(splitArgv('a\\\\b'), ['a\\b']);
  });

  test('a quoted span concatenates with its neighbours, like a shell', () => {
    assert.deepEqual(splitArgv("a'b c'd"), ['ab cd']);
    assert.deepEqual(splitArgv('a"b"c'), ['abc']);
  });

  test('an unclosed quote is a config error, never a half command', () => {
    assert.throws(() => splitArgv('kilo "acp'), /unclosed quote/);
    assert.throws(() => splitArgv("kilo 'acp"), /unclosed quote/);
  });

  test('a quote inside a bare word is a quote nobody closed', () => {
    assert.throws(() => splitArgv('a"b'), /unclosed quote/);
  });

  test('an empty quoted word is still a word', () => {
    assert.deepEqual(splitArgv('cmd "" x'), ['cmd', '', 'x']);
  });

  test('a trailing backslash protects nothing and is dropped', () => {
    assert.deepEqual(splitArgv('cmd a\\'), ['cmd', 'a']);
    // a lone backslash is no word at all
    assert.deepEqual(splitArgv('\\'), []);
  });

  test('escapes inside a quoted span are the char itself', () => {
    assert.deepEqual(splitArgv('cmd "a\\"b"'), ['cmd', 'a"b']);
  });

  test('the detailed split says which words were quoted', () => {
    assert.deepEqual(splitArgvDetailed('a "b c" d'), [
      { text: 'a', quoted: false },
      { text: 'b c', quoted: true },
      { text: 'd', quoted: false },
    ]);
  });
});

describe('the handshake', () => {
  test('initialize → session/new → live, with the capabilities parsed', async () => {
    const h = harness({
      caps: {
        loadSession: true,
        sessionCapabilities: { resume: true },
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
    });
    const caps = await h.client.start();
    assert.equal(caps.loadSession, true);
    assert.equal(caps.resume, true);
    assert.equal(caps.promptImage, true);
    assert.equal(caps.promptAudio, false);
    assert.equal(caps.promptEmbeddedContext, true);
    assert.equal(caps.agentName, 'fake');
    assert.equal(caps.protocolVersion, 1);
    assert.equal(h.client.status, 'live');
    assert.equal(h.client.sessionId, 'fake-1');
    await h.client.close();
  });

  test('a protocol we do not speak is refused, loudly', async () => {
    const h = harness({ protocolVersion: 99 });
    await assert.rejects(() => h.client.start(), /unsupported protocol/);
    assert.equal(h.client.status, 'failed');
    await h.client.close();
  });

  test('session/load continues a finished session', async () => {
    const h = harness({ caps: { loadSession: true } });
    const client = new AcpClient({
      command: cmd(),
      sessionId: 'old-1',
      env: { FAKE_AGENT: JSON.stringify({ caps: { loadSession: true } }) },
    });
    void h;
    await client.start();
    assert.equal(client.sessionId, 'old-1');
    await client.close();
  });

  test('an agent without loadSession refuses to continue — it is not a no-op', async () => {
    const client = new AcpClient({
      command: cmd(),
      sessionId: 'old-1',
      env: { FAKE_AGENT: JSON.stringify({ caps: {} }) },
    });
    await assert.rejects(() => client.start(), /loadSession/);
    await client.close();
  });

  test('a capability map advertises by NAME — `resume: {}` means yes', async () => {
    const h = harness({ caps: { sessionCapabilities: { resume: {} } } });
    const caps = await h.client.start();
    // ACP's capability maps hold an option BAG per name; the name
    // being there is the advertisement
    assert.equal(caps.resume, true);
    await h.client.close();

    const off = harness({ caps: { sessionCapabilities: { resume: false } } });
    const offCaps = await off.client.start();
    assert.equal(offCaps.resume, false);
    await off.client.close();
  });

  test('resume is opt-in and needs the capability the agent advertises', async () => {
    const client = new AcpClient({
      command: cmd(),
      sessionId: 'old-1',
      useResume: true,
      env: { FAKE_AGENT: JSON.stringify({ caps: { loadSession: true } }) },
    });
    await assert.rejects(() => client.start(), /resume/);
    await client.close();
  });
});

describe('a turn', () => {
  test('the rows are the archive shapes — the renderer stays untouched', async () => {
    const h = harness({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }],
    });
    await h.client.start();
    await h.client.prompt('do it');
    const kinds = h.rows.map(r => r.kind);
    assert.deepEqual(kinds, ['prompt', 'turn', 'update', 'turn']);
    assert.equal(h.rows[0]?.kind === 'prompt' ? h.rows[0].text : '', 'do it');
    assert.equal(h.rows[1]?.kind === 'turn' ? h.rows[1].phase : '', 'start');
    assert.equal(h.rows[3]?.kind === 'turn' ? h.rows[3].phase : '', 'stop');
    assert.equal(h.rows[3]?.kind === 'turn' ? h.rows[3].stopReason : '', 'end_turn');
    await h.client.close();
  });

  test('every row carries a stamp — the pane time gutter rides on it', async () => {
    const h = harness();
    await h.client.start();
    await h.client.prompt('do it');
    for (const row of h.rows) {
      assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
    }
    await h.client.close();
  });
});

describe('the queue — what the protocol does not have', () => {
  test('a prompt during a turn waits; it never rejects for busy', async () => {
    const h = harness({ mode: 'hold' });
    await h.client.start();
    const first = h.client.prompt('one');
    await waitFor(() => h.client.busy);
    await h.client.prompt('two');
    assert.deepEqual(h.client.pendingPrompts, [{ ordinal: 1, text: 'two' }]);
    assert.equal(h.client.busy, true);
    // the queue survives the cancel — cancelling stops the turn, not the human's words
    assert.equal(h.client.cancel(), true);
    await first;
    await waitFor(() => promptRows(h.rows).includes('two'));
    await h.client.close();
  });

  test('a prompt typed BEFORE the session opens waits for it', async () => {
    const h = harness();
    // the pane is usable while the handshake is still running
    await h.client.prompt('typed early');
    assert.deepEqual(h.client.pendingPrompts, [{ ordinal: 1, text: 'typed early' }]);
    await h.client.start();
    await waitFor(() => promptRows(h.rows).includes('typed early'));
    assert.deepEqual(h.client.pendingPrompts, []);
    await h.client.close();
  });

  test('the queue drains itself when the turn ends', async () => {
    const h = harness();
    await h.client.start();
    const first = h.client.prompt('one');
    const second = h.client.prompt('two');
    await Promise.all([first, second]);
    await waitFor(() => promptRows(h.rows).length === 2);
    assert.deepEqual(promptRows(h.rows), ['one', 'two']);
    assert.deepEqual(h.client.pendingPrompts, []);
    await h.client.close();
  });

  test('the queue keeps its order', async () => {
    const h = harness({ mode: 'hold' });
    await h.client.start();
    const first = h.client.prompt('one');
    await waitFor(() => h.client.busy);
    await h.client.prompt('two');
    await h.client.prompt('three');
    assert.deepEqual(h.client.pendingPrompts, [
      { ordinal: 1, text: 'two' },
      { ordinal: 2, text: 'three' },
    ]);
    h.client.cancel();
    await first;
    await h.client.close();
  });

  test('a cancel with nothing in flight is a no-op, never an error', async () => {
    const h = harness();
    await h.client.start();
    assert.equal(h.client.cancel(), false);
    await h.client.close();
  });
});

describe('permissions — the human decides', () => {
  test('an ask surfaces with the agent’s own options', async () => {
    const h = harness({
      askPermission: true,
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await h.client.start();
    const turn = h.client.prompt('do it');
    await waitFor(() => h.asks.length === 1);
    const ask = h.asks[0] as PermissionAsk;
    assert.equal(ask.title, 'Run ls');
    assert.equal(ask.toolCallId, 'tool-1');
    assert.deepEqual(
      ask.options.map(o => o.optionId),
      ['allow', 'reject']
    );
    assert.equal(h.client.awaitingPermission?.requestId, ask.requestId);
    assert.equal(h.client.answerPermission(ask.requestId, 'allow'), true);
    await turn;
    await h.client.close();
  });

  test('the answer carries the agent’s own optionId back', async () => {
    const h = harness({ askPermission: true });
    await h.client.start();
    const turn = h.client.prompt('do it');
    await waitFor(() => h.asks.length === 1);
    h.client.answerPermission((h.asks[0] as PermissionAsk).requestId, 'allow');
    await waitFor(() =>
      h.rows.some(r => r.kind === 'update' && r.update.sessionUpdate === 'fake/permission_outcome')
    );
    const row = h.rows.find(
      r => r.kind === 'update' && r.update.sessionUpdate === 'fake/permission_outcome'
    ) as Extract<ClientRow, { kind: 'update' }>;
    const outcome = row.update.outcome as { outcome?: string; optionId?: string };
    assert.equal(outcome.outcome, 'selected');
    assert.equal(outcome.optionId, 'allow');
    await turn;
    await h.client.close();
  });

  test('a denial is a denial — never an approval in disguise', async () => {
    const h = harness({ askPermission: true });
    await h.client.start();
    const turn = h.client.prompt('do it');
    await waitFor(() => h.asks.length === 1);
    h.client.denyPermission((h.asks[0] as PermissionAsk).requestId);
    await waitFor(() =>
      h.rows.some(r => r.kind === 'update' && r.update.sessionUpdate === 'fake/permission_outcome')
    );
    const row = h.rows.find(
      r => r.kind === 'update' && r.update.sessionUpdate === 'fake/permission_outcome'
    ) as Extract<ClientRow, { kind: 'update' }>;
    const outcome = row.update.outcome as { outcome?: string };
    assert.equal(outcome.outcome, 'cancelled');
    await turn;
    await h.client.close();
  });

  test('an unknown request id is refused, not answered into the void', async () => {
    const h = harness({ askPermission: true });
    await h.client.start();
    const turn = h.client.prompt('do it');
    await waitFor(() => h.asks.length === 1);
    assert.equal(h.client.answerPermission(424242, 'allow'), false);
    assert.equal(h.client.denyPermission(424242), false);
    h.client.denyPermission((h.asks[0] as PermissionAsk).requestId);
    await turn;
    await h.client.close();
  });

  test('an unanswered ask ends as a denial when the pane goes away', async () => {
    const h = harness({ askPermission: true });
    await h.client.start();
    void h.client.prompt('do it');
    await waitFor(() => h.asks.length === 1);
    assert.equal(h.client.denyAllPermissions(), 1);
    assert.equal(h.client.awaitingPermission, undefined);
    await h.client.close();
  });

  test('a close denies every outstanding ask — never a silent yes', async () => {
    const h = harness({ askPermission: true });
    await h.client.start();
    void h.client.prompt('do it');
    await waitFor(() => h.asks.length === 1);
    await h.client.close();
    assert.equal(h.client.awaitingPermission, undefined);
  });
});

describe('a wedged turn', () => {
  test('the turn fails loudly — it never hangs the pane', async () => {
    const h = harness({ mode: 'hold' });
    await h.client.start();
    // the agent holds the turn open; the client's own deadline ends it
    const client = new AcpClient({
      command: cmd(),
      env: { FAKE_AGENT: JSON.stringify({ mode: 'hold' }) },
      turnMs: 150,
      onRow: row => h.rows.push(row),
    });
    await client.start();
    await client.prompt('never answered');
    const stop = h.rows.find(r => r.kind === 'turn' && r.phase === 'stop');
    assert.ok(stop !== undefined, 'the turn must end, not hang');
    assert.equal(stop.kind === 'turn' ? stop.stopReason : '', 'error');
    assert.equal(client.status, 'failed');
    await client.close();
    await h.client.close();
  });
});

describe('a dead transport', () => {
  test('the turn fails, loudly — no silent success', async () => {
    const h = harness({ die: true });
    await assert.rejects(() => h.client.start());
    assert.equal(h.client.status, 'failed');
    await h.client.close();
  });

  test('a prompt on a dead session refuses to be sent', async () => {
    const h = harness({ die: true });
    await assert.rejects(() => h.client.start());
    await assert.rejects(() => h.client.prompt('nope'), /not live/);
    await h.client.close();
  });
});
