import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
  test('tool_call headers print per status EDGE — pending and in_progress are one live edge', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('tool_call', { toolCallId: 't1', title: 'Listed ./', kind: 'execute' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'completed' }));
    assert.deepEqual(lines, ['⣿ Listed ./ [execute]', '✓ Listed ./ [execute]']);
  });

  test('repeated same-status updates are churn — no re-print', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('tool_call', { toolCallId: 't1', title: 'x' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    r.update(upd('tool_call_update', { toolCallId: 't1', status: 'in_progress' }));
    assert.equal(lines.length, 1);
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
    assert.equal(lines[1], '✓ Run tests [execute]');
  });

  test('the header picks the meaningful arg by tool kind', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Bash',
        kind: 'execute',
        rawInput: { command: 'ls -la /tmp', timeout: 5000 },
      })
    );
    assert.equal(lines[0], '⣿ Bash [execute] ls -la /tmp');
  });

  test('kind-blind arg order prefers the path; rawInput-less falls to locations', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', { toolCallId: 't1', title: 'Read', rawInput: { file_path: '/etc/hosts' } })
    );
    r.update(upd('tool_call', { toolCallId: 't2', title: 'Edit', locations: [{ path: '/x.ts' }] }));
    assert.equal(lines[0], '⣿ Read /etc/hosts');
    assert.equal(lines[1], '⣿ Edit /x.ts');
  });

  test('search picks the pattern even when a path rides along', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Grep',
        kind: 'search',
        rawInput: { pattern: 'TODO', path: '/src' },
      })
    );
    assert.equal(lines[0], '⣿ Grep [search] TODO');
  });

  test('a long arg is clipped at line width', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Bash',
        kind: 'execute',
        rawInput: { command: 'y'.repeat(300) },
      })
    );
    assert.ok(lines[0]!.endsWith('…'));
    assert.ok(lines[0]!.length <= 121);
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

  const PERMIT_PICKS: [string, 'auto' | 'reads' | 'none' | undefined, string, string][] = [
    ['read kind prefers allow_always', undefined, 'read', 'o2'],
    ['permit=reads denies non-read kinds via reject_once', 'reads', 'edit', 'r1'],
    ['permit=none rejects even read kinds', 'none', 'read', 'r1'],
  ];
  for (const [name, mode, kind, want] of PERMIT_PICKS) {
    test(name, () => {
      const { out } = sink();
      const r = new AcpRenderer(out, { color: false });
      const res = r.permission(
        permReq(kind, [
          { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'o2', name: 'Always', kind: 'allow_always' },
          { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
        ]),
        mode
      );
      assert.deepEqual(res, { outcome: 'selected', optionId: want });
    });
  }

  test('no allow option → cancelled, never an invented approval', () => {
    const { out } = sink();
    const r = new AcpRenderer(out, { color: false });
    const res = r.permission(
      permReq('edit', [{ optionId: 'r1', name: 'Reject', kind: 'reject_once' }])
    );
    assert.deepEqual(res, { outcome: 'cancelled' });
  });
});

describe('AcpRenderer — paragraphs (spec bro-l8wqu)', () => {
  test('a message chunk with real newlines renders real lines', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('agent_message_chunk', { content: { type: 'text', text: 'one\ntwo\nthree' } }));
    r.end();
    assert.deepEqual(lines, ['one', 'two', 'three']);
  });

  test('newlines split the buffered run across chunk boundaries', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('agent_message_chunk', { content: { type: 'text', text: 'a\nb' } }));
    r.update(upd('agent_message_chunk', { content: { type: 'text', text: 'c' } }));
    r.end();
    assert.deepEqual(lines, ['a', 'bc']);
  });

  test('thought paragraphs stay dim line by line', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out);
    r.update(upd('agent_thought_chunk', { content: { type: 'text', text: 'l1\nl2' } }));
    r.end();
    assert.equal(lines.length, 2);
    for (const l of lines) assert.ok(l.startsWith(DIM));
  });

  test('blank lines inside a paragraph are kept', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('agent_message_chunk', { content: { type: 'text', text: 'a\n\nb' } }));
    r.end();
    assert.deepEqual(lines, ['a', '', 'b']);
  });
});

describe('AcpRenderer — tool output cards (spec bro-l8wqu)', () => {
  test('a finished call prints its output as an indented card', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('tool_call', { toolCallId: 't1', title: 'Bash', kind: 'execute' }));
    r.update(
      upd('tool_call_update', {
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'o1\no2' } }],
      })
    );
    assert.deepEqual(lines, ['⣿ Bash [execute]', '✓ Bash [execute]', '│  o1', '│  o2']);
  });

  test('a one-shot completed tool_call carries its card inline', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'data' } }],
      })
    );
    assert.deepEqual(lines, ['✓ Read', '│  data']);
  });

  test('the per-item cap collapses overflow to … (N more)', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Bash',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: Array.from({ length: 14 }, (_, i) => `l${i}`).join('\n'),
            },
          },
        ],
      })
    );
    assert.equal(lines.length, 12); // header + 10 body lines + tally
    assert.equal(lines[11], '│  … (4 more)');
  });

  test('the whole card caps — remaining items fold into a tally', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    const items = Array.from({ length: 5 }, (_, i) => ({
      type: 'content',
      content: { type: 'text', text: `item${i}\n`.repeat(9).trim() },
    }));
    r.update(
      upd('tool_call', { toolCallId: 't1', title: 'Bash', status: 'completed', content: items })
    );
    const card = lines.slice(1);
    assert.ok(card.length <= 31);
    assert.match(card[card.length - 1]!, /… \(/);
  });

  test('a diff renders path header + red minus + green plus', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out);
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Edit',
        status: 'completed',
        content: [{ type: 'diff', path: '/f.ts', oldText: 'old1\nold2', newText: 'new1' }],
      })
    );
    assert.ok(lines[0]!.includes('✓') && lines[0]!.includes('Edit'));
    assert.ok(lines[1]!.includes('─ /f.ts'));
    assert.ok(lines[2]!.includes('\u001b[31m') && lines[2]!.includes('- old1'));
    assert.ok(lines[3]!.includes('- old2'));
    assert.ok(lines[4]!.includes('\u001b[32m') && lines[4]!.includes('+ new1'));
  });

  test('a new-file diff prints only + lines', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Write',
        status: 'completed',
        content: [{ type: 'diff', path: '/n.ts', newText: 'fresh' }],
      })
    );
    assert.deepEqual(lines.slice(2), ['│  + fresh']);
  });

  test('terminal content notes the archive gap', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'Bash',
        status: 'completed',
        content: [{ type: 'terminal', terminalId: 't9' }],
      })
    );
    assert.match(lines[1]!, /terminal output is not archived.*t9/);
  });

  test('unknown content types stay visible as dim brackets', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'x',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image' } }, { type: 'mystery' }],
      })
    );
    assert.deepEqual(lines.slice(1), ['│  [image]', '│  [mystery]']);
  });

  test('a late content-carrying repeat lands the card exactly once', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(upd('tool_call', { toolCallId: 't1', title: 'Bash', status: 'completed' }));
    r.update(
      upd('tool_call_update', {
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'late' } }],
      })
    );
    r.update(
      upd('tool_call_update', {
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'later' } }],
      })
    );
    assert.deepEqual(lines, ['✓ Bash', '│  late']);
  });

  test('long single lines inside a card are clipped', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'x',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'z'.repeat(300) } }],
      })
    );
    assert.ok(lines[1]!.endsWith('…'));
  });
});

describe('AcpRenderer — wire text is sanitized', () => {
  test('escape sequences cannot inject into the pane — real newlines still flow', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out, { color: false });
    r.update(
      upd('agent_message_chunk', { content: { type: 'text', text: 'x\u001b[2J\u001b[H\nEVIL' } })
    );
    r.update(upd('tool_call', { toolCallId: 't', title: 'rm\u001b[1m-x', kind: 'e\u0007xec' }));
    r.end();
    assert.deepEqual(lines, ['x', 'EVIL', '⣿ rm-x [exec]']);
    for (const l of lines) assert.ok(!l.includes('\u001b'));
  });

  test('an ESC inside a tool output block is stripped, never painted through', () => {
    const { lines, out } = sink();
    const r = new AcpRenderer(out); // color ON — our own paint may use ESC; the AGENT's never may
    r.update(
      upd('tool_call', {
        toolCallId: 't1',
        title: 'x',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'a\u001b[2J\u001b[31mred\nc' } },
        ],
      })
    );
    for (const l of lines) {
      assert.ok(!l.includes('[2J'), `clear-screen survived in ${l}`);
      assert.ok(!l.includes('[31m'), `agent red survived in ${l}`);
    }
    assert.ok(lines.some(l => l.includes('ared')));
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
