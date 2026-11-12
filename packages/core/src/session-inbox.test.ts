import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSessionInbox, drainSessionInbox, sessionInboxDir } from './session-inbox.ts';
import { inboxPath } from './modes.ts';
import { drainMailbox, dropMailbox, notifyConnector, userMailboxDir } from './notify.ts';
import type { ConnectorCtx } from './connectors.ts';

function envFixture(): { env: NodeJS.ProcessEnv; dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-inbox-'));
  const env = { XDG_STATE_HOME: dir, BRO_HOOK_SPOOL: '0' } as NodeJS.ProcessEnv;
  return { env, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** notifyConnector reads process.env directly — point it at the
 *  fixture for the duration of a callback. */
async function withEnv<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
}

describe('session inbox', () => {
  test('append → drain round-trips entries in order', () => {
    const f = envFixture();
    try {
      const p1 = appendSessionInbox(f.env, 'claude', 'sid-1', {
        ts: 1000,
        from: 'agent-7',
        kind: 'note',
        text: 'first',
      });
      const p2 = appendSessionInbox(f.env, 'claude', 'sid-1', {
        ts: 2000,
        kind: 'ask',
        cause: 'bro-1',
        text: 'second',
      });
      assert.equal(p1, p2);
      assert.equal(p1, inboxPath(f.env, 'claude', 'sid-1'));
      const drained = drainSessionInbox(f.env, 'claude', 'sid-1');
      assert.ok(drained !== null);
      assert.equal(drained.path, p1);
      assert.equal(drained.entries.length, 2);
      assert.equal(drained.entries[0]!.text, 'first');
      assert.equal(drained.entries[0]!.from, 'agent-7');
      assert.equal(drained.entries[1]!.text, 'second');
      assert.equal(drained.entries[1]!.cause, 'bro-1');
      // claim-once: the file is gone, a second drain finds nothing
      assert.equal(drainSessionInbox(f.env, 'claude', 'sid-1'), null);
      assert.equal(existsSync(p1!), false);
    } finally {
      f.cleanup();
    }
  });

  test('a foreign (non-JSON) line passes through verbatim', () => {
    const f = envFixture();
    try {
      const path = inboxPath(f.env, 'codex', 'sid-9');
      assert.ok(path !== null);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'plain foreign line\n{"ts":5,"text":"json one"}\n');
      const drained = drainSessionInbox(f.env, 'codex', 'sid-9');
      assert.ok(drained !== null);
      assert.equal(drained.entries[0]!.text, 'plain foreign line');
      assert.equal(drained.entries[0]!.from, undefined);
      assert.equal(drained.entries[1]!.text, 'json one');
    } finally {
      f.cleanup();
    }
  });

  test('an append racing the drain survives on the fresh path', () => {
    const f = envFixture();
    try {
      appendSessionInbox(f.env, 'devin', 'sid-r', { ts: 1, text: 'before' });
      const path = inboxPath(f.env, 'devin', 'sid-r')!;
      // simulate the writer appending between rename and unlink: the
      // claimed file is renamed aside, a fresh append recreates `path`
      const claim = `${path}.drain-test`;
      renameSync(path, claim);
      appendSessionInbox(f.env, 'devin', 'sid-r', { ts: 2, text: 'during' });
      // the real drain then claims the NEW file — 'during' is delivered
      const drained = drainSessionInbox(f.env, 'devin', 'sid-r');
      assert.ok(drained !== null);
      assert.deepEqual(
        drained.entries.map(e => e.text),
        ['during']
      );
      rmSync(claim, { force: true });
    } finally {
      f.cleanup();
    }
  });

  test('empty host or sid has no inbox path', () => {
    const f = envFixture();
    try {
      assert.equal(appendSessionInbox(f.env, '', 'sid', { ts: 1, text: 'x' }), null);
      assert.equal(appendSessionInbox(f.env, 'claude', '', { ts: 1, text: 'x' }), null);
      assert.equal(drainSessionInbox(f.env, '', 'sid'), null);
      assert.equal(sessionInboxDir(f.env), join(f.dir, 'bro', 'inbox'));
    } finally {
      f.cleanup();
    }
  });
});

describe('notify connector inbox leg', () => {
  function ctx(over: Partial<ConnectorCtx>): ConnectorCtx {
    return { dir: '/tmp', sessionId: 'sid-1', ...over } as ConnectorCtx;
  }

  test('a proven host drains its inbox into context', async () => {
    const f = envFixture();
    try {
      await withEnv(f.dir, async () => {
        appendSessionInbox(process.env, 'claude', 'sid-1', {
          ts: 1,
          from: 'fixer-3',
          kind: 'ask',
          cause: 'bro-9',
          text: 'status?',
        });
        const c = ctx({ host: 'claude', sessionId: 'sid-1' });
        const lines = await notifyConnector.hooks!(c).postTool!(c);
        assert.equal(lines.length, 2);
        assert.match(lines[0]!, /bro messages — 1 message\(s\)/);
        assert.match(lines[1]!, /\[msg ask fixer-3 → claude:sid-1\] status\? ↳bro-9/);
        // drained — the file is claimed away
        assert.equal(drainSessionInbox(process.env, 'claude', 'sid-1'), null);
      });
    } finally {
      f.cleanup();
    }
  });

  test('unknown/absent host skips the inbox leg entirely', async () => {
    const f = envFixture();
    try {
      await withEnv(f.dir, async () => {
        appendSessionInbox(process.env, 'claude', 'sid-1', { ts: 1, text: 'should stay' });
        const hooks = notifyConnector.hooks!({} as ConnectorCtx);
        // host 'unknown' — no proven host, the file must NOT be claimed
        // (it may belong to a real claude:sid-1)
        const unknown = ctx({ host: 'unknown', sessionId: 'sid-1' });
        const lines = await hooks.postTool!(unknown);
        assert.equal(lines.length, 0);
        assert.ok(existsSync(inboxPath(process.env, 'claude', 'sid-1')!));
        // no host at all — same
        const bare = ctx({ sessionId: 'sid-1' });
        const lines2 = await hooks.postTool!(bare);
        assert.equal(lines2.length, 0);
        assert.ok(existsSync(inboxPath(process.env, 'claude', 'sid-1')!));
      });
    } finally {
      f.cleanup();
    }
  });

  test('mailbox-only drains keep the legacy header', async () => {
    const f = envFixture();
    try {
      await withEnv(f.dir, async () => {
        dropMailbox(userMailboxDir(), 'plain note', 'note');
        const c = ctx({ host: 'claude', sessionId: 'sid-zz' });
        const lines = await notifyConnector.hooks!(c).postTool!(c);
        assert.equal(lines.length, 2);
        assert.match(lines[0]!, /bro notify — 1 mailbox message\(s\)/);
        assert.equal(lines[1], 'plain note');
        // the drain consumed the drop
        assert.equal(drainMailbox('/tmp', 'sid-zz').length, 0);
      });
    } finally {
      f.cleanup();
    }
  });
});
