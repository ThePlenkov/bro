import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates } from './candidates.ts';
import { isRepoRelativePath, matchGlob } from './glob.ts';
import { routeTable } from './schema.ts';
import type { RouteTable } from './types.ts';

/** A table exercising every carried-field dimension the cascade added —
 *  labels, paths, repo, and typed features. */
const TABLE: RouteTable = routeTable({
  kind: 'route',
  version: 1,
  routes: {
    ui: {
      match: { labels: ['ui'], paths: ['packages/cli/**', 'web/**'] },
      chain: [{ provider: 'devin-acp' }],
    },
    backend: {
      match: { repo: 'ThePlenkov/bro', features: { tier: 'pro', area: ['api', 'store'] } },
      chain: [{ provider: 'devin-acp' }],
    },
    pinned: {
      match: { type: 'edit', labels: ['bug'], features: { risk: ['high', 'critical'] } },
      chain: [{ provider: 'devin-acp' }],
    },
    fallback: {
      chain: [{ provider: 'kilo-free' }],
    },
  },
});

const names = (set: ReturnType<typeof candidates>) => set.candidates.map(c => c.route.name);
const rejected = (set: ReturnType<typeof candidates>, name: string) =>
  set.rejected.find(r => r.route.name === name);

test('labels — every declared label must be carried', () => {
  // 'ui' pins labels AND paths — the task carries both so labels decide;
  // 'pinned' also wants type/features carried so ONLY its label fails
  const set = candidates(
    TABLE,
    { type: 'edit', labels: ['ui'], paths: ['web/app.tsx'], features: { risk: 'high' } },
    {}
  );
  assert.ok(names(set).includes('ui'));
  assert.ok(names(set).includes('fallback'));
  // 'pinned' wants 'bug' — absent, so it never fits
  assert.equal(rejected(set, 'pinned')?.reason, 'the task carries no label bug');
});

test('labels — a task with no labels satisfies no label pin', () => {
  const set = candidates(TABLE, { type: 'edit' }, {});
  assert.equal(rejected(set, 'ui')?.reason, 'the task carries no labels');
  assert.equal(rejected(set, 'pinned')?.reason, 'the task carries no labels');
});

test('paths — one task path matching one glob is enough', () => {
  const set = candidates(TABLE, { labels: ['ui'], paths: ['packages/brouter/src/x.ts'] }, {});
  // 'packages/brouter/**' is not declared — only cli/** and web/** are
  assert.equal(rejected(set, 'ui')?.reason, 'no task path matches "packages/cli/**", "web/**"');
  const hit = candidates(TABLE, { labels: ['ui'], paths: ['web/app.tsx'] }, {});
  assert.ok(names(hit).includes('ui'));
});

test('paths — a task without paths never satisfies the pin', () => {
  const set = candidates(TABLE, { labels: ['ui'] }, {});
  assert.equal(rejected(set, 'ui')?.reason, 'the task carries no paths');
});

test('repo — exact canonical id equality', () => {
  const fit = candidates(
    TABLE,
    { repo: 'ThePlenkov/bro', features: { tier: 'pro', area: 'api' } },
    {}
  );
  assert.ok(names(fit).includes('backend'));
  const miss = candidates(
    TABLE,
    { repo: 'other/repo', features: { tier: 'pro', area: 'api' } },
    {}
  );
  assert.equal(
    rejected(miss, 'backend')?.reason,
    'repo=ThePlenkov/bro does not fit repo=other/repo'
  );
  const none = candidates(TABLE, { features: { tier: 'pro', area: 'api' } }, {});
  assert.equal(rejected(none, 'backend')?.reason, 'the task carries no repo');
});

test('features — scalar wants exact equality, a list wants membership', () => {
  const scalar = candidates(
    TABLE,
    { repo: 'ThePlenkov/bro', features: { tier: 'free', area: 'api' } },
    {}
  );
  assert.equal(
    rejected(scalar, 'backend')?.reason,
    'feature tier=pro does not fit feature tier=free'
  );
  const member = candidates(
    TABLE,
    { repo: 'ThePlenkov/bro', features: { tier: 'pro', area: 'store' } },
    {}
  );
  assert.ok(names(member).includes('backend'));
  const outsider = candidates(
    TABLE,
    { repo: 'ThePlenkov/bro', features: { tier: 'pro', area: 'web' } },
    {}
  );
  assert.equal(
    rejected(outsider, 'backend')?.reason,
    'feature area=[api, store] does not fit feature area=web'
  );
});

test('features — a missing non-inferable key rejects; inferable pends', () => {
  const noInfer = candidates(TABLE, { repo: 'ThePlenkov/bro' }, {});
  assert.equal(rejected(noInfer, 'backend')?.reason, 'the task carries no feature tier');
  assert.deepEqual(noInfer.pending, []);

  const infer = candidates(
    TABLE,
    { repo: 'ThePlenkov/bro' },
    {},
    { inferable: new Set(['tier', 'area']) }
  );
  assert.equal(rejected(infer, 'backend'), undefined);
  const pend = infer.pending?.find(p => p.route.name === 'backend');
  assert.ok(pend !== undefined, 'backend must pend on its unanswered features');
  assert.deepEqual(pend.needs.sort(), ['area', 'tier']);
  assert.ok(!names(infer).includes('backend'), 'a pending route is never a candidate');
});

test('features — a carried conflict rejects even when inferable', () => {
  const set = candidates(
    TABLE,
    { type: 'edit', labels: ['bug'], features: { risk: 'low' } },
    {},
    { inferable: new Set(['risk']) }
  );
  assert.equal(
    rejected(set, 'pinned')?.reason,
    'feature risk=[high, critical] does not fit feature risk=low'
  );
});

test('features — "__proto__" reads as data, never the prototype', () => {
  // JSON.parse makes __proto__ an OWN data property — an object literal
  // would set the prototype instead and the key would silently vanish
  const table = routeTable(
    JSON.parse(
      '{"kind":"route","routes":{"odd":{"match":{"features":{"__proto__":"x"}},"chain":[{"provider":"kilo-free"}]}}}'
    )
  );
  // absent — the prototype must NOT answer for the task
  const bare = candidates(table, {}, {});
  assert.equal(rejected(bare, 'odd')?.reason, 'the task carries no feature __proto__');
  // present as own data — it reads literally and fits
  const features = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
  const set = candidates(table, { features }, {});
  assert.ok(names(set).includes('odd'));
});

test('pending routes sort by score, stable like candidates', () => {
  const table = routeTable({
    kind: 'route',
    routes: {
      first: { match: { features: { a: '1' } }, chain: [{ provider: 'kilo-free' }] },
      second: {
        match: { type: 'edit', features: { a: '1', b: '2' } },
        chain: [{ provider: 'kilo-free' }],
      },
    },
  });
  const set = candidates(table, { type: 'edit' }, {}, { inferable: new Set(['a', 'b']) });
  // 'second' pins the carried type (score 1); 'first' pins nothing the
  // task carries (score 0) — needs never score, only carried fits do
  assert.deepEqual(
    set.pending?.map(p => p.route.name),
    ['second', 'first']
  );
});

// ── the glob itself ─────────────────────────────────────────────────

test('matchGlob — *, **, and ? behave as documented', () => {
  assert.ok(matchGlob('packages/brouter/**', 'packages/brouter/src/x.ts'));
  assert.ok(matchGlob('packages/brouter/**', 'packages/brouter'));
  assert.ok(!matchGlob('packages/brouter/**', 'packages/cli/x.ts'));
  assert.ok(matchGlob('src/*.ts', 'src/x.ts'));
  assert.ok(!matchGlob('src/*.ts', 'src/deep/x.ts'), '* never crosses /');
  assert.ok(matchGlob('src/**/x.ts', 'src/a/b/x.ts'));
  assert.ok(matchGlob('a?c', 'abc'));
  assert.ok(!matchGlob('a?c', 'ac'));
  assert.ok(matchGlob('**/test/**', 'a/b/test/c/d.ts'));
  // anchored — a suffix match is not a match
  assert.ok(!matchGlob('brouter/**', 'packages/brouter/x.ts'));
  // Windows-origin separators fold to '/' on BOTH sides — a task path
  // spelled `src\view.ts` must match `src/*` like its POSIX twin
  // (bro-0ykhg.2 review)
  assert.ok(matchGlob('src/*.ts', 'src\\view.ts'));
  assert.ok(matchGlob('src/**/*.ts', 'src\\deep\\view.ts'));
  assert.ok(!matchGlob('src/*.ts', 'lib\\view.ts'));
});

test('isRepoRelativePath — absolute, ~, and .. never pass', () => {
  assert.ok(isRepoRelativePath('packages/brouter/src/x.ts'));
  assert.ok(isRepoRelativePath('./a/b'));
  assert.ok(!isRepoRelativePath('/etc/passwd'));
  assert.ok(!isRepoRelativePath('../outside'));
  assert.ok(!isRepoRelativePath('a/../../b'));
  assert.ok(!isRepoRelativePath('~/x'));
  assert.ok(!isRepoRelativePath(''));
  // Windows absolute forms — a drive letter or UNC prefix is never
  // repo-relative (bro-0ykhg.2 review)
  assert.ok(!isRepoRelativePath('C:/repo/file.ts'));
  assert.ok(!isRepoRelativePath('C:\\repo\\file.ts'));
  assert.ok(!isRepoRelativePath('\\\\server\\share'));
  assert.ok(!isRepoRelativePath('a/..\\b'));
  // a SINGLE leading backslash is a Windows root-relative path — the
  // matcher's separator fold would strip it and match `foo`-shaped
  // globs, so it must die at validation (bro-0ykhg.2 review)
  assert.ok(!isRepoRelativePath('\\src\\x.ts'));
  assert.ok(!isRepoRelativePath('\\foo'));
  assert.ok(!isRepoRelativePath('\\C:\\repo\\f.ts'));
  // drive-relative `C:foo` (no separator) is never repo-relative either
  assert.ok(!isRepoRelativePath('C:foo/bar.ts'));
});

test('duplicated pins count once — they are one restriction, not many', () => {
  const table = routeTable({
    kind: 'route',
    routes: {
      spam: { match: { labels: ['ui', 'ui', 'ui'] }, chain: [{ provider: 'kilo-free' }] },
      real: {
        match: { labels: ['ui'], paths: ['web/**'] },
        chain: [{ provider: 'devin-acp' }],
      },
    },
  });
  const set = candidates(table, { labels: ['ui'], paths: ['web/x.ts'] }, {});
  const spam = set.candidates.find(c => c.route.name === 'spam');
  const real = set.candidates.find(c => c.route.name === 'real');
  // spam earns ONE label point, not three — 'real' pins label+path and wins
  assert.equal(spam?.score, 1);
  assert.equal(real?.score, 2);
  assert.equal(set.candidates[0]?.route.name, 'real');
});
