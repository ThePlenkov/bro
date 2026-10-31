/**
 * The `acp` impl against the seam contract (spec bro-q2edc, "Phase
 * 2 — the seam"): archive rows in, our ops out — replay items carry
 * `origin: "replay"` until `beginLive()`, the live tail is `other`,
 * and the verdict follows the vendored session state.
 *
 *   bun test plugins/herdr/tui/acp/model.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { AcpImpl } from './model.ts';
import type { ArchiveRow } from '../../../../packages/cli/src/commands/session-feed.ts';
import type { ToolItem } from '../model.ts';

const update = (u: Record<string, unknown>): ArchiveRow => ({
  kind: 'update',
  update: u,
});

const toolRows: ArchiveRow[] = [
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Bash',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'ls -la' },
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file a\nfile b' } }],
  }),
];

describe('the acp impl', () => {
  test('a finished tool call appends a content card, folded by default', () => {
    const impl = new AcpImpl();
    for (const row of toolRows) impl.feed(row);
    const ops = impl.drain();
    const appended = ops.filter(o => o.op === 'append').map(o => o.item);
    const tool = appended.find(i => i.kind === 'tool') as ToolItem | undefined;
    expect(tool).toBeDefined();
    expect(tool?.toolCallId).toBe('t1');
    expect(tool?.status).toBe('completed');
    expect(tool?.collapsed).toBe(true);
    expect(tool?.content).toEqual([{ kind: 'text', text: 'file a\nfile b' }]);
    expect(tool?.arg).toBe('ls -la');
  });

  test('replay then live — the boundary flips origin semantics', () => {
    const impl = new AcpImpl();
    impl.feed(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    );
    impl.beginLive();
    impl.feed(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' there' } })
    );
    const ops = impl.drain();
    // a chunk past the replay envelope opens a fresh item — their
    // run boundary at session_opened — so both land as appends
    const appends = ops.filter(o => o.op === 'append').map(o => o.item);
    expect(appends.length).toBe(2);
    expect(appends[0]?.kind === 'message' && appends[0].text === 'hi').toBe(true);
    expect(appends[1]?.kind === 'message' && appends[1].text === ' there').toBe(true);
  });

  test('a turn stop lands a turn marker', () => {
    const impl = new AcpImpl();
    impl.feed({ kind: 'turn', phase: 'stop', stopReason: 'end_turn' });
    impl.beginLive();
    const appended = impl
      .drain()
      .filter(o => o.op === 'append')
      .map(o => o.item);
    const turn = appended.find(i => i.kind === 'turn');
    expect(turn).toBeDefined();
    expect(turn?.kind === 'turn' && turn.text.includes('turn complete')).toBe(true);
  });

  test('the verdict follows session state', () => {
    const impl = new AcpImpl();
    // during replay the verdict reads working/replaying
    impl.feed(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } })
    );
    expect(impl.verdict?.led.state).toBe('working');
    impl.beginLive();
    expect(impl.verdict?.led.state).toBe('idle');
  });

  test('a changed item re-projects — user toggles survive via a bare tool op', () => {
    const impl = new AcpImpl();
    const [call, done] = toolRows;
    if (call === undefined || done === undefined) throw new Error('fixture');
    impl.feed(call);
    impl.drain();
    impl.feed(done);
    const ops = impl.drain();
    const toolOp = ops.find(o => o.op === 'tool');
    expect(toolOp).toBeDefined();
    // the update op carries no `collapsed` — the fold keeps the user's
    if (toolOp?.op === 'tool') {
      expect('collapsed' in toolOp.item).toBe(false);
    }
  });
});
