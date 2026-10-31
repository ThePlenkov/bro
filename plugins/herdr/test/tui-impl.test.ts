/**
 * The pane impl seam (spec bro-q2edc, "Phase 2 — the seam"): the
 * registry resolves `--impl`/env to a `PaneImpl`, the default stays
 * `legacy`, and unknown names fail loud. The `acp` impl is Bun-only
 * (it loads `acp-model`), so these tests exercise the seam's
 * Node-safe half only — resolution and the legacy impl end to end.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { implArg, IMPL_NAMES, pickImpl } from '../tui/impl.ts';
import type { ArchiveRow } from '../../../packages/cli/src/commands/session-feed.ts';

describe('the pane impl seam', () => {
  test('the registry knows legacy and acp', () => {
    assert.deepEqual(IMPL_NAMES.sort(), ['acp', 'legacy']);
  });

  test('the default stays legacy — no flag, no env', async () => {
    const impl = await pickImpl(undefined, {});
    assert.equal(impl.name, 'legacy');
    assert.equal(impl.fold, 'legacy');
  });

  test('argv beats env beats default', async () => {
    const fromArgv = await pickImpl('legacy', { BRO_TUI_IMPL: 'acp' });
    assert.equal(fromArgv.name, 'legacy');
    const fromEnv = await pickImpl(undefined, { BRO_TUI_IMPL: 'legacy' });
    assert.equal(fromEnv.name, 'legacy');
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
});
