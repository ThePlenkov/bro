import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parse } from 'smol-toml';
import {
  entryStage,
  formulaSha,
  isTerminalAction,
  loadPipelineFormula,
  parsePipelineFormula,
  transitionFor,
} from './formula.ts';

const parseFormula = (toml: string) => parsePipelineFormula(parse(toml));

/** the spec's own example — this is also the spec-conformance test */
const SPEC_FORMULA = `
version = 1

[[stages]]
name = "classify"
engine = "judge"
verdicts = ["solo", "clump", "duplicate", "defer"]

[[stages]]
name = "route"
engine = "judge"
verdicts = ["spawn", "queue", "defer"]

[[stages]]
name = "work"
engine = "fleet"
verdicts = ["done", "rate_limited", "crash", "stopped"]

[[stages]]
name = "review"
engine = "judge"
gate_on = "complexity == complex"
verdicts = ["push", "fix", "abandon"]

[[stages]]
name = "merge"
engine = "act-gate"
verdicts = ["landed", "blocked", "dropped"]

[[stages]]
name = "capture"
engine = "learn"
mode = "always-capture"
verdicts = ["captured"]

[transitions]
classify = { solo = "route", clump = "route", duplicate = "close", defer = "park" }
route    = { spawn = "work", queue = "park", defer = "park" }
work     = { done = "review", rate_limited = "park", crash = "retry", stopped = "abandon" }
review   = { skip = "merge", push = "merge", fix = "work", abandon = "close" }
merge    = { landed = "capture", blocked = "retry", dropped = "close" }
capture  = { captured = "end" }
`;

describe('parsePipelineFormula', () => {
  test('parses the spec formula — 6 stages, gate_on, full transitions', () => {
    const f = parseFormula(SPEC_FORMULA);
    assert.equal(f.stages.length, 6);
    assert.deepEqual(
      f.stages.map(s => s.name),
      ['classify', 'route', 'work', 'review', 'merge', 'capture']
    );
    assert.deepEqual(f.stages[3].gate_on, {
      field: 'complexity',
      op: '==',
      value: 'complex',
    });
    assert.equal(f.stages[5].mode, 'always-capture');
    assert.equal(transitionFor(f, 'work', 'crash'), 'retry');
    assert.equal(transitionFor(f, 'review', 'push'), 'merge');
    assert.equal(transitionFor(f, 'review', 'skip'), 'merge');
    assert.equal(transitionFor(f, 'capture', 'captured'), 'end');
    assert.ok(isTerminalAction('park'));
    assert.ok(!isTerminalAction('work'));
    assert.equal(entryStage(f).name, 'classify');
  });

  test('missing transition for a declared verdict fails', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
verdicts = ["ok", "bad"]

[transitions]
a = { ok = "end" }
`),
      /verdict "bad" has no transition/
    );
  });

  test('stage with no transitions entry fails', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
verdicts = ["ok"]

[[stages]]
name = "b"
engine = "judge"
verdicts = ["ok"]

[transitions]
a = { ok = "b" }
`),
      /stage "b" has no entry/
    );
  });

  test('transition to undeclared stage or bogus action fails', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
verdicts = ["ok"]

[transitions]
a = { ok = "nowhere" }
`),
      /not a stage or terminal action/
    );
  });

  test('transition keyed by undeclared verdict fails', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
verdicts = ["ok"]

[transitions]
a = { ok = "end", bogus = "end" }
`),
      /not a declared verdict/
    );
  });

  test('unknown engine fails', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "temporal"
verdicts = ["ok"]

[transitions]
a = { ok = "end" }
`),
      /expected one of judge\|fleet\|act-gate\|learn/
    );
  });

  test('gated stage without a skip transition fails', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
gate_on = "complexity == complex"
verdicts = ["ok"]

[transitions]
a = { ok = "end" }
`),
      /verdict "skip" has no transition/
    );
  });

  test('skip transition on an ungated stage fails', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
verdicts = ["ok"]

[transitions]
a = { ok = "end", skip = "end" }
`),
      /not a declared verdict/
    );
  });

  test('"skip" as a declared verdict fails — reserved', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
verdicts = ["ok", "skip"]

[transitions]
a = { ok = "end", skip = "end" }
`),
      /"skip" is reserved/
    );
  });

  test('unparseable gate_on fails with a helpful message', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
gate_on = "complexity > 3"
verdicts = ["ok"]

[transitions]
a = { ok = "end" }
`),
      /gate_on: cannot parse/
    );
  });

  test('stage named after a terminal action fails — ambiguous targets', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "park"
engine = "judge"
verdicts = ["ok"]

[transitions]
park = { ok = "end" }
`),
      /"park" is a reserved terminal action/
    );
  });

  test('prototype-named stage still needs its transitions entry', () => {
    // `toString` passes `in` checks on plain objects — hasOwn is the guard
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "toString"
engine = "judge"
verdicts = ["ok"]

[[stages]]
name = "b"
engine = "judge"
verdicts = ["ok"]

[transitions]
b = { ok = "end" }
`),
      /stage "toString" has no entry/
    );
  });

  test('duplicate stage names fail', () => {
    assert.throws(
      () =>
        parseFormula(`
[[stages]]
name = "a"
engine = "judge"
verdicts = ["ok"]

[[stages]]
name = "a"
engine = "fleet"
verdicts = ["ok"]

[transitions]
a = { ok = "end" }
`),
      /duplicate stage name "a"/
    );
  });

  test('kind must be pipeline when present', () => {
    assert.throws(
      () => parseFormula(`kind = "convoy"\n${SPEC_FORMULA}`),
      /kind: expected "pipeline"/
    );
  });

  test('version pin above latest is rejected', () => {
    assert.throws(
      () => parseFormula(`version = 99\n${SPEC_FORMULA.replace('version = 1\n', '')}`),
      /newer than this bro understands/
    );
  });
});

describe('formulaSha', () => {
  test('sha256 over raw bytes — formatting is identity', () => {
    // pinned digest: catches a hash-algorithm regression
    assert.equal(
      formulaSha('x = 1\n'),
      '9e26bf369911c45c243c684147b23fc9e1dcfcf257d299a1c632016a6fcd33f4'
    );
    const b = formulaSha('x = 1\n# comment\n');
    assert.notEqual(formulaSha('x = 1\n'), b); // a comment IS a version delta
  });

  test('raw bytes hash — invalid UTF-8 stays a distinct identity', () => {
    const bytes = Buffer.from([0x78, 0x20, 0x3d, 0x20, 0x31, 0xff, 0x0a]); // 'x = 1\xff\n'
    const sha = formulaSha(bytes);
    assert.equal(sha, '7ba66a0528cbab29a35563dfedf5fe3c244cea588545a47be93987e2f42e532d');
    // decoded text collapses 0xff to U+FFFD — a different input
    assert.notEqual(sha, formulaSha(bytes.toString('utf8')));
  });
});

describe('loadPipelineFormula', () => {
  test('reads + validates + stamps sha', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
    const file = join(dir, 'f.toml');
    writeFileSync(file, SPEC_FORMULA);
    const { formula, sha } = loadPipelineFormula(file);
    assert.equal(formula.stages.length, 6);
    assert.equal(sha, formulaSha(SPEC_FORMULA));
  });

  test('unreadable file errors with the path', () => {
    assert.throws(
      () => loadPipelineFormula('/nonexistent/f.toml'),
      /\/nonexistent\/f\.toml: cannot read formula/
    );
  });
});
