/** `bro trace <ref>` — CLI-half tests: arg parsing, the human report's
 *  shape, and real-git kind detection. Resolution/verdict mechanics
 *  live in @broject/pipeline's trace.test.ts. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceStamps, type ArtifactTrace } from '@broject/pipeline';
import {
  detectRefKind,
  formatTrace,
  maybeSpawnTraceStamp,
  parseResolveArgs,
  stampBranchPr,
} from './trace-resolve.ts';
import { git, initRepo, inside } from './testrepo.ts';

describe('parseResolveArgs', () => {
  test('bare ref parses; flags pull out cleanly', () => {
    assert.deepEqual(parseResolveArgs(['deadbeef']), {
      ref: 'deadbeef',
      kind: undefined,
      json: false,
    });
    assert.deepEqual(parseResolveArgs(['--kind', 'branch', 'work/x', '--json']), {
      ref: 'work/x',
      kind: 'branch',
      json: true,
    });
  });

  test('a dangling --kind, a flag-shaped ref, or extra positionals fail', () => {
    assert.equal(parseResolveArgs(['--kind']), null);
    assert.equal(parseResolveArgs(['--kind', 'bogus', 'x']), null);
    assert.equal(parseResolveArgs(['-x']), null);
    assert.equal(parseResolveArgs(['a', 'b']), null);
    assert.equal(parseResolveArgs([]), null);
  });
});

describe('formatTrace', () => {
  const base: ArtifactTrace = {
    ref: 'deadbeef',
    kind: 'commit',
    verdict: 'verified',
    stamps: { run: 'ag-1', formula: 'pipe@f00', session: 'ses-1' },
    hops: [
      { hop: 'run', state: 'match', attested: 'ag-1', registry: 'ag-1' },
      { hop: 'formula', state: 'match', attested: 'pipe@f00', registry: 'pipe@f00' },
      { hop: 'session', state: 'match', attested: 'ses-1', registry: 'ses-1' },
    ],
    molStep: 'bro-x',
    agent: 'ag-1',
    provider: 'devin',
    model: 'swe-2',
    session: 'ses-1',
    formula: 'pipe@f00',
    pipelineStage: 'work',
    worktree: '/wt/x',
    backend: 'native',
    via: 'BRO-Run',
    detail: 'registry agrees on every attested hop',
  };

  test('VERIFIED report carries the resolved chain and hop marks', () => {
    const out = formatTrace(base);
    assert.ok(out.startsWith('VERIFIED  deadbeef (commit)'));
    assert.match(out, /agent\s+ag-1/);
    assert.match(out, /formula\s+pipe@f00/);
    assert.match(out, /mol step\s+bro-x/);
    assert.match(out, /✓ run\s+ag-1 — registry agrees/);
    assert.match(out, /stage\s+work/);
  });

  test('FORGED names the disagreeing hop with both values', () => {
    const out = formatTrace({
      ...base,
      verdict: 'forged',
      hops: [
        { hop: 'run', state: 'mismatch', attested: 'ag-9', registry: 'ag-1' },
        { hop: 'formula', state: 'match', attested: 'pipe@f00', registry: 'pipe@f00' },
        { hop: 'session', state: 'unattested' },
      ],
      detail: 'attestation disagrees with the registry',
    });
    assert.ok(out.startsWith('FORGED'));
    assert.match(out, /✗ run\s+ag-9 — registry says ag-1/);
    assert.match(out, /· session\s+— — not attested/);
  });

  test('MISSING prints what resolved and why', () => {
    const out = formatTrace({
      ref: 'abc',
      kind: 'commit',
      verdict: 'missing',
      stamps: {},
      hops: [],
      detail: 'no trace stamps and no registry record resolved',
    });
    assert.ok(out.startsWith('MISSING'));
    assert.match(out, /no trace stamps/);
    assert.doesNotMatch(out, /hops:/);
  });
});

describe('stampBranchPr', () => {
  const env = {
    BRO_AGENT_ID: 'ag-1',
    BRO_FORMULA: `pipeline@${'f'.repeat(64)}`,
    BRO_SESSION_ID: 'ses-1',
  };
  const ok = (out: string) => ({ code: 0, out, err: '' });
  const no = () => ({ code: 1, out: '', err: 'no' });

  test('missing pins → unattested; gh is never touched', () => {
    let calls = 0;
    const gh = () => {
      calls++;
      return ok('{}');
    };
    assert.equal(stampBranchPr('/x', {}, gh), 'unattested');
    assert.equal(stampBranchPr('/x', { BRO_FORMULA: 'f@x' }, gh), 'unattested');
    assert.equal(stampBranchPr('/x', { BRO_AGENT_ID: 'a' }, gh), 'unattested');
    assert.equal(calls, 0);
  });

  test('appends the footer once; the mark makes a second run a no-op', () => {
    let body = '# What\n\nsome pr text\n';
    const gh = (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return ok(JSON.stringify({ body }));
      }
      if (args[0] === 'pr' && args[1] === 'edit') {
        body = args[args.indexOf('--body') + 1]!;
        return ok('');
      }
      return no();
    };
    assert.equal(stampBranchPr('/x', env, gh), 'stamped');
    const t = parseTraceStamps(body, 'pr');
    assert.equal(t.run, 'ag-1');
    assert.equal(t.formula, env.BRO_FORMULA);
    assert.equal(t.session, 'ses-1');
    assert.match(body, /some pr text\n\n<!-- bro:trace/);
    assert.equal(stampBranchPr('/x', env, gh), 'skipped');
  });

  test('session falls back to the run id when BRO_SESSION_ID is absent', () => {
    let body = 'text';
    const gh = (args: string[]) => {
      if (args[1] === 'view') {
        return ok(JSON.stringify({ body }));
      }
      body = args[args.indexOf('--body') + 1]!;
      return ok('');
    };
    const { BRO_SESSION_ID: _s, ...pins } = env;
    assert.equal(stampBranchPr('/x', pins, gh), 'stamped');
    assert.equal(parseTraceStamps(body, 'pr').session, 'ag-1');
  });

  test('no PR, a torn view, or a failed edit → skipped (never thrown)', () => {
    assert.equal(
      stampBranchPr('/x', env, () => no()),
      'skipped'
    );
    assert.equal(
      stampBranchPr('/x', env, () => ok('not json')),
      'skipped'
    );
    const calls: string[] = [];
    const gh = (args: string[]) => {
      calls.push(args.join(' '));
      return args[1] === 'view' ? ok('{"body":"x"}') : no();
    };
    assert.equal(stampBranchPr('/x', env, gh), 'skipped');
    assert.ok(calls.some(c => c.startsWith('pr edit')));
  });
});

describe('maybeSpawnTraceStamp', () => {
  test('the formula pin gates the spawn; entry + dir reach spawnFn', () => {
    const spawned: string[] = [];
    const spy = (entry: string, dir: string) => {
      spawned.push(`${entry}|${dir}`);
    };
    maybeSpawnTraceStamp('/w', {}, spy);
    maybeSpawnTraceStamp('/w', { BRO_FORMULA: '  ' }, spy);
    assert.deepEqual<string[]>(spawned, []);
    maybeSpawnTraceStamp('/w', { BRO_FORMULA: 'f@x' }, spy);
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0]!.endsWith('|/w'));
  });
});

describe('detectRefKind', () => {
  test('local branch beats commit-ish; unresolvable refs stay undefined', () => {
    const { root, main } = initRepo('bro-trace-');
    inside(main, root, () => {
      git(['branch', 'work/bro-x'], main);
      assert.equal(detectRefKind(main, 'work/bro-x'), 'branch');
      assert.equal(detectRefKind(main, 'HEAD'), 'commit');
      assert.equal(detectRefKind(main, 'definitely-not-a-ref-xyz'), undefined);
    });
  });
});
