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
import type { CliRenderer } from '@opentui/core';
import { createMockMouse, createTestRenderer } from '@opentui/core/testing';
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
  renderer: CliRenderer;
  flush: () => Promise<void>;
  /** Wait until the scrollbox's bar is visible — its native geometry
   *  settles a frame or two after the feed first overflows, and a
   *  mouse event aimed at a not-yet-live bar falls through. */
  waitBar: () => Promise<void>;
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
    renderer: setup.renderer,
    flush,
    waitBar: async () => {
      for (let i = 0; i < 20 && !pane.scroller?.verticalScrollBar.visible; i++) await setup.flush();
      assert.ok(pane.scroller?.verticalScrollBar.visible, 'scrollbar never became visible');
    },
    dispose: async () => setup.dispose(),
  };
}

describe('the Solid session pane', () => {
  test('a click on the scrollbar track jumps there (mock mouse)', async () => {
    const p = await mount();
    try {
      p.model.feed(
        chunk('agent_message_chunk', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))
      );
      await p.flush();
      await p.waitBar();
      const before = await p.frame();
      const mouse = createMockMouse(p.renderer);
      // a press on the track — clicks are the class herdr DOES
      // forward (same event family as the wheel): no motion needed
      await mouse.click(59, 5, 0);
      await p.flush();
      const after = await p.frame();
      assert.match(after, /Jump to latest/);
      assert.notEqual(before, after);
    } finally {
      await p.dispose();
    }
  });

  test('a drag on the scrollbar track moves the thumb (mock mouse)', async () => {
    const p = await mount();
    try {
      // one text item >20 rows: the feed overflows the viewport so
      // the scrollbar exists and has room to move
      p.model.feed(
        chunk('agent_message_chunk', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))
      );
      await p.flush();
      await p.waitBar();
      const before = await p.frame();
      const mouse = createMockMouse(p.renderer);
      // the bar lives on the scrollbox's rightmost column (x=59 at
      // width 60); dragging its track up must scroll the feed
      await mouse.drag(59, 15, 59, 3, 0);
      await p.flush();
      const after = await p.frame();
      assert.match(after, /Jump to latest/);
      assert.notEqual(before, after);
    } finally {
      await p.dispose();
    }
  });

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

  test('a tool call renders collapsed; toggle expands its output', async () => {
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
      // the body lands folded — a completed call is one compact row
      assert.doesNotMatch(frame, /PASS 2330\/2330/);
      // opencode grammar — an execute call carries no kind badge
      assert.doesNotMatch(frame, /\[execute\]/);

      p.writer.select(1);
      p.writer.toggle();
      await p.flush();
      assert.match(await p.frame(), /PASS 2330\/2330/);
    } finally {
      await p.dispose();
    }
  });

  test('retiring the tail prints rows and keeps the strip bounded', async () => {
    const { mountPane } = await loadPane();
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const printed: string[] = [];
    const pane = await mountPane({
      renderer: setup.renderer,
      meta: { worktree: '/tmp/wt' },
      onRetire: items => {
        for (const it of items) printed.push(`RETIRED:${it.id}`);
      },
    });
    try {
      for (let i = 0; i < 25; i++) {
        pane.writer.apply([
          {
            op: 'append',
            item: {
              id: i,
              kind: 'tool',
              toolCallId: `t${i}`,
              title: `grep p${i}`,
              status: 'completed',
              bodyLanded: true,
              collapsed: false,
              foldTouched: false,
              content: [{ kind: 'text', text: `out-${i}` }],
            },
          },
        ]);
      }
      // a live call lands last — the strip's in-flight row
      pane.writer.apply([
        {
          op: 'append',
          item: {
            id: 99,
            kind: 'tool',
            toolCallId: 't99',
            title: 'live-call',
            status: 'live',
            bodyLanded: false,
            collapsed: false,
            foldTouched: false,
            content: [],
          },
        },
      ]);
      await setup.flush();
      const frame = await setup.captureCharFrame();
      // every settled row retired — the strip is in-flight rows
      // only; retired rows went to the printer, never clipped
      assert.ok(printed.length >= 25, `expected ≥25 retired, got ${printed.length}`);
      assert.match(frame, /live-call/);
      assert.doesNotMatch(frame, /grep p0\b/);
    } finally {
      await setup.dispose();
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
      // bodies land folded — no output until the user expands
      assert.doesNotMatch(await p.frame(), /SECRET-OUTPUT/);

      p.writer.select(1);
      p.writer.toggle();
      await p.flush();
      assert.match(await p.frame(), /SECRET-OUTPUT/);

      p.writer.toggle();
      await p.flush();
      assert.doesNotMatch(await p.frame(), /SECRET-OUTPUT/);
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

  test('an abnormal turn end is marked; a clean end_turn is silent', async () => {
    const p = await mount();
    try {
      p.model.feed({ kind: 'turn', phase: 'stop', stopReason: 'end_turn' });
      await p.flush();
      assert.doesNotMatch(await p.frame(), /turn/);
      p.model.feed({ kind: 'turn', phase: 'stop', stopReason: 'cancelled' });
      await p.flush();
      assert.match(await p.frame(), /turn ended \(cancelled\)/);
    } finally {
      await p.dispose();
    }
  });

  test('a turn start heads its group — time rows, not a gutter column', async () => {
    const p = await mount();
    try {
      p.model.feed({
        kind: 'turn',
        phase: 'start',
        ts: '2026-03-01T22:36:00Z',
        by: "acp provider 'devin-acp'",
      });
      p.model.feed({
        kind: 'update',
        ts: '2026-03-01T22:36:05Z',
        update: { sessionUpdate: 'session_info_update', title: 's' } as never,
      });
      p.model.feed(chunk('agent_message_chunk', 'working'));
      await p.flush();
      const frame = await p.frame();
      assert.match(frame, /── \d{2}:\d{2} · devin-acp ──/);
      assert.match(frame, /── \d+ \w+ ──/); // the day anchor
      assert.match(frame, /working/);
    } finally {
      await p.dispose();
    }
  });

  test('a long prompt folds by default and expands on toggle', async () => {
    const p = await mount();
    try {
      const text = Array.from({ length: 20 }, (_, i) => `row ${i} **b${i}**`).join('\n');
      p.model.feed({ kind: 'prompt', text });
      await p.flush();
      let frame = await p.frame();
      // folded: a +N lines summary, never the raw block
      assert.match(frame, /\+\d+ lines/);
      assert.doesNotMatch(frame, /row 15/);

      // select lands on it (foldable rows join the walk), toggle pins it open
      p.writer.select(1);
      p.writer.toggle();
      await p.flush();
      frame = await p.frame();
      assert.match(frame, /row 14/);
      // and it is REAL markdown — the literal markers never paint
      assert.doesNotMatch(frame, /\*\*b14\*\*/);
    } finally {
      await p.dispose();
    }
  });

  test('a settled row flushes to scrollback even under the strip budget', async () => {
    const { mountPane } = await loadPane();
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const printed: string[] = [];
    const pane = await mountPane({
      renderer: setup.renderer,
      meta: { worktree: '/tmp/wt' },
      onRetire: items => {
        for (const it of items) printed.push(...(it.kind === 'tool' ? [it.title] : []));
      },
    });
    try {
      pane.writer.apply([
        {
          op: 'append',
          item: {
            id: 1,
            kind: 'tool',
            toolCallId: 't1',
            title: 'done-call',
            status: 'completed',
            bodyLanded: true,
            collapsed: false,
            foldTouched: false,
            content: [],
          },
        },
      ]);
      await setup.flush();
      // a terminal call settles immediately — it prints rather than
      // idling in the live strip waiting for the budget to fill
      assert.deepEqual(printed, ['done-call']);
    } finally {
      await setup.dispose();
    }
  });

  test('printLines conceals markdown and folds long text', async () => {
    const { printLines } = await import('./view.ts');
    const text = ['**bold** and [x](https://u)', '<details>', ...Array(20).fill('l')].join('\n');
    const folded = printLines({
      id: 1,
      kind: 'prompt',
      text,
      collapsed: true,
    });
    const ESC = String.fromCharCode(27);
    const strip = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    assert.match(folded.map(strip).join('\n'), /\+\d+ lines/);
    const open = printLines({ id: 1, kind: 'prompt', text });
    const joined = open.map(strip).join('\n');
    assert.match(joined, /bold and x \(https:\/\/u\)/);
    assert.doesNotMatch(joined, /\*\*|<details>/);
    // the scroll region is plain text — captured stdout escapes the
    // ESC byte, so no SGR may reach it (field-found garbage)
    assert.ok(!open.join('\n').includes(`${ESC}[38;2;`));
  });
});
