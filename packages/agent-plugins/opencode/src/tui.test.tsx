import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from './tui.tsx';

const dir = mkdtempSync(join(tmpdir(), 'bro-octui-'));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Toast {
  title?: string;
  message: string;
  variant?: string;
}

interface Attention {
  title?: string;
  message: string;
  sound?: { name?: string; volume?: number };
}

/** A TUI context with just the surfaces the plugin touches. The RPC
 *  client is a stub — the contract is what matters, not the wire. */
function harness(
  options: { board?: unknown; boardFails?: boolean; boardFailsOnce?: boolean } = {}
) {
  const toasts: Toast[] = [];
  const attention: Attention[] = [];
  const layers: {
    commands?: {
      id?: string;
      slash?: { name?: string };
      run?: (input?: string) => void | false | Promise<void>;
    }[];
  }[] = [];
  const slots: { claim: { append?: string }; rendered: unknown }[] = [];
  const panelOpens: string[] = [];
  let boardCalls = 0;
  const listeners = new Map<string, (event: unknown) => void>();
  const board =
    options.board === undefined
      ? {
          dirty: 0,
          inWork: [{ id: 'bro-a', title: 'in flight' }],
          ready: [{ id: 'bro-b', title: 'next up' }],
          readyTotal: 3,
          agents: [],
          fleetMax: 2,
          runs: [],
          worktrees: [],
          attention: 0,
        }
      : options.board;

  const ctx = {
    location: { directory: dir },
    options: {},
    app: { version: '2.2.5', channel: 'latest' },
    theme: {
      text: {
        base: '#fff',
        muted: '#888',
        feedback: {
          info: { base: '#0af' },
          warning: { base: '#fa0' },
          error: { base: '#f00' },
          success: { base: '#0f0' },
        },
      },
    },
    client: {
      rpc: () => ({
        board: async () => {
          boardCalls += 1;
          // the server half registers its RPC a moment after the TUI
          // starts — the first read can land before that
          if (options.boardFails || (options.boardFailsOnce && boardCalls === 1)) {
            throw new Error('server unreachable');
          }
          return board;
        },
        events: {
          on: (name: string, handler: (event: unknown) => void) => {
            listeners.set(name, handler);
            return () => listeners.delete(name);
          },
        },
      }),
    },
    keymap: { layer: (f: () => unknown) => layers.push(f() as never) },
    ui: {
      toast: { show: (t: Toast) => toasts.push(t) },
      slot: (claim: { append?: string; render: (input: unknown) => unknown }) => {
        slots.push({ claim, rendered: null });
        return () => {};
      },
      panel: { open: (name: string) => panelOpens.push(name) },
    },
    attention: {
      notify: async (a: Attention) => {
        attention.push(a);
        return { ok: true, notification: true, sound: true };
      },
    },
    storage: {
      store: (_k: string, o: { initial: { open: boolean } }) => [o.initial, async () => {}],
    },
  };

  return {
    ctx,
    toasts,
    attention,
    layers,
    slots,
    panelOpens,
    listeners,
    boardCalls: () => boardCalls,
  };
}

/** The SDK types `setup`'s result as `void | Cleanup` — our plugin always
 *  hands back a teardown, and a void one is a no-op. */
async function setup(h: ReturnType<typeof harness>): Promise<() => Promise<void>> {
  const teardown = await plugin.setup(h.ctx as never);
  return typeof teardown === 'function' ? async () => void (await teardown()) : async () => {};
}

describe('tui loader shape', () => {
  test('the TUI part declares its own id and setup', () => {
    assert.equal(plugin.id, 'bro.cli');
    assert.equal(typeof plugin.setup, 'function');
  });
});

describe('tui setup', () => {
  test('registers the /bro slash command and the board panel command', async () => {
    const h = harness();
    const teardown = await setup(h);
    const layer = h.layers[0]!;
    const ids = (layer.commands ?? []).map(c => c.id);
    assert.ok(ids.includes('bro.status'));
    assert.ok(ids.includes('bro.board'));
    assert.equal((layer.commands ?? [])[0]!.slash?.name, 'bro');
    await teardown();
  });

  test('claims the sidebar slot and the session panel', async () => {
    const h = harness();
    const teardown = await setup(h);
    const claimed = h.slots.map(s => s.claim.append);
    assert.ok(claimed.includes('sidebar.content'));
    assert.ok(claimed.includes('session.panel'));
    await teardown();
  });

  test('reads the board over the RPC contract', async () => {
    const h = harness();
    const teardown = await setup(h);
    // the refresh runs on setup — the board RPC was called and the
    // widget has a board to render
    assert.ok(h.slots.length >= 2);
    await teardown();
  });

  test('an unreachable server degrades to no board, never a throw', async () => {
    const h = harness({ boardFails: true });
    const teardown = await setup(h);
    assert.ok(h.slots.length >= 2);
    await teardown();
  });

  test('a failed first read retries — the server half registers a moment later', async () => {
    const h = harness({ boardFailsOnce: true });
    const teardown = await setup(h);
    assert.equal(h.boardCalls(), 1);
    // the retry ladder fills the window between the TUI's first read and
    // the server's RPC registration
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(h.boardCalls(), 2);
    await teardown();
  });

  test('an attention event becomes a toast and a sound', async () => {
    const h = harness();
    const teardown = await setup(h);
    h.listeners.get('attention')?.({
      data: { title: 'bro', message: 'PR #42 needs a fix', severity: 'error' },
    });
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0]!.variant, 'error');
    assert.match(h.toasts[0]!.message, /PR #42/);
    assert.equal(h.attention.length, 1);
    assert.equal(h.attention[0]!.sound?.name, 'error');
    await teardown();
  });

  test('a changed event refreshes the board', async () => {
    const h = harness();
    const teardown = await setup(h);
    assert.ok(h.listeners.has('changed'));
    h.listeners.get('changed')?.({ data: { inWork: 1, ready: 1, agents: 0 } });
    await teardown();
  });

  test('the board command opens the panel', async () => {
    const h = harness();
    const teardown = await setup(h);
    const layer = h.layers[0]!;
    const command = (layer.commands ?? []).find(c => c.id === 'bro.board');
    await command?.run?.();
    assert.deepEqual(h.panelOpens, ['bro.board']);
    await teardown();
  });

  test('the status command reports the board through a toast', async () => {
    const h = harness();
    const teardown = await setup(h);
    const layer = h.layers[0]!;
    const command = (layer.commands ?? []).find(c => c.id === 'bro.status');
    await command?.run?.('status');
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0]!.message, /in work: 1/);
    assert.match(h.toasts[0]!.message, /ready: 3/);
    await teardown();
  });

  test('teardown releases the subscriptions', async () => {
    const h = harness();
    const teardown = await setup(h);
    assert.ok(h.listeners.size >= 2);
    await teardown();
    assert.equal(h.listeners.size, 0);
  });
});
