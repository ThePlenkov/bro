import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fleetStatusPath, type FleetPaneState, writeFleetState } from './fleet-state.ts';
import {
  applyRaw,
  metaArgs,
  PANE_AGENT,
  PANE_SOURCE,
  plain,
  releaseArgs,
  renderView,
  reportArgs,
  runStatusView,
} from './herdr-status-view.ts';

const NOW = Date.now();

/** The state doc a pass renders — the daemon projector's side of the
 *  contract, verbatim. */
const doc = (over: Partial<FleetPaneState> = {}): FleetPaneState => ({
  v: 1,
  worktree: '/repo/trees/t1',
  workspace: 'w1',
  title: 'Ship the thing',
  slug: 'bro-idsat',
  status: 'working·#7',
  led: { state: 'working' },
  ts: NOW,
  ...over,
});

describe('reportArgs / releaseArgs — the bro:fleet contract', () => {
  test('report carries source, agent, nanos seq, state, message', () => {
    const a = reportArgs('w1:p1', { state: 'blocked', message: 'lost' }, 42);
    assert.deepEqual(a, [
      'pane',
      'report-agent',
      'w1:p1',
      '--source',
      'bro:fleet',
      '--agent',
      'bro-status',
      '--seq',
      '42',
      '--state',
      'blocked',
      '--message',
      'lost',
    ]);
    assert.equal(PANE_SOURCE.startsWith('herdr:'), false);
  });

  test('a message-less state emits no --message flag', () => {
    const a = reportArgs('w1:p1', { state: 'working' }, 42);
    assert.ok(!a.includes('--message'));
  });

  test('release clears name and state for the same source/agent', () => {
    assert.deepEqual(releaseArgs('w1:p1', 43), [
      'pane',
      'release-agent',
      'w1:p1',
      '--source',
      'bro:fleet',
      '--agent',
      'bro-status',
      '--seq',
      '43',
    ]);
  });
});

describe('metaArgs — display text is metadata, never the semantic', () => {
  test('slug becomes --display-agent; status text becomes the state label', () => {
    const calls = metaArgs('w1:p1', doc(), 7);
    assert.equal(calls.length, 2);
    const [clear, set] = calls;
    // call 1 clears only — clear wipes display-agent AND labels
    assert.ok(clear!.includes('--clear-state-labels'));
    assert.ok(!clear!.includes('--display-agent') && !clear!.includes('--state-label'));
    // call 2 writes name + label together
    assert.equal(set![set!.indexOf('--display-agent') + 1], 'bro-idsat');
    assert.deepEqual(set!.slice(set!.indexOf('--state-label')), [
      '--state-label',
      'working=working·#7',
    ]);
  });

  test('an agent name wins over slug; slug wins over fleet', () => {
    const a = metaArgs('w1:p1', doc({ agent: 'opencode' }), 7);
    assert.equal(a[1]![a[1]!.indexOf('--display-agent') + 1], 'opencode');
    const s = doc();
    delete s.slug;
    const b = metaArgs('w1:p1', s, 7);
    assert.equal(b[1]![b[1]!.indexOf('--display-agent') + 1], 'fleet');
  });

  test('undefined state clears everything back to the bare binding', () => {
    const calls = metaArgs('w1:p1', undefined, 7);
    assert.equal(calls.length, 2);
    const a = calls[1]!;
    assert.equal(a[a.indexOf('--display-agent') + 1], 'fleet');
    assert.ok(!a.includes('--state-label'));
  });
});

describe('renderView — the pane face', () => {
  test('waiting state when the projector has not written yet', () => {
    const v = renderView(undefined, '/repo/trees/t1');
    assert.match(v, /waiting/);
    assert.match(v, /repos?\/trees\/t1/);
    assert.ok(v.includes('\u001b[2J'));
  });

  test('populated state carries icon, status, title, timestamp', () => {
    const v = renderView(doc(), '/repo/trees/t1', NOW + 5_000);
    assert.match(v, /● working·#7/);
    assert.match(v, /Ship the thing/);
    assert.match(v, /5s ago/);
    assert.match(v, /w1/);
  });

  test('a prUrl wraps the #N token in an OSC8 link', () => {
    const v = renderView(doc({ prUrl: 'https://github.com/o/r/pull/7' }), '/repo/trees/t1');
    assert.ok(v.includes('\u001b]8;;https://github.com/o/r/pull/7\u0007#7\u001b]8;;\u0007'));
    // no URL → the token stays plain text
    assert.ok(renderView(doc(), '/repo/trees/t1').includes('working·#7'));
    // an injected URL is sanitized before it reaches the escape — the
    // payload survives as inert text, never as a live escape
    const evil = renderView(doc({ prUrl: 'http://e\u001b]8;;x\u0007' }), '/repo/trees/t1');
    assert.ok(evil.includes(']8;;http://e]8;;x\u0007'));
  });

  test('untrusted fields can never inject terminal escapes', () => {
    assert.equal(plain('a\u001b[2Jb'), 'a[2Jb');
    const evil = doc({ title: 'x\u001b]8;;http://e\u0007t', slug: 's\u0007[0m' });
    const v = renderView(evil, '/repo/trees/t1');
    // the only ESC bytes left are the view's own clear-and-home prefix
    assert.equal(v.indexOf('\u001b', v.indexOf('[H')), -1);
    const meta = metaArgs('w1:p1', evil, 1);
    assert.equal(meta[1]![meta[1]!.indexOf('--display-agent') + 1], 's[0m');
  });
});

describe('applyRaw — the dedupe the watch rides on', () => {
  test('identical raw never re-applies', () => {
    let n = 0;
    const last = applyRaw('{"a":1}', '{"a":1}', () => {
      n += 1;
    });
    assert.equal(n, 0);
    assert.equal(last, '{"a":1}');
  });

  test('changed raw parses and applies once', () => {
    const seen: (FleetPaneState | undefined)[] = [];
    const last = applyRaw(JSON.stringify(doc()), '{"a":1}', s => {
      seen.push(s);
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.workspace, 'w1');
    assert.equal(last, JSON.stringify(doc()));
  });

  test('a vanished file applies undefined — the waiting face', () => {
    const seen: (FleetPaneState | undefined)[] = [];
    applyRaw(undefined, 'x', s => {
      seen.push(s);
    });
    assert.deepEqual(seen, [undefined]);
  });
});

/** A fake `herdr` that only logs argv — the status-view's reports are
 *  fire-and-forget, so logging is the whole contract. */
const FAKE_HERDR = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.FAKE_HERDR_LOG) {
  fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
}
`;

describe('runStatusView --once — one bind against a seeded state file', () => {
  const callsOf = (log: string): string[][] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as string[]);

  /** Env bound for one call — the command reads it per invocation. */
  function withEnv<T>(env: Record<string, string>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) saved[k] = process.env[k];
    try {
      Object.assign(process.env, env);
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test('reports the file verdict on its own pane, then returns', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'sv-tree-'));
    const statePath = fleetStatusPath(worktree, worktree);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFleetState(statePath, doc({ worktree }));

    const dir = mkdtempSync(join(tmpdir(), 'sv-'));
    const fake = join(dir, 'fake-herdr.js');
    const log = join(dir, 'calls.jsonl');
    writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
    rmSync(log, { force: true });

    await withEnv(
      {
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'w1:p9',
        HERDR_BIN_PATH: fake,
        FAKE_HERDR_LOG: log,
      },
      () => runStatusView([worktree, '--once'])
    );

    const calls = callsOf(log);
    const report = calls.find(c => c[1] === 'report-agent');
    assert.ok(report !== undefined);
    assert.equal(report[2], 'w1:p9');
    assert.equal(report[report.indexOf('--source') + 1], 'bro:fleet');
    assert.equal(report[report.indexOf('--agent') + 1], 'bro-status');
    assert.equal(report[report.indexOf('--state') + 1], 'working');
    const meta = calls.find(c => c[1] === 'report-metadata' && c.includes('--display-agent'));
    assert.ok(meta !== undefined);
    assert.equal(meta[meta.indexOf('--display-agent') + 1], 'bro-idsat');
  });

  test('a missing state file binds unknown', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'sv-tree-'));
    const dir = mkdtempSync(join(tmpdir(), 'sv-'));
    const fake = join(dir, 'fake-herdr.js');
    const log = join(dir, 'calls.jsonl');
    writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
    rmSync(log, { force: true });

    await withEnv(
      {
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'w2:p1',
        HERDR_BIN_PATH: fake,
        FAKE_HERDR_LOG: log,
      },
      () => runStatusView([worktree, '--once'])
    );

    const report = callsOf(log).find(c => c[1] === 'report-agent');
    assert.equal(report?.[report.indexOf('--state') + 1], 'unknown');
  });

  test('outside herdr the command is a silent no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sv-'));
    const log = join(dir, 'calls.jsonl');
    await withEnv({ FAKE_HERDR_LOG: log, HERDR_BIN_PATH: '/nonexistent/herdr' }, () =>
      runStatusView([mkdtempSync(join(tmpdir(), 'sv-tree-')), '--once'])
    );
    assert.throws(() => callsOf(log));
  });
});
