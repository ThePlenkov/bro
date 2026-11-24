import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  createBroDriver,
  sharedBinding,
  type BroContext,
  type BroHostApi,
  type BroHostBinding,
  type BroHostShape,
} from './host.ts';

interface TestCtx extends BroContext {
  notes: string[];
}

type Handlers = Map<string, (event: unknown, ctx: TestCtx) => unknown>;

function makeBinding(handlers: Handlers): BroHostBinding<TestCtx> {
  const shape: BroHostShape<TestCtx> = {
    kind: 'test',
    stop: 'session_stop',
    on(event, handler) {
      handlers.set(event, handler as (event: unknown, ctx: TestCtx) => unknown);
    },
    paint() {},
    notify(ctx, text) {
      ctx.notes.push(text);
    },
    refuseStop(reason) {
      return { blocked: reason };
    },
    stopAlreadyRefused: () => false,
  };
  return sharedBinding(shape);
}

const api: BroHostApi<TestCtx> = {
  registerCommand() {},
  registerTool() {},
  sendMessage() {},
};

test('the driver registers the host stop event', () => {
  const handlers: Handlers = new Map();
  createBroDriver(makeBinding(handlers), api);
  assert.ok(handlers.has('session_stop'));
});
