import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpRenderer, type SessionUpdateLike } from '../src/acp-render.ts';

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

function sink(): { lines: string[]; out: (s: string) => void } {
  const lines: string[] = [];
  return { lines, out: (s: string) => lines.push(s) };
}

const upd = (sessionUpdate: string, rest: Record<string, unknown> = {}): SessionUpdateLike => ({
  sessionUpdate,
  ...rest,
});

describe('AcpRenderer — chunk styling', () => {
  test('thought chunks render dimmed, coalesced into one line', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out);
    r.update(upd('agent_thought_chunk', { content: { type: 'text', text: 'I need to ' } }));
    r.update(upd('agent_thought_chunk', { content: { type: 'text', text: 'list files.' } }));
    r.end();
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.startsWith(DIM));
    assert.ok(lines[0]!.includes('I need to list files.'));
    assert.ok(lines[0]!.endsWith(RESET));
  });

  test('message chunks render plain — no ANSI on the text', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out);
    r.update(upd('agent_message_chunk', { content: { type: 'text', text: 'Hello ' } }));
    r.update(upd('agent_message_chunk', { content: { type: 'text', text: 'world.' } }));
    r.end();
    assert.deepEqual(lines, ['Hello world.']);
  });

  test('color:false keeps thoughts plain too', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('agent_thought_chunk', { content: { type: 'text', text: 'hmm' } }));
    r.end();
    assert.deepEqual(lines, ['hmm']);
  });

  test('a structural update flushes the pending chunk first', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out);
    r.update(upd('agent_thought_chunk', { content: { type: 'text', text: 'thinking' } }));
    r.update(upd('tool_call', { toolCallId: 't1', title: 'ls', kind: 'execute' }));
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes('thinking'));
    assert.ok(lines[1]!.includes('⣿'));
  });
});

describe('AcpRenderer — tool calls', () => {
  test('tool_call prints `⣿ title [kind] status`; transitions re-print', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('tool_call', { toolCallId: 't1', title: 'Listed ./', kind: 'execute' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'completed' }));
    assert.deepEqual(lines, [
      '⣿ Listed ./ [execute] pending',
      '⣿ Listed ./ [execute] in_progress',
      '⣿ Listed ./ [execute] completed',
    ]);
  });

  test('repeated same-status updates are churn — no re-print', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('tool_call', { toolCallId: 't1', title: 'x' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    assert.equal(lines.length, 2);
  });

  test('failed renders red when color is on', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out);
    r.update(upd('tool_call', { toolCallId: 't1', title: 'x' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'failed' }));
    assert.ok(lines[1]!.includes('\u001b[31m'));
  });

  test('title learned on the call persists into bare updates', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('tool_call', { toolCallId: 't1', title: 'Run tests', kind: 'execute' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'completed' }));
    assert.equal(lines[1], '⣿ Run tests [execute] completed');
  });
});

describe('AcpRenderer — plan', () => {
  test('plan re-renders the full checklist with status boxes', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('plan', {
        entries: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'pending' },
        ],
      })
    );
    assert.deepEqual(lines, ['── plan ──', '  [x] a', '  [>] b', '  [ ] c']);
  });
});

describe('AcpRenderer — permission policy', () => {
  const permReq = (kind: string, opts: { optionId: string; name: string; kind: string }[]) => ({
    toolCall: { toolCallId: 't1', title: 'Do a thing', kind },
    options: opts,
  });

  test('non-read kind picks allow_once', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    const res = r.permission(
      permReq('edit', [
        { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'o2', name: 'Always', kind: 'allow_always' },
        { optionId: 'o3', name: 'Reject', kind: 'reject_once' },
      ])
    );
    assert.deepEqual(res, { outcome: 'selected', optionId: 'o1' });
    assert.ok(lines[0]!.startsWith('⚠ Do a thing'));
    assert.ok(lines[0]!.includes('Allow once, Always, Reject'));
  });

  test('read kind prefers allow_always', () => {
    const { out } = sink();
    const r = new AcpRenderer(out, { color: false });
    const res = r.permission(
      permReq('read', [
        { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'o2', name: 'Always', kind: 'allow_always' },
      ])
    );
    assert.deepEqual(res, { outcome: 'selected', optionId: 'o2' });
  });

  test('no allow option → cancelled, never an invented approval', () => {
    const { out } = sink();
    const r = new AcpRenderer(out, { color: false });
    const res = r.permission(
      permReq('edit', [{ optionId: 'r1', name: 'Reject', kind: 'reject_once' }])
    );
    assert.deepEqual(res, { outcome: 'cancelled' });
  });

  test('permit=reads denies non-read kinds via reject_once', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    const res = r.permission(
      permReq('edit', [
        { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
      ]),
      'reads'
    );
    assert.deepEqual(res, { outcome: 'selected', optionId: 'r1' });
    assert.ok(lines.some(l => l.includes('auto-answered Reject')));
  });

  test('permit=none rejects even read kinds', () => {
    const { out } = sink();
    const r = new AcpRenderer(out, { color: false });
    const res = r.permission(
      permReq('read', [
        { optionId: 'o1', name: 'Allow', kind: 'allow_once' },
        { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
      ]),
      'none'
    );
    assert.deepEqual(res, { outcome: 'selected', optionId: 'r1' });
  });
});

describe('AcpRenderer — wire text is sanitized', () => {
  test('escape sequences and newlines cannot inject into the pane', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('agent_message_chunk', { content: { type: 'text', text: 'x\u001b[2J\u001b[H\nEVIL' } })
    );
    r.update(upd('tool_call', { toolCallId: 't', title: 'rm\u001b[1m-x', kind: 'e\u0007xec' }));
    r.end();
    assert.deepEqual(lines, ['x ⏎ EVIL', '⣿ rm-x [exec] pending']);
    for (const l of lines) assert.ok(!l.includes('\u001b'));
  });
});

describe('AcpRenderer — sidebands and markers', () => {
  test('ext notices dedupe per method with a ×N tally', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.notice('_vendor/output', { channel: 'log', message: 'one' });
    r.notice('_vendor/output', { channel: 'log', message: 'two' });
    r.notice('_vendor/output', { channel: 'log', message: 'three' });
    r.end();
    assert.deepEqual(lines, ['‹log› one', '[_vendor/output] ×3']);
  });

  test('turnEnd and closed print the boundary markers', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.turnEnd('end_turn');
    r.closed('child exited (code 0)');
    assert.deepEqual(lines, [
      '── turn complete (end_turn) ──',
      '── session ended (child exited (code 0)) — scrollback kept ──',
    ]);
  });

  test('unknown update kinds stay visible as dim markers', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('totally_new_kind', { whatever: 1 }));
    assert.deepEqual(lines, ['[totally_new_kind]']);
  });
});
