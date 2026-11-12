import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandError,
  inboxPath,
  ledgerFacade,
  type EventsFacade,
  type EventInput,
  type LedgerFacade,
  type LedgerSessionRow,
} from '@broject/core';
import { resolveMsgTarget, sendSessionMessage, type MsgSessionRow } from './session-msg.ts';
import { runMsgCommand } from './msg.ts';
import { runSessionsResume } from './sessions-resume.ts';
import { sessionResumeArgv } from '../session-planes/resume.ts';

const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const BOOT = T0 - 60 * 60 * 1000;
const NOW = T0;

function ledgerFixture(): { dir: string; ledger: LedgerFacade; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-msg-'));
  const env = { BRO_HOOK_SPOOL: '0', XDG_STATE_HOME: dir } as NodeJS.ProcessEnv;
  return {
    dir,
    ledger: ledgerFacade({ dbPath: join(dir, 'ledger.db'), env }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function sess(
  partial: Partial<LedgerSessionRow> & { host: string; sid: string }
): LedgerSessionRow {
  return {
    kind: 'session',
    mode: 'observe',
    state: 'live',
    lastSeen: NOW - 60_000,
    ...partial,
  };
}

function row(partial: Partial<MsgSessionRow> & { host: string; sid: string }): MsgSessionRow {
  return {
    project: null,
    cwd: null,
    state: 'live',
    lastSeen: NOW - 60_000,
    spawnedBy: null,
    ...partial,
  };
}

/** A recording events facade — captures publishes, always succeeds. */
function eventsStub(fail = false): { events: EventsFacade; published: EventInput[] } {
  const published: EventInput[] = [];
  return {
    published,
    events: {
      async publish(event: EventInput) {
        if (fail) {
          return { published: false, reason: 'stub-down' };
        }
        published.push(event);
        return { published: true, locator: `loc-${published.length}` };
      },
      async subscribe() {
        return { close() {} };
      },
      async probe() {
        return { events: [], gapped: false };
      },
    },
  };
}

describe('resolveMsgTarget', () => {
  const rows = [
    row({ host: 'claude', sid: 'abcdef123456', state: 'live', spawnedBy: null }),
    row({ host: 'codex', sid: '9999ffff0000', state: 'live', spawnedBy: 'fixer-7' }),
    row({ host: 'claude', sid: 'aaaabbbbcccc', state: 'ended', spawnedBy: null }),
    row({ host: 'unknown', sid: 'plugin-sid-1', state: 'live', spawnedBy: 'worker-2' }),
  ];

  test('<host>:<sid> exact key resolves the row', () => {
    const res = resolveMsgTarget(rows, 'claude:abcdef123456');
    assert.equal(res.error, undefined);
    assert.equal(res.deliveries.length, 1);
    const d = res.deliveries[0]!;
    assert.equal(d.session?.host, 'claude');
    assert.equal(d.to, 'claude:abcdef123456');
    assert.equal(d.inbox, true);
    assert.equal(d.label, 'claude:abcdef123456');
  });

  test('bare sid exact match', () => {
    const res = resolveMsgTarget(rows, '9999ffff0000');
    assert.equal(res.deliveries.length, 1);
    assert.equal(res.deliveries[0]!.session?.host, 'codex');
  });

  test('unique sid prefix (>=4 chars) resolves', () => {
    const res = resolveMsgTarget(rows, 'abcdef');
    assert.equal(res.deliveries.length, 1);
    assert.equal(res.deliveries[0]!.session?.sid, 'abcdef123456');
  });

  test('agentId matches rows whose spawnedBy is the agent', () => {
    const res = resolveMsgTarget(rows, 'fixer-7');
    assert.equal(res.deliveries.length, 1);
    assert.equal(res.deliveries[0]!.session?.sid, '9999ffff0000');
  });

  test('orchestrator matches rows with no spawnedBy', () => {
    const res = resolveMsgTarget(rows, 'orchestrator');
    const sids = res.deliveries.map(d => d.session?.sid).sort();
    assert.deepEqual(sids, ['aaaabbbbcccc', 'abcdef123456']);
  });

  test('ambiguous prefix fails with candidates, never guesses', () => {
    const dup = [
      row({ host: 'claude', sid: 'deadbeef0001' }),
      row({ host: 'codex', sid: 'deadbeef0002' }),
    ];
    const res = resolveMsgTarget(dup, 'dead');
    assert.ok(res.error !== undefined);
    assert.match(res.error, /ambiguous session "dead"/);
    assert.match(res.error, /claude:deadbeef0001/);
    assert.match(res.error, /codex:deadbeef0002/);
    assert.equal(res.deliveries.length, 0);
  });

  test('zero matches degrade to a mailbox-address delivery', () => {
    const res = resolveMsgTarget(rows, 'never-seen-sid');
    assert.equal(res.error, undefined);
    assert.equal(res.deliveries.length, 1);
    assert.equal(res.deliveries[0]!.to, 'never-seen-sid');
    assert.equal(res.deliveries[0]!.inbox, false);
    assert.equal(res.deliveries[0]!.session, undefined);
  });

  test('unknown ledger host uses the mailbox channel (raw sid)', () => {
    const res = resolveMsgTarget(rows, 'plugin-sid-1');
    assert.equal(res.deliveries.length, 1);
    const d = res.deliveries[0]!;
    assert.equal(d.session?.host, 'unknown');
    assert.equal(d.inbox, false);
    assert.equal(d.to, 'plugin-sid-1'); // mailbox vocabulary, not the key
  });

  test('ended session is reported, never inbox-delivered', () => {
    const res = resolveMsgTarget(rows, 'claude:aaaabbbbcccc');
    assert.equal(res.deliveries.length, 1);
    const d = res.deliveries[0]!;
    assert.equal(d.inbox, false);
    assert.equal(d.to, 'claude:aaaabbbbcccc'); // record-only key address
    assert.match(d.note ?? '', /session ended/);
  });

  test('unknown <host>:<sid> degrades to mailbox with a warning', () => {
    const res = resolveMsgTarget(rows, 'claude:not-in-ledger');
    assert.equal(res.deliveries.length, 1);
    assert.equal(res.deliveries[0]!.to, 'not-in-ledger');
    assert.equal(res.deliveries[0]!.inbox, false);
    assert.ok(res.warnings.some(w => /no ledger session matches/.test(w)));
  });
});

describe('sendSessionMessage', () => {
  function envFixture(): { env: NodeJS.ProcessEnv; dir: string; cleanup(): void } {
    const dir = mkdtempSync(join(tmpdir(), 'bro-msgenv-'));
    return {
      env: { XDG_STATE_HOME: dir, BRO_HOOK_SPOOL: '0' } as NodeJS.ProcessEnv,
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test('inbox-capable session gets the inbox file + one record publish', async () => {
    const f = ledgerFixture();
    const e = envFixture();
    const { events, published } = eventsStub();
    try {
      await f.ledger.append([sess({ host: 'claude', sid: 'sess-live-1', cwd: '/work/repo' })]);
      const res = await sendSessionMessage({
        dir: f.dir,
        target: 'claude:sess-live-1',
        text: 'status?',
        kind: 'ask',
        inReplyTo: 'bro-42',
        key: 'k-1',
        env: e.env,
        ledger: f.ledger,
        events,
        now: NOW,
        bootTimeMs: BOOT,
      });
      assert.equal(res.error, undefined);
      assert.equal(res.deliveries.length, 1);
      const d = res.deliveries[0]!;
      assert.equal(d.channel, 'inbox+record');
      assert.equal(d.published, true);
      assert.ok(d.inboxPath !== undefined && existsSync(d.inboxPath));
      // the inbox file is the JSONL entry the drain will render
      const raw = readFileSync(d.inboxPath!, 'utf8');
      const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
      assert.equal(entry.text, 'status?');
      assert.equal(entry.kind, 'ask');
      assert.equal(entry.cause, 'bro-42');
      // exactly one publish, addressed to the session KEY (record-only
      // in the mailbox — never a second copy in the recipient's ctx)
      assert.equal(published.length, 1);
      assert.equal(published[0]!.topic, 'msg');
      assert.equal(published[0]!.to, 'claude:sess-live-1');
      assert.equal(published[0]!.cause, 'bro-42');
      assert.equal(published[0]!.key, 'k-1');
    } finally {
      f.cleanup();
      e.cleanup();
    }
  });

  test('mailbox fallback target publishes with the sid address', async () => {
    const f = ledgerFixture();
    const { events, published } = eventsStub();
    try {
      const res = await sendSessionMessage({
        dir: f.dir,
        target: 'ghost-sid',
        text: 'ping',
        env: { XDG_STATE_HOME: f.dir, BRO_HOOK_SPOOL: '0' } as NodeJS.ProcessEnv,
        ledger: f.ledger,
        events,
        now: NOW,
        bootTimeMs: BOOT,
      });
      assert.equal(res.deliveries.length, 1);
      assert.equal(res.deliveries[0]!.channel, 'mailbox');
      assert.equal(published[0]!.to, 'ghost-sid');
      assert.equal(published[0]!.topic, 'msg');
    } finally {
      f.cleanup();
    }
  });

  test('ended session: no inbox append, record-only publish, warning', async () => {
    const f = ledgerFixture();
    const e = envFixture();
    const { events, published } = eventsStub();
    try {
      await f.ledger.append([
        sess({
          host: 'claude',
          sid: 'dead-sess',
          state: 'ended',
          lastSeen: NOW - 3_600_000,
        }),
      ]);
      const res = await sendSessionMessage({
        dir: f.dir,
        target: 'claude:dead-sess',
        text: 'too late',
        env: e.env,
        ledger: f.ledger,
        events,
        now: NOW,
        bootTimeMs: BOOT,
      });
      const d = res.deliveries[0]!;
      assert.equal(d.channel, 'mailbox'); // no inbox leg ran
      assert.equal(d.inboxPath, undefined);
      assert.equal(published.length, 1);
      assert.equal(published[0]!.to, 'claude:dead-sess');
      assert.ok(res.warnings.some(w => /session ended/.test(w)));
      // and no inbox file was created for it
      assert.equal(
        inboxPath(e.env, 'claude', 'dead-sess') !== null &&
          existsSync(inboxPath(e.env, 'claude', 'dead-sess')!),
        false
      );
    } finally {
      f.cleanup();
      e.cleanup();
    }
  });

  test('events publish failure degrades to a warning, not a throw', async () => {
    const f = ledgerFixture();
    const e = envFixture();
    const { events } = eventsStub(true);
    try {
      await f.ledger.append([sess({ host: 'claude', sid: 'sess-x' })]);
      const res = await sendSessionMessage({
        dir: f.dir,
        target: 'claude:sess-x',
        text: 'ping',
        env: e.env,
        ledger: f.ledger,
        events,
        now: NOW,
        bootTimeMs: BOOT,
      });
      const d = res.deliveries[0]!;
      assert.equal(d.published, false);
      assert.equal(d.reason, 'stub-down');
      // inbox still landed — channel is 'inbox', not 'inbox+record'
      assert.equal(d.channel, 'inbox');
      assert.ok(res.warnings.some(w => /publish failed/.test(w)));
    } finally {
      f.cleanup();
      e.cleanup();
    }
  });

  test('ambiguous target returns error with zero deliveries', async () => {
    const rows = [
      row({ host: 'claude', sid: 'deadbeef0001' }),
      row({ host: 'codex', sid: 'deadbeef0002' }),
    ];
    // exercise through the full path with a stubbed ledger
    const fakeLedger = {
      sessions: async () =>
        rows.map(r => ({
          kind: 'session' as const,
          mode: 'observe' as const,
          state: 'live' as const,
          host: r.host,
          sid: r.sid,
          project: null,
          cwd: null,
          branch: null,
          pid: null,
          pidStart: null,
          started: null,
          lastSeen: r.lastSeen,
          spawnedBy: r.spawnedBy,
        })),
      append: async () => {},
      drainWarning: () => undefined,
    } as unknown as LedgerFacade;
    const { events } = eventsStub();
    const res = await sendSessionMessage({
      dir: '/tmp',
      target: 'dead',
      text: 'x',
      env: { XDG_STATE_HOME: '/tmp', BRO_HOOK_SPOOL: '0' } as NodeJS.ProcessEnv,
      ledger: fakeLedger,
      events,
      now: NOW,
      bootTimeMs: BOOT,
    });
    assert.ok(res.error !== undefined);
    assert.equal(res.deliveries.length, 0);
  });
});

describe('runMsgCommand', () => {
  test('usage error on missing args', async () => {
    await assert.rejects(
      runMsgCommand(['onlytarget'], { dir: '/tmp' }),
      (err: unknown) => err instanceof CommandError && /usage: bro msg/.test(String(err))
    );
  });

  test('invalid --kind is a usage error', async () => {
    await assert.rejects(
      runMsgCommand(['--kind', 'bogus', 'sid', 'text'], { dir: '/tmp' }),
      (err: unknown) => err instanceof CommandError && /--kind must be one of/.test(String(err))
    );
  });

  test('ambiguous target surfaces the candidate list', async () => {
    const f = ledgerFixture();
    const { events } = eventsStub();
    try {
      await f.ledger.append([
        sess({ host: 'claude', sid: 'deadbeef0001' }),
        sess({ host: 'codex', sid: 'deadbeef0002' }),
      ]);
      await assert.rejects(
        runMsgCommand(['dead', 'hello'], {
          dir: f.dir,
          ledger: f.ledger,
          events,
          env: { XDG_STATE_HOME: f.dir, BRO_HOOK_SPOOL: '0' } as NodeJS.ProcessEnv,
        }),
        (err: unknown) =>
          err instanceof CommandError && /ambiguous session "dead"/.test(String(err))
      );
    } finally {
      f.cleanup();
    }
  });
});

describe('sessionResumeArgv', () => {
  test('known hosts return their documented argv', async () => {
    // planes self-register on import of session-planes/resume.ts
    const cases: Array<[string, string[]]> = [
      ['claude', ['claude', '--resume', 'sid1']],
      ['codex', ['codex', 'resume', 'sid1']],
      ['opencode', ['opencode', '--session', 'sid1']],
      ['cursor', ['agent', '--resume', 'sid1']],
      ['devin', ['devin', '--resume', 'sid1']],
    ];
    for (const [host, want] of cases) {
      assert.deepEqual(sessionResumeArgv(host, 'sid1', '/work'), want, host);
    }
  });

  test('unknown host returns null — never guesses', () => {
    assert.equal(sessionResumeArgv('no-such-host', 'sid', '/work'), null);
    assert.equal(sessionResumeArgv('unknown', 'sid', '/work'), null);
  });
});

describe('runSessionsResume', () => {
  function resumeFixture(): {
    dir: string;
    ledger: LedgerFacade;
    env: NodeJS.ProcessEnv;
    cleanup(): void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'bro-resume-'));
    const env = { BRO_HOOK_SPOOL: '0', XDG_STATE_HOME: dir } as NodeJS.ProcessEnv;
    return {
      dir,
      ledger: ledgerFacade({ dbPath: join(dir, 'ledger.db'), env }),
      env,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test('--print renders the argv without spawning', async () => {
    const f = resumeFixture();
    const lines: string[] = [];
    try {
      await f.ledger.append([
        sess({ host: 'claude', sid: 'resume-me-1', cwd: '/work/repo', lastSeen: NOW - 1000 }),
      ]);
      await runSessionsResume(['--print', 'claude:resume-me-1'], {
        dir: f.dir,
        ledger: f.ledger,
        now: NOW,
        bootTimeMs: BOOT,
        out: l => lines.push(l),
        spawn: async () => {
          throw new Error('must not spawn in --print');
        },
      });
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /claude --resume resume-me-1/);
      assert.match(lines[0]!, /cwd: \/work\/repo/);
    } finally {
      f.cleanup();
    }
  });

  test('--last picks the most recently seen session', async () => {
    const f = resumeFixture();
    const spawned: Array<{ argv: string[]; cwd: string }> = [];
    const lines: string[] = [];
    try {
      await f.ledger.append([
        sess({ host: 'claude', sid: 'old-sess', lastSeen: NOW - 5000 }),
        sess({ host: 'codex', sid: 'new-sess', lastSeen: NOW - 100 }),
      ]);
      await runSessionsResume(['--last'], {
        dir: f.dir,
        ledger: f.ledger,
        now: NOW,
        bootTimeMs: BOOT,
        out: l => lines.push(l),
        spawn: async (argv, cwd) => {
          spawned.push({ argv, cwd });
          return 0;
        },
      });
      assert.equal(spawned.length, 1);
      assert.deepEqual(spawned[0]!.argv, ['codex', 'resume', 'new-sess']);
      assert.match(lines[0]!, /codex:new-sess/);
    } finally {
      f.cleanup();
    }
  });

  test('bare sid resolves through the shared grammar', async () => {
    const f = resumeFixture();
    const lines: string[] = [];
    try {
      await f.ledger.append([sess({ host: 'claude', sid: 'uniq-sid-1234', cwd: '/w' })]);
      await runSessionsResume(['--print', 'uniq-sid'], {
        dir: f.dir,
        ledger: f.ledger,
        now: NOW,
        bootTimeMs: BOOT,
        out: l => lines.push(l),
      });
      assert.match(lines[0]!, /claude --resume uniq-sid-1234/);
    } finally {
      f.cleanup();
    }
  });

  test('unsupported host reports and exits cleanly', async () => {
    const f = resumeFixture();
    const lines: string[] = [];
    try {
      await f.ledger.append([sess({ host: 'mystery', sid: 'm-1', cwd: '/w' })]);
      await runSessionsResume(['mystery:m-1'], {
        dir: f.dir,
        ledger: f.ledger,
        now: NOW,
        bootTimeMs: BOOT,
        out: l => lines.push(l),
        spawn: async () => {
          throw new Error('must not spawn for unsupported host');
        },
      });
      assert.match(lines[0]!, /no resume command/);
      assert.match(lines[0]!, /unsupported|mystery/);
    } finally {
      f.cleanup();
    }
  });

  test('--pick on non-TTY is a usage error', async () => {
    const f = resumeFixture();
    try {
      await f.ledger.append([sess({ host: 'claude', sid: 'p-1' })]);
      await assert.rejects(
        runSessionsResume(['--pick'], {
          dir: f.dir,
          ledger: f.ledger,
          now: NOW,
          bootTimeMs: BOOT,
          stdinTTY: false,
        }),
        (err: unknown) =>
          err instanceof CommandError && /--pick needs an interactive terminal/.test(String(err))
      );
    } finally {
      f.cleanup();
    }
  });

  test('resume child nonzero exit is an error', async () => {
    const f = resumeFixture();
    try {
      await f.ledger.append([sess({ host: 'claude', sid: 'fail-1' })]);
      await assert.rejects(
        runSessionsResume(['fail-1'], {
          dir: f.dir,
          ledger: f.ledger,
          now: NOW,
          bootTimeMs: BOOT,
          out: () => {},
          spawn: async () => 3,
        }),
        (err: unknown) => err instanceof CommandError && /resume exited 3/.test(String(err))
      );
    } finally {
      f.cleanup();
    }
  });

  test('spawn receives the session cwd, not process cwd', async () => {
    const f = resumeFixture();
    const seen: string[] = [];
    try {
      await f.ledger.append([sess({ host: 'claude', sid: 'cwd-test', cwd: '/recorded/cwd' })]);
      await runSessionsResume(['cwd-test'], {
        dir: f.dir,
        ledger: f.ledger,
        now: NOW,
        bootTimeMs: BOOT,
        out: () => {},
        spawn: async (_argv, cwd) => {
          seen.push(cwd);
          return 0;
        },
      });
      assert.deepEqual(seen, ['/recorded/cwd']);
    } finally {
      f.cleanup();
    }
  });
});
