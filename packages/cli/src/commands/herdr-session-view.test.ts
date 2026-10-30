import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fleetStatusPath, type FleetPaneState, writeFleetState } from './fleet-state.ts';
import {
  resolveTarget,
  SESSION_PANE_AGENT,
  sessionMetaArgs,
  sessionReleaseArgs,
  sessionReportArgs,
  runSessionView,
  targetKey,
  viewVerdict,
} from './herdr-session-view.ts';

const NOW = Date.now();

/** The state doc a pass renders — the daemon projector's side of the
 *  contract, verbatim, with the session-view fields riding. */
const doc = (over: Partial<FleetPaneState> = {}): FleetPaneState => ({
  v: 1,
  worktree: '/repo/trees/t1',
  workspace: 'w1',
  title: 'Ship the thing',
  slug: 'bro-nwl5g',
  status: 'working',
  led: { state: 'working' },
  ts: NOW,
  ...over,
});

describe('sessionReportArgs / sessionReleaseArgs — the bro:fleet contract', () => {
  test('report carries source, bro-session agent, seq, state', () => {
    const a = sessionReportArgs('w1:p2', { state: 'working' }, 42);
    assert.deepEqual(a, [
      'pane',
      'report-agent',
      'w1:p2',
      '--source',
      'bro:fleet',
      '--agent',
      'bro-session',
      '--seq',
      '42',
      '--state',
      'working',
    ]);
    // the session pane is NOT bro-status — a recycled pane id must
    // fail the status backstop's foreign-agent check
    assert.equal(SESSION_PANE_AGENT, 'bro-session');
  });

  test('release clears name and state for the same source/agent', () => {
    const a = sessionReleaseArgs('w1:p2', 43);
    assert.deepEqual(a, [
      'pane',
      'release-agent',
      'w1:p2',
      '--source',
      'bro:fleet',
      '--agent',
      'bro-session',
      '--seq',
      '43',
    ]);
  });
});

describe('resolveTarget — provider config gates the acp attach', () => {
  const acpProviders = {
    oc: { type: 'acp', command: 'opencode acp' },
    cl: { type: 'cli', command: 'claude -p' },
    api: { type: 'api', baseUrl: 'http://x', models: {} },
  } as const;

  test('acp provider + session id → session target resolved', () => {
    const t = resolveTarget(
      doc({ provider: 'oc', acpSessionId: 'ses_1', model: 'm1', agent: 'opencode' }),
      '/repo/trees/t1',
      { ...acpProviders }
    );
    assert.deepEqual(t?.session, {
      id: 'ses_1',
      command: 'opencode acp',
      provider: 'oc',
      model: 'm1',
    });
    assert.equal(targetKey(t), 'acp|opencode acp|ses_1');
  });

  test('cli/api/missing providers never spawn — no session target', () => {
    for (const p of ['cl', 'api', 'gone']) {
      const t = resolveTarget(
        doc({ provider: p, acpSessionId: 'ses_1', log: '/l.log' }),
        '/repo/trees/t1',
        { ...acpProviders }
      );
      assert.equal(t?.session, undefined, p);
      assert.equal(t?.log, '/l.log');
      assert.equal(targetKey(t), 'log|/l.log');
    }
  });

  test('no session id means no attach even for an acp provider', () => {
    const t = resolveTarget(doc({ provider: 'oc', log: '/l.log' }), '/repo/trees/t1', {
      ...acpProviders,
    });
    assert.equal(t?.session, undefined);
    assert.equal(t?.log, '/l.log');
  });

  test('no session and no log resolves to the empty view', () => {
    const t = resolveTarget(doc({ provider: 'oc' }), '/repo/trees/t1', { ...acpProviders });
    assert.equal(targetKey(t), 'none');
    assert.equal(viewVerdict(t, { mode: 'none', acp: 'none' }).led.state, 'unknown');
  });

  test('undefined state is the waiting verdict', () => {
    const t = resolveTarget(undefined, '/repo/trees/t1', {});
    assert.equal(targetKey(t), 'waiting');
    assert.equal(viewVerdict(t, { mode: 'none', acp: 'none' }).mode, 'waiting for projector');
  });
});

describe('viewVerdict — the pane reports its own feed', () => {
  const t = resolveTarget(
    doc({ provider: 'oc', acpSessionId: 'ses_1', log: '/l' }),
    '/repo/trees/t1',
    { oc: { type: 'acp', command: 'opencode acp' } }
  )!;

  test('acp attach postures → working/idle', () => {
    assert.deepEqual(viewVerdict(t, { mode: 'acp', acp: 'connecting' }), {
      led: { state: 'working' },
      mode: 'attaching',
    });
    assert.deepEqual(viewVerdict(t, { mode: 'acp', acp: 'live' }), {
      led: { state: 'working' },
      mode: 'session/load',
    });
    assert.deepEqual(viewVerdict(t, { mode: 'acp', acp: 'ended' }), {
      led: { state: 'idle' },
      mode: 'session ended',
    });
  });

  test('log mode follows the worker verdict — live tail works, dead idles', () => {
    assert.equal(viewVerdict(t, { mode: 'log', acp: 'none' }).led.state, 'working');
    const dead = resolveTarget(doc({ led: { state: 'idle' }, log: '/l' }), '/repo/trees/t1', {})!;
    assert.deepEqual(viewVerdict(dead, { mode: 'log', acp: 'none' }), {
      led: { state: 'idle' },
      mode: 'log tail',
    });
  });
});

describe('sessionMetaArgs — two-call display contract', () => {
  test('call 1 clears, call 2 sets display-agent + state-label', () => {
    const t = resolveTarget(doc({ agent: 'opencode' }), '/repo/trees/t1', {});
    const calls = sessionMetaArgs(
      'w1:p2',
      t,
      { led: { state: 'working' }, mode: 'session/load' },
      7
    );
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.includes('--clear-state-labels'));
    assert.ok(!calls[0]!.includes('--display-agent'));
    const set = calls[1]!;
    assert.equal(set[set.indexOf('--display-agent') + 1], 'opencode');
    assert.deepEqual(set.slice(set.indexOf('--state-label')), [
      '--state-label',
      'working=session/load',
    ]);
  });

  test('provider names the pane when no agent binary resolves', () => {
    const t = resolveTarget(doc({ provider: 'oc', acpSessionId: 's' }), '/repo/trees/t1', {
      oc: { type: 'acp', command: 'opencode acp' },
    });
    const calls = sessionMetaArgs('w1:p2', t, { led: { state: 'idle' }, mode: 'x' }, 7);
    assert.equal(calls[1]![calls[1]!.indexOf('--display-agent') + 1], 'oc');
  });

  test('escapes in display text are stripped', () => {
    const t = resolveTarget(doc({ agent: 'a[2J' }), '/repo/trees/t1', {});
    const calls = sessionMetaArgs('w1:p2', t, { led: { state: 'idle' }, mode: 'm' }, 7);
    assert.equal(calls[1]![calls[1]!.indexOf('--display-agent') + 1], 'a[2J');
  });
});

/** A fake `herdr` that only logs argv — the pane's reports are
 *  fire-and-forget, so logging is the whole contract. */
const FAKE_HERDR = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.FAKE_HERDR_LOG) {
  fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
}
`;

/** A minimal NDJSON ACP agent: answers initialize with loadSession,
 *  replays canned updates on session/load, idles until killed. */
const FAKE_AGENT = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', l => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: m.params.protocolVersion,
      agentInfo: { name: 'fake', version: '0' },
      agentCapabilities: { loadSession: true },
      authMethods: [],
    }});
  } else if (m.method === 'session/load') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: m.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-LINE' } },
    }});
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nf' } });
  }
});
`;

/** Apply an env map — `undefined` deletes the key. Shared by the
 *  bind and the restore so the loop body lives once. */
const putEnv = (env: Record<string, string | undefined>): void => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

/** Env bound for one call — the command reads it per invocation.
 *  `undefined` unbinds: the ambient shell may itself run inside
 *  herdr, so absence is a value a test must be able to force. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    putEnv(env);
    return fn();
  } finally {
    putEnv(saved);
  }
}

const callsOf = (log: string): string[][] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as string[]);

/** A fixture: temp worktree + fake herdr + a captured render stream
 *  (the `out` seam — patching process.stdout would eat the TAP
 *  reporter's own output mid-run). */
function fixture(): {
  worktree: string;
  dir: string;
  env: Record<string, string>;
  log: string;
  opts: { out: (line: string) => void };
  stdout: () => string;
  write: (rel: string, text: string) => string;
} {
  const worktree = mkdtempSync(join(tmpdir(), 'sesv-tree-'));
  const dir = mkdtempSync(join(tmpdir(), 'sesv-'));
  const fake = join(dir, 'fake-herdr.js');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
  rmSync(log, { force: true });
  const lines: string[] = [];
  return {
    worktree,
    dir,
    log,
    opts: { out: line => lines.push(line) },
    stdout: () => lines.join('\n'),
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2', HERDR_BIN_PATH: fake, FAKE_HERDR_LOG: log },
    write: (rel, text) => {
      const p = join(worktree, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
  };
}

describe('runSessionView --once', () => {
  test('a log-only state tails the native log and reports log tail', async () => {
    const f = fixture();
    const logPath = f.write('agent.log', 'session ses_1 (cwd /x)\nmodel m\nhello-world\n');
    const statePath = fleetStatusPath(f.worktree, f.worktree);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFleetState(statePath, doc({ worktree: f.worktree, log: logPath }));
    await withEnv(f.env, () => runSessionView([f.worktree, '--once'], f.opts));
    const text = f.stdout();
    assert.match(text, /hello-world/);
    assert.match(text, /tailing the native log|log tail/);
    const calls = callsOf(f.log);
    const report = calls.find(c => c[1] === 'report-agent');
    assert.equal(report?.[2], 'w1:p2');
    assert.equal(report?.[report.indexOf('--agent') + 1], 'bro-session');
    // the worker's verdict is live — a live log tail reports working
    assert.equal(report?.[report.indexOf('--state') + 1], 'working');
  });

  test('an acp provider state spawns the command and replays the load', async () => {
    const f = fixture();
    const agent = f.write('fake-agent.cjs', FAKE_AGENT);
    f.write(
      'bro.config.json',
      JSON.stringify({ providers: { fakeacp: { type: 'acp', command: `node ${agent}` } } })
    );
    const statePath = fleetStatusPath(f.worktree, f.worktree);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFleetState(
      statePath,
      doc({
        worktree: f.worktree,
        provider: 'fakeacp',
        acpSessionId: 'ses_x',
        agent: 'fake',
        log: f.write('agent.log', 'LOG-FALLBACK'),
      })
    );
    await withEnv(f.env, () => runSessionView([f.worktree, '--once'], f.opts));
    const text = f.stdout();
    assert.match(text, /REPLAYED-LINE/, 'the replayed update must render');
    assert.match(text, /ses_x/, 'the session id shows in the banner');
    const calls = callsOf(f.log);
    const report = calls.find(c => c[1] === 'report-agent');
    assert.equal(report?.[report.indexOf('--state') + 1], 'working');
  });

  test('a cli provider state never spawns — the log tail renders', async () => {
    const f = fixture();
    const agent = f.write('fake-agent.cjs', 'process.exit(99)');
    const logPath = f.write('agent.log', 'CLI-LOG-LINE');
    f.write(
      'bro.config.json',
      JSON.stringify({
        providers: { fakecli: { type: 'cli', command: `node ${agent}` } },
      })
    );
    const statePath = fleetStatusPath(f.worktree, f.worktree);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFleetState(
      statePath,
      doc({ worktree: f.worktree, provider: 'fakecli', acpSessionId: 'ses_x', log: logPath })
    );
    await withEnv(f.env, () => runSessionView([f.worktree, '--once'], f.opts));
    const text = f.stdout();
    assert.match(text, /CLI-LOG-LINE/);
    assert.match(text, /no acp session resolved/);
  });

  test('no state file binds unknown, no session', async () => {
    const f = fixture();
    await withEnv(f.env, () => runSessionView([f.worktree, '--once'], f.opts));
    f.stdout();
    const report = callsOf(f.log).find(c => c[1] === 'report-agent');
    assert.equal(report?.[report.indexOf('--state') + 1], 'unknown');
  });

  test('outside herdr the command is a silent no-op', async () => {
    const f = fixture();
    // the ambient dev shell may itself be a herdr pane — the herdr
    // vars must go, not merely be overridden
    await withEnv(
      {
        HERDR_ENV: undefined,
        HERDR_PANE_ID: undefined,
        HERDR_BIN_PATH: f.env.HERDR_BIN_PATH!,
        FAKE_HERDR_LOG: f.log,
      },
      () => runSessionView([f.worktree, '--once'], f.opts)
    );
    f.stdout();
    assert.throws(() => callsOf(f.log));
  });
});
