import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  DEAD_LOOP_REPEAT,
  deadLoopMarkerExists,
  deadLoopPostTool,
  deadLoopPreTool,
  deadSignature,
  trailingLoop,
} from './deadloop.ts';
import { journalTrace } from './hooks.ts';
import { git, initRepo, insideAsync } from './testrepo.ts';

const BASH = { tool_name: 'Bash', tool_input: { command: 'npm test' } };
const BASH2 = { tool_name: 'Bash', tool_input: { command: 'npm run build' } };
const EDIT = { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } };

function markerFile(main: string, session: string): string {
  const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim());
  return join(common, 'bro', 'hooks', 'trace', `${session}.deadloop.json`);
}

describe('deadloop', () => {
  test('signature: command whitespace collapses, paths sort, tool prefixes', () => {
    assert.equal(
      deadSignature({ tool_name: 'Bash', tool_input: { command: 'a  b\tc' } }),
      deadSignature({ tool_name: 'Bash', tool_input: { command: 'a b c' } })
    );
    assert.notEqual(
      deadSignature({ tool_name: 'Bash', tool_input: { command: 'a' } }),
      deadSignature({ tool_name: 'Bash', tool_input: { command: 'b' } })
    );
    assert.notEqual(deadSignature(BASH), deadSignature(EDIT));
    // file_path lands in the detail slot for edit-family tools
    assert.match(deadSignature(EDIT), /^Edit\|src\/a\.ts$/);
  });

  test('trailingLoop counts only the identical tail run', async () => {
    const { root, main } = initRepo('bro-deadloop-tail-');
    await insideAsync(main, root, async () => {
      for (let i = 0; i < DEAD_LOOP_REPEAT - 1; i++) journalTrace(BASH, 's1');
      journalTrace(BASH2, 's1');
      journalTrace(BASH, 's1');
      // run of 1 at the tail — under threshold
      assert.equal(trailingLoop(main, 's1'), null);
      for (let i = 0; i < DEAD_LOOP_REPEAT - 1; i++) journalTrace(BASH, 's1');
      const loop = trailingLoop(main, 's1');
      assert.ok(loop);
      assert.equal(loop.count, DEAD_LOOP_REPEAT);
      assert.match(loop.signature, /^Bash\|npm test$/);
    });
  });

  test('post-tool arms marker + warns once; pre-tool vetoes the same signature only', async () => {
    const { root, main } = initRepo('bro-deadloop-gate-');
    await insideAsync(main, root, async () => {
      for (let i = 0; i < DEAD_LOOP_REPEAT; i++) journalTrace(BASH, 's2');
      const warn = deadLoopPostTool(main, 's2', BASH);
      assert.equal(warn.length, 1);
      assert.match(warn[0] as string, /dead loop detected/);
      assert.ok(deadLoopMarkerExists(main, 's2'));
      assert.ok(existsSync(markerFile(main, 's2')));

      // the gate: same signature → veto; anything else → pass
      const veto = deadLoopPreTool(main, 's2', BASH);
      assert.ok(veto);
      assert.match(veto as string, /dead loop gate/);
      assert.equal(deadLoopPreTool(main, 's2', BASH2), null);
      assert.equal(deadLoopPreTool(main, 's2', EDIT), null);

      // second post-tool on the same loop does not re-warn
      journalTrace(BASH, 's2');
      assert.deepEqual(deadLoopPostTool(main, 's2', BASH), []);
    });
  });

  test('under threshold: no marker, no veto, no warning', async () => {
    const { root, main } = initRepo('bro-deadloop-under-');
    await insideAsync(main, root, async () => {
      for (let i = 0; i < DEAD_LOOP_REPEAT - 1; i++) journalTrace(BASH, 's3');
      assert.deepEqual(deadLoopPostTool(main, 's3', BASH), []);
      assert.equal(deadLoopPreTool(main, 's3', BASH), null);
      assert.equal(deadLoopMarkerExists(main, 's3'), false);
    });
  });

  test('journal tail and live payload must agree — foreign repeats do not arm', async () => {
    const { root, main } = initRepo('bro-deadloop-foreign-');
    await insideAsync(main, root, async () => {
      for (let i = 0; i < DEAD_LOOP_REPEAT; i++) journalTrace(BASH, 's4');
      // the live event is a DIFFERENT call — the loop belongs to
      // whatever wrote those journal lines, not this session's action
      assert.deepEqual(deadLoopPostTool(main, 's4', BASH2), []);
      assert.equal(deadLoopPreTool(main, 's4', BASH), null);
    });
  });

  test('expired marker does not veto; fresh marker does', async () => {
    const { root, main } = initRepo('bro-deadloop-ttl-');
    await insideAsync(main, root, async () => {
      for (let i = 0; i < DEAD_LOOP_REPEAT; i++) journalTrace(BASH, 's5');
      deadLoopPostTool(main, 's5', BASH);
      const marker = JSON.parse(readFileSync(markerFile(main, 's5'), 'utf8')) as {
        ts: number;
      };
      // age the marker past the TTL
      const aged = { ...marker, ts: Date.now() - 16 * 60_000 };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(markerFile(main, 's5'), `${JSON.stringify(aged)}\n`);
      assert.equal(deadLoopPreTool(main, 's5', BASH), null);
    });
  });
});
