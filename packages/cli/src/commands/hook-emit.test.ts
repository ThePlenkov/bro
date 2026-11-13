/** The adapter emit path (specs/bro-izpyk.9.md): a `bro hooks` spawn
 *  whose env carries a registered plane's `BRO_HOOK_HOST` marker
 *  journals the same v2 start/end pair run.sh writes — every other
 *  invocation writes nothing. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  clearSessionPlanes,
  parseSpoolLine,
  registerSessionPlane,
  sessionPlanes,
  SpawnError,
  type SessionPlane,
  type SpoolRow,
} from '@broject/core';
import { adapterEmitBegin } from './hook-emit.ts';

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-hook-emit-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const rows = (spool: string): SpoolRow[] =>
  readFileSync(spool, 'utf8')
    .trim()
    .split('\n')
    .map(l => parseSpoolLine(l) as SpoolRow);

test('a marked launch writes the run.sh v2 start/end pair', () =>
  withDir(dir => {
    const spool = join(dir, 'hooks.spool');
    const env = {
      BRO_HOOK_SPOOL: spool,
      BRO_HOOK_HOST: 'pi',
      BRO_HOOK_PROOT: '/opt/pi-plugin',
      BRO_HOOK_ADAPTER: '0.4.2',
      BRO_AGENT_ID: 'agent-9',
      HOME: dir,
    };
    const emit = adapterEmitBegin('post-tool', { session_id: 'sess-1' }, 'sess-1', env);
    emit.end();
    const pair = rows(spool);
    assert.equal(pair.length, 2);
    const [start, end] = pair;
    assert.deepEqual(
      {
        version: start?.version,
        phase: start?.phase,
        host: start?.host,
        sid: start?.sid,
        event: start?.event,
        pid: start?.pid,
        ppid: start?.ppid,
        agent: start?.agent,
        adapter: start?.adapter,
        pluginRoot: start?.pluginRoot,
        launcher: start?.launcher,
        cwd: start?.cwd,
      },
      {
        version: 2,
        phase: 'start',
        host: 'pi',
        sid: 'sess-1',
        event: 'post-tool',
        pid: process.pid,
        ppid: process.ppid,
        agent: 'agent-9',
        adapter: '0.4.2',
        pluginRoot: '/opt/pi-plugin',
        launcher: 'agent', // BRO_AGENT_ID wins like run.sh
        cwd: process.cwd(),
      }
    );
    assert.equal(end?.phase, 'end');
    assert.equal(end?.id, start?.id);
    assert.equal(end?.rc, 0);
    assert.equal(end?.outcome, 'ok');
  }));

test('every adapter kind registers a detectHook plane', () =>
  withDir(dir => {
    for (const kind of ['opencode', 'kilo', 'pi', 'omp']) {
      const spool = join(dir, `${kind}.spool`);
      adapterEmitBegin('session-start', { session_id: 's' }, 's', {
        BRO_HOOK_SPOOL: spool,
        BRO_HOOK_HOST: kind,
        HOME: dir,
      }).end();
      assert.equal(rows(spool).at(0)?.host, kind);
    }
  }));

test('mark sets the outcome the end row carries; first end wins', () =>
  withDir(dir => {
    const spool = join(dir, 'hooks.spool');
    const env = { BRO_HOOK_SPOOL: spool, BRO_HOOK_HOST: 'omp', HOME: dir };
    const emit = adapterEmitBegin('pre-tool', {}, '', env);
    emit.mark('error');
    emit.end();
    emit.end('ok'); // write-once — a second end must not double the row
    const pair = rows(spool);
    assert.equal(pair.length, 2);
    assert.equal(pair[1]?.outcome, 'error');
    // an explicit end-outcome also beats the default
    const e2 = adapterEmitBegin('pre-tool', {}, '', env);
    e2.end('fastpath');
    assert.equal(rows(spool).at(3)?.outcome, 'fastpath');
  }));

test('sid comes from the plane normalize — input.session_id is the fallback', () =>
  withDir(dir => {
    const spool = join(dir, 'hooks.spool');
    const env = { BRO_HOOK_SPOOL: spool, BRO_HOOK_HOST: 'kilo', HOME: dir };
    // alternate identity spelling the shared normalizer knows
    adapterEmitBegin('session-start', { conversation_id: 'conv-7' }, '', env).end();
    assert.equal(rows(spool).at(0)?.sid, 'conv-7');
  }));

test('unmarked and unclaimable launches write nothing', () =>
  withDir(dir => {
    const spool = join(dir, 'hooks.spool');
    // no marker — the run.sh path's own spawn looks exactly like this
    adapterEmitBegin('post-tool', { session_id: 's' }, 's', {
      BRO_HOOK_SPOOL: spool,
      HOME: dir,
    }).end();
    // a marker no plane claims — 'claude' is a run.sh host, not an adapter
    adapterEmitBegin('post-tool', { session_id: 's' }, 's', {
      BRO_HOOK_SPOOL: spool,
      BRO_HOOK_HOST: 'claude',
      HOME: dir,
    }).end();
    assert.equal(existsSync(spool), false);
  }));

test('disabled spool and BRO_HOOKS=0 machine trees write nothing', () =>
  withDir(dir => {
    const spool = join(dir, 'hooks.spool');
    adapterEmitBegin('post-tool', {}, '', {
      BRO_HOOK_SPOOL: '0',
      BRO_HOOK_HOST: 'pi',
      HOME: dir,
    }).end();
    adapterEmitBegin('post-tool', {}, '', {
      BRO_HOOK_SPOOL: spool,
      BRO_HOOK_HOST: 'pi',
      BRO_HOOKS: '0',
      HOME: dir,
    }).end();
    assert.equal(existsSync(spool), false);
    // permission is run.sh's exception — BRO_HOOKS=0 still journals it
    adapterEmitBegin('permission', {}, '', {
      BRO_HOOK_SPOOL: spool,
      BRO_HOOK_HOST: 'pi',
      BRO_HOOKS: '0',
      HOME: dir,
    }).end('fastpath');
    assert.equal(rows(spool).at(1)?.outcome, 'fastpath');
  }));

test('the end rc mirrors the outcome — failures write nonzero like run.sh', () =>
  withDir(dir => {
    const spool = join(dir, 'hooks.spool');
    const env = { BRO_HOOK_SPOOL: spool, BRO_HOOK_HOST: 'omp', HOME: dir };
    adapterEmitBegin('e1', {}, '', env).end('error');
    adapterEmitBegin('e2', {}, '', env).end('fastpath');
    adapterEmitBegin('e3', {}, '', env).end();
    const pair = rows(spool);
    // start/end alternation — rc lives on the end rows
    assert.equal(pair.at(1)?.outcome, 'error');
    assert.equal(pair.at(1)?.rc, 1);
    assert.equal(pair.at(3)?.outcome, 'fastpath');
    assert.equal(pair.at(3)?.rc, 0);
    assert.equal(pair.at(5)?.outcome, 'ok');
    assert.equal(pair.at(5)?.rc, 0);
    // three begins in the same process-second still mint distinct pair
    // ids — the dedup key can never merge two launches
    const ids = [pair.at(0)?.id, pair.at(2)?.id, pair.at(4)?.id];
    assert.equal(new Set(ids).size, 3);
  }));

test('a throwing plane hook cannot break the host — begin fails open', () =>
  withDir(dir => {
    const saved = sessionPlanes();
    clearSessionPlanes();
    registerSessionPlane({
      kind: 'zev',
      detectsCli: () => false,
      countLive() {
        throw new SpawnError('unavailable', 'unavailable');
      },
      detectHook() {
        throw new Error('hostile plane — a emit bug must not kill the hook');
      },
    } satisfies SessionPlane);
    try {
      const spool = join(dir, 'hooks.spool');
      const emit = adapterEmitBegin('post-tool', { session_id: 's' }, 's', {
        BRO_HOOK_SPOOL: spool,
        BRO_HOOK_HOST: 'zev',
        HOME: dir,
      });
      // begin returned a handle instead of throwing; it is the noop —
      // no start row, and end() must not throw either
      emit.end();
      assert.equal(existsSync(spool), false);
    } finally {
      clearSessionPlanes();
      for (const plane of saved) {
        registerSessionPlane(plane);
      }
    }
  }));

test('launcher mirrors run.sh precedence', () =>
  withDir(dir => {
    const spool = join(dir, 'hooks.spool');
    adapterEmitBegin('e', {}, '', {
      BRO_HOOK_SPOOL: spool,
      BRO_HOOK_HOST: 'opencode',
      TMUX: '/tmp/tmux-1',
      HOME: dir,
    }).end();
    assert.equal(rows(spool).at(0)?.launcher, 'tmux');
    const bare = join(dir, 'bare.spool');
    adapterEmitBegin('e', {}, '', {
      BRO_HOOK_SPOOL: bare,
      BRO_HOOK_HOST: 'opencode',
      HOME: dir,
    }).end();
    assert.equal(rows(bare).at(0)?.launcher, 'interactive');
  }));
