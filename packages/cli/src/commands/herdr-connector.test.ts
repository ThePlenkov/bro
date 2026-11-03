/** The herdr report-back probe (spec bro-84zrj): env gates, the
 *  per-kind config switch, and the prompt payload `bro exec` hands to
 *  `herdr agent prompt`. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorCtx, TaskFinishReport } from '@broject/core';
import {
  reportBackArgs,
  reportBackEnabled,
  reportBackMessage,
  type PaneAgent,
} from './herdr-connector.ts';

const ctx: ConnectorCtx = { dir: process.cwd() };
const env = { HERDR_PANE_ID: 'w0:p1', HERDR_SOCKET_PATH: '/run/herdr.sock' };
const report: TaskFinishReport = {
  cmd: 'npm test',
  exitCode: 0,
  durationMs: 12_340,
  tail: 'ok 42 tests',
};
const devin = (): PaneAgent => ({ agent: 'devin', agent_status: 'idle' });
const args = (
  bags: Record<string, Record<string, unknown>>,
  paneAgent: () => PaneAgent | undefined = devin,
  e: NodeJS.ProcessEnv = env
) => reportBackArgs(ctx, report, e, { bags, paneAgent });

describe('reportBackEnabled', () => {
  test('true enables every kind', () => {
    assert.equal(reportBackEnabled(true, 'devin'), true);
    assert.equal(reportBackEnabled(true, 'opencode'), true);
  });
  test('a kind map opts in one kind at a time', () => {
    const cfg = { devin: true };
    assert.equal(reportBackEnabled(cfg, 'devin'), true);
    assert.equal(reportBackEnabled(cfg, 'opencode'), false);
  });
  test('absent or false disables', () => {
    assert.equal(reportBackEnabled(undefined, 'devin'), false);
    assert.equal(reportBackEnabled(false, 'devin'), false);
    assert.equal(reportBackEnabled({ devin: false }, 'devin'), false);
  });
});

describe('reportBackArgs', () => {
  test('outside a herdr pane it is a no-op', () => {
    assert.equal(args({ herdr: { reportBack: true } }, devin, {}), undefined);
    assert.equal(
      args({ herdr: { reportBack: true } }, devin, { HERDR_PANE_ID: 'w0:p1' }),
      undefined
    );
  });
  test('an enabled kind prompts the pane', () => {
    const out = args({ herdr: { reportBack: { devin: true } } });
    assert.deepEqual(out?.slice(0, 3), ['agent', 'prompt', 'w0:p1']);
    assert.match(out![3]!, /^\[task-result\] `bro exec` npm test — exit 0 \(12\.3s\)/);
    assert.match(out![3]!, /ok 42 tests/);
  });
  test('a kind the config does not name is skipped', () => {
    assert.equal(
      args({ herdr: { reportBack: { devin: true } } }, () => ({ agent: 'opencode' })),
      undefined
    );
    assert.equal(args({ herdr: {} }), undefined);
    assert.equal(args({}), undefined);
  });
  test('reportBack: true reports any kind', () => {
    assert.ok(args({ herdr: { reportBack: true } }, () => ({ agent: 'claude' })));
  });
  test('an unreadable pane agent is skipped', () => {
    assert.equal(
      args({ herdr: { reportBack: true } }, () => undefined),
      undefined
    );
    assert.equal(
      args({ herdr: { reportBack: true } }, () => ({})),
      undefined
    );
  });
});

describe('reportBackMessage', () => {
  test('a signal death reports the signal', () => {
    const msg = reportBackMessage({ cmd: 'x', exitCode: null, signal: 'SIGTERM', durationMs: 500 });
    assert.match(msg, /signal SIGTERM \(0\.5s\)/);
  });
  test('an empty tail is omitted', () => {
    const msg = reportBackMessage({ cmd: 'x', exitCode: 1, durationMs: 0 });
    assert.equal(msg.endsWith('(0.0s)'), true);
  });
});
