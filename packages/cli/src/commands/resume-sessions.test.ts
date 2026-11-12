/** `bro fleet resume` sessions leg — fleet F4 (specs/bro-izpyk.4.md
 *  §4): interrupted sessions across the WHOLE machine ledger, derived
 *  with the same state rule `bro sessions` uses, newest first, capped,
 *  each carrying the session plane's resume argv (or null → the text
 *  block says 'unsupported'). Report-only — nothing spawns. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { collectInterruptedSessions, sessionsLines, type SessionsLegReport } from './resume.ts';
import type { LedgerFacade, LedgerSessionRow } from '@broject/core';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const BOOT = NOW - 60 * 60 * 1000; // "now" is one hour after boot

function sess(
  partial: Partial<LedgerSessionRow> & { host: string; sid: string }
): LedgerSessionRow {
  return {
    kind: 'session',
    mode: 'observe',
    state: 'live',
    lastSeen: NOW - 120_000,
    ...partial,
  };
}

/** A ledger stub — sessions() returns the fixture rows; everything
 *  else the leg never touches. */
function ledgerOf(rows: LedgerSessionRow[], drain?: string): LedgerFacade {
  return {
    sessions: async () => rows,
    append: async () => {},
    drainWarning: () => drain,
  } as unknown as LedgerFacade;
}

describe('collectInterruptedSessions', () => {
  test('keeps only interrupted rows — live-since-boot and ended drop out', async () => {
    const ledger = ledgerOf([
      // lastSeen before this boot → interrupted
      sess({ host: 'claude', sid: 'old-1', lastSeen: BOOT - 1000, cwd: '/w/old' }),
      // seen after boot → still live, not interrupted
      sess({ host: 'claude', sid: 'fresh-1', lastSeen: NOW - 1000 }),
      // stored 'ended' is terminal regardless of timestamps
      sess({ host: 'codex', sid: 'done-1', state: 'ended', lastSeen: BOOT - 500 }),
      // stored 'interrupted' stays interrupted even with a recent stamp
      sess({ host: 'cursor', sid: 'int-1', state: 'interrupted', lastSeen: NOW - 100 }),
    ]);
    const rep = await collectInterruptedSessions({
      ledger,
      now: NOW,
      bootTimeMs: BOOT,
      dir: '/tmp',
    });
    const sids = rep.interrupted.map(r => r.sid).sort();
    assert.deepEqual(sids, ['int-1', 'old-1']);
    assert.equal(rep.truncated, undefined);
    assert.deepEqual(rep.warnings, []);
  });

  test('newest first, capped at ten with a truncated count', async () => {
    const rows = Array.from({ length: 13 }, (_, i) =>
      sess({
        host: 'claude',
        sid: `cap-${String(i).padStart(2, '0')}`,
        lastSeen: BOOT - (13 - i) * 1000, // cap-12 newest … cap-00 oldest
      })
    );
    const rep = await collectInterruptedSessions({
      ledger: ledgerOf(rows),
      now: NOW,
      bootTimeMs: BOOT,
      dir: '/tmp',
    });
    assert.equal(rep.interrupted.length, 10);
    assert.equal(rep.truncated, 3);
    // newest first — cap-12 (largest lastSeen) leads
    assert.equal(rep.interrupted[0]!.sid, 'cap-12');
    assert.equal(rep.interrupted[9]!.sid, 'cap-03');
  });

  test('resumeArgv comes from the session plane — known hosts get argv, others null', async () => {
    const rep = await collectInterruptedSessions({
      ledger: ledgerOf([
        sess({ host: 'claude', sid: 'r-claude', lastSeen: BOOT - 10, cwd: '/w/c' }),
        sess({ host: 'devin', sid: 'r-devin', lastSeen: BOOT - 20, cwd: '/w/d' }),
        sess({ host: 'mystery', sid: 'r-mystery', lastSeen: BOOT - 30 }),
      ]),
      now: NOW,
      bootTimeMs: BOOT,
      dir: '/tmp',
    });
    const bySid = new Map(rep.interrupted.map(r => [r.sid, r]));
    assert.deepEqual(bySid.get('r-claude')!.resumeArgv, ['claude', '--resume', 'r-claude']);
    assert.deepEqual(bySid.get('r-devin')!.resumeArgv, ['devin', '--resume', 'r-devin']);
    assert.equal(bySid.get('r-mystery')!.resumeArgv, null);
  });

  test('a ledger that throws becomes a warning, never a failed pass', async () => {
    const ledger = {
      sessions: async () => {
        throw new Error('sqlite is on fire');
      },
      append: async () => {},
    } as unknown as LedgerFacade;
    const rep = await collectInterruptedSessions({ ledger, dir: '/tmp' });
    assert.deepEqual(rep.interrupted, []);
    assert.equal(rep.warnings.length, 1);
    assert.match(rep.warnings[0]!, /session ledger unreadable/);
    assert.match(rep.warnings[0]!, /sqlite is on fire/);
  });

  test('a spool drain failure rides as a staleness warning', async () => {
    const rep = await collectInterruptedSessions({
      ledger: ledgerOf([sess({ host: 'claude', sid: 'w-1', lastSeen: BOOT - 5 })], 'spool locked'),
      now: NOW,
      bootTimeMs: BOOT,
      dir: '/tmp',
    });
    assert.equal(rep.interrupted.length, 1);
    assert.ok(rep.warnings.some(w => /spool drain failed/.test(w)));
  });
});

describe('sessionsLines', () => {
  const base: SessionsLegReport = {
    interrupted: [
      {
        host: 'claude',
        sid: 'abcdef1234567890',
        cwd: '/work/repo',
        lastSeen: NOW - 30 * 60_000,
        resumeArgv: ['claude', '--resume', 'abcdef1234567890'],
      },
      {
        host: 'mystery',
        sid: 'xyz',
        cwd: null,
        lastSeen: NOW - 60 * 60_000,
        resumeArgv: null,
      },
    ],
    warnings: [],
  };

  test('renders the block header, rows, resume argv, and the actionable hint', () => {
    const lines = sessionsLines(base);
    assert.match(lines[0]!, /2 interrupted session\(s\)/);
    // known host → the real argv
    assert.ok(
      lines.some(
        l => l.includes('claude abcdef12') && l.includes('claude --resume abcdef1234567890')
      ),
      lines.join('\n')
    );
    // unsupported host → the word 'unsupported', never a guessed argv
    assert.ok(lines.some(l => l.includes('mystery xyz') && l.includes('unsupported')));
    // the actionable hint names the exact command
    assert.ok(
      lines.some(l => l.includes('bro sessions resume claude:abcdef1234567890')),
      lines.join('\n')
    );
    assert.ok(
      lines.some(l => l.includes('bro sessions resume mystery:xyz')),
      lines.join('\n')
    );
  });

  test('empty report renders only warnings', () => {
    assert.deepEqual(sessionsLines({ interrupted: [], warnings: [] }), []);
    const warnOnly = sessionsLines({
      interrupted: [],
      warnings: ['ledger down'],
    });
    assert.deepEqual(warnOnly, ['resume: sessions — warning: ledger down']);
  });

  test('truncated count is reported', () => {
    const lines = sessionsLines({ ...base, truncated: 4 });
    assert.ok(
      lines.some(l => /and 4 more/.test(l)),
      lines.join('\n')
    );
  });
});
