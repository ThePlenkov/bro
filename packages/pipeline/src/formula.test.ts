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
work     = { done = "review", rate_limited = "route", crash = "retry", stopped = "abandon" }
review   = { skip = "merge", push = "merge", fix = "work", abandon = "abandon" }
merge    = { landed = "capture", blocked = "retry", dropped = "close" }
capture  = { captured = "end" }
`;

/** one-stage formula shell for negative cases */
const oneStage = (stageBody: string, transitions: string) => `
[[stages]]
${stageBody}

[transitions]
${transitions}
`;

const A = 'name = "a"\nengine = "judge"\nverdicts = ["ok"]';

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

  test('a verdict literally named __proto__ lands as data, not a setter', () => {
    const f = parseFormula(
      oneStage(
        'name = "a"\nengine = "judge"\nverdicts = ["ok", "__proto__"]',
        'a = { ok = "end", "__proto__" = "park" }'
      )
    );
    assert.equal(transitionFor(f, 'a', '__proto__'), 'park');
    assert.equal(transitionFor(f, 'a', 'ok'), 'end');
  });
});

describe('invalid formulas — table of rejections', () => {
  const bad: [string, string, RegExp][] = [
    [
      'missing transition for a declared verdict',
      oneStage('name = "a"\nengine = "judge"\nverdicts = ["ok", "bad"]', 'a = { ok = "end" }'),
      /verdict "bad" has no transition/,
    ],
    [
      'stage with no transitions entry',
      `${oneStage(A, 'a = { ok = "b" }')}\n[[stages]]\nname = "b"\nengine = "judge"\nverdicts = ["ok"]`,
      /stage "b" has no entry/,
    ],
    [
      'transition to undeclared stage or bogus action',
      oneStage(A, 'a = { ok = "nowhere" }'),
      /not a stage or terminal action/,
    ],
    [
      'transition keyed by undeclared verdict',
      oneStage(A, 'a = { ok = "end", bogus = "end" }'),
      /not a declared verdict/,
    ],
    [
      'unknown engine',
      oneStage('name = "a"\nengine = "temporal"\nverdicts = ["ok"]', 'a = { ok = "end" }'),
      /expected one of judge\|fleet\|act-gate\|learn/,
    ],
    [
      'gated stage without a skip transition',
      oneStage(
        'name = "a"\nengine = "judge"\ngate_on = "complexity == complex"\nverdicts = ["ok"]',
        'a = { ok = "end" }'
      ),
      /verdict "skip" has no transition/,
    ],
    [
      'skip transition on an ungated stage',
      oneStage(A, 'a = { ok = "end", skip = "end" }'),
      /not a declared verdict/,
    ],
    [
      '"skip" as a declared verdict — reserved',
      oneStage(
        'name = "a"\nengine = "judge"\nverdicts = ["ok", "skip"]',
        'a = { ok = "end", skip = "end" }'
      ),
      /"skip" is reserved/,
    ],
    [
      'unparseable gate_on',
      oneStage(
        'name = "a"\nengine = "judge"\ngate_on = "complexity > 3"\nverdicts = ["ok"]',
        'a = { ok = "end" }'
      ),
      /gate_on: cannot parse/,
    ],
    [
      'stage named after a terminal action — ambiguous targets',
      oneStage('name = "park"\nengine = "judge"\nverdicts = ["ok"]', 'park = { ok = "end" }'),
      /"park" is a reserved terminal action/,
    ],
    [
      'prototype-named stage still needs its transitions entry',
      `${oneStage('name = "toString"\nengine = "judge"\nverdicts = ["ok"]', 'b = { ok = "end" }')}\n[[stages]]\nname = "b"\nengine = "judge"\nverdicts = ["ok"]`,
      /stage "toString" has no entry/,
    ],
    [
      'duplicate stage names',
      `${oneStage(A, 'a = { ok = "end" }')}\n[[stages]]\nname = "a"\nengine = "fleet"\nverdicts = ["ok"]`,
      /duplicate stage name "a"/,
    ],
    [
      'kind must be pipeline when present',
      `kind = "convoy"\n${SPEC_FORMULA}`,
      /kind: expected "pipeline"/,
    ],
    [
      'version pin above latest is rejected',
      `version = 99\n${SPEC_FORMULA.replace('version = 1\n', '')}`,
      /newer than this bro understands/,
    ],
  ];
  for (const [name, toml, re] of bad) {
    test(name, () => assert.throws(() => parseFormula(toml), re));
  }
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
