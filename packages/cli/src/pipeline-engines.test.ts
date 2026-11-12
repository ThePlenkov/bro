/** `engines(dir)` production-map tests (specs/bro-qjji2.10.md §engine
 *  map): the factory binds all seven slots the contract formula uses,
 *  the judge slot is a stageDispatch (invoke + the safe recheck), the
 *  accept/fleet/act-gate/learn seams are the stage factories over their
 *  production deps, and building the map in a bare checkout does not
 *  require a configured judge or review connector (both resolve lazily
 *  on first use). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EngineHandler, EngineMap } from '@broject/pipeline';
import { engines } from './pipeline-engines.ts';
import { initRepo, inside } from './commands/testrepo.ts';

const SLOTS = ['judge', 'intake', 'fleet', 'e2e', 'accept', 'act-gate', 'learn'] as const;

/** An EngineMap value is an invoke-only EngineFn or an EngineHandler —
 *  normalize to the handler shape for assertions. */
function asHandler(v: EngineMap[keyof EngineMap]): EngineHandler {
  if (typeof v === 'function') {
    return { invoke: v };
  }
  assert.ok(v !== undefined && typeof v === 'object', 'engine slot must be bound');
  return v as EngineHandler;
}

describe('production engines(dir)', () => {
  test('binds all seven slots the contract formula uses', () => {
    const { root, main } = initRepo('bro-engines-map-');
    inside(main, root, () => {
      const map = engines(main);
      for (const slot of SLOTS) {
        assert.ok(map[slot] !== undefined, `engine slot "${slot}" must be bound`);
        const h = asHandler(map[slot]);
        assert.equal(typeof h.invoke, 'function', `${slot}.invoke must be a function`);
      }
    });
  });

  test('the judge slot is a stageDispatch — invoke AND the safe recheck', () => {
    const { root, main } = initRepo('bro-engines-judge-');
    inside(main, root, () => {
      const map = engines(main);
      const judge = asHandler(map.judge);
      // stageDispatch always binds recheck — the conservative park for
      // spawn-like intents and bounded re-fire for read intents
      assert.equal(typeof judge.recheck, 'function', 'judge.recheck must be bound');
    });
  });

  test('the single-stage slots are EngineHandlers over their factories', () => {
    const { root, main } = initRepo('bro-engines-slots-');
    inside(main, root, () => {
      const map = engines(main);
      // intake/verify/accept/act-gate/capture stage factories return
      // EngineHandler — invoke present on each
      for (const slot of ['intake', 'e2e', 'accept', 'act-gate', 'learn', 'fleet'] as const) {
        const h = asHandler(map[slot]);
        assert.equal(typeof h.invoke, 'function', `${slot}.invoke must be a function`);
      }
    });
  });

  test('building the map needs no judge or review connector configured', () => {
    const { root, main } = initRepo('bro-engines-lazy-');
    inside(main, root, () => {
      // a bare checkout has no connectors.judge/reviews — the lazy seams
      // must not resolve them at map-build time
      assert.doesNotThrow(() => engines(main));
    });
  });

  test('admitIntents and formula provenance options are accepted', () => {
    const { root, main } = initRepo('bro-engines-opts-');
    inside(main, root, () => {
      const map = engines(main, {
        formula: 'test-formula',
        formulaSha: 'abc123',
        admitIntents: ['spawn', 'gate'],
      });
      assert.ok(map.judge !== undefined);
    });
  });
});
