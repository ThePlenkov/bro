/**
 * The session pane model — archive rows in, item tree + ops out. Pure
 * and headless: the OpenTUI shell applies the ops, these tests assert
 * the tree and the mutation stream.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ArchiveRow } from '../../../packages/cli/src/commands/session-feed.ts';
import { MAX_ITEMS, SessionModel, type Op, type ToolItem } from '../tui/model.ts';

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
