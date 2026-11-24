/**
 * The shared driver's stop gate — the one place bro blocks rather than
 * advises, and the one place a dead probe must not pass invisibly.
 *
 * The stub stands in for `bro hooks <event>`: it reads the payload on
 * stdin, prints the canned answer for that event, and exits
 * env-controlled. The driver's `deps.resolve` seam pins the stub as the
 * CLI so no real ladder (or real bro) is involved.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  GATE_DIAG_INTERVAL_MS,
  createBroDriver,
  sharedBinding,
  type BroContext,
  type BroHostApi,
  type BroHostBinding,
  type BroHostShape,
} from './host.ts';
import type { Command, ResolveOptions } from './core.ts';

const dir = mkdtempSync(join(tmpdir(), 'bro-host-'));
writeFileSync(join(dir, 'bro.config.json'), '{}');
const stub = join(dir, 'stub.mjs');
writeFileSync(
  stub,
  `const at = process.argv.indexOf('hooks')
const event = at >= 0 ? (process.argv[at + 1] ?? '') : ''
try { process.stdin.on('data', () => {}).on('end', () => {}) } catch {}
const map = process.env.BRO_STUB_MAP ? JSON.parse(process.env.BRO_STUB_MAP) : {}
if (event in map) process.stdout.write(map[event] ?? '')
process.exit(Number(process.env.BRO_STUB_STATUS ?? '0'))
`
);
after(() => rmSync(dir, { recursive: true, force: true }));

function respond(map: Record<string, string>, status = 0): void {
  process.env.BRO_STUB_MAP = JSON.stringify(map);
  process.env.BRO_STUB_STATUS = String(status);
}

interface Note {
  text: string;
  level: string;
}

interface TestCtx extends BroContext {
  notes: Note[];
}

type Handlers = Map<string, (event: unknown, ctx: TestCtx) => unknown>;
type Notify = BroHostShape<TestCtx>['notify'];

/** notify() that records into the ctx's notes sink. */
const recordNotify: Notify = (c, text, level) => {
  c.notes.push({ text, level });
};

/** notify() that explodes — the throwing-notify fail-open probe. */
const explodingNotify: Notify = () => {
  throw new Error('notify exploded');
};

/** on() that records every bound handler so the tests can fire them. */
const recordOn =
  (handlers: Handlers): BroHostShape<TestCtx>['on'] =>
  (event, handler) => {
    handlers.set(event, handler as (event: unknown, ctx: TestCtx) => unknown);
  };

/** The ctx the driver sees: a notes sink in the shared-lineage shape. */
function makeCtx(): TestCtx {
  return {
    notes: [],
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
    },
    cwd: dir,
    mode: 'rpc',
    hasUI: false,
    sessionManager: { getSessionId: () => 'ses_1' },
  };
}

/** The host's own half: bound handlers recorded, notify() collected. */
function makeBinding(
  handlers: Handlers,
  notifyThrows: boolean,
  withUserInput = true
): BroHostBinding<TestCtx> {
  return sharedBinding<TestCtx>({
    kind: 'test',
    stop: 'session_stop',
    userInput: withUserInput ? 'input' : undefined,
    on: recordOn(handlers),
    paint() {},
    notify: notifyThrows ? explodingNotify : recordNotify,
    refuseStop(reason) {
      return { blocked: reason };
    },
    stopAlreadyRefused: () => false,
  });
}

test('user input captures the prompt and runs prompt-submit before agent start', async () => {
  respond({
    'prompt-submit': '{"hookSpecificOutput":{"additionalContext":"prompt nudge"}}',
  });
  const { ctx, handlers } = makeHost();
  const input = handlers.get('input');
  const before = handlers.get('before_agent_start');
  assert.ok(input !== undefined);
  assert.ok(before !== undefined);

  await input({ text: 'inspect the queue' }, ctx);
  assert.deepEqual(await before({}, ctx), {
    message: { customType: 'bro-context', content: 'prompt nudge', display: false },
  });
});

test('agent start does not probe prompt-submit without a user-input event', async () => {
  respond({
    'prompt-submit': '{"hookSpecificOutput":{"additionalContext":"must not run"}}',
  });
  const { ctx, handlers } = makeHost();
  const before = handlers.get('before_agent_start');
  assert.ok(before !== undefined);
  assert.equal(await before({}, ctx), undefined);
});

test('agent start probes prompt-submit on hosts without a user-input event', async () => {
  respond({
    'prompt-submit': '{"hookSpecificOutput":{"additionalContext":"start nudge"}}',
  });
  const { ctx, handlers } = makeHost({ userInput: false });
  const before = handlers.get('before_agent_start');
  assert.ok(before !== undefined);
  assert.deepEqual(await before({}, ctx), {
    message: { customType: 'bro-context', content: 'start nudge', display: false },
  });
});

const API: BroHostApi<TestCtx> = {
  registerCommand() {},
  registerTool() {},
  sendMessage() {},
};

/** The resolve seam: the stub CLI by default, or the caller's pinned
 *  ladder end (null = every rung failed, the no-cli class). */
function stubResolve(
  pinned: Command | null | undefined
): (o: ResolveOptions) => Promise<Command | null> {
  return async (_o: ResolveOptions): Promise<Command | null> =>
    pinned === undefined ? { cmd: process.execPath, args: [stub] } : pinned;
}

/** A host stub: the events the driver binds are recorded, notifications
 *  collected, and the stop refusal is an inspectable marker. */
function makeHost(
  opts: { notifyThrows?: boolean; resolve?: Command | null; userInput?: boolean } = {}
): {
  ctx: TestCtx;
  handlers: Handlers;
  fireStop(): Promise<unknown>;
} {
  const handlers: Handlers = new Map();
  const ctx = makeCtx();
  createBroDriver(
    makeBinding(handlers, opts.notifyThrows === true, opts.userInput !== false),
    API,
    {
      resolve: stubResolve(opts.resolve),
    }
  );
  const fireStop = async (): Promise<unknown> => {
    const handler = handlers.get('session_stop');
    assert.ok(handler !== undefined, 'the driver bound no stop handler');
    return handler({}, ctx);
  };
  return { ctx, handlers, fireStop };
}

test('a block verdict still refuses the stop', async () => {
  respond({ stop: '{"decision":"block","reason":"dirty worktree"}' });
  const { fireStop } = makeHost();
  assert.deepEqual(await fireStop(), { blocked: 'dirty worktree' });
});

test('a healthy silent probe emits nothing — silence is no opinion', async () => {
  respond({});
  const { ctx, fireStop } = makeHost();
  assert.equal(await fireStop(), undefined);
  assert.deepEqual(ctx.notes, []);
});

test('a dead probe warns once, then stays quiet inside the window', async () => {
  respond({}, 2);
  const { ctx, fireStop } = makeHost();
  assert.equal(await fireStop(), undefined);
  assert.equal(ctx.notes.length, 1);
  assert.equal(ctx.notes[0]?.level, 'warning');
  assert.match(ctx.notes[0]?.text ?? '', /stop gate did not run/);
  assert.match(ctx.notes[0]?.text ?? '', /exited 2/);
  // a second stop inside the interval is suppressed — loud once, not spam
  assert.equal(await fireStop(), undefined);
  assert.equal(ctx.notes.length, 1);
});

test('chatter without a control object is a failure, not silence', async () => {
  respond({ stop: 'loading beads...\nnot json\n' });
  const { ctx, fireStop } = makeHost();
  assert.equal(await fireStop(), undefined);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0]?.text ?? '', /no control object/);
});

test('a missing CLI is its own failure class', async () => {
  const { ctx, fireStop } = makeHost({ resolve: null });
  assert.equal(await fireStop(), undefined);
  assert.equal(ctx.notes.length, 1);
  assert.equal(ctx.notes[0]?.level, 'warning');
  assert.match(ctx.notes[0]?.text ?? '', /no bro CLI resolved/);
});

test('a throwing notify cannot break fail-open', async () => {
  respond({}, 3);
  const { fireStop } = makeHost({ notifyThrows: true });
  assert.equal(await fireStop(), undefined);
});

test('the interval constant is a real throttle, not a per-stop spammer', () => {
  assert.equal(GATE_DIAG_INTERVAL_MS, 15 * 60_000);
});
