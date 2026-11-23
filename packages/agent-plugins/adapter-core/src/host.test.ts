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

/** A host stub: the events the driver binds are recorded, notifications
 *  collected, and the stop refusal is an inspectable marker. */
function makeHost(opts: { notifyThrows?: boolean; resolve?: Command | null } = {}): {
  ctx: TestCtx;
  handlers: Map<string, (event: unknown, ctx: TestCtx) => unknown>;
  fireStop(): Promise<unknown>;
} {
  const handlers = new Map<string, (event: unknown, ctx: TestCtx) => unknown>();
  const ctx: TestCtx = {
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
  const binding: BroHostBinding<TestCtx> = sharedBinding<TestCtx>({
    kind: 'test',
    stop: 'session_stop',
    on(event, handler) {
      handlers.set(event, handler as (event: unknown, ctx: TestCtx) => unknown);
    },
    paint() {},
    notify(c, text, level) {
      if (opts.notifyThrows === true) {
        throw new Error('notify exploded');
      }
      c.notes.push({ text, level });
    },
    refuseStop(reason) {
      return { blocked: reason };
    },
    stopAlreadyRefused: () => false,
  });
  const api: BroHostApi<TestCtx> = {
    registerCommand() {},
    registerTool() {},
    sendMessage() {},
  };
  const resolve =
    opts.resolve === undefined
      ? async (_o: ResolveOptions): Promise<Command | null> => ({
          cmd: process.execPath,
          args: [stub],
        })
      : async (_o: ResolveOptions): Promise<Command | null> => opts.resolve ?? null;
  createBroDriver(binding, api, { resolve });
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
