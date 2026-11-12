import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  broStateDir,
  hookHostOf,
  inboxPath,
  listModeFiles,
  modeFilePath,
  MODE_SNAPSHOT_EVENTS,
  MODE_SNAPSHOT_TTL_MS,
  modeSessionsDir,
  parseModeCommand,
  readModeFile,
  readModeSnapshot,
  removeModeFile,
  safeSessionFilePart,
  sessionFileStem,
  sessionIdFromEnv,
  sessionMode,
  snapshotEventPath,
  snapshotFresh,
  snapshotModeDir,
  snapshotStampPath,
  touchSnapshotStamp,
  writeModeFile,
  writeModeSnapshot,
} from './modes.ts';
import { scrubEnv } from './testkit.ts';

after(scrubEnv());

const tmp = (): string => mkdtempSync(join(tmpdir(), 'bro-modes-'));
const envIn = (root: string): NodeJS.ProcessEnv => ({ XDG_STATE_HOME: root });

describe('broStateDir', () => {
  test('XDG_STATE_HOME wins; HOME falls back to ~/.local/state/bro', () => {
    assert.equal(broStateDir({ XDG_STATE_HOME: '/xdg' }), join('/xdg', 'bro'));
    assert.equal(broStateDir({ HOME: '/home/x' }), join('/home/x', '.local', 'state', 'bro'));
    // XDG empty string is absent, not a root
    assert.equal(
      broStateDir({ XDG_STATE_HOME: '', HOME: '/home/x' }),
      join('/home/x', '.local', 'state', 'bro')
    );
  });
});

describe('safe names', () => {
  test('safeSessionFilePart folds hostile bytes to _', () => {
    assert.equal(safeSessionFilePart('abc-123_X.Y'), 'abc-123_X.Y');
    assert.equal(safeSessionFilePart('a/b\\c:d e'), 'a_b_c_d_e');
    assert.equal(safeSessionFilePart('..'), '..'); // dots are legal — callers join under sessions/
    assert.equal(safeSessionFilePart(''), '');
  });

  test('sessionFileStem joins sanitized halves on the first dash', () => {
    assert.equal(sessionFileStem('claude', 's/1'), 'claude-s_1');
    assert.equal(sessionFileStem('my-host', 'sid'), 'my-host-sid');
  });
});

describe('mode files', () => {
  test('modeFilePath/modeSessionsDir resolve under the state dir', () => {
    const root = tmp();
    try {
      const env = envIn(root);
      assert.equal(
        modeFilePath(env, 'claude', 's1'),
        join(root, 'bro', 'sessions', 'claude-s1.mode')
      );
      assert.equal(modeSessionsDir(env), join(root, 'bro', 'sessions'));
      // sid-less sessions have no file
      assert.equal(modeFilePath(env, 'claude', ''), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writeModeFile is atomic, line 1 is the mode, line 2 the project', () => {
    const root = tmp();
    try {
      const env = envIn(root);
      const path = modeFilePath(env, 'codex', 's9')!;
      writeModeFile(path, 'code', 'proj-1');
      assert.equal(readFileSync(path, 'utf8'), 'code\nproj-1\n');
      assert.equal(readModeFile(path), 'code');
      // no leftover tmp files
      assert.deepEqual(readdirSync(join(root, 'bro', 'sessions')), ['codex-s9.mode']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readModeFile rejects invalid content; removeModeFile deletes', () => {
    const root = tmp();
    try {
      const path = join(root, 'x.mode');
      writeFileSync(path, 'bogus\n');
      assert.equal(readModeFile(path), undefined);
      writeFileSync(path, 'review\n');
      assert.equal(readModeFile(path), 'review');
      removeModeFile(path);
      assert.equal(existsSync(path), false);
      // missing file reads undefined, never throws
      assert.equal(readModeFile(join(root, 'nope.mode')), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('listModeFiles unions valid + corrupt entries with parsed stems', () => {
    const root = tmp();
    try {
      const dir = join(root, 'bro', 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'claude-s1.mode'), 'code\n');
      writeFileSync(join(dir, 'codex-bad_sid.mode'), 'garbage\n');
      writeFileSync(join(dir, 'not-a-mode.txt'), 'code\n'); // ignored
      writeFileSync(join(dir, 'dashless.mode'), 'code\n'); // no host-sid split → skipped
      const rows = listModeFiles(envIn(root));
      assert.equal(rows.length, 2);
      const good = rows.find(r => r.host === 'claude')!;
      assert.equal(good.sid, 's1');
      assert.equal(good.mode, 'code');
      const bad = rows.find(r => r.host === 'codex')!;
      assert.equal(bad.sid, 'bad_sid');
      assert.equal(bad.mode, undefined);
      assert.equal(bad.raw, 'garbage');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('identity', () => {
  test('sessionIdFromEnv resolves the shared var order', () => {
    assert.equal(sessionIdFromEnv({ BRO_SESSION_ID: 'a', DEVIN_SESSION_ID: 'b' }), 'a');
    assert.equal(sessionIdFromEnv({ CODEX_SESSION_ID: 'c' }), 'c');
    assert.equal(sessionIdFromEnv({ BRO_SESSION_ID: '  ' }), undefined);
    assert.equal(sessionIdFromEnv({}), undefined);
  });

  test('hookHostOf mirrors run.sh: env markers, then payload fingerprint', () => {
    assert.equal(hookHostOf({ CURSOR_PLUGIN_ROOT: '/x' }), 'cursor');
    assert.equal(hookHostOf({ DEVIN_PLUGIN_ROOT: '/x' }), 'devin');
    assert.equal(hookHostOf({ CLAUDE_PLUGIN_ROOT: '/x' }), 'claude');
    assert.equal(hookHostOf({ CURSOR_PROJECT_DIR: '/p' }), 'cursor');
    assert.equal(hookHostOf({ DEVIN_PROJECT_DIR: '/p' }), 'devin');
    assert.equal(hookHostOf({ PLUGIN_ROOT: '/p' }), 'codex');
    assert.equal(hookHostOf({}, { turn_id: 't1' }), 'codex');
    assert.equal(hookHostOf({}, { cursor_version: '1' }), 'cursor');
    assert.equal(hookHostOf({}, {}), 'unknown');
    assert.equal(hookHostOf({}), 'unknown');
  });
});

describe('sessionMode resolution', () => {
  test('file > modes.default > observe', () => {
    const root = tmp();
    try {
      const env = envIn(root);
      const host = 'claude';
      const sid = 's1';
      // nothing anywhere → observe
      let res = sessionMode({ env, host, sid });
      assert.equal(res.mode, 'observe');
      assert.equal(res.source, 'observe');
      assert.equal(res.file, modeFilePath(env, host, sid));
      // modes.default applies with no file — and asks for materialization
      res = sessionMode({ env, host, sid, defaultMode: 'plan' });
      assert.equal(res.mode, 'plan');
      assert.equal(res.source, 'default');
      assert.equal(res.materialize, 'plan');
      // a real file wins over the default
      writeModeFile(res.file!, 'review');
      res = sessionMode({ env, host, sid, defaultMode: 'plan' });
      assert.equal(res.mode, 'review');
      assert.equal(res.source, 'file');
      assert.equal(res.materialize, undefined);
      // an INVALID file pins observe — never the default
      writeFileSync(res.file!, 'bogus\n');
      res = sessionMode({ env, host, sid, defaultMode: 'plan' });
      assert.equal(res.mode, 'observe');
      assert.equal(res.source, 'file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sid-less sessions resolve default/observe without a file', () => {
    const res = sessionMode({
      env: envIn('/nonexistent'),
      host: 'x',
      sid: '',
      defaultMode: 'code',
    });
    assert.equal(res.mode, 'code');
    assert.equal(res.file, null);
    assert.equal(res.materialize, undefined);
  });
});

describe('parseModeCommand', () => {
  test('bare `bro mode <name>` binds; off → observe', () => {
    assert.equal(parseModeCommand('bro mode code'), 'code');
    assert.equal(parseModeCommand('  bro   mode   review  '), 'review');
    assert.equal(parseModeCommand('bro mode off'), 'observe');
    assert.equal(parseModeCommand('npx bro mode plan'), 'plan');
    assert.equal(parseModeCommand('npx -y @broject/bro@1.2.3 mode orchestrate'), 'orchestrate');
    assert.equal(parseModeCommand('npx bro@1.2.3 mode code'), 'code');
    // npm protocol aliases resolve to a DIFFERENT package — never bind
    assert.equal(parseModeCommand('npx bro@npm:other mode code'), null);
    assert.equal(parseModeCommand('npx @broject/bro@npm:other mode code'), null);
    assert.equal(parseModeCommand('npx bro@github:u/r mode code'), null);
    assert.equal(parseModeCommand('bro mode get'), null); // get is not a set
    assert.equal(parseModeCommand('bro mode bogus'), null);
    assert.equal(parseModeCommand('bro mode'), null);
  });

  test('explicit targeting and metacharacters veto the auto-bind', () => {
    assert.equal(parseModeCommand('bro mode code --session s1'), null);
    assert.equal(parseModeCommand('bro mode code --host claude'), null);
    assert.equal(parseModeCommand('bro mode code --json'), 'code'); // --json is a display flag, still a set
    // --help prints help and sets nothing — binding it would pin a mode
    // the CLI never applied
    assert.equal(parseModeCommand('bro mode code --help'), null);
    assert.equal(parseModeCommand('bro mode code -h'), null);
    assert.equal(parseModeCommand('bro mode --help'), null);
    assert.equal(parseModeCommand('bro mode code && rm -rf /'), null);
    assert.equal(parseModeCommand('bro mode code; echo hi'), null);
    assert.equal(parseModeCommand('echo bro mode code'), null);
    assert.equal(parseModeCommand('bro modes code'), null);
    assert.equal(parseModeCommand('bd mode code'), null);
  });
});

describe('snapshots', () => {
  test('paths validate project+mode; stamp gates freshness', () => {
    const root = tmp();
    try {
      const env = envIn(root);
      assert.equal(
        snapshotEventPath(env, 'proj1', 'code', 'session-start'),
        join(root, 'bro', 'snapshots', 'proj1', 'code', 'session-start.txt')
      );
      assert.equal(snapshotModeDir(env, 'bad/project', 'code'), null);
      assert.equal(snapshotEventPath(env, 'p', 'bogus' as never, 'session-start'), null);
      assert.deepEqual(
        [...MODE_SNAPSHOT_EVENTS],
        ['session-start', 'post-compaction', 'pre-compact']
      );
      // no stamp → not fresh → read is a miss
      assert.equal(snapshotFresh(env, 'p', 'code'), false);
      assert.equal(readModeSnapshot(env, 'p', 'code', 'session-start'), undefined);
      // write + stamp → fresh read; empty text is a valid answer
      assert.equal(writeModeSnapshot(env, 'p', 'code', 'session-start', 'line1\nline2'), true);
      touchSnapshotStamp(env, 'p', 'code');
      assert.equal(snapshotFresh(env, 'p', 'code'), true);
      assert.equal(readModeSnapshot(env, 'p', 'code', 'session-start'), 'line1\nline2');
      assert.equal(
        snapshotStampPath(env, 'p', 'code'),
        join(root, 'bro', 'snapshots', 'p', 'code', '.stamp')
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a stale stamp reads as a miss', () => {
    const root = tmp();
    try {
      const env = envIn(root);
      writeModeSnapshot(env, 'p', 'plan', 'pre-compact', 'ctx');
      touchSnapshotStamp(env, 'p', 'plan');
      const stamp = snapshotStampPath(env, 'p', 'plan')!;
      const old = new Date(Date.now() - MODE_SNAPSHOT_TTL_MS - 1000);
      utimesSync(stamp, old, old);
      assert.equal(snapshotFresh(env, 'p', 'plan'), false);
      assert.equal(readModeSnapshot(env, 'p', 'plan', 'pre-compact'), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('inboxPath', () => {
  test('resolves inbox/<host>-<sid> under the state dir', () => {
    const root = tmp();
    try {
      assert.equal(inboxPath(envIn(root), 'devin', 's 1'), join(root, 'bro', 'inbox', 'devin-s_1'));
      assert.equal(inboxPath(envIn(root), 'devin', ''), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
