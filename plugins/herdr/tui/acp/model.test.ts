/**
 * The `acp` impl against the seam contract (spec bro-q2edc, "Phase
 * 2 — the seam"): archive rows in, our ops out — replay items carry
 * `origin: "replay"` until `beginLive()`, the live tail is `other`,
 * and the verdict follows the vendored session state.
 *
 *   bun test plugins/herdr/tui/acp/model.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ArchiveRow } from '../../../../packages/cli/src/commands/session-feed.ts';
import type { ToolItem } from '../model.ts';
import { AcpImpl } from './model.ts';

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

  test('a turn stop emits no row — duration folds into the activity line', () => {
    const impl = new AcpImpl();
    impl.feed({ kind: 'turn', phase: 'stop', stopReason: 'end_turn' });
    impl.beginLive();
    const appended = impl
      .drain()
      .filter(o => o.op === 'append')
      .map(o => o.item);
    // no 'turn' boundary row — duration/ctx fold into the ▸ line
    // (addendum 11); with no preceding activity it drops silently
    expect(appended.find(i => i.kind === 'turn')).toBeUndefined();
  });

  test('adjacent activity items collapse into one ▸ tally item', () => {
    const impl = new AcpImpl();
    for (const [id, title] of [
      ['t1', 'Bash'],
      ['t2', 'Read'],
    ] as const) {
      impl.feed(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title,
          kind: 'execute',
          status: 'completed',
          rawInput: { command: 'x' },
        })
      );
    }
    const appended = impl
      .drain()
      .filter(o => o.op === 'append')
      .map(o => o.item);
    // one group item, not two cards — `▸ 2 tool calls`
    expect(appended.length).toBe(1);
    const run = appended[0];
    expect(run?.kind === 'tool' && run.runs?.length === 2).toBe(true);
    expect(run?.kind === 'tool' && run.arg).toBe('2 tool calls');
  });

  test('a solo tool card morphs into the tally line when a member lands', () => {
    const impl = new AcpImpl();
    impl.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Bash',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'x' },
      })
    );
    const first = impl.drain();
    const solo = first.find(o => o.op === 'append')?.item;
    expect(solo?.kind === 'tool' && solo.runs === undefined).toBe(true);
    impl.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        rawInput: { path: '/x' },
      })
    );
    const ops = impl.drain();
    // no new append — the leader's card morphs via a tool op
    expect(ops.filter(o => o.op === 'append').length).toBe(0);
    const morph = ops.find(o => o.op === 'tool');
    expect(morph?.op === 'tool' && morph.item.id === solo?.id).toBe(true);
    expect(morph?.op === 'tool' && morph.item.runs?.length).toBe(2);
    expect(morph?.op === 'tool' && morph.item.arg).toBe('2 tool calls');
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

describe('the acp impl — internal storms', () => {
  const start = (by: string): ArchiveRow => ({ kind: 'turn', phase: 'start', by });
  const stop = (error?: string): ArchiveRow => ({
    kind: 'turn',
    phase: 'stop',
    ...(error !== undefined ? { stopReason: 'error', error } : { stopReason: 'end_turn' }),
  });
  const chunk = (text: string): ArchiveRow =>
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  test('internal micro-turns collapse into one ▸ internal calls row', () => {
    const impl = new AcpImpl();
    for (let i = 0; i < 5; i++) {
      impl.feed(start('provider:kilo'));
      impl.feed(chunk('ok'));
      impl.feed(stop());
    }
    impl.feed(start("acp provider 'x'"));
    impl.feed(chunk('real reply'));
    const appended = impl
      .drain()
      .filter(o => o.op === 'append')
      .map(o => o.item);
    const storm = appended.find(i => i.kind === 'tool' && i.toolCallId.startsWith('storm:')) as
      | ToolItem
      | undefined;
    expect(storm).toBeDefined();
    expect(storm?.title).toBe('internal');
    expect(storm?.arg).toBe('5 internal calls · kilo');
    // no per-reply message items — the fake `okok` merge is gone
    expect(appended.filter(i => i.kind === 'message' && i.text.includes('ok')).length).toBe(0);
    // the managed agent's own reply still lands
    expect(appended.some(i => i.kind === 'message' && i.text === 'real reply')).toBe(true);
  });

  test('failed internal calls tally AND print origin-prefixed red rows, deduped', () => {
    const impl = new AcpImpl();
    for (let i = 0; i < 3; i++) {
      impl.feed(start('provider:kilo'));
      impl.feed(stop('Internal error'));
    }
    impl.feed(start('conductor:t'));
    impl.feed(stop('boom'));
    const appended = impl
      .drain()
      .filter(o => o.op === 'append')
      .map(o => o.item);
    const storm = appended.find(i => i.kind === 'tool' && i.toolCallId.startsWith('storm:')) as
      | ToolItem
      | undefined;
    expect(storm?.arg).toBe('4 internal calls · 4 failed · kilo, t');
    const errs = appended.filter(i => i.kind === 'turn' && i.text.startsWith('── turn failed'));
    expect(errs.map(i => i.text)).toEqual([
      '── turn failed — kilo · Internal error ──',
      '── turn failed — t · boom ──',
    ]);
  });

  test('a managed-agent failure keeps the bare banner', () => {
    const impl = new AcpImpl();
    impl.feed(start("acp provider 'x'"));
    impl.feed(stop('blew up'));
    const appended = impl
      .drain()
      .filter(o => o.op === 'append')
      .map(o => o.item);
    const errs = appended.filter(i => i.kind === 'turn' && i.text.startsWith('── turn failed'));
    expect(errs.map(i => i.text)).toEqual(['── turn failed — blew up ──']);
  });
});
