/**
 * The Solid pane, headless (spec bro-q2edc).
 *
 * `createTestRenderer` gives a headless renderer — no terminal, no
 * FFI screen — so the tree can be asserted on its rendered
 * characters. That is the seam the imperative shell never had: its
 * views were renderables, and a renderable cannot be inspected
 * without a screen.
 *
 * Bun-only: the Solid JSX transform and OpenTUI's native FFI are
 * both Bun-only, so this file runs under `bun test`, not the repo's
 * Node runner. The model's and the pane state's own tests stay on
 * Node (`plugins/herdr/test/`).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { PaneWriter } from './app.tsx';
import { SessionModel } from './model.ts';

/**
 * Load the pane the way `main.ts` does.
 *
 * The Solid JSX transform is a Bun plugin, and it must be
 * registered BEFORE the modules that use Solid are loaded — Bun
 * builds a module's import graph before evaluating it, so a static
 * preload import would land too late. Both imports are therefore
 * dynamic, and in this order.
 */
async function loadPane(): Promise<{ mountPane: typeof import('./app.tsx').mountPane }> {
  await import('@opentui/solid/preload');
  return import('./app.tsx');
}

const upd = (u: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'update',
  update: u,
});
const chunk = (kind: string, text: string): Record<string, unknown> =>
  upd({ sessionUpdate: kind, content: { type: 'text', text } });

/** The pane mounted on a headless renderer, plus the model feeding it. */
async function mount(): Promise<{
  frame: () => Promise<string>;
  model: SessionModel;
  writer: PaneWriter;
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
}> {
  const { mountPane } = await loadPane();
  const setup = await createTestRenderer({ width: 60, height: 20 });
  const model = new SessionModel();
  const pane = await mountPane({
    renderer: setup.renderer,
    meta: { worktree: '/tmp/wt' },
  });
  const flush = async (): Promise<void> => {
    pane.writer.apply(model.drain());
    await setup.flush();
  };
  return {
    frame: async () => setup.captureCharFrame(),
    model,
    writer: pane.writer,
    flush,
    dispose: async () => setup.dispose(),
  };
}

describe('the Solid session pane', () => {
  test('renders the banner and the agent speech as markdown', async () => {
    const p = await mount();
    try {
      p.model.feed(chunk('agent_message_chunk', 'Fix the flaky land e2e'));
      await p.flush();
      const frame = await p.frame();
      assert.match(frame, /bro: session/);
      assert.match(frame, /Fix the flaky land e2e/);
    } finally {
      await p.dispose();
    }
  });

  test('a streamed chunk updates the same row instead of adding one', async () => {
    const p = await mount();
    try {
      p.model.feed(chunk('agent_message_chunk', 'Hel'));
      await p.flush();
      p.model.feed(chunk('agent_message_chunk', 'lo'));
      await p.flush();
      const frame = await p.frame();
      assert.match(frame, /Hello/);
      // One row, not two: the model's chunk coalescing keeps one item.
      assert.equal(frame.split('Hello').length - 1, 1);
    } finally {
      await p.dispose();
    }
  });

  test('a tool call renders as a bordered card with its output', async () => {
    const p = await mount();
    try {
      p.model.feed(
        upd({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Bash',
          kind: 'execute',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'PASS 2330/2330' } }],
        })
      );
      await p.flush();
      const frame = await p.frame();
      assert.match(frame, /Bash/);
      assert.match(frame, /execute/);
      assert.match(frame, /PASS 2330\/2330/);
    } finally {
      await p.dispose();
    }
  });

  test('folding the selected card hides its body', async () => {
    const p = await mount();
    try {
      p.model.feed(
        upd({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Bash',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'SECRET-OUTPUT' } }],
        })
      );
      await p.flush();
      assert.match(await p.frame(), /SECRET-OUTPUT/);

      p.writer.select(1);
      p.writer.toggle();
      await p.flush();
      assert.doesNotMatch(await p.frame(), /SECRET-OUTPUT/);

      p.writer.toggle();
      await p.flush();
      assert.match(await p.frame(), /SECRET-OUTPUT/);
    } finally {
      await p.dispose();
    }
  });

  test('a caller prompt renders real markdown — markers concealed', async () => {
    const p = await mount();
    try {
      p.model.feed({ kind: 'prompt', text: 'see [**docs**](https://x.io) and **bold**' });
      await p.flush();
      const frame = await p.frame();
      assert.match(frame, /docs/);
      assert.match(frame, /bold/);
      // real markdown: the literal markers never paint
      assert.doesNotMatch(frame, /\[\*\*docs\]/);
      assert.doesNotMatch(frame, /\]\(https:/);
    } finally {
      await p.dispose();
    }
  });

  test('a permission ask is called out', async () => {
    const p = await mount();
    try {
      p.model.feed({ kind: 'permission', title: 'write /etc/hosts', verdict: 'denied' });
      await p.flush();
      assert.match(await p.frame(), /permission/);
    } finally {
      await p.dispose();
    }
  });

  test('a turn boundary is announced', async () => {
    const p = await mount();
    try {
      p.model.feed({ kind: 'turn', phase: 'stop' });
      await p.flush();
      assert.match(await p.frame(), /turn complete/);
    } finally {
      await p.dispose();
    }
  });
});
