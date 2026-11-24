/** The minimal gate/debt scenario needs no model proxy — the boundary
 *  pinned mechanically (spec bro-l8c4f.11). `bro act` + `bro debt` are
 *  the wedge: they ride the review-host facade and the filesystem, and
 *  must never resolve the `/v1/*` provider plane — no listener, no
 *  upstream credential, no proxy module. The one model-adjacent
 *  surface act keeps is judge shadow-annotation, opt-in behind
 *  `judge.mode === 'shadow'`.
 *
 *  Source-level assertions follow the import-graph convention
 *  (herdr-kit): the boundary is what the files import and reference —
 *  a future change routing the gate through model transport fails
 *  here, not in a docs review. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** The wedge commands — the gate and the ledger. */
const GATE_DEBT = ['act.ts', 'debt.ts'];

/** The proxy plane's arming surface — the import name, the exported
 *  API, the env overrides, and the state files a client resolves.
 *  A reference to any of them means the command touched the plane. */
const PROXY_SURFACE = [
  'serve-provider',
  'providerConfig',
  'fileProviderConfig',
  'providerProxy',
  'forwardBody',
  'BRO_PROVIDER_',
  'ANTHROPIC_',
  'serve.json',
  'provider.json',
];

test('act/debt never touch the provider-proxy arming surface', () => {
  for (const f of GATE_DEBT) {
    const body = readFileSync(join(SRC, f), 'utf8');
    for (const token of PROXY_SURFACE) {
      assert.equal(
        body.includes(token),
        false,
        `${f} references '${token}' — the gate/debt path must not resolve the /v1/* provider plane`
      );
    }
  }
});

test("act resolves the judge facade only behind judge.mode === 'shadow'", () => {
  const body = readFileSync(join(SRC, 'act.ts'), 'utf8');
  const calls = [...body.matchAll(/\bjudgeFacade\(/g)].map(m => m.index ?? -1);
  assert.equal(
    calls.length,
    1,
    `act.ts has ${calls.length} judgeFacade call sites — the opt-in contract allows exactly one (shadowNotes)`
  );
  const shadowAt = body.indexOf('function shadowNotes');
  assert.ok(shadowAt >= 0, 'shadowNotes helper missing — the opt-in seam moved');
  const callAt = calls[0] ?? -1;
  assert.ok(callAt > shadowAt, 'the judgeFacade call site must live inside shadowNotes');
  const guardAt = body.indexOf("mode !== 'shadow'", shadowAt);
  assert.ok(
    guardAt > shadowAt && guardAt < callAt,
    "the judge.mode !== 'shadow' early-return must precede the facade resolve — annotation is opt-in, never default"
  );
  const returnAt = body.indexOf('return', guardAt);
  assert.ok(
    returnAt > guardAt && returnAt < callAt,
    'the shadow guard must bail out — a non-returning condition would resolve the facade by default while passing the ordering check'
  );
});

test('debt has no judge facade call site at all', () => {
  const body = readFileSync(join(SRC, 'debt.ts'), 'utf8');
  assert.equal(
    /\bjudgeFacade\(/.test(body),
    false,
    'debt.ts must not resolve a model facade — the ledger is filesystem + review host only'
  );
});

test('provider docs keep transport and boundary policy separate from workflow mechanics', () => {
  const docs = readFileSync(
    fileURLToPath(new URL('../../../../site/content/docs/commands/provider.md', import.meta.url)),
    'utf8'
  );
  for (const heading of [
    '## Three separate concerns',
    '## Credential boundary',
    '## Retention',
    '## Approval boundary',
  ]) {
    assert.match(docs, new RegExp(`^${heading}$`, 'm'), `${heading} is missing from provider docs`);
  }
  assert.match(
    docs,
    /The provider plane is opt-in transport/,
    'provider docs must state that model transport is opt-in'
  );
  assert.match(
    docs,
    /bro review act[\s\S]{0,60}bro review\s*\ndebt/,
    'provider docs must state that the core gate/debt workflow needs no provider plane'
  );
});
