/**
 * The pane impl seam (spec bro-q2edc, "Phase 2 — the seam"): the
 * registry resolves `--impl`/env to a `PaneImpl`, the default is
 * `acp` (the headless dump falls back to `legacy` unflagged), and
 * unknown names fail loud. Both impls run under Node here — the
 * `acp` cases exercise the seam end to end; only the Solid/TUI
 * shell above them stays Bun-only.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ArchiveRow } from '../archive/index.ts';
import { IMPL_NAMES, implArg, pickImpl } from './impl.ts';

describe('the pane impl seam', () => {
  test('the registry knows legacy and acp', () => {
    assert.deepEqual(IMPL_NAMES.sort(), ['acp', 'legacy']);
  });

  test('the default is acp — no flag, no env', async () => {
    const impl = await pickImpl(undefined, {});
    assert.equal(impl.name, 'acp');
  });

  test('argv beats env beats default', async () => {
    const fromArgv = await pickImpl('legacy', { BRO_TUI_IMPL: 'acp' });
    assert.equal(fromArgv.name, 'legacy');
    // Use the opposite fallback so this proves the environment is read
    // rather than merely agreeing with the default.
    const fromEnv = await pickImpl(undefined, { BRO_TUI_IMPL: 'acp' }, 'legacy');
    assert.equal(fromEnv.name, 'acp');
  });

  test('an unknown name fails loud', async () => {
    await assert.rejects(() => pickImpl('bogus', {}), /unknown --impl 'bogus'/);
  });

  test('implArg parses the flag both ways', () => {
    assert.equal(implArg(['--impl', 'acp']), 'acp');
    assert.equal(implArg(['--impl=acp']), 'acp');
    assert.equal(implArg(['x', '--dump']), undefined);
  });

  test('the legacy impl still speaks the seam', async () => {
    const impl = await pickImpl('legacy', {});
    const row: ArchiveRow = {
      kind: 'update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    };
    impl.feed(row);
    impl.beginLive();
    const ops = impl.drain();
    const appended = ops.filter(o => o.op === 'append');
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.item.kind, 'message');
    assert.ok(impl.dump().length > 0);
    assert.equal(impl.drain().length, 0);
  });

  test('an archive turn start drives the acp LED to working', async () => {
    const impl = await pickImpl('acp', {});
    impl.feed({ kind: 'turn', phase: 'start', ts: '2026-01-01T00:00:00Z' });
    impl.beginLive();
    const on = impl.verdict;
    assert.equal(on?.led.state, 'working');
    assert.match(on?.mode ?? '', /^turn since /);
    // the matching stop idles it again — the lifecycle still closes,
    // and the footer carries the idle-since clock stamp
    impl.feed({ kind: 'turn', phase: 'stop', ts: '2026-01-01T00:01:00Z' });
    const v = impl.verdict;
    assert.equal(v?.led.state, 'idle');
    assert.match(v?.mode ?? '', /^since /);
  });

  test('an interactive permission: the ask opens, the answer closes it', async () => {
    const impl = await pickImpl('acp', {});
    impl.feed({ kind: 'turn', phase: 'start', ts: '2026-01-01T00:00:00Z' });
    impl.feed({
      kind: 'permission',
      phase: 'ask',
      title: 'write /x',
      toolCallId: 'tool-1',
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      ts: '2026-01-01T00:00:30Z',
    });
    impl.beginLive();
    // the ask is open — the pane is blocked until a human answers
    assert.equal(impl.verdict?.led.state, 'blocked');
    const asked = impl.dump().join('\n');
    assert.match(asked, /Allow once/);

    impl.feed({
      kind: 'permission',
      phase: 'answer',
      title: 'write /x',
      toolCallId: 'tool-1',
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      verdict: 'approved',
      optionId: 'allow',
      optionKind: 'allow_once',
      ts: '2026-01-01T00:00:40Z',
    });
    const answered = impl.dump().join('\n');
    assert.match(answered, /allow once/);
    // the ask is closed — the pane is not blocked any more
    assert.notEqual(impl.verdict?.led.state, 'blocked');
  });

  test('the permission clock starts at the ask — later rows do not move it', async () => {
    const impl = await pickImpl('acp', {});
    impl.feed({ kind: 'turn', phase: 'start', ts: '2026-01-01T00:00:00Z' });
    impl.feed({
      kind: 'permission',
      title: 'write /x',
      verdict: 'denied',
      ts: '2026-01-01T00:00:30Z',
    });
    impl.beginLive();
    const asked = impl.verdict?.mode;
    assert.match(asked ?? '', /^permission · since /);
    // an update row keeps requires_action open (the ask is still
    // unanswered) but is not a new ask — the stamp must not move
    impl.feed({
      kind: 'update',
      ts: '2026-01-01T00:05:00Z',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'still blocked' },
      } as never,
    });
    assert.equal(impl.verdict?.led.state, 'blocked');
    assert.equal(impl.verdict?.mode, asked);
  });

  // bro-rszje — drain() must not key the whole emission on the item
  // map's identity: session-level changes (hidden tally, header
  // metadata) never touch `items` and used to drain to nothing.
  test('an update their reducer drops still emits the hidden tally', async () => {
    const impl = await pickImpl('acp', {});
    impl.beginLive();
    impl.feed({
      kind: 'update',
      ts: '2026-01-01T00:00:00Z',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      } as never,
    });
    impl.drain();
    impl.feed({
      kind: 'update',
      ts: '2026-01-01T00:00:05Z',
      update: { sessionUpdate: 'a_kind_nobody_implements' } as never,
    });
    // items keeps its identity — the tally row is the only change
    const notes = impl
      .drain()
      .flatMap(o => (o.op === 'append' && o.item.kind === 'note' ? [o.item.text] : []));
    assert.deepEqual(notes, ['▸ 1 hidden']);
  });

  test('a metadata-only update re-projects the feed header', async () => {
    const impl = await pickImpl('acp', {});
    impl.beginLive();
    impl.feed({
      kind: 'update',
      ts: '2026-01-01T00:00:00Z',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      } as never,
    });
    impl.drain();
    // a config_option_update changes session.configOptions only —
    // items keeps its identity, but the header's model slot moved
    impl.feed({
      kind: 'update',
      ts: '2026-01-01T00:00:10Z',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'gpt-5',
            options: [{ value: 'gpt-5', name: 'gpt-5' }],
          },
        ],
      } as never,
    });
    const patches = impl.drain().flatMap(o => (o.op === 'text' ? [o.text] : []));
    assert.equal(patches.length, 1);
    assert.match(patches[0] ?? '', /gpt-5/);
  });

  test('a status-only tool update re-projects the row', async () => {
    const impl = await pickImpl('acp', {});
    impl.beginLive();
    impl.feed({
      kind: 'update',
      ts: '2026-01-01T00:00:00Z',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'ls',
        status: 'in_progress',
      } as never,
    });
    impl.drain();
    impl.feed({
      kind: 'update',
      ts: '2026-01-01T00:00:05Z',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      } as never,
    });
    const tools = impl.drain().filter(o => o.op === 'tool');
    assert.equal(tools.length, 1);
  });
});
