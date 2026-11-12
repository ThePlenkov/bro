import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerFacade, Mode, SessionKey, SessionRow } from '@broject/core';
import { modeFilePath } from '@broject/core';
import { capture, initRepo } from './testrepo.ts';
import { modeArgs, runModeCommand } from './mode.ts';
import { CommandError } from '@broject/core';

/** Hermetic env: XDG_STATE_HOME pinned to a throwaway dir so mode files
 *  never touch the host's real state. */
function envFixture(): { root: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'bro-mode-'));
  return {
    root,
    env: { XDG_STATE_HOME: root, BRO_SESSION_ID: 'sess-1' } as NodeJS.ProcessEnv,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeLedger(rows: SessionRow[] = []): {
  ledger: LedgerFacade;
  setCalls: { key: SessionKey; mode: Mode }[];
} {
  const setCalls: { key: SessionKey; mode: Mode }[] = [];
  const ledger: LedgerFacade = {
    append: async () => {},
    sessions: async () => rows,
    installs: async () => [],
    stats: async () => [],
    setMode: async (key, mode) => {
      setCalls.push({ key, mode });
    },
  };
  return { ledger, setCalls };
}

const srow = (host: string, sid: string, mode: Mode = 'observe'): SessionRow => ({
  host,
  sid,
  project: null,
  cwd: null,
  branch: null,
  mode,
  state: 'live',
  pid: null,
  pidStart: null,
  started: null,
  lastSeen: Date.now(),
  spawnedBy: null,
});

describe('modeArgs', () => {
  test('parses subs, modes, off→observe, and flags', () => {
    assert.deepEqual(modeArgs(['code', '--session', 's1']), {
      sub: 'set',
      mode: 'code',
      session: 's1',
      host: undefined,
      json: false,
    });
    assert.equal(modeArgs(['off']).mode, 'observe');
    assert.equal(modeArgs(['list']).sub, 'list');
    assert.equal(modeArgs(['clear', '--host', 'codex']).sub, 'clear');
    assert.equal(modeArgs(['render', '--mode', 'plan']).renderMode, 'plan');
    assert.equal(modeArgs([]).sub, 'get');
    assert.equal(modeArgs(['get']).sub, 'get');
    assert.equal(modeArgs(['code', '--json']).json, true);
  });

  test('rejects unknown modes, stray args, and misplaced --mode', () => {
    for (const argv of [
      ['bogus'],
      ['code', 'extra'],
      ['list', '--mode', 'code'],
      ['render', '--session', 's1'],
      ['render', '--mode', 'bogus'],
    ]) {
      assert.throws(() => modeArgs(argv), CommandError, JSON.stringify(argv));
    }
  });
});

describe('runModeCommand', () => {
  test('get resolves file > modes.default > observe with source', async () => {
    const f = envFixture();
    try {
      const { root: repo } = initRepo('bro-mode-get-');
      try {
        // no file, no default → observe
        let out = await capture(() =>
          runModeCommand([], { dir: repo, env: f.env, ledger: fakeLedger().ledger })
        );
        assert.match(out.out.join('\n'), /mode: observe \(default/);
        // modes.default in project config → default source
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
          join(repo, 'bro.config.json'),
          JSON.stringify({ modes: { default: 'plan' } })
        );
        out = await capture(() =>
          runModeCommand([], { dir: repo, env: f.env, ledger: fakeLedger().ledger })
        );
        assert.match(out.out.join('\n'), /mode: plan \(modes\.default/);
        // a mode file wins over everything
        const file = modeFilePath(f.env, 'unknown', 'sess-1')!;
        const { mkdirSync } = await import('node:fs');
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'review\n');
        out = await capture(() =>
          runModeCommand([], { dir: repo, env: f.env, ledger: fakeLedger().ledger })
        );
        assert.match(out.out.join('\n'), /mode: review \(mode file\)/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  });

  test('set writes the mode file + ledger projection + renders snapshots', async () => {
    const f = envFixture();
    try {
      const { root: repo } = initRepo('bro-mode-set-');
      try {
        const { ledger, setCalls } = fakeLedger();
        const rendered: string[] = [];
        const out = await capture(() =>
          runModeCommand(['code'], {
            dir: repo,
            env: f.env,
            ledger,
            render: async (_d, m) => {
              rendered.push(m);
            },
          })
        );
        assert.match(out.out.join('\n'), /mode: code/);
        const file = modeFilePath(f.env, 'unknown', 'sess-1')!;
        assert.equal(readFileSync(file, 'utf8').split('\n')[0], 'code');
        assert.deepEqual(setCalls, [{ key: { host: 'unknown', sid: 'sess-1' }, mode: 'code' }]);
        assert.deepEqual(rendered, ['code']);
        // 'off' pins observe — file written, render skipped for observe
        rendered.length = 0;
        await capture(() =>
          runModeCommand(['off'], {
            dir: repo,
            env: f.env,
            ledger,
            render: async (_d, m) => {
              rendered.push(m);
            },
          })
        );
        assert.equal(readFileSync(file, 'utf8').split('\n')[0], 'observe');
        assert.deepEqual(rendered, []);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  });

  test('set without session env prints the hook-binding path and exits 0', async () => {
    const f = envFixture();
    try {
      const { root: repo } = initRepo('bro-mode-bind-');
      try {
        const env = { XDG_STATE_HOME: f.root } as NodeJS.ProcessEnv; // no BRO_SESSION_ID
        const out = await capture(() =>
          runModeCommand(['code'], { dir: repo, env, ledger: fakeLedger().ledger })
        );
        assert.equal(out.code, 0);
        assert.match(out.err.join('\n'), /post-tool hook binds/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  });

  test('clear removes the file and re-projects the effective mode', async () => {
    const f = envFixture();
    try {
      const { root: repo } = initRepo('bro-mode-clear-');
      try {
        const file = modeFilePath(f.env, 'unknown', 'sess-1')!;
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'code\n');
        const { ledger, setCalls } = fakeLedger();
        const out = await capture(() =>
          runModeCommand(['clear'], { dir: repo, env: f.env, ledger })
        );
        assert.equal(existsSync(file), false);
        assert.match(out.out.join('\n'), /effective mode: observe/);
        assert.deepEqual(setCalls, [{ key: { host: 'unknown', sid: 'sess-1' }, mode: 'observe' }]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  });

  test('list unions mode files with ledger sessions — file wins', async () => {
    const f = envFixture();
    try {
      const { root: repo } = initRepo('bro-mode-list-');
      try {
        const file = modeFilePath(f.env, 'claude', 's-file')!;
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'plan\n');
        const { ledger } = fakeLedger([
          srow('claude', 's-file', 'code'), // file 'plan' must win
          srow('codex', 's-ledger', 'review'),
        ]);
        const out = await capture(() =>
          runModeCommand(['list', '--json'], { dir: repo, env: f.env, ledger })
        );
        const payload = JSON.parse(out.out.join('\n')) as {
          modes: { host: string; sid: string; mode: string; source: string }[];
        };
        assert.equal(payload.modes.length, 2);
        const fileRow = payload.modes.find(r => r.sid === 's-file')!;
        assert.equal(fileRow.mode, 'plan');
        assert.equal(fileRow.source, 'file');
        const ledgerRow = payload.modes.find(r => r.sid === 's-ledger')!;
        assert.equal(ledgerRow.mode, 'review');
        assert.equal(ledgerRow.source, 'ledger');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  });

  test('render delegates per mode and reports the project', async () => {
    const f = envFixture();
    try {
      const { root: repo } = initRepo('bro-mode-render-');
      try {
        const rendered: string[] = [];
        const out = await capture(() =>
          runModeCommand(['render', '--mode', 'code', '--json'], {
            dir: repo,
            env: f.env,
            ledger: fakeLedger().ledger,
            render: async (_d, m) => {
              rendered.push(m);
            },
          })
        );
        assert.deepEqual(rendered, ['code']);
        const payload = JSON.parse(out.out.join('\n')) as {
          project: string;
          rendered: string[];
        };
        assert.equal(typeof payload.project, 'string');
        assert.deepEqual(payload.rendered, ['code']);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  });
});
