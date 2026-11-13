import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inboxPath,
  ledgerFacade,
  modeFilePath,
  writeModeFile,
  type ClaimFacade,
  type ClaimRow,
  type ConnectorCtx,
  type EventInput,
  type EventsFacade,
  type LedgerSessionRow,
} from '@broject/core';
import {
  claimConflictConnector,
  claimConflictVerdicts,
  noteRefusedClaim,
} from './claim-conflicts.ts';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');

function claimRow(partial: Partial<ClaimRow> & { resource: string }): ClaimRow {
  return {
    host: 'claude',
    sid: 'other-1',
    project: 'P1',
    exclusive: true,
    leaseUntil: NOW + 60_000,
    claimedAt: NOW - 60_000,
    ...partial,
  };
}

function fakeClaims(rows: ClaimRow[], fail = false): ClaimFacade {
  return {
    async claim() {
      return { ok: true };
    },
    async release() {},
    async list() {
      if (fail) {
        throw new Error('store down');
      }
      return rows;
    },
  };
}

function ctx(dir: string, sid = 's1', host: string | undefined = 'claude'): ConnectorCtx {
  return {
    dir,
    sessionId: sid,
    ...(host !== undefined ? { host } : {}),
  } as ConnectorCtx;
}

const toolCall = (input: Record<string, unknown> = {}, tool = 'Bash') => ({ tool, input });

describe('claimConflictVerdicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-claim-conflict-'));

  test('empty session id can never tell own from foreign — no verdict', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}` })];
    const v = await claimConflictVerdicts(ctx(dir, ''), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.deepEqual(v, []);
  });

  test('policy off skips the check entirely', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}` })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'off',
      claims: fakeClaims(rows, /* fail= */ true), // proves list() was never called
      cwd: dir,
      project: 'P1',
    });
    assert.deepEqual(v, []);
  });

  test('foreign exclusive worktree claim covering the cwd warns', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}` })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.equal(v.length, 1);
    assert.match(v[0]!.warn!, /claim conflict — worktree:/);
    assert.match(v[0]!.warn!, /claude-other-1/);
    assert.equal(v[0]!.block, undefined);
  });

  test('claimed worktree is an ancestor — a session cwd below it conflicts', async () => {
    const sub = join(dir, 'sub');
    const rows = [claimRow({ resource: `worktree:${dir}` })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: sub,
      project: 'P1',
    });
    assert.equal(v.length, 1);
  });

  test('a sibling worktree is a different resource — no verdict', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}-sibling` })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.deepEqual(v, []);
  });

  test('a tool path landing inside a claimed worktree conflicts', async () => {
    const claimed = join(dir, 'claimed-wt');
    const rows = [claimRow({ resource: `worktree:${claimed}` })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(claimed, 'x.ts') }, 'Edit'),
      { policy: 'warn', claims: fakeClaims(rows), cwd: dir, project: 'P1' }
    );
    assert.equal(v.length, 1);
  });

  test("the session's own claim is never a conflict", async () => {
    const rows = [claimRow({ resource: `worktree:${dir}`, sid: 's1' })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.deepEqual(v, []);
  });

  test('shared + shared coexist — only exclusivity conflicts', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}`, exclusive: false })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.deepEqual(v, []);
  });

  test('own exclusive claim makes a foreign shared row a conflict', async () => {
    const rows = [
      claimRow({ resource: `worktree:${dir}`, sid: 's1', exclusive: true }),
      claimRow({ resource: `worktree:${dir}`, sid: 'other-9', exclusive: false }),
    ];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.equal(v.length, 1);
    assert.match(v[0]!.warn!, /other-9/);
  });

  test('same sid on a proven different host is foreign', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}`, host: 'codex', sid: 's1' })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.equal(v.length, 1);
  });

  test('sid match with unproven host is treated as own — no noise', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}`, host: 'claude', sid: 's1' })];
    const v = await claimConflictVerdicts(ctx(dir, 's1', undefined), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.deepEqual(v, []);
  });

  test('path glob claims match tool paths, cwd- and dir-relative', async () => {
    const rows = [claimRow({ resource: 'path:src/**' })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'src', 'a.ts') }, 'Edit'),
      { policy: 'warn', claims: fakeClaims(rows), cwd: dir, project: 'P1' }
    );
    assert.equal(v.length, 1);
    assert.match(v[0]!.warn!, /path:src\/\*\*/);
  });

  test('path claims from another project do not fire', async () => {
    const rows = [claimRow({ resource: 'path:src/**', project: 'OTHER' })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'src', 'a.ts') }, 'Edit'),
      { policy: 'warn', claims: fakeClaims(rows), cwd: dir, project: 'P1' }
    );
    assert.deepEqual(v, []);
  });

  test('a project-scoped row cannot veto a session with no project', async () => {
    // our project unresolvable → we are provably not in the row's
    // project (sessionProject derives the id deterministically per dir);
    // accepting the row would let a foreign project's claim block us
    const rows = [claimRow({ resource: 'path:src/**', project: 'OTHER' })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'src', 'a.ts') }, 'Edit'),
      { policy: 'block', claims: fakeClaims(rows), cwd: dir, project: null }
    );
    assert.deepEqual(v, []);
  });

  test('a null-project row still counts when our project is unresolved', async () => {
    const rows = [claimRow({ resource: 'path:src/**', project: null })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'src', 'a.ts') }, 'Edit'),
      { policy: 'warn', claims: fakeClaims(rows), cwd: dir, project: null }
    );
    assert.equal(v.length, 1);
  });

  test('tool paths resolve against the tool cwd before going repo-relative', async () => {
    // ctx.dir = repo root, session cwd = <root>/sub: `../src/a.ts` from
    // the tool means <root>/src/a.ts — the dir-relative frame must see it
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    const rows = [claimRow({ resource: 'path:src/**' })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: '../src/a.ts' }, 'Edit'),
      { policy: 'warn', claims: fakeClaims(rows), cwd: sub, project: 'P1' }
    );
    assert.equal(v.length, 1);
  });

  test('a tool path through a symlinked parent lands on the claimed tree', async () => {
    // /alias → <dir>/claimed-wt: a write to <alias>/new.ts (uncreated)
    // still conflicts with worktree:<claimed-wt> — the longest existing
    // parent resolves, the nonexistent tail re-appends lexically
    const claimed = join(dir, 'claimed-wt');
    mkdirSync(claimed, { recursive: true });
    const alias = join(dir, 'alias-link');
    try {
      symlinkSync(claimed, alias);
    } catch {
      return; // filesystems without symlink support — nothing to verify
    }
    const rows = [claimRow({ resource: `worktree:${realpathSync(claimed)}` })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(alias, 'new.ts') }, 'Edit'),
      { policy: 'warn', claims: fakeClaims(rows), cwd: join(dir, 'outside'), project: 'P1' }
    );
    assert.equal(v.length, 1);
  });

  test('out-of-bounds path globs never reach the matcher', async () => {
    // pathological wildcard fan-out — admission rejects the same shape,
    // but a row from any other source must not stall the hook either
    const blowup = `path:${'*a'.repeat(30)}*b`;
    const rows = [claimRow({ resource: blowup })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'a.ts') }, 'Edit'),
      { policy: 'block', claims: fakeClaims(rows), cwd: dir, project: 'P1' }
    );
    assert.deepEqual(v, []);
  });

  test('a dense in-bounds wildcard glob evaluates in linear time', async () => {
    // '*a'×12+'b' = 13 wildcards — the classic super-linear shape a
    // backtracking regex chokes on; the NFA matcher stays O(tok×path)
    const dense = `path:${'*a'.repeat(12)}b`;
    const rows = [claimRow({ resource: dense })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'a'.repeat(200)) }, 'Edit'),
      { policy: 'block', claims: fakeClaims(rows), cwd: dir, project: 'P1' }
    );
    assert.deepEqual(v, []); // no 'b' — no match, but no hang either
  });

  test('glob dialect: ? stays in-segment, **/ is zero-or-more dirs', async () => {
    const hit = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'src', 'fix.ts') }, 'Edit'),
      {
        policy: 'warn',
        claims: fakeClaims([claimRow({ resource: 'path:src/?ix.ts' })]),
        cwd: dir,
        project: 'P1',
      }
    );
    assert.equal(hit.length, 1);
    const miss = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'src', 'd', 'fix.ts') }, 'Edit'),
      {
        policy: 'warn',
        claims: fakeClaims([claimRow({ resource: 'path:src/?ix.ts' })]),
        cwd: dir,
        project: 'P1',
      }
    );
    assert.deepEqual(miss, []);
    // `**/x` matches `x` at any depth — the relative frame exercises
    // the zero-dir skip, the absolute one the dir-consuming branch
    const top = await claimConflictVerdicts(ctx(dir), toolCall({ file_path: 'leaf.ts' }, 'Edit'), {
      policy: 'warn',
      claims: fakeClaims([claimRow({ resource: 'path:**/leaf.ts' })]),
      cwd: dir,
      project: 'P1',
    });
    assert.equal(top.length, 1);
    const deep = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'a', 'b', 'leaf.ts') }, 'Edit'),
      {
        policy: 'warn',
        claims: fakeClaims([claimRow({ resource: 'path:**/leaf.ts' })]),
        cwd: dir,
        project: 'P1',
      }
    );
    assert.equal(deep.length, 1);
  });

  test('a null-project path claim still counts', async () => {
    const rows = [claimRow({ resource: 'path:src/**', project: null })];
    const v = await claimConflictVerdicts(
      ctx(dir),
      toolCall({ file_path: join(dir, 'src', 'a.ts') }, 'Edit'),
      { policy: 'warn', claims: fakeClaims(rows), cwd: dir, project: 'P1' }
    );
    assert.equal(v.length, 1);
  });

  test('branch claims conflict only on the claimed branch', async () => {
    const rows = [claimRow({ resource: 'branch:main' })];
    const hit = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
      branch: () => 'main',
    });
    assert.equal(hit.length, 1);
    const miss = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
      branch: () => 'dev',
    });
    assert.deepEqual(miss, []);
  });

  test('block policy vetoes with the release remedy', async () => {
    const rows = [claimRow({ resource: `worktree:${dir}` })];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'block',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
    });
    assert.equal(v.length, 1);
    assert.match(v[0]!.block!, /claim conflict — worktree:/);
    assert.match(v[0]!.block!, /bro claim release/);
    assert.equal(v[0]!.warn, undefined);
  });

  test('task/pr/role claims have no tool-call mapping', async () => {
    const rows = [
      claimRow({ resource: 'task:bro-x' }),
      claimRow({ resource: 'pr:12' }),
      claimRow({ resource: 'role:orchestrator@P1' }),
    ];
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'warn',
      claims: fakeClaims(rows),
      cwd: dir,
      project: 'P1',
      branch: () => 'main',
    });
    assert.deepEqual(v, []);
  });

  test('a wedged claims store is silent, never a veto', async () => {
    const v = await claimConflictVerdicts(ctx(dir), toolCall(), {
      policy: 'block',
      claims: fakeClaims([], /* fail= */ true),
      cwd: dir,
      project: 'P1',
    });
    assert.deepEqual(v, []);
  });

  test('the connector is active in every mode except observe', () => {
    const modes = claimConflictConnector.activeIn?.preTool ?? [];
    assert.deepEqual([...modes].sort(), ['code', 'orchestrate', 'plan', 'review']);
  });

  test('the connector name does not squat the claims facade namespace', () => {
    assert.equal(claimConflictConnector.name, 'claim-conflicts');
  });
});

describe('noteRefusedClaim', () => {
  function fixture(): {
    dir: string;
    env: NodeJS.ProcessEnv;
    ledger: ReturnType<typeof ledgerFacade>;
    events: EventsFacade;
    published: EventInput[];
    cleanup(): void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'bro-claim-note-'));
    const env = { BRO_HOOK_SPOOL: '0', XDG_STATE_HOME: dir } as NodeJS.ProcessEnv;
    const published: EventInput[] = [];
    const events: EventsFacade = {
      async publish(e: EventInput) {
        published.push(e);
        return { published: true, locator: `loc-${published.length}` };
      },
      async subscribe() {
        return { close() {} };
      },
      async probe() {
        return { events: [], gapped: false };
      },
    };
    return {
      dir,
      env,
      ledger: ledgerFacade({ dbPath: join(dir, 'ledger.db'), env }),
      events,
      published,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  function sessRow(partial: Partial<LedgerSessionRow> & { host: string; sid: string }) {
    return {
      kind: 'session' as const,
      mode: 'observe' as const,
      state: 'live' as const,
      lastSeen: NOW - 60_000,
      ...partial,
    } as LedgerSessionRow;
  }

  test('observe session: the refusal lands in the session inbox', async () => {
    const f = fixture();
    try {
      await f.ledger.append([sessRow({ host: 'claude', sid: 's1' })]);
      const ok = await noteRefusedClaim({
        dir: f.dir,
        env: f.env,
        session: { host: 'claude', sid: 's1' },
        resource: 'worktree:/repo',
        conflict: claimRow({ resource: 'worktree:/repo', sid: 'other-1' }),
        ledger: f.ledger,
        events: f.events,
        now: NOW,
      });
      assert.equal(ok, true);
      const path = inboxPath(f.env, 'claude', 's1');
      assert.ok(path && existsSync(path));
      const entry = JSON.parse(readFileSync(path!, 'utf8').trim());
      assert.match(entry.text, /claim refused — worktree:\/repo held by claude-other-1/);
      assert.equal(entry.kind, 'info');
      assert.equal(f.published.length, 1);
      assert.equal(f.published[0]!.to, 'claude:s1');
    } finally {
      f.cleanup();
    }
  });

  test('a code-mode session gets no note — the pre-tool verdict carries it', async () => {
    const f = fixture();
    try {
      const modeFile = modeFilePath(f.env, 'claude', 's1')!;
      writeModeFile(modeFile, 'code');
      await f.ledger.append([sessRow({ host: 'claude', sid: 's1' })]);
      const ok = await noteRefusedClaim({
        dir: f.dir,
        env: f.env,
        session: { host: 'claude', sid: 's1' },
        resource: 'worktree:/repo',
        conflict: claimRow({ resource: 'worktree:/repo' }),
        ledger: f.ledger,
        events: f.events,
        now: NOW,
      });
      assert.equal(ok, false);
      assert.equal(f.published.length, 0);
    } finally {
      f.cleanup();
    }
  });

  test('a session the ledger has not seen degrades to the mailbox address', async () => {
    const f = fixture();
    try {
      const ok = await noteRefusedClaim({
        dir: f.dir,
        env: f.env,
        session: { host: 'claude', sid: 'ghost' },
        resource: 'worktree:/repo',
        conflict: null,
        ledger: f.ledger,
        events: f.events,
        now: NOW,
      });
      assert.equal(ok, true);
      assert.equal(f.published[0]!.to, 'ghost');
      assert.match(String(f.published[0]!.payload), /held by another session/);
    } finally {
      f.cleanup();
    }
  });
});
