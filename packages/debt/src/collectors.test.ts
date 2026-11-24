import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  collectCodeScanning,
  collectDependabot,
  collectFailedCi,
  collectSecretScanning,
  collectStalePrs,
  collectSverka,
  importSarifFiles,
  parseSources,
  resolvedThreadIds,
  SourceSkipped,
  sverkaArtifactInScanScope,
  sverkaArtifactOf,
  sverkaFileScope,
  sverkaScanScope,
} from './collectors.ts';
import type { DebtRecord } from './types.ts';

const CTX = { repo: 'acme/widgets', runId: 't', harvestedAt: '2026-01-02T00:00:00Z' };

/** Scripted gh on PATH — answers by argv substring via a JSON map file. */
function withFakeGh(cases: Record<string, string>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-gh-'));
  const mapPath = join(dir, 'map.json');
  writeFileSync(mapPath, JSON.stringify(cases));
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env node',
      'const map = JSON.parse(require("fs").readFileSync(process.env.FAKE_GH_MAP, "utf8"))',
      'const args = process.argv.slice(2).join(" ")',
      'for (const [k, v] of Object.entries(map)) {',
      '  if (args.includes(k)) { console.log(v); process.exit(0) }',
      '}',
      'console.log("[]")',
    ].join('\n')
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const prevPath = process.env.PATH;
  const prevMap = process.env.FAKE_GH_MAP;
  process.env.PATH = `${dir}:${prevPath}`;
  process.env.FAKE_GH_MAP = mapPath;
  try {
    fn();
  } finally {
    process.env.PATH = prevPath;
    if (prevMap === undefined) {
      delete process.env.FAKE_GH_MAP;
    } else {
      process.env.FAKE_GH_MAP = prevMap;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const DEPENDABOT_ALERT = {
  number: 7,
  html_url: 'https://github.com/acme/widgets/security/dependabot/7',
  created_at: '2026-01-01T00:00:00Z',
  dependency: { manifest_path: 'packages/app/package.json' },
  security_vulnerability: {
    severity: 'high',
    package: { name: 'lodash' },
    summary: 'Prototype pollution in lodash',
  },
};

describe('collectDependabot', () => {
  test('open alert → record with source + severity priority', () => {
    withFakeGh({ 'dependabot/alerts': JSON.stringify([DEPENDABOT_ALERT]) }, () => {
      const rows = collectDependabot(CTX);
      assert.equal(rows.length, 1);
      const r = rows[0]!;
      assert.equal(r.thread_id, 'dependabot:7');
      assert.equal(r.source, 'dependabot');
      assert.equal(r.priority, 'blocking');
      assert.equal(r.path, 'packages/app/package.json');
    });
  });

  test('alert with an open dependabot PR is skipped (the PR is the work item)', () => {
    withFakeGh(
      {
        'dependabot/alerts': JSON.stringify([DEPENDABOT_ALERT]),
        'pr list': JSON.stringify([
          { number: 42, headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21', url: 'u' },
        ]),
      },
      () => {
        assert.equal(collectDependabot(CTX).length, 0);
      }
    );
  });

  test('an open PR for a LONGER package name does not suppress this alert', () => {
    const ember = {
      ...DEPENDABOT_ALERT,
      security_vulnerability: {
        ...DEPENDABOT_ALERT.security_vulnerability,
        package: { name: 'ember' },
      },
    };
    withFakeGh(
      {
        'dependabot/alerts': JSON.stringify([ember]),
        // `ember-` is a prefix of `ember-cli` — matching on the raw
        // substring would silence a distinct package's alert
        'pr list': JSON.stringify([
          { number: 43, headRefName: 'dependabot/npm_and_yarn/ember-cli-5.0.0', url: 'u' },
        ]),
      },
      () => {
        assert.equal(collectDependabot(CTX).length, 1);
      }
    );
  });

  test('an open PR for a digit-suffix package name does not suppress this alert', () => {
    const lodash = {
      ...DEPENDABOT_ALERT,
      security_vulnerability: {
        ...DEPENDABOT_ALERT.security_vulnerability,
        package: { name: 'lodash' },
      },
    };
    withFakeGh(
      {
        'dependabot/alerts': JSON.stringify([lodash]),
        // `lodash-` is a prefix of `lodash-2fa` — the digit after the
        // dash is a NAME segment there, not a version start; matching
        // on it would silence a distinct package's alert
        'pr list': JSON.stringify([
          { number: 44, headRefName: 'dependabot/npm_and_yarn/lodash-2fa-1.0.0', url: 'u' },
        ]),
      },
      () => {
        assert.equal(collectDependabot(CTX).length, 1);
      }
    );
  });

  test('medium severity maps to scan priority', () => {
    const a = {
      ...DEPENDABOT_ALERT,
      security_vulnerability: { ...DEPENDABOT_ALERT.security_vulnerability, severity: 'medium' },
    };
    withFakeGh({ 'dependabot/alerts': JSON.stringify([a]) }, () => {
      assert.equal(collectDependabot(CTX)[0]!.priority, 'scan');
    });
  });
});

describe('collectCodeScanning', () => {
  test('open alert maps rule + location', () => {
    const alert = {
      number: 3,
      html_url: 'u',
      created_at: '2026-01-01T00:00:00Z',
      rule: { id: 'js/xss', description: 'XSS sink', severity: 'error' },
      most_recent_instance: { location: { path: 'src/render.ts' } },
    };
    withFakeGh({ 'code-scanning/alerts': JSON.stringify([alert]) }, () => {
      const r = collectCodeScanning(CTX)[0]!;
      assert.equal(r.thread_id, 'code-scanning:3');
      assert.equal(r.priority, 'blocking');
      assert.equal(r.path, 'src/render.ts');
    });
  });
});

describe('collectSecretScanning', () => {
  test('secret alert is always blocking', () => {
    const alert = { number: 1, html_url: 'u', created_at: 'x', secret_type: 'npm' };
    withFakeGh({ 'secret-scanning/alerts': JSON.stringify([alert]) }, () => {
      const r = collectSecretScanning(CTX)[0]!;
      assert.equal(r.priority, 'blocking');
      assert.equal(r.thread_id, 'secret-scanning:1');
    });
  });
});

describe('collectStalePrs', () => {
  const stale = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const fresh = new Date().toISOString();

  test('idle > staleDays → nit row', () => {
    const pr = {
      number: 9,
      title: 'old',
      url: 'u',
      updatedAt: stale,
      isDraft: false,
      statusCheckRollup: [],
    };
    withFakeGh({ 'pr list': JSON.stringify([pr]) }, () => {
      const r = collectStalePrs(CTX, 14)[0]!;
      assert.equal(r.thread_id, 'stale-pr:9');
      assert.equal(r.priority, 'nit');
      assert.match(r.body, /idle \d+d/);
    });
  });

  test('failing checks → blocking even when fresh', () => {
    const pr = {
      number: 10,
      title: 'red',
      url: 'u',
      updatedAt: fresh,
      isDraft: true,
      statusCheckRollup: [{ conclusion: 'FAILURE' }],
    };
    withFakeGh({ 'pr list': JSON.stringify([pr]) }, () => {
      assert.equal(collectStalePrs(CTX, 14)[0]!.priority, 'blocking');
    });
  });

  test('quiet WIP draft is not debt', () => {
    const pr = {
      number: 11,
      title: 'wip',
      url: 'u',
      updatedAt: stale,
      isDraft: true,
      statusCheckRollup: [],
    };
    withFakeGh({ 'pr list': JSON.stringify([pr]) }, () => {
      assert.equal(collectStalePrs(CTX, 14).length, 0);
    });
  });
});

describe('collectFailedCi', () => {
  test('latest default-branch run failed → one stable row', () => {
    withFakeGh(
      {
        'repos/acme/widgets"': '{"default_branch":"main"}',
        'actions/runs': JSON.stringify({
          workflow_runs: [
            { id: 55, name: 'CI', html_url: 'u', conclusion: 'failure', created_at: 'x' },
          ],
        }),
      },
      () => {
        const r = collectFailedCi(CTX)[0]!;
        assert.equal(r.thread_id, 'failed-ci:main');
        assert.equal(r.priority, 'blocking');
      }
    );
  });

  test('green default branch → nothing', () => {
    withFakeGh(
      {
        'repos/acme/widgets"': '{"default_branch":"main"}',
        'actions/runs': JSON.stringify({
          workflow_runs: [
            { id: 55, name: 'CI', html_url: 'u', conclusion: 'success', created_at: 'x' },
          ],
        }),
      },
      () => {
        assert.equal(collectFailedCi(CTX).length, 0);
      }
    );
  });
});

describe('parseSources', () => {
  test('default is review-threads only', () => {
    assert.deepEqual(parseSources(undefined), ['review-threads']);
    assert.deepEqual(parseSources([]), ['review-threads']);
  });
  test('unknown sources drop out', () => {
    assert.deepEqual(parseSources(['dependabot', 'bogus']), ['dependabot']);
    assert.deepEqual(parseSources(['sonarcloud']), ['sonarcloud']);
  });
});

describe('resolvedThreadIds', () => {
  const rec = (id: string, status = 'open'): DebtRecord =>
    ({ thread_id: id, status, source: 'dependabot' }) as DebtRecord;

  test('open row absent from fresh fetch resolves upstream', () => {
    assert.deepEqual(
      resolvedThreadIds([rec('dependabot:1'), rec('dependabot:2')], 'dependabot', [
        rec('dependabot:1'),
      ]),
      ['dependabot:2']
    );
  });

  test('rows of other sources and non-open rows untouched', () => {
    const other = { ...rec('x:1'), source: 'code-scanning' };
    const done = rec('dependabot:3', 'done');
    assert.deepEqual(resolvedThreadIds([other, done], 'dependabot', []), []);
  });
});

describe('collectSverka', () => {
  /** Seed a fresh checkout's `.sverka/artifacts` with `files` (name →
   *  content, or a builder receiving the tmp root), collect, clean up. */
  function sverkaCollect(
    files: Record<string, string> | ((dir: string) => Record<string, string>)
  ): DebtRecord[] {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sverka-'));
    try {
      const artifacts = join(dir, '.sverka', 'artifacts');
      mkdirSync(artifacts, { recursive: true });
      const seeded = typeof files === 'function' ? files(dir) : files;
      for (const [name, content] of Object.entries(seeded)) {
        writeFileSync(join(artifacts, name), content);
      }
      return collectSverka({ repo: 'a/b', runId: 't', harvestedAt: 'x', dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A malformed/incomplete snapshot must throw SourceSkipped — a partial
   *  import reaching the resolve sweep would read as "fixed upstream". */
  function assertSverkaSkipped(files: Record<string, string>): void {
    assert.throws(
      () => sverkaCollect(files),
      (e: unknown) => e instanceof SourceSkipped
    );
  }

  const sarifRun = (tool: string, results: unknown[]): string =>
    JSON.stringify({ runs: [{ tool: { driver: { name: tool } }, results }] });
  const sarifRes = (
    ruleId: string,
    text: string,
    uri: string,
    startLine?: number
  ): Record<string, unknown> => ({
    ruleId,
    message: { text },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }],
  });
  const RESULT = sarifRes('no-unused-vars', 'x is unused', 'src/a.ts', 3);

  test('imports SARIF results with stable thread_id (idempotent)', () => {
    const files = { 'r.sarif': sarifRun('eslint', [RESULT]) };
    const a = sverkaCollect(files);
    const b = sverkaCollect(files);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]!.thread_id, b[0]!.thread_id);
    assert.equal(a[0]!.source, 'sverka');
    assert.equal(a[0]!.path, 'src/a.ts');
    assert.equal(a[0]!.author, 'eslint');
    // identity = repo + tool + rule + artifact + fingerprint
    assert.match(
      a[0]!.thread_id,
      /^sverka:a%2Fb:eslint:no-unused-vars:\.sverka%2Fartifacts%2Fr\.sarif:/
    );
    assert.equal(a[0]!.artifact, '.sverka/artifacts/r.sarif');
    // Local artifact path is provenance, not a navigable URL.
    assert.equal(a[0]!.thread_url, '');
  });

  test('missing artifacts dir skips (no resolve sweep risk)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sverka-empty-'));
    try {
      assert.throws(
        () => collectSverka({ repo: 'a/b', runId: 't', harvestedAt: 'x', dir }),
        (e: unknown) => e instanceof SourceSkipped
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".sverka/findings.sarif — sverka's default output — is swept", () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sverka-findings-'));
    try {
      mkdirSync(join(dir, '.sverka'), { recursive: true });
      writeFileSync(join(dir, '.sverka', 'findings.sarif'), sarifRun('eslint', [RESULT]));
      const rows = collectSverka({ repo: 'a/b', runId: 't', harvestedAt: 'x', dir });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.artifact, '.sverka/findings.sarif');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('artifacts dir without .sarif files skips (empty result would false-resolve)', () => {
    assertSverkaSkipped({ 'notes.txt': 'not sarif' });
  });

  test('invalid SARIF refuses partial snapshot', () => {
    assertSverkaSkipped({ 'bad.sarif': '{not json' });
  });

  test('non-object SARIF JSON skips instead of TypeError', () => {
    assertSverkaSkipped({ 'null.sarif': 'null' });
  });

  test('non-array results value refuses the snapshot instead of dropping findings', () => {
    assertSverkaSkipped({
      'r.sarif': JSON.stringify({
        runs: [{ tool: { driver: { name: 't' } }, results: { bogus: true } }],
      }),
    });
  });

  test('a null run element refuses the snapshot — [] would false-resolve prior findings', () => {
    assertSverkaSkipped({ 'r.sarif': JSON.stringify({ runs: [null] }) });
    assertSverkaSkipped({
      'r.sarif': JSON.stringify({ runs: [{ tool: { driver: { name: 't' } }, results: [] }, 42] }),
    });
  });

  test('a null result element refuses the snapshot — dropping it could resolve its ledger row', () => {
    assertSverkaSkipped({
      'r.sarif': sarifRun('eslint', [RESULT, null]),
    });
    assertSverkaSkipped({
      'r.sarif': sarifRun('eslint', [42]),
    });
  });

  test('identical finding in two SARIF files keeps distinct thread_ids', () => {
    const sarif = sarifRun('eslint', [RESULT]);
    const rows = sverkaCollect({ 'a.sarif': sarif, 'b.sarif': sarif });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.thread_id, rows[1]!.thread_id);
  });

  test('colons inside SARIF fields cannot collide thread_ids', () => {
    // Same file, two runs: naive `tool:ruleId` concat makes 'a'+'b:c' and
    // 'a:b'+'c' identical — percent-encoding keeps the segments unambiguous.
    const sarif = JSON.stringify({
      runs: [
        { tool: { driver: { name: 'a' } }, results: [sarifRes('b:c', 'm', 'f.ts')] },
        { tool: { driver: { name: 'a:b' } }, results: [sarifRes('c', 'm', 'f.ts')] },
      ],
    });
    const rows = sverkaCollect({ 'r.sarif': sarif });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.thread_id, rows[1]!.thread_id);
    assert.match(rows[0]!.thread_id, /^sverka:a%2Fb:a:b%3Ac:/);
    assert.match(rows[1]!.thread_id, /^sverka:a%2Fb:a%3Ab:c:/);
  });

  test('SARIF artifact URIs normalize to checkout-relative paths', () => {
    const rows = sverkaCollect(dir => ({
      'r.sarif': sarifRun('t', [
        sarifRes('R', 'm', `file://${join(dir, 'src', 'a.ts')}`),
        sarifRes('R', 'm', 'src/b%20c.ts'),
      ]),
    }));
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.path, join('src', 'a.ts'));
    assert.equal(rows[1]!.path, 'src/b c.ts');
  });

  test('two runs in same SARIF produce distinct records by fingerprint/location', () => {
    const sarif = JSON.stringify({
      runs: [
        { tool: { driver: { name: 't' } }, results: [sarifRes('R1', 'a', 'f.ts', 1)] },
        { tool: { driver: { name: 't' } }, results: [sarifRes('R2', 'b', 'f.ts', 2)] },
      ],
    });
    const rows = sverkaCollect({ 'r.sarif': sarif });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.thread_id, rows[1]!.thread_id);
  });

  test('a declared fingerprints.primary survives message-wording drift', () => {
    const fp = 'a1b2c3';
    const run1 = sverkaCollect({
      'r.sarif': sarifRun('eslint', [
        {
          ...sarifRes('no-unused-vars', 'x is unused', 'src/a.ts', 3),
          fingerprints: { primary: fp },
        },
      ]),
    });
    // re-run: same finding, upstream reworded the message — the declared
    // fingerprint must pin the same thread_id, not mint a dup.
    const run2 = sverkaCollect({
      'r.sarif': sarifRun('eslint', [
        {
          ...sarifRes('no-unused-vars', "'x' is assigned a value but never used", 'src/a.ts', 3),
          fingerprints: { primary: fp },
        },
      ]),
    });
    assert.equal(run1[0]!.thread_id, run2[0]!.thread_id);
    assert.ok(run1[0]!.thread_id.endsWith(`:${fp}`));
  });

  test('partialFingerprints is the fallback when fingerprints is absent', () => {
    const fp = 'line-hash-1';
    const rows = sverkaCollect({
      'r.sarif': sarifRun('t', [
        { ...sarifRes('R', 'm', 'f.ts', 1), partialFingerprints: { primary: fp, other: 'x' } },
      ]),
    });
    assert.ok(rows[0]!.thread_id.endsWith(`:${fp}`));
  });

  test('a declared fingerprint drops uri/line/message from identity', () => {
    const fp = 'stable-1';
    const rows = sverkaCollect({
      'r.sarif': sarifRun('t', [
        { ...sarifRes('R', 'first wording', 'f.ts', 10), fingerprints: { primary: fp } },
      ]),
    });
    // thread_id = sverka:repo:tool:rule:artifact:fp — exactly 6 segments,
    // the fp tail carrying none of the driftable fields.
    assert.equal(rows[0]!.thread_id.split(':').length, 6);
    assert.ok(rows[0]!.thread_id.endsWith(`:${fp}`));
  });
});

describe('importSarifFiles', () => {
  test('parses every file before returning — one bad file fails the whole set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sverka-import-'));
    try {
      const good = join(dir, 'good.sarif');
      const bad = join(dir, 'bad.sarif');
      writeFileSync(
        good,
        JSON.stringify({ runs: [{ tool: { driver: { name: 't' } }, results: [] }] })
      );
      writeFileSync(bad, '{not json');
      assert.throws(
        () =>
          importSarifFiles({ repo: 'a/b', runId: 'i', harvestedAt: 'x', dir }, dir, [good, bad]),
        (e: unknown) => e instanceof SourceSkipped
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('out-of-root artifacts keep an absolute scope path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sverka-out-'));
    const other = mkdtempSync(join(tmpdir(), 'bro-sverka-art-'));
    try {
      const file = join(other, 'x.sarif');
      writeFileSync(
        file,
        JSON.stringify({
          runs: [
            {
              tool: { driver: { name: 't' } },
              results: [
                {
                  ruleId: 'R',
                  message: { text: 'm' },
                  locations: [{ physicalLocation: { artifactLocation: { uri: 'f.ts' } } }],
                },
              ],
            },
          ],
        })
      );
      const rows = importSarifFiles({ repo: 'a/b', runId: 'i', harvestedAt: 'x', dir }, dir, [
        file,
      ]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.artifact, file.split(sep).join('/'));
      // out-of-scope for the dir-scan — its rows are never closed by it
      assert.equal(sverkaArtifactInScanScope(rows[0]!.artifact), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('sverka resolve scopes', () => {
  const row = (thread_id: string, artifact?: string): DebtRecord =>
    ({
      thread_id,
      status: 'open',
      source: 'sverka',
      ...(artifact !== undefined ? { artifact } : {}),
    }) as DebtRecord;

  test('sverkaArtifactOf prefers the field, falls back to a legacy id segment', () => {
    assert.equal(sverkaArtifactOf(row('x', 'a.sarif')), 'a.sarif');
    const legacy = row(
      `sverka:t:r:${encodeURIComponent('f.ts')}:3:${encodeURIComponent('.sverka/artifacts/old.sarif')}:deadbeef`
    );
    assert.equal(sverkaArtifactOf(legacy), '.sverka/artifacts/old.sarif');
    assert.equal(sverkaArtifactOf(row('dependabot:1')), undefined);
  });

  test('scan scope covers tracked dirs + findings.sarif, deleted files included', () => {
    const inScope = sverkaScanScope();
    assert.equal(inScope(row('x', '.sverka/artifacts/a.sarif')), true);
    assert.equal(inScope(row('x', '.sverka/sarif/b.sarif')), true);
    assert.equal(inScope(row('x', '.sverka/findings.sarif')), true);
    // a deleted artifact's row is still scan-scoped — the sweep owns it
    assert.equal(inScope(row('x', '.sverka/artifacts/gone.sarif')), true);
    assert.equal(inScope(row('x', '/tmp/out.sarif')), false);
    assert.equal(inScope(row('x', 'reports/findings.sarif')), false);
    // a legacy id whose recovered artifact is inside the tracked dirs
    const legacy = `sverka:t:r:u:1:${encodeURIComponent('.sverka/artifacts/old.sarif')}:fp`;
    assert.equal(inScope(row(legacy)), true);
    // unnameable provenance stays scan-born — the dir-scan was the only
    // producer before `debt import` existed
    assert.equal(inScope(row('sverka:3')), true);
  });

  test('file scope is exactly the imported artifacts — other rows untouched', () => {
    const inScope = sverkaFileScope(['a.sarif', 'b.sarif']);
    assert.equal(inScope(row('x', 'a.sarif')), true);
    assert.equal(inScope(row('x', 'b.sarif')), true);
    assert.equal(inScope(row('x', 'c.sarif')), false);
    assert.equal(inScope(row('x')), false);
  });

  test('resolvedThreadIds with a scope never closes out-of-scope rows', () => {
    const existing = [row('sverka:1', 'a.sarif'), row('sverka:2', 'b.sarif'), row('sverka:3')];
    // re-import of a.sarif missing rows 1: only row 1 may resolve —
    // b.sarif's row is a different scope, the unscoped row isn't owned.
    const gone = resolvedThreadIds(existing, 'sverka', [], sverkaFileScope(['a.sarif']));
    assert.deepEqual(gone, ['sverka:1']);
  });
});
