import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actConnector } from './connector.ts';
import { openActState } from './act-fixtures.ts';
import { prStateCache } from './state-cache.ts';
import { registerConnector, scrubEnv, testGit, type ReviewFacade } from '@broject/core';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

const dirs: string[] = [];
after(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-act-conn-'));
  testGit(['init', '-q', dir]);
  dirs.push(dir);
  return dir;
}

/** A dead-pid supervisor heartbeat — the state a killed `bro <kind>`
 *  leaves behind for the next session start. */
function deadSupervisor(dir: string, kind: string, merge: boolean): void {
  const wd = join(dir, '.git', 'bro', 'watches');
  mkdirSync(wd, { recursive: true });
  writeFileSync(
    join(wd, `7-${kind}-2000000000.json`),
    JSON.stringify({
      pr: 7,
      link: '[#7](https://github.com/o/r/pull/7)',
      pid: 2_000_000_000,
      merge,
      startedAt: Date.now(),
      timeoutMin: 45,
    })
  );
}

const start = (dir: string) => actConnector.hooks!({ dir }).sessionStart!({ dir });

describe('act connector — stale supervisor restart hints', () => {
  test('a dead --no-merge drive marker restarts with --no-merge', async () => {
    const dir = repo();
    deadSupervisor(dir, 'drive', false);
    const stale = (await start(dir)).find(l => l.includes('stale act watch'));
    assert.ok(stale);
    assert.match(stale, /`bro drive --every --no-merge`/);
  });

  test('a dead merge drive marker restarts plain --every', async () => {
    const dir = repo();
    deadSupervisor(dir, 'drive', true);
    const stale = (await start(dir)).find(l => l.includes('stale act watch'));
    assert.ok(stale);
    assert.match(stale, /`bro drive --every`/);
    assert.ok(!stale.includes('--no-merge'));
  });

  test('a dead loop marker restarts as `bro loop`', async () => {
    const dir = repo();
    deadSupervisor(dir, 'loop', true);
    const stale = (await start(dir)).find(l => l.includes('stale act watch'));
    assert.ok(stale);
    assert.match(stale, /`bro loop`/);
  });
});

/** An open PR on the current branch — opt-in so the name pin in
 *  bro.config.json is the only resolution path that can reach it. */
const FAKE_REV = 'conn-test-stop-gate';
registerConnector({
  name: FAKE_REV,
  optIn: true,
  reviews: () =>
    ({
      currentPr: () => ({ pr: 7, state: 'OPEN', url: 'https://github.com/o/r/pull/7' }),
      resolveRepo: () => 'o/r',
      prLink: (_repo: string, pr: number) => `[#${pr}](https://github.com/o/r/pull/${pr})`,
      parsePrRef: () => null,
    }) as unknown as ReviewFacade,
});

/** A repo whose config pins the fake review host — every stopGate
 *  resolves PR 7 on 'o/r'. */
function repoWithPr(): string {
  const dir = repo();
  writeFileSync(
    join(dir, 'bro.config.json'),
    JSON.stringify({ connectors: { reviews: FAKE_REV } })
  );
  return dir;
}

/** Publish a feed entry exactly like a detached `bro act status`
 *  leaves behind. */
function publish(dir: string, over: Parameters<typeof openActState>[0] = {}): void {
  prStateCache(dir)!.write(
    { repo: 'o/r', pr: 7 },
    openActState({ pr: 7, url: 'https://github.com/o/r/pull/7', ...over })
  );
}

/** A live wait marker — this pid is the watcher, so liveness holds. */
function liveWatch(dir: string): void {
  const wd = join(dir, '.git', 'bro', 'watches');
  mkdirSync(wd, { recursive: true });
  writeFileSync(
    join(wd, `7-${process.pid}.json`),
    JSON.stringify({
      pr: 7,
      link: '[#7](https://github.com/o/r/pull/7)',
      pid: process.pid,
      merge: false,
      startedAt: Date.now(),
      timeoutMin: 45,
    })
  );
}

const stop = (dir: string) => actConnector.hooks!({ dir }).stopGate!({ dir });

describe('act connector — stopGate reads the feed only (bro-36sx7.4)', () => {
  test('cache miss + no watch → pending-verdict block + refresh stamp', async () => {
    const dir = repoWithPr();
    const rows = await stop(dir);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.block!, /gate verdict pending — no live act watch/);
    assert.match(rows[0]!.block!, /bro act wait 7 --merge --cleanup --detach/);
    // the miss claimed the refresh stamp — the detached `bro act
    // status` spawn itself refuses under a test argv, by design
    assert.ok(existsSync(join(dir, '.git', 'bro', 'act-state', 'o%2Fr-7.json.refresh')));
  });

  test('a fresh refresh stamp suppresses the next claim', async () => {
    const dir = repoWithPr();
    await stop(dir);
    const cache = prStateCache(dir)!;
    assert.equal(cache.claimRefresh({ repo: 'o/r', pr: 7 }), false);
  });

  test('cache miss + live watch → silent (a poller publishes)', async () => {
    const dir = repoWithPr();
    liveWatch(dir);
    assert.deepEqual(await stop(dir), []);
  });

  test('blocked cached verdict → the same blockers as a live fetch', async () => {
    const dir = repoWithPr();
    publish(dir, { openThreads: 3 });
    const rows = await stop(dir);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.block!, /3 unresolved review thread/);
  });

  test('green cached verdict + no watch → the arm-a-watch block', async () => {
    const dir = repoWithPr();
    publish(dir);
    const rows = await stop(dir);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.block!, /gate OK but no live act watch/);
    assert.match(rows[0]!.block!, /bro act wait 7 --merge --cleanup --detach/);
  });

  test('green cached verdict + live watch → silent', async () => {
    const dir = repoWithPr();
    publish(dir);
    liveWatch(dir);
    assert.deepEqual(await stop(dir), []);
  });
});
