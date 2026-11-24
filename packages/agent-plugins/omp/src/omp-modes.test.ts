import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { installModeBridges, type ModeBridgeSource } from './omp-modes.ts';
import type { OmpApi, OmpContext } from './omp-api.ts';

function context(): OmpContext {
  return {
    cwd: '/repo',
    mode: 'tui',
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
    },
    sessionManager: { getSessionId: () => 'session' },
  };
}

function api(handlers: Map<string, (event: unknown, ctx: OmpContext) => unknown>): OmpApi {
  return {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    registerTool() {},
    sendMessage() {},
  };
}

describe('omp mode bridges', () => {
  test('injects routing and review debt through prompt submission', async () => {
    const handlers = new Map<string, (event: unknown, ctx: OmpContext) => unknown>();
    const source: ModeBridgeSource = {
      board: () => null,
      modeContext: async kind =>
        kind === 'prewalk' ? 'bro provider routing: fast=local' : 'bro review debt: fix finding-1',
    };
    installModeBridges(api(handlers), source);

    const handler = handlers.get('before_agent_start');
    assert.ok(handler);
    assert.deepEqual(await handler({}, context()), {
      message: {
        customType: 'bro-mode-context',
        content: 'bro provider routing: fast=local\n\nbro review debt: fix finding-1',
        display: false,
      },
    });
  });

  test('fails open when mode context is unavailable', async () => {
    const handlers = new Map<string, (event: unknown, ctx: OmpContext) => unknown>();
    installModeBridges(api(handlers), { board: () => null, modeContext: async () => null });

    const handler = handlers.get('before_agent_start');
    assert.ok(handler);
    assert.equal(await handler({}, context()), undefined);
  });
});
