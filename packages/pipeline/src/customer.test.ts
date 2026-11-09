/**
 * customer channel suite — the signing seam (specs/bro-7d5nb.md
 * §accept trust model): `pipelineKey` resolves the shared secret
 * from the env badge or the operator's key file (never a
 * group/other-readable file — a leaked key counts as absent), and
 * `recordSignatureValid` proves a record's MAC covers the decision
 * payload bytes, not just the envelope.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  contentDigest,
  pipelineKey,
  recordSignatureValid,
  signCustomerRecord,
  verdictDigest,
} from './customer.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pipeline-customer-'));

/** A key file under `home` at the seam's own path, written with the
 *  given mode — what `~/.config/bro/pipeline.key` looks like on a
 *  configured operator box. */
const keyFile = (home: string, mode: number, body = 'channel-key\n'): string => {
  const dir = join(home, '.config', 'bro');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'pipeline.key');
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
};

const NO_ENV = {} as NodeJS.ProcessEnv;

describe('pipelineKey — the channel key seam', () => {
  test('the BRO_PIPELINE_KEY badge wins over any file', () => {
    const home = tmp();
    keyFile(home, 0o600, 'file-key\n');
    assert.equal(pipelineKey({ env: { BRO_PIPELINE_KEY: 'env-key' }, home }), 'env-key');
    // and the badge alone resolves — no file needed
    assert.equal(pipelineKey({ env: { BRO_PIPELINE_KEY: 'env-key' }, home: tmp() }), 'env-key');
  });

  test('a 0600 key file resolves its trimmed contents', () => {
    const home = tmp();
    keyFile(home, 0o600, '  file-key\n\n');
    assert.equal(pipelineKey({ env: NO_ENV, home }), 'file-key');
  });

  test('a group/other-readable key file reads as ABSENT — a leaked key', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      const home = tmp();
      keyFile(home, mode);
      assert.equal(
        pipelineKey({ env: NO_ENV, home }),
        undefined,
        `mode ${mode.toString(8)} must not resolve`
      );
    }
  });

  test('no env badge, no file → undefined (unsigned mode)', () => {
    assert.equal(pipelineKey({ env: NO_ENV, home: tmp() }), undefined);
    // an empty badge is no badge — the file path still decides
    assert.equal(pipelineKey({ env: { BRO_PIPELINE_KEY: '  ' }, home: tmp() }), undefined);
    // an empty key file is no key either
    const home = tmp();
    keyFile(home, 0o600, '   \n');
    assert.equal(pipelineKey({ env: NO_ENV, home }), undefined);
  });
});

describe('recordSignatureValid — the MAC binds the payload', () => {
  const KEY = 'channel-key-1';
  const TS = '2026-11-06T00:00:00Z';

  /** A verdict record MAC'd exactly as `bro pipeline accept` writes
   *  it — content slot = the {verdict, notes} payload digest. */
  const signedVerdict = (
    v: string,
    notes: string | undefined = undefined,
    key = KEY
  ): Record<string, unknown> => {
    const rec: Record<string, unknown> = {
      kind: 'verdict',
      item: 'bro-x',
      verdict: v,
      accepted_by: 'cust-1',
      ...(notes !== undefined ? { notes } : {}),
      ts: TS,
    };
    rec.signature = signCustomerRecord(key, {
      runId: 'r1',
      item: 'bro-x',
      kind: 'verdict',
      content: verdictDigest({ verdict: v, notes }),
      signer: 'cust-1',
      ts: TS,
    });
    return rec;
  };

  test('a signed verdict verifies — and every field is bound', () => {
    const rec = signedVerdict('rejected', 'ac-2 misses');
    assert.ok(recordSignatureValid({ key: KEY, runId: 'r1', record: rec }));
    // notes rewrite under the same signature → the digest no longer
    // matches (the round-1 gap: the word alone was bound)
    assert.equal(
      recordSignatureValid({
        key: KEY,
        runId: 'r1',
        record: { ...rec, notes: 'fine, ship it' },
      }),
      false
    );
    // verdict word, signer, run, key — all inside the MAC
    assert.equal(
      recordSignatureValid({
        key: KEY,
        runId: 'r1',
        record: { ...rec, verdict: 'accepted' },
      }),
      false
    );
    assert.equal(
      recordSignatureValid({
        key: KEY,
        runId: 'r1',
        record: { ...rec, accepted_by: 'cust-2' },
      }),
      false
    );
    assert.equal(recordSignatureValid({ key: KEY, runId: 'r2', record: rec }), false);
    assert.equal(recordSignatureValid({ key: 'other', runId: 'r1', record: rec }), false);
  });

  test('an answer record binds the answers payload bytes', () => {
    const rec: Record<string, unknown> = {
      kind: 'answer',
      item: 'bro-x',
      answers: { q1: 'sqlite' },
      by: 'cust-1',
      ts: TS,
    };
    rec.signature = signCustomerRecord(KEY, {
      runId: 'r1',
      item: 'bro-x',
      kind: 'answer',
      content: contentDigest(rec.answers),
      signer: 'cust-1',
      ts: TS,
    });
    assert.ok(recordSignatureValid({ key: KEY, runId: 'r1', record: rec }));
    // swapped payload under the copied signature → invalid
    assert.equal(
      recordSignatureValid({
        key: KEY,
        runId: 'r1',
        record: { ...rec, answers: { q1: 'postgres' } },
      }),
      false
    );
  });

  test('a missing or non-MAC signature is not a signature at all', () => {
    const rec = signedVerdict('accepted');
    const { signature: _sig, ...unsigned } = rec;
    assert.equal(recordSignatureValid({ key: KEY, runId: 'r1', record: unsigned }), false);
    assert.equal(
      recordSignatureValid({ key: KEY, runId: 'r1', record: { ...rec, signature: 'zzz' } }),
      false
    );
  });
});
