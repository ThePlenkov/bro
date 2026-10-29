import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Planes } from '../src/planes.ts';
import { LiveSource } from '../src/sources.ts';

const MAIN = mkdtempSync(join(tmpdir(), 'bro-src-main-'));

let n = 0;
const read = (): Planes => ({
  repo: MAIN,
  main: MAIN,
  status: {
    dir: MAIN,
    worktrees: [],
    beads: { inProgress: [] },
    fleet: { maxConcurrent: 4, agents: [] },
    loop: { stallMin: 30, runs: [] },
  },
  worktrees: { source: { source_checkout_path: MAIN }, worktrees: [] },
  workspaces: [],
  registry: {},
  // a fresh detail every read — every wake produces a moved diff-key
  armedDetails: [String(++n)],
  mirrorPanes: {},
  rendererPanes: {},
  act: [],
});

/** `it.next()` with a hard ceiling — a hung source fails fast. */
const nextWithin = async (
  it: AsyncGenerator<Planes, void>,
  ms: number
): Promise<IteratorResult<Planes, void>> =>
  Promise.race([
    it.next(),
    new Promise<IteratorResult<Planes, void>>((_, rej) =>
      setTimeout(() => rej(new Error(`next() exceeded ${ms}ms`)), ms)
    ),
  ]);

describe('LiveSource', () => {
  test('a bus event wakes the sleep early — not on the 30s cadence', async () => {
    const src = new LiveSource(MAIN, 30_000, {
      read,
      // emits one frame ~50ms in, then idles — a real broker tail's shape
      busArgv: ['sh', '-c', 'sleep 0.05; echo \'{"topic":"worker","kind":"silent"}\'; sleep 60'],
    });
    const it = src[Symbol.asyncIterator]();
    const t0 = Date.now();
    await nextWithin(it, 10_000);
    await nextWithin(it, 10_000);
    const elapsed = Date.now() - t0;
    await it.return(undefined);
    assert.ok(elapsed < 10_000, `event wake took ${elapsed}ms — the 30s poll won`);
  });

  test('broker down — poll cadence still drives the loop', async () => {
    const src = new LiveSource(MAIN, 60, {
      read,
      busArgv: ['sh', '-c', 'exit 1'],
    });
    const it = src[Symbol.asyncIterator]();
    const t0 = Date.now();
    await nextWithin(it, 10_000);
    await nextWithin(it, 10_000);
    const elapsed = Date.now() - t0;
    await it.return(undefined);
    assert.ok(elapsed < 5_000, `poll fallback took ${elapsed}ms`);
    assert.ok(elapsed >= 55, `poll fallback fired at ${elapsed}ms — before the tick`);
  });

  test('noBus — same loop, no tail child at all', async () => {
    const src = new LiveSource(MAIN, 60, { read, noBus: true });
    const it = src[Symbol.asyncIterator]();
    const t0 = Date.now();
    await nextWithin(it, 10_000);
    await nextWithin(it, 10_000);
    const elapsed = Date.now() - t0;
    await it.return(undefined);
    assert.ok(elapsed < 5_000);
    assert.ok(elapsed >= 55);
  });
});
