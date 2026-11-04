import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { testRepoInit } from '@broject/core';
import {
  appendJournalRow,
  fileJournal,
  type JournalRow,
  journalRecords,
  memoryJournal,
  openPipelineJournal,
  pendingRecord,
  pipelineJournalPath,
  readJournalFile,
} from './journal.ts';

const row = (over: Partial<JournalRow> = {}): JournalRow => ({
  run_id: 'r1',
  item: 'bro-x.1',
  seq: 1,
  stage: 'work',
  intent: 'spawn',
  attempt: 1,
  formula_sha: 'abc',
  ts: '2026-01-01T00:00:00.000Z',
  ...over,
});

const tmp = () => mkdtempSync(join(tmpdir(), 'pipeline-journal-'));

describe('journal storage', () => {
  test('append + read round-trips rows', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    appendJournalRow(file, row());
    appendJournalRow(file, row({ seq: 2, verdict: 'done' }));
    const rows = readJournalFile(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].verdict, 'done');
    assert.equal(rows[0].run_id, 'r1');
  });

  test('a torn last line is dropped, not poison', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    appendJournalRow(file, row());
    appendFileSync(file, '{"run_id":"r1","seq":');
    const rows = readJournalFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq, 1);
  });

  test('an append after a torn tail lands on a fresh line — the new row survives', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    appendJournalRow(file, row());
    appendFileSync(file, '{"run_id":"r1","seq":'); // torn tail, no newline
    appendJournalRow(file, row({ seq: 7 }));
    const rows = readJournalFile(file);
    assert.equal(rows.length, 2); // torn bytes dropped, BOTH rows survive
    assert.equal(rows[1].seq, 7);
  });

  test('a read error that is not ENOENT propagates — an unreadable journal is not an empty run', () => {
    assert.throws(() => readJournalFile(tmp()), /EISDIR|EPERM|EACCES/);
  });

  test('a valid-JSON line missing row fields is dropped', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({ run_id: 'r1', seq: 9 })}\n${JSON.stringify(row({ seq: 2 }))}\n`
    );
    const rows = readJournalFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq, 2);
  });

  test('rows with a missing or non-integer `attempt` are dropped — NaN budgets rejected at parse', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    const missingAttempt = {
      run_id: 'r1',
      item: 'x',
      seq: 1,
      stage: 'work',
      intent: 'spawn',
      ts: 't',
    };
    const floatAttempt = { ...row({ seq: 3 }), attempt: 1.5 };
    const stringAttempt = { ...row({ seq: 4 }), attempt: '1' };
    writeFileSync(
      file,
      [missingAttempt, floatAttempt, stringAttempt, row({ seq: 2 })]
        .map(r => `${JSON.stringify(r)}\n`)
        .join('')
    );
    const rows = readJournalFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq, 2);
  });

  test('rows with non-positive seq or attempt are dropped — budgets start at 1', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    writeFileSync(
      file,
      [row({ seq: 0 }), row({ seq: 3, attempt: -1 }), row({ seq: 2 })]
        .map(r => `${JSON.stringify(r)}\n`)
        .join('')
    );
    const rows = readJournalFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq, 2);
  });

  test('a row missing `formula_sha` is dropped — a missing hash would crash the drift check', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    const noSha = { ...row({ seq: 5 }) };
    delete (noSha as Record<string, unknown>).formula_sha;
    writeFileSync(
      file,
      `${JSON.stringify(noSha)}\n${JSON.stringify(row({ seq: 6, formula_sha: '' }))}\n`
    );
    const rows = readJournalFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq, 6); // present-but-empty sha is legitimate
    assert.equal(rows[0].formula_sha, '');
  });

  test('missing file reads as empty', () => {
    assert.deepEqual(readJournalFile(join(tmp(), 'nope.jsonl')), []);
  });
});

describe('pipelineJournalPath / openPipelineJournal', () => {
  test('anchors under the git common dir — <common>/bro/pipeline/<run>.journal.jsonl', () => {
    const dir = tmp();
    testRepoInit(dir);
    const path = pipelineJournalPath({ dir, runId: 'r1' });
    assert.ok(path !== null);
    assert.ok(path.endsWith(join('.git', 'bro', 'pipeline', 'r1.journal.jsonl')));
  });

  test('null outside a repo; unsafe run ids throw', () => {
    const dir = tmp();
    assert.equal(pipelineJournalPath({ dir, runId: 'r1' }), null);
    assert.throws(() => pipelineJournalPath({ dir, runId: '../escape' }), /unsafe run id/);
  });

  test('openPipelineJournal persists across instances — the resume shape', () => {
    const dir = tmp();
    testRepoInit(dir);
    const j1 = openPipelineJournal({ dir, runId: 'r1' });
    assert.ok(j1 !== null);
    assert.equal(j1.runId, 'r1');
    j1.append(row());
    const j2 = openPipelineJournal({ dir, runId: 'r1' });
    assert.ok(j2 !== null);
    assert.equal(j2.rows().length, 1);
  });

  test('openPipelineJournal is null outside a repo', () => {
    assert.equal(openPipelineJournal({ dir: tmp(), runId: 'r1' }), null);
  });

  test('a bare `.journal.jsonl` name has no run id — empty stem is not an id', () => {
    const file = join(tmp(), '.journal.jsonl');
    assert.equal(fileJournal(file).runId, undefined);
  });

  test('a journal never double-reads its own appends', () => {
    const file = join(tmp(), 'r1.journal.jsonl');
    const j = fileJournal(file);
    j.append(row());
    assert.equal(j.rows().length, 1);
    j.append(row({ seq: 2 }));
    assert.equal(j.rows().length, 2);
    // bytes actually landed — a second instance reads them back
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  });
});

describe('journalRecords — last row per seq wins', () => {
  test('an intent completed by its verdict is ONE record', () => {
    const intent = row({ seq: 3 });
    const rows = journalRecords([intent, { ...intent, verdict: 'done' }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, 'done');
  });

  test('records come back seq-ordered whatever the write order', () => {
    const rows = journalRecords([row({ seq: 5 }), row({ seq: 2 }), row({ seq: 5, verdict: 'x' })]);
    assert.deepEqual(
      rows.map(r => r.seq),
      [2, 5]
    );
  });
});

describe('pendingRecord — the resume contract', () => {
  test('a trailing verdict-less intent is pending', () => {
    const records = journalRecords([row({ seq: 1, verdict: 'done' }), row({ seq: 2 })]);
    assert.equal(pendingRecord(records)?.seq, 2);
  });

  test('a completed last record is not pending', () => {
    const records = journalRecords([row({ seq: 1 }), row({ seq: 1, verdict: 'done' })]);
    assert.equal(pendingRecord(records), undefined);
  });

  test('an alert last record is not pending — it parks instead', () => {
    const records = journalRecords([row({ seq: 1, intent: 'alert', alert: 'gate-indeterminate' })]);
    assert.equal(pendingRecord(records), undefined);
  });

  test('an earlier verdict-less intent is crash history, not the resume point', () => {
    const records = journalRecords([row({ seq: 1 }), row({ seq: 2, verdict: 'done' })]);
    assert.equal(pendingRecord(records), undefined);
    assert.equal(records[0].verdict, undefined); // the artifact stays in the journal
  });
});

describe('memoryJournal', () => {
  test('append + rows for in-memory runs', () => {
    const j = memoryJournal('r9');
    j.append(row({ run_id: 'r9' }));
    assert.equal(j.runId, 'r9');
    assert.equal(j.rows().length, 1);
    assert.equal(j.rows()[0].run_id, 'r9');
  });
});
