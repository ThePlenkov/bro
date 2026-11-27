import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetVerdict } from './bench-hooks.ts';

describe('bench-hooks floor-relative enforcement', () => {
  it('passes a small overage when it is within the hook margin', () => {
    const verdict = budgetVerdict(
      { key: 'runsh:post-tool', cap: 400 },
      { p50: 319, errors: 0 },
      { p50: 300, errors: 0 }
    );

    assert.equal(verdict.failed, false);
    assert.match(verdict.line, /delta=19ms margin=390ms/);
  });

  it('fails a genuine regression beyond the measured floor margin', () => {
    const verdict = budgetVerdict(
      { key: 'runsh:post-tool', cap: 400 },
      { p50: 700, errors: 0 },
      { p50: 300, errors: 0 }
    );

    assert.equal(verdict.failed, true);
    assert.match(verdict.line, /OVER/);
  });

  it('falls back to the absolute budget without a noop twin', () => {
    const verdict = budgetVerdict(
      { key: 'dist:session-start', cap: 500 },
      { p50: 501, errors: 0 },
      undefined
    );

    assert.equal(verdict.failed, true);
    assert.match(verdict.line, /floor=missing \(absolute fallback\)/);
  });
});
