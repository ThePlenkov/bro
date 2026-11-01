/**
 * The session pane model — archive rows in, item tree + ops out. Pure
 * and headless: the OpenTUI shell applies the ops, these tests assert
 * the tree and the mutation stream.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ArchiveRow } from '../../../packages/cli/src/commands/session-feed.ts';
import { MAX_ITEMS, type Op, SessionModel, type ToolItem } from '../tui/model.ts';
import { dayLabel, hhmm } from '../tui/view.ts';

const upd = (u: Record<string, unknown>): ArchiveRow => ({ kind: 'update', update: u as never });
const chunk = (kind: string, text: string): ArchiveRow =>
  upd({ sessionUpdate: kind, content: { type: 'text', text } });

const ops = (m: SessionModel): Op[] => m.drain();

describe('SessionModel — chunk coalescing', () => {
  test('same-kind chunk run merges into one growing item', () => {
    const m = new SessionModel();
    m.feed(chunk('agent_message_chunk', 'Hello'));
    m.feed(chunk('agent_message_chunk', ' world'));
    m.feed(chunk('agent_message_chunk', '!'));
    m.feed(chunk('agent_thought_chunk', 'thinking'));
    m.feed(chunk('agent_thought_chunk', ' more'));
    m.feed(upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'pending' }));

    const kinds = m.items.map(i => i.kind);
    assert.deepEqual(kinds, ['message', 'thought', 'tool']);
    const msg = m.items[0]!;
    assert.equal(msg.kind === 'message' ? msg.text : '', 'Hello world!');
    const th = m.items[1]!;
    assert.equal(th.kind === 'thought' ? th.text : '', 'thinking more');

    // ops: append msg, text×2, append thought, text, append tool
    const shapes = ops(m).map(o => o.op);
    assert.deepEqual(shapes, ['append', 'text', 'text', 'append', 'text', 'append']);
  });

  test('a structural row between same-kind runs opens a new item', () => {
    const m = new SessionModel();
    m.feed(chunk('agent_message_chunk', 'one'));
    m.feed(upd({ sessionUpdate: 'usage_update', used: 1, size: 2 }));
    m.feed(chunk('agent_message_chunk', 'two'));
    assert.deepEqual(
      m.items.map(i => i.kind),
      ['message', 'note', 'message']
    );
    const last = m.items[2]!;
    assert.equal(last.kind === 'message' ? last.text : '', 'two');
  });

  test('multi-line chunk text keeps real newlines', () => {
    const m = new SessionModel();
    m.feed(chunk('agent_thought_chunk', 'line1\nline2'));
    m.feed(chunk('agent_thought_chunk', '\nline3'));
    const th = m.items[0]!;
    assert.equal(th.kind === 'thought' ? th.text : '', 'line1\nline2\nline3');
    assert.deepEqual(m.dump(), ['line1', 'line2', 'line3']);
  });

  test('ESC and control bytes never reach item text', () => {
    const m = new SessionModel();
    m.feed(chunk('agent_message_chunk', 'safe\x1b[2J\x1b[31mok\x07'));
    const msg = m.items[0]!;
    const text = msg.kind === 'message' ? msg.text : '';
    assert.equal(text, 'safeok');
  });
});

describe('SessionModel — tool cards', () => {
  const open = (id = 't1'): ArchiveRow =>
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: 'Bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls -la /tmp' },
    });

  test('open then complete lands header + content in one item', () => {
    const m = new SessionModel();
    m.feed(open());
    m.feed(
      upd({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'OUT-LINE' } }],
      })
    );
    const tool = m.items[0]! as ToolItem;
    assert.equal(tool.kind, 'tool');
    assert.equal(tool.title, 'Bash');
    assert.equal(tool.toolKind, 'execute');
    assert.equal(tool.arg, 'ls -la /tmp');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.bodyLanded, true);
    assert.deepEqual(tool.content, [{ kind: 'text', text: 'OUT-LINE' }]);
    assert.ok(m.dump().join('\n').includes('OUT-LINE'));
  });

  test('pending and in_progress are one live edge — no churn ops', () => {
    const m = new SessionModel();
    m.feed(upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' }));
    const n1 = ops(m).length;
    m.feed(upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }));
    const more = ops(m);
    assert.equal(n1 >= 1, true);
    assert.equal(more.length, 0);
    const tool = m.items[0]! as ToolItem;
    assert.equal(tool.status, 'live');
  });

  test('a terminal repeat that newly carries content lands once', () => {
    const m = new SessionModel();
    m.feed(open());
    m.feed(upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
    m.feed(
      upd({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'LATE' } }],
      })
    );
    const tool = m.items[0]! as ToolItem;
    assert.equal(tool.bodyLanded, true);
    assert.deepEqual(tool.content, [{ kind: 'text', text: 'LATE' }]);
    // a third content-carrying repeat does NOT re-emit
    ops(m);
    m.feed(
      upd({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'AGAIN' } }],
      })
    );
    assert.equal(ops(m).length, 0);
    assert.equal(tool.content.length, 1);
  });

  test('failed is a terminal edge — ✗ in the dump', () => {
    const m = new SessionModel();
    m.feed(open());
    m.feed(upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }));
    const tool = m.items[0]! as ToolItem;
    assert.equal(tool.status, 'failed');
    assert.ok(m.dump()[0]!.startsWith('✗'));
  });

  test('arg extraction prefers the kind-guided rawInput key', () => {
    const m = new SessionModel();
    m.feed(
      upd({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Fetch',
        kind: 'fetch',
        status: 'pending',
        rawInput: { url: 'https://x', pattern: 'unused' },
      })
    );
    assert.equal((m.items[0]! as ToolItem).arg, 'https://x');
  });

  test('locations[0] is the arg fallback', () => {
    const m = new SessionModel();
    m.feed(
      upd({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Edit',
        status: 'pending',
        locations: [{ path: '/src/a.ts' }],
      })
    );
    assert.equal((m.items[0]! as ToolItem).arg, '/src/a.ts');
  });
});

describe('SessionModel — content classification', () => {
  const done = (content: unknown[]): ArchiveRow =>
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit',
      status: 'completed',
      content,
    });

  test('diff items parse path + old/new text', () => {
    const m = new SessionModel();
    m.feed(done([{ type: 'diff', path: '/f.ts', oldText: 'old', newText: 'new' }]));
    const tool = m.items[0]! as ToolItem;
    assert.deepEqual(tool.content, [{ kind: 'diff', path: '/f.ts', old: 'old', cur: 'new' }]);
    const dump = m.dump().join('\n');
    assert.ok(dump.includes('─ /f.ts'));
    assert.ok(dump.includes('- old'));
    assert.ok(dump.includes('+ new'));
  });

  test('terminal content is a note, not dropped', () => {
    const m = new SessionModel();
    m.feed(done([{ type: 'terminal', terminalId: 'term-9' }]));
    const tool = m.items[0]! as ToolItem;
    assert.deepEqual(tool.content, [{ kind: 'terminal', id: 'term-9' }]);
    assert.ok(m.dump().join('\n').includes('terminal output is not archived'));
  });

  test('unknown content types stay visible', () => {
    const m = new SessionModel();
    m.feed(done([{ type: 'resource_link', uri: 'x://y' }]));
    const tool = m.items[0]! as ToolItem;
    assert.deepEqual(tool.content, [{ kind: 'unknown', type: 'resource_link' }]);
    assert.ok(m.dump().join('\n').includes('[resource_link]'));
  });
});

describe('SessionModel — side rows + verdict', () => {
  test('a normal end_turn prints no marker; abnormal stops and permissions land as side items', () => {
    const m = new SessionModel();
    m.feed({ kind: 'turn', phase: 'start' });
    m.feed({ kind: 'turn', phase: 'stop', stopReason: 'end_turn' });
    m.feed({ kind: 'permission', title: 'Write /x', verdict: 'denied' });
    assert.deepEqual(
      m.items.map(i => i.kind),
      ['permission']
    );
    assert.ok(m.items[0]!.text.includes('permission ‹Write /x›'));
    assert.equal(m.verdict?.led.state, 'blocked');
    assert.equal(m.verdict?.mode, 'permission — denied');

    m.feed({ kind: 'turn', phase: 'stop', stopReason: 'cancelled' });
    const last = m.items.at(-1)!;
    assert.ok(last.kind === 'turn' && last.text.includes('turn ended (cancelled)'));
  });

  test('turn stop clean → idle; error → blocked', () => {
    const m = new SessionModel();
    m.feed({ kind: 'turn', phase: 'stop', stopReason: 'end_turn' });
    assert.equal(m.verdict?.led.state, 'idle');
    m.feed({ kind: 'turn', phase: 'stop', error: 'crash' });
    assert.equal(m.verdict?.led.state, 'blocked');
    assert.equal(m.verdict?.mode, 'turn error');
  });

  test('update rows keep working verdict; unknown kinds parse through', () => {
    const m = new SessionModel();
    m.feed(upd({ sessionUpdate: 'session_info_update', title: 's1' }));
    assert.equal(m.verdict?.led.state, 'working');
    m.feed({ kind: 'future-kind', phase: '?' } as ArchiveRow);
    assert.equal(m.items[m.items.length - 1]!.kind, 'note'); // session info note still last
  });
});

describe('SessionModel — time separators', () => {
  const msg = (ts: string, text = 'hi'): ArchiveRow => ({
    kind: 'update',
    ts,
    // a note per row — chunks of one kind would merge into the tail
    // item (no birth, no head); these always birth a fresh item
    update: { sessionUpdate: 'session_info_update', title: text } as never,
  });
  const turnStart = (ts: string, by?: string): ArchiveRow => ({
    kind: 'turn',
    phase: 'start',
    ts,
    ...(by !== undefined ? { by } : {}),
  });
  const times = (m: SessionModel): string[] =>
    m.items.filter(i => i.kind === 'time').map(i => i.text);

  test('a turn start lazily heads its group — minute · origin, provider unwrapped', () => {
    const m = new SessionModel();
    m.feed(turnStart('2026-03-01T22:36:00Z', "acp provider 'devin-acp'"));
    m.feed(msg('2026-03-01T22:36:05Z'));
    assert.deepEqual(times(m), [
      `── ${dayLabel('2026-03-01T22:36:05Z')} ──`, // the first birth anchors the day
      `── ${hhmm('2026-03-01T22:36:05Z')} · devin-acp ──`,
    ]);
    // internal labels keep their raw by — never masquerade as the agent
    const m2 = new SessionModel();
    m2.feed(turnStart('2026-03-01T22:36:00Z', 'provider:kilo'));
    m2.feed(msg('2026-03-01T22:36:05Z'));
    assert.deepEqual(times(m2), [
      `── ${dayLabel('2026-03-01T22:36:05Z')} ──`,
      `── ${hhmm('2026-03-01T22:36:05Z')} · provider:kilo ──`,
    ]);
  });

  test('a micro-turn storm under one origin collapses to one head', () => {
    const m = new SessionModel();
    for (let i = 0; i < 5; i++) {
      m.feed(turnStart('2026-03-01T22:36:00Z', 'conductor:t'));
      m.feed(msg('2026-03-01T22:36:10Z', `v${i}`));
      m.feed({ kind: 'turn', phase: 'stop', ts: '2026-03-01T22:36:10Z', stopReason: 'end_turn' });
    }
    assert.deepEqual(times(m), [
      `── ${dayLabel('2026-03-01T22:36:10Z')} ──`,
      `── ${hhmm('2026-03-01T22:36:10Z')} · conductor:t ──`,
    ]);
  });

  test('a same-minute origin change re-heads; a mid-turn minute change re-heads with the new time', () => {
    // managed-agent origins — internal ones collapse into the ▸
    // storm note instead of birthing rows of their own
    const m = new SessionModel();
    m.feed(turnStart('2026-03-01T22:36:00Z', "acp provider 'kilo'"));
    m.feed(msg('2026-03-01T22:36:05Z'));
    m.feed(turnStart('2026-03-01T22:36:20Z', "acp provider 'cond'"));
    m.feed(msg('2026-03-01T22:36:25Z'));
    // still inside the cond turn, the minute rolls
    m.feed(msg('2026-03-01T22:37:05Z'));
    assert.deepEqual(times(m), [
      `── ${dayLabel('2026-03-01T22:36:05Z')} ──`,
      `── ${hhmm('2026-03-01T22:36:05Z')} · kilo ──`,
      `── ${hhmm('2026-03-01T22:36:25Z')} · cond ──`,
      `── ${hhmm('2026-03-01T22:37:05Z')} · cond ──`,
    ]);
  });

  test('internal origin churn stays under one head — the storm is one group', () => {
    const m = new SessionModel();
    m.feed(turnStart('2026-03-01T22:36:00Z', 'provider:kilo'));
    m.feed(msg('2026-03-01T22:36:05Z'));
    m.feed(turnStart('2026-03-01T22:36:20Z', 'conductor:t'));
    m.feed(msg('2026-03-01T22:36:25Z'));
    assert.deepEqual(times(m), [
      `── ${dayLabel('2026-03-01T22:36:05Z')} ──`,
      `── ${hhmm('2026-03-01T22:36:05Z')} · provider:kilo ──`,
    ]);
    // …and the one storm note names both origins
    const note = m.items.find(i => i.kind === 'note');
    assert.match(note!.text, /^▸ 2 internal calls · kilo, t$/m);
  });

  test('a turn that births nothing earns no head; pre-turn rows head bare', () => {
    const m = new SessionModel();
    m.feed(msg('2026-03-01T22:35:55Z')); // pre-turn traffic — bare tick
    m.feed(turnStart('2026-03-01T22:36:00Z', "acp provider 'x'"));
    m.feed({ kind: 'turn', phase: 'stop', ts: '2026-03-01T22:36:01Z', stopReason: 'end_turn' });
    assert.deepEqual(times(m), [
      `── ${dayLabel('2026-03-01T22:35:55Z')} ──`,
      `── ${hhmm('2026-03-01T22:35:55Z')} ──`,
    ]);
  });

  test('post-turn stragglers keep the last origin until the next start', () => {
    const m = new SessionModel();
    m.feed(turnStart('2026-03-01T22:36:00Z', 'provider:kilo'));
    m.feed(msg('2026-03-01T22:36:05Z'));
    m.feed({ kind: 'turn', phase: 'stop', ts: '2026-03-01T22:36:06Z', stopReason: 'end_turn' });
    m.feed(msg('2026-03-01T22:37:05Z')); // between turns — still the kilo group
    assert.deepEqual(times(m), [
      `── ${dayLabel('2026-03-01T22:36:05Z')} ──`,
      `── ${hhmm('2026-03-01T22:36:05Z')} · provider:kilo ──`,
      `── ${hhmm('2026-03-01T22:37:05Z')} · provider:kilo ──`,
    ]);
  });

  test('a day change emits its marker before the next head', () => {
    // +25h apart — a different LOCAL date in every TZ (fixed UTC
    // dates can resolve to one local date, e.g. 23:59Z and 00:01Z
    // are the same Mar-2 morning ahead of UTC)
    const t1 = '2026-03-01T23:59:30Z';
    const t2 = new Date(Date.parse(t1) + 25 * 3_600_000).toISOString();
    const m = new SessionModel();
    m.feed(turnStart(t1, "acp provider 'x'"));
    m.feed(msg(t1));
    m.feed(turnStart(t2, "acp provider 'x'"));
    m.feed(msg(t2));
    assert.deepEqual(times(m), [
      `── ${dayLabel(t1)} ──`,
      `── ${hhmm(t1)} · x ──`,
      `── ${dayLabel(t2)} ──`,
      `── ${hhmm(t2)} · x ──`,
    ]);
  });
});

describe('SessionModel — internal storms + turn seals', () => {
  const start = (by: string): ArchiveRow => ({ kind: 'turn', phase: 'start', by });
  const stop = (error?: string, stopReason?: string): ArchiveRow => ({
    kind: 'turn',
    phase: 'stop',
    ...(stopReason !== undefined ? { stopReason } : { stopReason: 'end_turn' }),
    ...(error !== undefined ? { error } : {}),
  });
  const chunk = (text: string): ArchiveRow => ({
    kind: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as never,
  });
  const texts = (m: SessionModel): string[] =>
    m.items.filter(i => i.kind !== 'time').map(i => i.text.split('\n')[0] ?? '');

  test('internal micro-turns collapse into one ▸ tally row — no fake merged replies', () => {
    const m = new SessionModel();
    for (let i = 0; i < 5; i++) {
      m.feed(start('conductor'));
      m.feed(chunk('ok'));
      m.feed(stop());
    }
    m.feed(start("acp provider 'x'"));
    m.feed(chunk('real reply'));
    const note = m.items.find(i => i.kind === 'note');
    assert.ok(note !== undefined);
    assert.match(note!.text, /^▸ 5 internal calls · conductor$/m);
    assert.ok(note!.text.includes('`ok`'));
    // the five "ok" replies never became items of their own — and
    // the agent's reply is untouched
    assert.deepEqual(
      texts(m).filter(t => t === 'real reply'),
      ['real reply']
    );
    assert.equal(m.items.filter(i => i.kind === 'message' && i.text === 'okok').length, 0);
  });

  test('a turn boundary seals the message item — same-kind chunks never merge across turns', () => {
    const m = new SessionModel();
    m.feed(start("acp provider 'x'"));
    m.feed(chunk('ok'));
    m.feed(stop());
    m.feed(start("acp provider 'x'"));
    m.feed(chunk('ok'));
    m.feed(stop());
    const msgs = m.items.filter(i => i.kind === 'message');
    assert.deepEqual(
      msgs.map(i => i.text),
      ['ok', 'ok']
    );
  });

  test('failed internal calls keep visible ✗ rows — deduped by (origin,error), tally counts all', () => {
    const m = new SessionModel();
    for (let i = 0; i < 3; i++) {
      m.feed(start('provider:kilo'));
      m.feed(stop('Internal error'));
    }
    m.feed(start('conductor:t'));
    m.feed(stop('boom'));
    const errs = m.items.filter(i => i.kind === 'turn' && i.text.startsWith('✗'));
    // 3 identical kilo failures → one visible row; conductor → one
    assert.deepEqual(
      errs.map(i => i.text),
      ['✗ kilo · Internal error', '✗ t · boom']
    );
    const note = m.items.find(i => i.kind === 'note');
    assert.match(note!.text, /^▸ 4 internal calls · 4 failed · kilo, t$/m);
  });

  test('a managed-agent failure keeps the bare banner — its head names the origin', () => {
    const m = new SessionModel();
    m.feed(start("acp provider 'x'"));
    m.feed(stop('blew up'));
    const errs = m.items.filter(i => i.kind === 'turn');
    assert.deepEqual(
      errs.map(i => i.text),
      ['── turn failed — blew up ──']
    );
  });
});

describe('SessionModel — eviction + toggle + plan', () => {
  test('past MAX_ITEMS the oldest items evict with ids in ops', () => {
    const m = new SessionModel();
    for (let i = 0; i < MAX_ITEMS + 5; i++) {
      m.feed(upd({ sessionUpdate: 'usage_update', used: i, size: i }));
    }
    assert.equal(m.items.length, MAX_ITEMS);
    const evictions = m
      .drain()
      .filter((o): o is Extract<Op, { op: 'evict' }> => o.op === 'evict')
      .flatMap(o => o.ids);
    assert.equal(evictions.length, 5);
  });

  test('toggle flips collapsed and emits a tool op', () => {
    const m = new SessionModel();
    m.feed(
      upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress' })
    );
    m.drain();
    m.toggle('t1');
    const tool = m.items[0]! as ToolItem;
    assert.equal(tool.collapsed, true);
    const o = m.drain();
    assert.equal(o.length, 1);
    assert.equal(o[0]!.op, 'tool');
    m.toggle('t1');
    assert.equal(tool.collapsed, false);
    m.toggle('nonexistent'); // no throw
  });

  test('plan renders as a checklist side item', () => {
    const m = new SessionModel();
    m.feed(
      upd({
        sessionUpdate: 'plan',
        entries: [
          { content: 'do it', status: 'completed' },
          { content: 'doing', status: 'in_progress' },
        ],
      })
    );
    const it = m.items[0]!;
    assert.ok(it.text.includes('[x] do it'));
    assert.ok(it.text.includes('[>] doing'));
  });
});
