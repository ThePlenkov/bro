/**
 * Trace-resolver tests (spec bro-7d5nb §traceability) — the verdict
 * matrix over injected seams: stamps parse, the chain resolves
 * (run / session / bead / worktree hints), and every attested hop
 * verifies against the registry — VERIFIED on agreement, FORGED on
 * mismatch or attested-but-unrecorded, MISSING on absence.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKind,
  formulaRef,
  parseTraceStamps,
  prTraceFooter,
  resolveTrace,
  splitFormulaRef,
  TRACE_FOOTER_MARK,
  trailerBlock,
  type TraceDeps,
  type TraceEntryView,
} from './trace.ts';

const SHA = 'f'.repeat(64);
const FORMULA_REF = formulaRef('pipeline', SHA);

const entry = (extra: Partial<TraceEntryView> = {}): TraceEntryView => ({
  agentId: 'ag-1',
  backend: 'native',
  provider: 'devin',
  model: 'swe-2',
  worktree: '/wt/bro--bro-7d5nb.7',
  formula: 'pipeline',
  formula_sha: SHA,
  session_id: 'ses-1',
  pipeline_stage: 'work',
  ...extra,
});

const msg = (trailers: string[], body = 'feat: did the thing'): string =>
  [body, '', ...trailers].join('\n');

const depsOf = (
  reg: Record<string, TraceEntryView>,
  extra: Partial<TraceDeps> = {}
): TraceDeps => ({
  registry: () => reg,
  ...extra,
});

describe('trailerBlock', () => {
  test('reads the trailing trailer block only', () => {
    const t = trailerBlock(
      msg(['BRO-Run: ag-1', `BRO-Formula: ${FORMULA_REF}`, 'BRO-Session: ses-1'])
    );
    assert.deepEqual(t.stamps, {
      run: 'ag-1',
      formula: FORMULA_REF,
      session: 'ses-1',
    });
  });

  test('a BRO-* line mid-body is prose, not a stamp', () => {
    const t = trailerBlock(
      [
        'feat: did the thing',
        '',
        'BRO-Run: fake-run explains the change',
        '',
        'more text here',
      ].join('\n')
    );
    assert.deepEqual(t.stamps, {});
  });

  test('trailer block survives foreign trailers mixed in', () => {
    const t = trailerBlock(
      msg([
        'Agent: devin',
        'Session: ag-1',
        'Signed-off-by: Someone <s@x>',
        'BRO-Formula: ' + FORMULA_REF,
        'BRO-Run: ag-1',
      ])
    );
    assert.equal(t.stamps.run, 'ag-1');
    assert.equal(t.stamps.formula, FORMULA_REF);
    assert.equal(t.session, 'ag-1');
  });

  test('legacy Session/Bead ride along as hints', () => {
    const t = trailerBlock(msg(['Agent: devin', 'Session: ag-9', 'Bead: bro-abc']));
    assert.equal(t.session, 'ag-9');
    assert.equal(t.bead, 'bro-abc');
    assert.deepEqual(t.stamps, {});
  });
});

describe('footer + stamps parse', () => {
  test('prTraceFooter emits the one-line mark and it parses back', () => {
    const line = prTraceFooter({ run: 'ag-1', formula: FORMULA_REF, session: 'ses-1' });
    assert.ok(line.includes(TRACE_FOOTER_MARK));
    assert.equal(line.trim().startsWith('<!--'), true);
    const body = `# What\n\nsome pr text\n\n${line}\n`;
    assert.deepEqual(parseTraceStamps(body, 'pr'), {
      run: 'ag-1',
      formula: FORMULA_REF,
      session: 'ses-1',
    });
  });

  test('whitespace/--> inside values is stripped, never mark-breaking', () => {
    const line = prTraceFooter({ run: 'a b', formula: 'f@x --> trailing', session: 's' });
    assert.deepEqual(parseTraceStamps(line, 'pr'), {
      run: 'ab',
      formula: 'f@xtrailing',
      session: 's',
    });
  });

  test('unknown footer tokens are forward-compat noise', () => {
    assert.deepEqual(
      parseTraceStamps('<!-- bro:trace run=a extra=1 formula=f@x session=s -->', 'pr'),
      { run: 'a', formula: 'f@x', session: 's' }
    );
  });

  test('no mark → empty stamps; commit kind ignores the mark', () => {
    assert.deepEqual(parseTraceStamps('plain body', 'pr'), {});
    assert.deepEqual(
      parseTraceStamps(`<!-- bro:trace run=a formula=f@x session=s -->`, 'commit'),
      {}
    );
  });
});

describe('formulaRef / splitFormulaRef', () => {
  test('round-trips; splits at the last @', () => {
    assert.deepEqual(splitFormulaRef(FORMULA_REF), { id: 'pipeline', sha: SHA });
    assert.deepEqual(splitFormulaRef('a@b@sha'), { id: 'a@b', sha: 'sha' });
    assert.equal(splitFormulaRef('noatsign'), undefined);
    assert.equal(splitFormulaRef('@sha'), undefined);
    assert.equal(splitFormulaRef('id@'), undefined);
  });
});

describe('detectKind', () => {
  test('PR-shaped refs detect pr, everything else commit', () => {
    assert.equal(detectKind('42'), 'pr');
    assert.equal(detectKind('#42'), 'pr');
    assert.equal(detectKind('https://github.com/o/r/pull/42'), 'pr');
    assert.equal(detectKind('https://gl/o/r/-/merge_requests/42'), 'pr');
    assert.equal(detectKind('work/bro-x'), 'commit');
    assert.equal(detectKind('deadbeef'), 'commit');
  });
});

describe('resolveTrace — commit', () => {
  const stamped = msg(['BRO-Run: ag-1', `BRO-Formula: ${FORMULA_REF}`, 'BRO-Session: ses-1']);

  test('VERIFIED when the registry agrees on every attested hop', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf({ 'bro-7d5nb.7': entry() }, { commitMessage: () => stamped }),
      'commit'
    );
    assert.equal(t.verdict, 'verified');
    assert.equal(t.agent, 'ag-1');
    assert.equal(t.provider, 'devin');
    assert.equal(t.model, 'swe-2');
    assert.equal(t.session, 'ses-1');
    assert.equal(t.formula, FORMULA_REF);
    assert.equal(t.pipelineStage, 'work');
    assert.equal(t.molStep, 'bro-7d5nb.7');
    assert.equal(t.via, 'run');
    assert.deepEqual(
      t.hops.map(h => h.state),
      ['match', 'match', 'match']
    );
  });

  test('FORGED on a formula mismatch', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf(
        { 'bro-x': entry() },
        {
          commitMessage: () =>
            msg(['BRO-Run: ag-1', `BRO-Formula: other@${'0'.repeat(64)}`, 'BRO-Session: ses-1']),
        }
      ),
      'commit'
    );
    assert.equal(t.verdict, 'forged');
    const hop = t.hops.find(h => h.hop === 'formula')!;
    assert.equal(hop.state, 'mismatch');
    assert.equal(hop.registry, FORMULA_REF);
  });

  test('FORGED when the trailer names another agent', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf(
        { 'bro-a': entry({ agentId: 'ag-2', session_id: 'ag-2' }) },
        {
          commitMessage: () =>
            msg(['BRO-Run: ag-1', `BRO-Formula: ${FORMULA_REF}`, 'BRO-Session: ag-2']),
        }
      ),
      'commit'
    );
    // run resolves ag-1 → the ag-1 entry — wait: only one entry exists
    // (ag-2) and stamps.run names ag-1 which isn't in the registry;
    // the session hint resolves instead
    assert.equal(t.via, 'session');
    assert.equal(t.verdict, 'forged');
    assert.equal(t.hops.find(h => h.hop === 'run')!.state, 'mismatch');
  });

  test('attested run resolves no entry → MISSING (unbacked attestation)', () => {
    const t = resolveTrace('deadbeef', depsOf({}, { commitMessage: () => stamped }), 'commit');
    assert.equal(t.verdict, 'missing');
    assert.match(t.detail!, /unbacked attestation/);
    assert.equal(t.agent, undefined);
  });

  test('a formula stamp against a formula-less entry is forged-by-absence', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf(
        { 'bro-x': entry({ formula: undefined, formula_sha: undefined }) },
        { commitMessage: () => stamped }
      ),
      'commit'
    );
    assert.equal(t.verdict, 'forged');
    const hop = t.hops.find(h => h.hop === 'formula')!;
    assert.equal(hop.state, 'mismatch');
    assert.equal(hop.registry, undefined);
  });

  test('session hop accepts the agentId pin when no session fields are recorded', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf(
        {
          'bro-x': entry({ session_id: undefined, sessionId: undefined, acpSessionId: undefined }),
        },
        {
          commitMessage: () =>
            msg(['BRO-Run: ag-1', `BRO-Formula: ${FORMULA_REF}`, 'BRO-Session: ag-1']),
        }
      ),
      'commit'
    );
    assert.equal(t.verdict, 'verified');
    assert.equal(t.hops.find(h => h.hop === 'session')!.state, 'match');
  });

  test('backend session ids count as recorded sessions', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf(
        { 'bro-x': entry({ session_id: undefined, acpSessionId: 'acp-77' }) },
        {
          commitMessage: () =>
            msg(['BRO-Run: ag-1', `BRO-Formula: ${FORMULA_REF}`, 'BRO-Session: acp-77']),
        }
      ),
      'commit'
    );
    assert.equal(t.hops.find(h => h.hop === 'session')!.state, 'match');
  });

  test('a session the registry never recorded is forged', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf(
        { 'bro-x': entry() },
        {
          commitMessage: () =>
            msg(['BRO-Run: ag-1', `BRO-Formula: ${FORMULA_REF}`, 'BRO-Session: bogus']),
        }
      ),
      'commit'
    );
    assert.equal(t.verdict, 'forged');
    assert.equal(t.hops.find(h => h.hop === 'session')!.state, 'mismatch');
  });

  test('no stamps but a legacy Session/Bead hint resolves registry-only → MISSING', () => {
    const t = resolveTrace(
      'deadbeef',
      depsOf(
        { 'bro-abc': entry({ session_id: undefined }) },
        { commitMessage: () => msg(['Agent: devin', 'Session: ag-1', 'Bead: bro-abc']) }
      ),
      'commit'
    );
    assert.equal(t.verdict, 'missing');
    assert.match(t.detail!, /registry-only resolution/);
    assert.equal(t.molStep, 'bro-abc');
    assert.equal(t.agent, 'ag-1');
  });

  test('no stamps and nothing resolves → MISSING', () => {
    const t = resolveTrace('deadbeef', depsOf({}, { commitMessage: () => msg([]) }), 'commit');
    assert.equal(t.verdict, 'missing');
    assert.equal(t.hops.length, 0);
  });
});

describe('resolveTrace — branch', () => {
  test('branch → worktree → registry: VERIFIED against the tip commit trailers', () => {
    const t = resolveTrace(
      'work/bro-7d5nb.7',
      depsOf(
        { 'bro-7d5nb.7': entry() },
        {
          worktrees: () => [{ path: '/wt/bro--bro-7d5nb.7', branch: 'work/bro-7d5nb.7' }],
          commitMessage: () =>
            msg(['BRO-Run: ag-1', `BRO-Formula: ${FORMULA_REF}`, 'BRO-Session: ses-1']),
        }
      ),
      'branch'
    );
    assert.equal(t.verdict, 'verified');
    assert.equal(t.via, 'worktree');
    assert.equal(t.molStep, 'bro-7d5nb.7');
  });

  test('tip trailers claiming another run read FORGED against the worktree entry', () => {
    const t = resolveTrace(
      'work/bro-7d5nb.7',
      depsOf(
        { 'bro-7d5nb.7': entry() },
        {
          worktrees: () => [{ path: '/wt/bro--bro-7d5nb.7', branch: 'work/bro-7d5nb.7' }],
          commitMessage: () => msg(['BRO-Run: ag-9', 'BRO-Session: ag-9']),
        }
      ),
      'branch'
    );
    assert.equal(t.verdict, 'forged');
    assert.equal(t.hops.find(h => h.hop === 'run')!.state, 'mismatch');
  });

  test('a branch whose worktree the registry does not know → MISSING', () => {
    const t = resolveTrace(
      'work/ghost',
      depsOf(
        {},
        {
          worktrees: () => [{ path: '/wt/ghost', branch: 'work/ghost' }],
          commitMessage: () => msg([]),
        }
      ),
      'branch'
    );
    assert.equal(t.verdict, 'missing');
  });
});

describe('resolveTrace — pr', () => {
  const body = (stamps?: string) => `# What\n\nnotes\n\n${stamps ?? ''}`;
  const footer = prTraceFooter({ run: 'ag-1', formula: FORMULA_REF, session: 'ses-1' });

  test('VERIFIED when the footer matches the registry', () => {
    const t = resolveTrace(
      '42',
      depsOf(
        { 'bro-7d5nb.7': entry() },
        { prView: () => ({ body: body(footer), headRefName: 'work/bro-7d5nb.7' }) }
      ),
      'pr'
    );
    assert.equal(t.verdict, 'verified');
    assert.equal(t.agent, 'ag-1');
    assert.equal(t.molStep, 'bro-7d5nb.7');
  });

  test('footer naming another run is FORGED', () => {
    const t = resolveTrace(
      '42',
      depsOf(
        { 'bro-7d5nb.7': entry() },
        {
          prView: () => ({
            body: body(prTraceFooter({ run: 'ag-1', formula: `x@${SHA}`, session: 'ses-1' })),
            headRefName: 'work/bro-7d5nb.7',
          }),
        }
      ),
      'pr'
    );
    assert.equal(t.verdict, 'forged');
  });

  test('no footer → MISSING even when the head worktree resolves', () => {
    const t = resolveTrace(
      '42',
      depsOf(
        { 'bro-7d5nb.7': entry() },
        {
          prView: () => ({ body: body(), headRefName: 'work/bro-7d5nb.7' }),
          worktrees: () => [{ path: '/wt/bro--bro-7d5nb.7', branch: 'work/bro-7d5nb.7' }],
        }
      ),
      'pr'
    );
    // the head branch's worktree still resolves the record — the
    // missing verdict is about the absent stamps
    assert.equal(t.verdict, 'missing');
    assert.equal(t.agent, 'ag-1');
    assert.equal(t.via, 'worktree');
  });

  test('unreadable pr view → MISSING', () => {
    const t = resolveTrace('42', depsOf({}, { prView: () => undefined }), 'pr');
    assert.equal(t.verdict, 'missing');
  });
});

describe('kind probing', () => {
  test('deps.kind wins over the lexical fallback', () => {
    const t = resolveTrace(
      'work/bro-x',
      depsOf(
        { 'bro-x': entry() },
        {
          kind: () => 'branch',
          worktrees: () => [{ path: '/wt/bro--bro-7d5nb.7', branch: 'work/bro-x' }],
        }
      )
    );
    assert.equal(t.kind, 'branch');
    assert.equal(t.molStep, 'bro-x');
  });
});
