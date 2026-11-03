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
  test('outside a herdr pane it is a no-op', async () => {
    assert.equal(await args({ herdr: { reportBack: true } }, devin, {}), undefined);
    assert.equal(
      await args({ herdr: { reportBack: true } }, devin, { HERDR_PANE_ID: 'w0:p1' }),
      undefined
    );
    assert.equal(
      await args({ herdr: { reportBack: true } }, devin, {
        HERDR_PANE_ID: 'w0:p1',
        HERDR_SOCKET_PATH: '',
      }),
      undefined
    );
  });
  test('an enabled kind prompts the pane', async () => {
    const out = await args({ herdr: { reportBack: { devin: true } } });
    assert.deepEqual(out?.slice(0, 3), ['agent', 'prompt', 'w0:p1']);
    assert.match(out![3]!, /^\[task-result\] `bro exec` npm test — exit 0 \(12\.3s\)/);
    assert.match(out![3]!, /ok 42 tests/);
  });
  test('a kind the config does not name is skipped', async () => {
    assert.equal(
      await args({ herdr: { reportBack: { devin: true } } }, () => ({ agent: 'opencode' })),
      undefined
    );
    assert.equal(await args({ herdr: {} }), undefined);
    assert.equal(await args({}), undefined);
  });
  test('a disabled config never asks the pane for its agent', async () => {
    let fetched = 0;
    const counting = (): PaneAgent | undefined => {
      fetched += 1;
      return devin();
    };
    assert.equal(await args({ herdr: {} }, counting), undefined);
    assert.equal(await args({ herdr: { reportBack: false } }, counting), undefined);
    assert.equal(fetched, 0);
  });
  test('reportBack: true reports any kind without an agent get', async () => {
    let fetched = 0;
    const out = await args({ herdr: { reportBack: true } }, () => {
      fetched += 1;
      return { agent: 'claude' };
    });
    assert.ok(out);
    assert.equal(fetched, 0);
  });
  test('an unreadable pane agent is skipped', async () => {
    const cfg = { herdr: { reportBack: { devin: true } } };
    assert.equal(await args(cfg, () => undefined), undefined);
    assert.equal(await args(cfg, () => ({})), undefined);
  });
});

describe('reportBackMessage', () => {
  test('a signal death reports the signal', () => {
    const msg = reportBackMessage({ cmd: 'x', exitCode: null, signal: 'SIGTERM', durationMs: 500 });
    assert.match(msg, /signal SIGTERM \(0\.5s\)/);
  });
  test('an empty tail is omitted', () => {
    const msg = reportBackMessage({ cmd: 'x', exitCode: 1, durationMs: 0, tail: '' });
    assert.equal(msg.endsWith('(0.0s)'), true);
  });
});
