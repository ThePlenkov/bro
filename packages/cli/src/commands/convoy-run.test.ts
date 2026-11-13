import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEARN_RETRO_CLOSEOUT } from '@broject/loop';
import { runArgs, runnerPrompt, runnerSpawnReq } from './convoy-run.ts';

// The molecule FSM (runMol/runQueue + the classification matrix) lives
// in @broject/rig's convoyPolicy — its tests moved to
// packages/rig/src/policies/convoy.test.ts (bro-u6fp5). This file keeps
// the adapter surface: argv parsing, the work-order prompt, and the
// spawn request.

describe('runArgs', () => {
  test('defaults', () => {
    assert.deepEqual(runArgs(['m-1']), {
      mols: ['m-1'],
      open: false,
      attempts: 4,
      pollSec: 15,
      retryDelaySec: 60,
      json: false,
    });
  });

  test('flags parse — both spellings', () => {
    const a = runArgs([
      'm-1',
      'm-2',
      '--open',
      '--attempts',
      '2',
      '--poll=5',
      '--retry-delay',
      '9',
      '--json',
    ]);
    assert.equal(a.open, true);
    assert.equal(a.attempts, 2);
    assert.equal(a.pollSec, 5);
    assert.equal(a.retryDelaySec, 9);
    assert.equal(a.json, true);
    assert.deepEqual(a.mols, ['m-1', 'm-2']);
  });
});

describe('runnerPrompt', () => {
  test('carries the mol id, repo, and the convoy contract', () => {
    const p = runnerPrompt('bro-mol-x', '/repo/here');
    assert.match(p, /molecule bro-mol-x/);
    assert.match(p, /bro convoy next --mol bro-mol-x/);
    assert.match(p, /\/repo\/here/);
    assert.match(p, /state: complete/);
    assert.match(p, /bro act merge/);
  });

  test('ends with the shared learn+retro closeout (bro-xkv42.1)', () => {
    const p = runnerPrompt('bro-mol-x', '/repo/here');
    assert.ok(p.includes(LEARN_RETRO_CLOSEOUT), 'closeout verbatim');
    assert.ok(p.trimEnd().endsWith(LEARN_RETRO_CLOSEOUT), 'closeout is the last word');
  });
});

describe('runnerSpawnReq', () => {
  test('runner spawns ride the fleet lane — BRO_BATCH marks the spawn so the provider wall and the fleet caps see it', () => {
    const req = runnerSpawnReq('m-1', '/repo', '/repo/.beads');
    assert.equal(req.molStep, 'm-1');
    assert.equal(req.worktree, '/repo');
    assert.equal(req.beadsDir, '/repo/.beads');
    assert.equal(req.lane, 'batch');
    assert.match(req.prompt ?? '', /m-1/);
  });
});
