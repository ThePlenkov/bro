/** Hook-gate e2e — `bro hooks <event>` spawned as the real CLI the way
 *  plugin hosts invoke it: JSON on stdin, control JSON on stdout, exit 0
 *  or the session stalls. The matrix covers the two contracts a
 *  regression here would silently break: fail-open (a wedged/missing
 *  probe never stalls a session) and arming (only a session that touched
 *  the thing is blocked; ambient state is passive context). */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CLI_DIST,
  e2eEnv,
  FAKE_BEAD,
  git,
  initRepo,
  installFakeBd,
  inside,
  runCli,
} from './testrepo.ts';
import { spawnSync } from 'node:child_process';
import { scrubEnv, testGitSpawn } from '@broject/core';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

interface Fixture {
  root: string;
  main: string;
  /** <git-common>/bro/hooks — shared across linked worktrees. */
  markerDir: string;
}

function hookFixture(): Fixture {
  const { root, main } = initRepo('bro-hooks-e2e-', m => {
    writeFileSync(join(m, 'bro.config.json'), '{}');
  });
  // --git-common-dir is relative ('.git') in the main worktree
  const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim());
  return { root, main, markerDir: join(common, 'bro', 'hooks') };
}

/** Arm `aspect` for a session by writing the same marker post-tool
 *  would — the file is the contract, not the classifier. */
function arm(f: Fixture, sessionId: string, aspect: string, detail = 'x'): void {
  mkdirSync(f.markerDir, { recursive: true });
  writeFileSync(join(f.markerDir, `${sessionId}.${aspect}`), `${Date.now()}\n${detail}\n`);
}

const markerExists = (f: Fixture, sessionId: string, aspect: string): boolean =>
  existsSync(join(f.markerDir, `${sessionId}.${aspect}`));

function hook(
  f: Fixture,
  event: string,
  payload: Record<string, unknown>,
  cwd = f.main
): { code: number | null; stdout: string; stderr: string } {
  // XDG pinned to the fixture — the notify drain reads the user-level
  // mailbox ($HOME/.local/state/bro/notify) too, and a test run must
  // never eat a real session's drops
  return runCli(['hooks', event], {
    cwd,
    input: JSON.stringify(payload),
    env: { XDG_STATE_HOME: join(f.root, 'xdg-state') },
  });
}

/** A linked worktree, optionally dirty. */
function linked(f: Fixture, dirty: boolean): string {
  const wt = join(f.root, 'main--w');
  git(['worktree', 'add', '-q', wt, '-b', 'work/w'], f.main);
  if (dirty) {
    writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n');
  }
  return wt;
}

const BLOCK = /"decision":"block"/;

// the launcher is part of the fail-open contract — it's what plugin
// hosts actually exec; dist must resolve without PATH help
const RUN_SH = resolve(CLI_DIST, '..', '..', '..', '..', 'hooks', 'run.sh');
const CURSOR_PLUGIN_RUN_SH = resolve(
  CLI_DIST,
  '..',
  '..',
  '..',
  '..',
  'plugins',
  'cursor',
  'bro',
  'hooks',
  'run.sh'
);
const CURSOR_HOOKS_JSON = resolve(
  CLI_DIST,
  '..',
  '..',
  '..',
  '..',
  'plugins',
  'cursor',
  'bro',
  'hooks',
  'hooks.json'
);
const DEVIN_PLUGIN_RUN_SH = resolve(
  CLI_DIST,
  '..',
  '..',
  '..',
  '..',
  'plugins',
  'devin',
  'bro',
  'hooks',
  'run.sh'
);

describe('hooks e2e — stop gate', () => {
  test('armed work session in a dirty linked worktree is blocked', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, true);
      arm(f, 's1', 'work');
      const r = hook(f, 'stop', { session_id: 's1' }, wt);
      assert.equal(r.code, 0);
      assert.match(r.stdout, BLOCK);
      assert.match(r.stdout, /uncommitted/);
    });
  });

  test('unarmed session in the same dirty worktree is not blocked — ambient is passive', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, true);
      const r = hook(f, 'stop', { session_id: 's2' }, wt);
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, BLOCK);
    });
  });

  test('stop_hook_active suppresses the block — gates, not loops', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, true);
      arm(f, 's1', 'work');
      const r = hook(f, 'stop', { session_id: 's1', stop_hook_active: true }, wt);
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '');
    });
  });

  test('armed work session in a clean worktree gets the hint, not a block', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, false);
      arm(f, 's1', 'work');
      const r = hook(f, 'stop', { session_id: 's1' }, wt);
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, BLOCK);
      assert.match(r.stdout, /bro work leave/);
    });
  });

  test('foreign claimed beads never reach an unarmed session — armed task gets the hint', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const { binDir, db } = installFakeBd(f.root, [
        {
          ...FAKE_BEAD,
          id: 'fx-9',
          title: 'held elsewhere',
          status: 'in_progress',
          assignee: 'other-agent',
        },
      ]);
      const env = {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_BD_DB: db,
        XDG_STATE_HOME: join(f.root, 'xdg-state'),
      };
      const stop = (session_id: string) =>
        runCli(['hooks', 'stop'], {
          cwd: f.main,
          input: JSON.stringify({ session_id }),
          env,
        });
      // bro-hpb35: ambient claims belong to the session-start parallel
      // probe — a session that armed nothing hears nothing at stop
      const fresh = stop('s-fresh');
      assert.equal(fresh.code, 0);
      assert.doesNotMatch(fresh.stdout, /claimed beads/);
      // the marker's owner still sees the foreign claim as a hint —
      // its `work enter fx-9` was refused by the other actor
      arm(f, 's1', 'task', 'fx-9');
      const armed = stop('s1');
      assert.equal(armed.code, 0);
      assert.doesNotMatch(armed.stdout, BLOCK);
      assert.match(armed.stdout, /claimed beads open: fx-9/);
      // the same hint on the next stop would re-wake the host in a loop
      assert.doesNotMatch(stop('s1').stdout, /claimed beads/);
    });
  });

  test('an unchanged gate hint is not repeated on the next stop — no re-wake loop', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, false);
      arm(f, 's1', 'work');
      assert.match(hook(f, 'stop', { session_id: 's1' }, wt).stdout, /bro work leave/);
      const again = hook(f, 'stop', { session_id: 's1' }, wt);
      assert.equal(again.code, 0, again.stderr);
      assert.doesNotMatch(again.stdout, /bro work leave/);
      // another session has its own memory of what it was told
      arm(f, 's3', 'work');
      assert.match(hook(f, 'stop', { session_id: 's3' }, wt).stdout, /bro work leave/);
    });
  });
});

describe('hooks e2e — sdd nudge scope + dedup (bro-6a3dq)', () => {
  const sddFixture = (f: Fixture) => {
    const { binDir, db } = installFakeBd(f.root, [
      {
        ...FAKE_BEAD,
        id: 'fx-9',
        title: 'spec me',
        status: 'in_progress',
        assignee: 'tester',
      },
      {
        ...FAKE_BEAD,
        id: 'fx-8',
        title: 'also mine',
        status: 'in_progress',
        assignee: 'tester',
      },
    ]);
    writeFileSync(join(f.main, 'bro.config.json'), '{"sdd":{"mode":"gate"}}');
    const env = {
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_BD_DB: db,
      XDG_STATE_HOME: join(f.root, 'xdg-state'),
    };
    return {
      submit: () =>
        runCli(['hooks', 'prompt-submit'], {
          cwd: f.main,
          input: JSON.stringify({ session_id: 's1', prompt: 'go' }),
          env,
        }),
      stop: () =>
        runCli(['hooks', 'stop'], {
          cwd: f.main,
          input: JSON.stringify({ session_id: 's1' }),
          env,
        }),
    };
  };

  test('prompt-submit reports the missing set once per change — not on every prompt', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const { submit } = sddFixture(f);
      arm(f, 's1', 'task', 'fx-9');
      const first = submit();
      assert.equal(first.code, 0);
      assert.match(first.stdout, /fx-9 spec me/);
      // the same set on the next prompt is already told — the nudge
      // used to spam every submit for the claim's whole lifetime
      const repeat = submit();
      assert.equal(repeat.code, 0);
      assert.doesNotMatch(repeat.stdout, /fx-9/);
      // the set changed → report again, once
      arm(f, 's1', 'task', 'fx-9\nfx-8');
      const grown = submit();
      assert.equal(grown.code, 0);
      assert.match(grown.stdout, /fx-9 spec me/);
      assert.match(grown.stdout, /fx-8 also mine/);
      const settled = submit();
      assert.equal(settled.code, 0);
      assert.doesNotMatch(settled.stdout, /fx-9/);
    });
  });

  test('a bead a newer sibling session claims is delegated — this session hears nothing', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const { submit, stop } = sddFixture(f);
      arm(f, 's1', 'task', 'fx-9');
      // the orchestrator's claim is the OLDER one — age its marker
      // back so the executor's stamp wins outside ms granularity
      const claimedAt = new Date(Date.now() - 60_000);
      utimesSync(join(f.markerDir, 's1.task'), claimedAt, claimedAt);
      // the executor session's fresher claim wins — fx-9 is its spec
      // to write, never this session's nudge
      arm(f, 's2', 'task', 'fx-9');
      const quiet = submit();
      assert.equal(quiet.code, 0);
      assert.doesNotMatch(quiet.stdout, /SDD/);
      // the task gate still sees the real claim — only the spec nudge
      // scopes the delegated bead out
      const r = stop();
      assert.equal(r.code, 0);
      assert.match(r.stdout, /fx-9/);
      assert.doesNotMatch(r.stdout, /SDD/);
    });
  });
});

describe('hooks e2e — post-tool arming', () => {
  const postTool = (cmd: string, success = true) => ({
    tool_input: { command: cmd },
    tool_response: { success },
    session_id: 's1',
  });

  test('git push arms the act aspect', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('git push origin work/x'));
      assert.equal(r.code, 0);
      assert.equal(markerExists(f, 's1', 'act'), true);
    });
  });

  test('bro work enter arms work + task and cites the governing skill', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('bro work enter fx-9'));
      assert.equal(r.code, 0);
      assert.equal(markerExists(f, 's1', 'work'), true);
      assert.equal(markerExists(f, 's1', 'task'), true);
      assert.match(r.stdout, /skills\/work\/SKILL\.md/);
    });
  });

  test('a failed tool call arms nothing', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('git push origin work/x', false));
      assert.equal(r.code, 0);
      assert.equal(markerExists(f, 's1', 'act'), false);
    });
  });
});

describe('hooks e2e — session trace journal', () => {
  /** <git-common>/bro/hooks/trace/<session>.jsonl */
  const tracePath = (f: Fixture, sessionId: string): string =>
    join(f.markerDir, 'trace', `${sessionId}.jsonl`);

  test('every post-tool event journals one trace line — success or not', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const ok = hook(f, 'post-tool', {
        tool_name: 'exec',
        tool_input: { command: 'true' },
        tool_response: { success: true },
        session_id: 's1',
      });
      assert.equal(ok.code, 0);
      const fail = hook(f, 'post-tool', {
        tool_name: 'edit',
        tool_input: { file_path: join(f.main, 'x.ts') },
        tool_response: { success: false },
        session_id: 's1',
      });
      // the fail-open contract covers failed landings too — a nonzero
      // exit here would stall the session while the journal still passes
      assert.equal(fail.code, 0);
      const lines = readFileSync(tracePath(f, 's1'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      assert.equal(first.tool, 'exec');
      assert.equal(first.command, 'true');
      assert.equal(first.ok, true);
      const second = JSON.parse(lines[1]!) as Record<string, unknown>;
      assert.equal(second.tool, 'edit');
      assert.deepEqual(second.paths, [join(f.main, 'x.ts')]);
      assert.equal(second.ok, false);
      // the journal is a subdir — never a flat <session>.trace.jsonl
      // sibling the stop gate would read as an arming aspect
      assert.equal(existsSync(join(f.markerDir, 's1.trace.jsonl')), false);
    });
  });

  test('the journal trims to the keep window once it crosses the byte cap', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // >256KB of prior events — the next append must drop the oldest
      const prior = Array.from({ length: 600 }, (_, i) =>
        JSON.stringify({ ts: i, tool: 'exec', command: `c${i} ${'x'.repeat(512)}` })
      );
      mkdirSync(join(f.markerDir, 'trace'), { recursive: true });
      writeFileSync(tracePath(f, 's1'), `${prior.join('\n')}\n`);
      const r = hook(f, 'post-tool', {
        tool_name: 'exec',
        tool_input: { command: 'true' },
        tool_response: { success: true },
        session_id: 's1',
      });
      assert.equal(r.code, 0);
      const lines = readFileSync(tracePath(f, 's1'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 500);
      const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      assert.equal(last.command, 'true');
    });
  });

  test('no session id → no journal', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', {
        tool_input: { command: 'true' },
        tool_response: { success: true },
      });
      assert.equal(r.code, 0);
      assert.equal(existsSync(join(f.markerDir, 'trace')), false);
    });
  });
});

describe('hooks e2e — post-tool mailbox drain', () => {
  /** <git-common>/bro/notify — sibling of the marker dir. */
  const mailbox = (f: Fixture): string => join(f.markerDir, '..', 'notify');
  const postTool = (sessionId: string, success = true) => ({
    tool_input: { command: 'true' },
    tool_response: { success },
    session_id: sessionId,
  });

  test('a pending drop is injected once per session — broadcast, not first-consumer-wins', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      mkdirSync(mailbox(f), { recursive: true });
      writeFileSync(join(mailbox(f), 'note-1-ab12.txt'), 'watcher: gate ready on s-9');
      const r = hook(f, 'post-tool', postTool('s1'));
      assert.equal(r.code, 0);
      assert.match(r.stdout, /PostToolUse/);
      assert.match(r.stdout, /mailbox message/);
      assert.match(r.stdout, /watcher: gate ready on s-9/);
      // delivered once to s1 — a second probe stays quiet…
      const again = hook(f, 'post-tool', postTool('s1'));
      assert.doesNotMatch(again.stdout, /watcher: gate ready/);
      // …but the drop stays for other sessions — the intended
      // parent isn't eaten by whoever drained first
      const other = hook(f, 'post-tool', postTool('s2'));
      assert.match(other.stdout, /watcher: gate ready on s-9/);
    });
  });

  test('a failed tool call is still a delivery tick — and does not re-deliver', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      mkdirSync(mailbox(f), { recursive: true });
      writeFileSync(join(mailbox(f), 'note-1-ab12.txt'), 'fixer died');
      const r = hook(f, 'post-tool', postTool('s1', false));
      assert.match(r.stdout, /fixer died/);
      const again = hook(f, 'post-tool', postTool('s1'));
      assert.doesNotMatch(again.stdout, /fixer died/);
    });
  });

  test('an empty mailbox emits nothing', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('s1'));
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '');
    });
  });
});

describe('hooks e2e — permission + fail-open', () => {
  test('permission auto-approves bro/bd, stays silent on other tools', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const ok = hook(f, 'permission', { tool_input: { command: 'bd ready -n 5' } });
      assert.equal(ok.code, 0);
      assert.match(ok.stdout, /"decision":"approve"/);
      const no = hook(f, 'permission', { tool_input: { command: 'rm -rf build' } });
      assert.equal(no.code, 0);
      assert.doesNotMatch(no.stdout, /approve/);
      // Codex PermissionRequest ignores legacy decision:approve.
      // turn_id is the Codex-only field; Devin keeps the approve shape.
      const codex = hook(f, 'permission', {
        turn_id: 'turn-1',
        hook_event_name: 'PermissionRequest',
        tool_input: { command: 'bd ready -n 5' },
      });
      assert.equal(codex.code, 0);
      assert.match(codex.stdout, /"behavior":"allow"/);
      assert.doesNotMatch(codex.stdout, /"decision":"approve"/);
    });
  });

  test('garbage stdin, unknown events, and non-bro dirs all fail open', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const bad = runCli(['hooks', 'stop'], { cwd: f.main, input: '{not json' });
      assert.equal(bad.code, 0);
      const unknown = hook(f, 'future-event', { session_id: 's1' });
      assert.equal(unknown.code, 0);
      // a directory that never opted in (no bro.config.json/.beads) —
      // walk-up may still find an ambient store above tmpdir, so the
      // contract is exit 0 + never a block, not silence
      const bare = join(f.root, 'bare');
      mkdirSync(bare);
      const outside = hook(f, 'stop', { session_id: 's1' }, bare);
      assert.equal(outside.code, 0);
      assert.doesNotMatch(outside.stdout, BLOCK);
    });
  });
});

describe('hooks e2e — commit provenance (prepare-commit-msg)', () => {
  const msgFile = (f: Fixture): string => join(f.main, 'COMMIT_MSG.txt');

  /** A `bro` on PATH that execs the CLI under test — what the installed
   *  shim resolves first (the npx fallback would hit the network). */
  const fakeBro = (f: Fixture): string => {
    const bin = join(f.root, 'brobin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bro'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_DIST}" "$@"\n`);
    spawnSync('chmod', ['+x', join(bin, 'bro')]);
    return bin;
  };

  test('the event writes env-pinned trailers into the message file', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      writeFileSync(msgFile(f), 'feat: thing\n');
      const r = runCli(['hooks', 'prepare-commit-msg', msgFile(f)], {
        cwd: f.main,
        env: {
          AI_AGENT: 'devin_3000-11-3_agent',
          BRO_SESSION_ID: 'native-abc',
          BRO_BEAD_ID: 'fx-9',
        },
      });
      assert.equal(r.code, 0);
      const msg = readFileSync(msgFile(f), 'utf8');
      assert.match(msg, /^Agent: devin$/m);
      assert.match(msg, /^Session: native-abc$/m);
      assert.match(msg, /^Bead: fx-9$/m);
    });
  });

  test('the molecule parent resolves through bd show — and a repeat run adds nothing', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const { binDir, db } = installFakeBd(f.root, [
        { id: 'fx-9', parent: 'fx-mol-1', status: 'in_progress' },
      ]);
      writeFileSync(msgFile(f), 'feat: thing\n');
      const env = {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_BD_DB: db,
        BRO_AGENT: 'devin',
        BRO_BEAD_ID: 'fx-9',
      };
      const r = runCli(['hooks', 'prepare-commit-msg', msgFile(f)], { cwd: f.main, env });
      assert.equal(r.code, 0);
      const once = readFileSync(msgFile(f), 'utf8');
      assert.match(once, /^Molecule: fx-mol-1$/m);
      runCli(['hooks', 'prepare-commit-msg', msgFile(f)], { cwd: f.main, env });
      const twice = readFileSync(msgFile(f), 'utf8');
      assert.equal(twice, once); // doNothing — provenance is first-writer-wins
      assert.equal(twice.match(/^Agent:/gm)?.length, 1);
    });
  });

  test('install writes the shim and a real commit lands trailers end-to-end', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const inst = runCli(['hooks', 'install'], { cwd: f.main });
      assert.equal(inst.code, 0, inst.stderr);
      const shim = join(f.main, '.git', 'hooks', 'prepare-commit-msg');
      assert.equal(existsSync(shim), true);
      writeFileSync(join(f.main, 'work.txt'), 'x\n');
      git(['add', '-A'], f.main);
      const commit = testGitSpawn(['commit', '-qm', 'feat: tagged'], {
        cwd: f.main,
        env: e2eEnv({
          PATH: `${fakeBro(f)}:${process.env.PATH}`,
          AI_AGENT: 'devin_3000-11-3_agent',
          BRO_BEAD_ID: 'fx-9',
        }),
        encoding: 'utf8',
      });
      assert.equal(commit.status, 0, commit.stderr);
      const body = git(['log', '-1', '--format=%B'], f.main);
      assert.match(body, /^Agent: devin$/m);
      assert.match(body, /^Bead: fx-9$/m);
      // uninstall restores a clean hooks dir
      const un = runCli(['hooks', 'uninstall'], { cwd: f.main });
      assert.equal(un.code, 0);
      assert.equal(existsSync(shim), false);
    });
  });

  test('a config-less repo still tags — the installed shim is the opt-in, not broEnabled', () => {
    const { root, main } = initRepo('bro-githooks-bare-'); // no bro.config.json/.beads
    inside(main, root, () => {
      writeFileSync(join(main, 'm.txt'), 'feat: x\n');
      const r = runCli(['hooks', 'prepare-commit-msg', join(main, 'm.txt')], {
        cwd: main,
        env: { AI_AGENT: 'devin_1' },
      });
      assert.equal(r.code, 0);
      assert.match(readFileSync(join(main, 'm.txt'), 'utf8'), /^Agent: devin$/m);
    });
  });
});

function cursorPayload(
  event: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    hook_event_name: event,
    cursor_version: '1.7.2',
    conversation_id: 's1',
    ...extra,
  };
}

describe('hooks e2e — cursor schema', () => {
  test('session-start emits additional_context, not the Claude envelope', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'session-start', cursorPayload('sessionStart', { session_id: 's1' }));
      assert.equal(r.code, 0);
      assert.match(r.stdout, /"additional_context":/);
      assert.match(r.stdout, /parallel-friendly/);
      assert.doesNotMatch(r.stdout, /hookSpecificOutput/);
    });
  });

  test('postToolUse arms from tool_input.command and emits additional_context', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(
        f,
        'post-tool',
        cursorPayload('postToolUse', {
          tool_name: 'Shell',
          tool_input: { command: 'gh pr merge 3 --squash' },
        })
      );
      assert.equal(r.code, 0);
      assert.match(r.stdout, /additional_context/);
      assert.match(r.stdout, /bro debt collect/);
      assert.equal(markerExists(f, 's1', 'act'), true);
    });
  });

  test('postToolUseFailure does not arm', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(
        f,
        'post-tool',
        cursorPayload('postToolUseFailure', { tool_input: { command: 'git push' } })
      );
      assert.equal(r.code, 0);
      assert.equal(markerExists(f, 's1', 'act'), false);
      assert.doesNotMatch(r.stdout, /additional_context/);
    });
  });

  test('stop follow-up fires once; a later loop_count and an abort stay quiet', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, true);
      arm(f, 's1', 'work');
      const first = hook(
        f,
        'stop',
        cursorPayload('stop', { status: 'completed', loop_count: 0 }),
        wt
      );
      assert.equal(first.code, 0);
      assert.match(first.stdout, /"followup_message":/);
      assert.match(first.stdout, /uncommitted/);
      assert.doesNotMatch(first.stdout, /"decision"/);
      const again = hook(
        f,
        'stop',
        cursorPayload('stop', { status: 'completed', loop_count: 1 }),
        wt
      );
      assert.equal(again.stdout.trim(), '');
      const aborted = hook(
        f,
        'stop',
        cursorPayload('stop', { status: 'aborted', loop_count: 0 }),
        wt
      );
      assert.equal(aborted.stdout.trim(), '');
    });
  });

  test('permission in a repo that has not opted in still answers', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const bare = join(f.root, 'bare');
      mkdirSync(bare);
      const env = { XDG_STATE_HOME: join(f.root, 'xdg-state') };
      const allow = runCli(['hooks', 'permission'], {
        cwd: bare,
        input: JSON.stringify(cursorPayload('beforeShellExecution', { command: 'bd ready' })),
        env,
      });
      assert.equal(allow.code, 0);
      assert.match(allow.stdout, /"permission":"allow"/);
      const ask = runCli(['hooks', 'permission'], {
        cwd: bare,
        input: JSON.stringify(
          cursorPayload('beforeShellExecution', { command: 'bro act status && true' })
        ),
        env,
      });
      assert.equal(ask.code, 0);
      assert.match(ask.stdout, /"permission":"ask"/);
    });
  });

  test('permission allows a self-tool and asks on a chain', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const allow = hook(
        f,
        'permission',
        cursorPayload('beforeShellExecution', { command: 'bd ready -n 5' })
      );
      assert.match(allow.stdout, /"permission":"allow"/);
      const ask = hook(
        f,
        'permission',
        cursorPayload('beforeShellExecution', { command: 'bro act status && rm -rf x' })
      );
      assert.match(ask.stdout, /"permission":"ask"/);
      assert.doesNotMatch(ask.stdout, /allow/);
    });
  });

  test('the first prompt rehydrates once; preCompact lets the next prompt do it again', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      arm(f, 'other-session', 'work', 'fx-9');
      const first = hook(
        f,
        'prompt-submit',
        cursorPayload('beforeSubmitPrompt', { prompt: 'hello' })
      );
      assert.match(first.stdout, /additional_context/);
      assert.match(first.stdout, /fx-9/);
      assert.match(first.stdout, /"continue":true/);
      const second = hook(
        f,
        'prompt-submit',
        cursorPayload('beforeSubmitPrompt', { prompt: 'hello again' })
      );
      assert.doesNotMatch(second.stdout, /fx-9/);
      hook(f, 'pre-compact', cursorPayload('preCompact'));
      const third = hook(
        f,
        'prompt-submit',
        cursorPayload('beforeSubmitPrompt', { prompt: 'after compact' })
      );
      assert.match(third.stdout, /fx-9/);
    });
  });

  test('session-start marks the session hydrated so the next prompt does not repeat it', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      arm(f, 'other-session', 'work', 'fx-9');
      const start = hook(f, 'session-start', cursorPayload('sessionStart', { session_id: 's1' }));
      assert.match(start.stdout, /fx-9/);
      const prompt = hook(
        f,
        'prompt-submit',
        cursorPayload('beforeSubmitPrompt', { prompt: 'hello' })
      );
      assert.doesNotMatch(prompt.stdout, /fx-9/);
    });
  });

  test('CURSOR_PROJECT_DIR wins over cwd; a non-cursor payload ignores it', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const elsewhere = join(f.root, 'elsewhere');
      mkdirSync(elsewhere);
      const wt = linked(f, true);
      arm(f, 's1', 'work');
      const env = { CURSOR_PROJECT_DIR: wt, XDG_STATE_HOME: join(f.root, 'xdg-state') };
      const hit = runCli(['hooks', 'stop'], {
        cwd: elsewhere,
        input: JSON.stringify(cursorPayload('stop', { status: 'completed', loop_count: 0 })),
        env,
      });
      assert.equal(hit.code, 0);
      assert.match(hit.stdout, /followup_message/);
      assert.match(hit.stdout, /uncommitted/);
      const miss = runCli(['hooks', 'stop'], {
        cwd: elsewhere,
        input: JSON.stringify({ session_id: 's1' }),
        env,
      });
      assert.equal(miss.code, 0);
      assert.doesNotMatch(miss.stdout, /followup_message/);
      assert.doesNotMatch(miss.stdout, /"decision"/);
    });
  });

  test('workspace_roots is the project when cwd is outside the repo', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const elsewhere = join(f.root, 'elsewhere');
      mkdirSync(elsewhere);
      const wt = linked(f, true);
      arm(f, 's1', 'work');
      const r = runCli(['hooks', 'stop'], {
        cwd: elsewhere,
        input: JSON.stringify(
          cursorPayload('stop', {
            status: 'completed',
            loop_count: 0,
            workspace_roots: [wt],
          })
        ),
        env: { XDG_STATE_HOME: join(f.root, 'xdg-state') },
      });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /followup_message/);
      assert.match(r.stdout, /uncommitted/);
    });
  });
});

describe('hooks e2e — Codex instructions', () => {
  const pluginRoot = resolve(CLI_DIST, '..', '..', '..', '..');

  test('session-start and post-compaction inject the plugin file only for Codex', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const env = { XDG_STATE_HOME: join(f.root, 'xdg-state'), PLUGIN_ROOT: pluginRoot };
      const codex = runCli(['hooks', 'session-start'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's1', turn_id: 'turn-1' }),
        env,
      });
      assert.equal(codex.code, 0);
      assert.match(codex.stdout, /# bro on Codex/);
      const other = runCli(['hooks', 'session-start'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's1' }),
        env,
      });
      assert.doesNotMatch(other.stdout, /# bro on Codex/);
      const pre = runCli(['hooks', 'pre-compact'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's1', turn_id: 'turn-1' }),
        env,
      });
      assert.doesNotMatch(pre.stdout, /# bro on Codex/);
      const post = runCli(['hooks', 'post-compaction'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's1', turn_id: 'turn-1' }),
        env,
      });
      assert.match(post.stdout, /PostCompact/);
      assert.match(post.stdout, /# bro on Codex/);
    });
  });
});

describe('hooks e2e — session-start + the run.sh launcher', () => {
  test('session-start in the main checkout emits the parallel-friendly nudge', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'session-start', { session_id: 's1' });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /parallel-friendly/);
    });
  });

  test("a foreign session's live work marker surfaces as passive context", () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      arm(f, 'other-session', 'work', 'fx-9');
      const r = hook(f, 'session-start', { session_id: 's1' });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /parallel work detected/);
      assert.match(r.stdout, /fx-9/);
    });
  });

  test("the session's own spawn-pinned claim is not parallel work — the nudge stays quiet", () => {
    // bro-qteky: a spawned worker's bead is claimed by the orchestrator,
    // so no `.task` marker ever armed — BRO_BEAD_ID is the session's
    // claim record. In a single-runner scratch repo the nudge must say
    // nothing at all (the assignee is the pin's claimAs identity, not
    // this actor — pin trust bypasses assignee verification).
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const { binDir, db } = installFakeBd(f.root, [
        {
          ...FAKE_BEAD,
          id: 'fx-9',
          title: 'spawn-assigned step',
          status: 'in_progress',
          assignee: 'fx-9',
        },
      ]);
      const r = runCli(['hooks', 'session-start'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's1' }),
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          FAKE_BD_DB: db,
          BRO_BEAD_ID: 'fx-9',
          XDG_STATE_HOME: join(f.root, 'xdg-state'),
        },
      });
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, /parallel work detected/);
      assert.doesNotMatch(r.stdout, /fx-9/);
    });
  });

  const runSh = (cwd: string, event: string, input: string) =>
    spawnSync('sh', [RUN_SH, event], { cwd, input, env: e2eEnv(), encoding: 'utf8' });

  test('run.sh emits the armed dirty-worktree block through the real launch path', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, true);
      arm(f, 's1', 'work');
      const r = runSh(wt, 'stop', JSON.stringify({ session_id: 's1' }));
      assert.equal(r.status, 0);
      assert.match(r.stdout, BLOCK);
    });
  });

  test('run.sh exits 0 on an unknown event — hooks never stall the session', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = runSh(f.main, 'bogus-event', '{}');
      assert.equal(r.status, 0);
    });
  });

  test('run.sh watchdog kills a hung bro process under dash and bash', () => {
    for (const shell of ['/bin/dash', '/bin/bash']) {
      const f = hookFixture();
      inside(f.main, f.root, () => {
        const bin = join(f.root, 'bin');
        const pluginRoot = join(f.root, 'plugin');
        const pidFile = join(f.root, 'bro.pid');
        mkdirSync(bin);
        mkdirSync(pluginRoot);
        const bro = join(bin, 'bro');
        writeFileSync(
          bro,
          '#!/bin/sh\nprintf "%s\\n" "$$" > "$STUB_PID_FILE"\nexec /bin/sleep 30\n'
        );
        chmodSync(bro, 0o755);
        const input = JSON.stringify({
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: { command: 'git push origin main' },
        });
        const proc = spawnSync(shell, [RUN_SH, 'post-tool'], {
          cwd: f.main,
          input,
          env: e2eEnv({
            PATH: `${bin}:${process.env.PATH}`,
            PLUGIN_ROOT: pluginRoot,
            BRO_HOOK_WATCHDOG_S: '2',
            STUB_PID_FILE: pidFile,
            XDG_STATE_HOME: join(f.root, 'xdg-state'),
          }),
          encoding: 'utf8',
          // TERM at 2s + 1s grace + sweep ≈ 3.2s; '2' because whole-second
          // T0 math can expire '1' before run_bounded starts (boundary
          // crossing → _remaining=0 → bro never runs → no pidFile)
          timeout: 5_000,
        });
        assert.equal(proc.error, undefined, `${shell} exceeded the watchdog bound`);
        assert.equal(proc.status, 0, proc.stderr);
        const pid = Number(readFileSync(pidFile, 'utf8'));
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        assert.equal(alive, false, `${shell} left the bro process alive`);
      });
    }
  });

  test('run.sh fails open under dash and bash with one launcher-wide budget', () => {
    const cases = [
      {
        name: 'watchdog kill stops fallback',
        event: 'session-start',
        input: '{}',
        script: `const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.LOCAL_MARKER, 'started')\nsetTimeout(() => {}, 30_000)\n`,
        watchdogS: '2',
        fallback: false,
        local: true,
        captureFailure: false,
        // TERM at 2s + 1s grace + KILL-leg tail ≈ 3.2s
        timeout: 6_000,
        elapsedMs: 5_000,
      },
      {
        name: 'quick nonzero exit falls through',
        event: 'session-start',
        input: '{}',
        script: `const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.LOCAL_MARKER, 'started')\nprocess.exit(7)\n`,
        watchdogS: '8',
        fallback: true,
        local: true,
        captureFailure: false,
        timeout: 2_500,
        elapsedMs: 2_200,
      },
      {
        name: 'partial payload capture runs no candidate',
        event: 'post-tool',
        input: '{"cursor_version":"1"}',
        script: `const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.LOCAL_MARKER, 'started')\n`,
        watchdogS: '8',
        fallback: false,
        local: false,
        captureFailure: true,
        timeout: 2_500,
        elapsedMs: 2_200,
      },
    ] as const;
    for (const scenario of cases) {
      for (const shell of ['/bin/dash', '/bin/bash']) {
        const f = hookFixture();
        inside(f.main, f.root, () => {
          const bin = join(f.root, 'bin');
          const pluginRoot = join(f.root, 'plugin');
          const localMarker = join(f.root, 'local.started');
          const fallbackMarker = join(f.root, 'fallback.started');
          mkdirSync(bin);
          mkdirSync(join(pluginRoot, 'packages', 'cli', 'dist'), { recursive: true });
          writeFileSync(join(pluginRoot, 'packages', 'cli', 'dist', 'index.js'), scenario.script);
          if (scenario.captureFailure) {
            const cat = join(bin, 'cat');
            writeFileSync(
              cat,
              `#!/bin/sh
if [ "$#" -eq 0 ]; then
  printf '%s' '{"cursor_version":"1"'
  exit 1
fi
exec /bin/cat "$@"
`
            );
            chmodSync(cat, 0o755);
          }
          const bro = join(bin, 'bro');
          writeFileSync(bro, '#!/bin/sh\nprintf x > "$FALLBACK_MARKER"\n');
          chmodSync(bro, 0o755);

          const started = Date.now();
          const proc = spawnSync(shell, [RUN_SH, scenario.event], {
            cwd: f.main,
            input: scenario.input,
            env: e2eEnv({
              PATH: `${bin}:${process.env.PATH}`,
              PLUGIN_ROOT: pluginRoot,
              LOCAL_MARKER: localMarker,
              FALLBACK_MARKER: fallbackMarker,
              BRO_HOOK_WATCHDOG_S: scenario.watchdogS,
              XDG_STATE_HOME: join(f.root, 'xdg-state'),
            }),
            encoding: 'utf8',
            timeout: scenario.timeout,
          });
          const elapsed = Date.now() - started;
          assert.equal(proc.error, undefined, `${shell} ${scenario.name} exceeded the bound`);
          assert.equal(proc.status, 0, proc.stderr);
          assert.equal(
            existsSync(localMarker),
            scenario.local,
            `${shell} ${scenario.name} local CLI`
          );
          assert.equal(
            existsSync(fallbackMarker),
            scenario.fallback,
            `${shell} ${scenario.name} had unexpected fallback behavior`
          );
          assert.ok(elapsed < scenario.elapsedMs, `${shell} ${scenario.name} took ${elapsed}ms`);
        });
      }
    }
  });

  test('a watchdog-killed Cursor permission run still answers ask', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // silence on beforeShellExecution is a deny — the launcher must
      // emit the no-opinion itself when the watchdog expired the binary
      const bin = join(f.root, 'bin');
      const pluginRoot = join(f.root, 'plugin');
      mkdirSync(bin);
      mkdirSync(pluginRoot);
      const bro = join(bin, 'bro');
      writeFileSync(bro, '#!/bin/sh\nsleep 60\n');
      chmodSync(bro, 0o755);

      const proc = spawnSync('sh', [RUN_SH, 'permission'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's-perm', tool_input: { command: 'ls' } }),
        env: e2eEnv({
          PATH: `${bin}:${process.env.PATH}`,
          CURSOR_PLUGIN_ROOT: pluginRoot,
          BRO_HOOK_WATCHDOG_S: '1',
          XDG_STATE_HOME: join(f.root, 'xdg-state'),
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(proc.error, undefined, 'hook exceeded the test bound');
      assert.equal(proc.status, 0);
      assert.match(proc.stdout, /"permission":"ask"/, 'killed run left a deny-shaped silence');
    });
  });

  test('a TERM-ignoring straggler is KILLed so it cannot hold the host pipe', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // the straggler ignores TERM and inherits the hook's stdout pipe;
      // the parent dies on TERM while it survives — the watchdog's KILL
      // leg must still reach it before the launcher cancels the dog
      const bin = join(f.root, 'bin');
      const pluginRoot = join(f.root, 'plugin');
      const pidFile = join(f.root, 'straggler.pid');
      mkdirSync(bin);
      mkdirSync(pluginRoot);
      writeFileSync(
        join(bin, 'straggler.sh'),
        `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nexec sleep 60\n`
      );
      chmodSync(join(bin, 'straggler.sh'), 0o755);
      writeFileSync(join(bin, 'bro'), `#!/bin/sh\n"${bin}/straggler.sh" &\nsleep 60\n`);
      chmodSync(join(bin, 'bro'), 0o755);

      const started = Date.now();
      const proc = spawnSync('sh', [RUN_SH, 'post-tool'], {
        cwd: f.main,
        input: JSON.stringify({
          session_id: 's-dog',
          tool_name: 'Bash',
          tool_input: { command: 'git push -u origin feat/x' },
        }),
        env: e2eEnv({
          PATH: `${bin}:${process.env.PATH}`,
          PLUGIN_ROOT: pluginRoot,
          // '2' not '1': whole-second T0 math can expire a 1s window
          // before run_bounded starts (boundary crossing → _remaining=0
          // → bro never runs → no straggler.pid)
          BRO_HOOK_WATCHDOG_S: '2',
          XDG_STATE_HOME: join(f.root, 'xdg-state'),
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(proc.error, undefined, 'straggler held the pipe past the deadline');
      assert.equal(proc.status, 0);
      assert.ok(Date.now() - started < 9_000, `took ${Date.now() - started}ms`);
      const pid = readFileSync(pidFile, 'utf8').trim();
      let alive = true;
      try {
        process.kill(Number(pid), 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `straggler ${pid} survived the KILL leg`);
    });
  });

  test('the dist→bro fallback owns only the leftover of one script-wide window', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // dist exits non-zero after 4s; with BRO_HOOK_WATCHDOG_S=5 the
      // fallback `bro` has ~1s of window left, not a fresh 5s — the
      // host's timeout counts from launch, not per attempt
      const bin = join(f.root, 'bin');
      const pluginRoot = join(f.root, 'plugin');
      mkdirSync(bin);
      mkdirSync(join(pluginRoot, 'packages', 'cli', 'dist'), { recursive: true });
      writeFileSync(
        join(pluginRoot, 'packages', 'cli', 'dist', 'index.js'),
        'setTimeout(() => process.exit(1), 4000)\n'
      );
      writeFileSync(join(bin, 'bro'), '#!/bin/sh\nsleep 60\n');
      chmodSync(join(bin, 'bro'), 0o755);

      const started = Date.now();
      const proc = spawnSync('sh', [RUN_SH, 'stop'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's-budget', stop_hook_active: false }),
        env: e2eEnv({
          PATH: `${bin}:${process.env.PATH}`,
          PLUGIN_ROOT: pluginRoot,
          BRO_HOOK_WATCHDOG_S: '5',
          XDG_STATE_HOME: join(f.root, 'xdg-state'),
        }),
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(proc.error, undefined, 'hook exceeded the test bound');
      assert.equal(proc.status, 0);
      assert.ok(
        Date.now() - started < 9_000,
        `fallback must run inside the leftover window (${Date.now() - started}ms, two full windows would take ~11s)`
      );
    });
  });

  test('run.sh survives a closed fd 0 (POSIX special-builtin redirect)', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // `exec` is a POSIX special builtin — a failed redirect on it
      // exits a non-interactive shell before || can fall back
      const bin = join(f.root, 'bin');
      const pluginRoot = join(f.root, 'plugin');
      mkdirSync(bin);
      mkdirSync(pluginRoot);
      writeFileSync(join(bin, 'bro'), '#!/bin/sh\ncat >/dev/null\n');
      chmodSync(join(bin, 'bro'), 0o755);

      const proc = spawnSync('sh', ['-c', `sh "${RUN_SH}" stop 0<&-`], {
        cwd: f.main,
        env: e2eEnv({
          PATH: `${bin}:${process.env.PATH}`,
          PLUGIN_ROOT: pluginRoot,
          XDG_STATE_HOME: join(f.root, 'xdg-state'),
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(proc.status, 0, `closed stdin must not kill the launcher: ${proc.stderr}`);
    });
  });

  test('run.sh forwards captured and uncaptured stdin byte-for-byte under dash and bash', () => {
    const cases = [
      { event: 'permission', input: '{"hook_event_name":"permission"}\n' },
      {
        event: 'post-tool',
        input: `${JSON.stringify({
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: { command: 'git push origin main' },
        })}\n\n`,
      },
    ] as const;
    for (const { event, input } of cases) {
      for (const shell of ['/bin/dash', '/bin/bash']) {
        const f = hookFixture();
        inside(f.main, f.root, () => {
          const bin = join(f.root, 'bin');
          const pluginRoot = join(f.root, 'plugin');
          const stdinFile = join(f.root, 'bro.stdin');
          mkdirSync(bin);
          mkdirSync(pluginRoot);
          const bro = join(bin, 'bro');
          writeFileSync(bro, '#!/bin/sh\ncat > "$STUB_STDIN_FILE"\n');
          chmodSync(bro, 0o755);
          const proc = spawnSync(shell, [RUN_SH, event], {
            cwd: f.main,
            input,
            env: e2eEnv({
              PATH: `${bin}:${process.env.PATH}`,
              PLUGIN_ROOT: pluginRoot,
              STUB_STDIN_FILE: stdinFile,
              ...(event === 'post-tool' ? { XDG_STATE_HOME: join(f.root, 'xdg-state') } : {}),
            }),
            encoding: 'utf8',
            timeout: 2_500,
          });
          assert.equal(proc.error, undefined, `${shell} exceeded the test bound`);
          assert.equal(proc.status, 0, proc.stderr);
          assert.equal(readFileSync(stdinFile, 'utf8'), input);
        });
      }
    }
  });

  test('plugin run.sh defers only to registered executable Devin hooks', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const bin = join(f.root, 'bin');
      mkdirSync(bin);
      const node = join(bin, 'node');
      const bro = join(bin, 'bro');
      writeFileSync(node, '#!/bin/sh\nprintf x > "$NODE_MARKER"\n');
      writeFileSync(bro, '#!/bin/sh\nprintf x > "$BRO_MARKER"\n');
      chmodSync(node, 0o755);
      chmodSync(bro, 0o755);

      const config = (project: string) => {
        writeFileSync(join(project, 'bro.config.json'), '{}');
        mkdirSync(join(project, '.devin'), { recursive: true });
        writeFileSync(
          join(project, '.devin', 'hooks.v1.json'),
          JSON.stringify({
            hooks: [
              { event: 'PostToolUse', command: '"$DEVIN_PROJECT_DIR/hooks/run.sh" post-tool' },
            ],
          })
        );
      };
      const project = (name: string, launcher: 'executable' | 'non-executable' | 'missing') => {
        const dir = join(f.root, name);
        mkdirSync(dir);
        config(dir);
        if (launcher !== 'missing') {
          mkdirSync(join(dir, 'hooks'));
          const path = join(dir, 'hooks', 'run.sh');
          writeFileSync(path, '#!/bin/sh\nprintf x > "$LOCAL_MARKER"\n');
          if (launcher === 'executable') chmodSync(path, 0o755);
        }
        return dir;
      };
      const invoke = (dir: string, event: string, label: string) => {
        const nodeMarker = join(f.root, `${label}-node`);
        const broMarker = join(f.root, `${label}-bro`);
        const r = spawnSync('sh', [DEVIN_PLUGIN_RUN_SH, event], {
          cwd: dir,
          input: JSON.stringify({
            session_id: 'devin-test-session',
            tool_name: 'bash',
            tool_input: { command: 'git push -u origin feat/test' },
          }),
          env: e2eEnv({
            DEVIN_PROJECT_DIR: dir,
            NODE_MARKER: nodeMarker,
            BRO_MARKER: broMarker,
            LOCAL_MARKER: join(f.root, `${label}-local`),
            PATH: `${bin}:${process.env.PATH ?? ''}`,
          }),
          encoding: 'utf8',
        });
        return { r, nodeMarker, broMarker };
      };

      const registeredProject = project('registered', 'executable');
      const registered = invoke(registeredProject, 'post-tool', 'registered');
      assert.equal(registered.r.status, 0);
      assert.equal(registered.r.stdout, '');
      assert.equal(existsSync(registered.nodeMarker), false);
      assert.equal(existsSync(registered.broMarker), false);
      assert.equal(existsSync(join(f.root, 'registered-local')), false);

      const unregistered = invoke(registeredProject, 'stop', 'unregistered');
      assert.equal(unregistered.r.status, 0);
      assert.ok(existsSync(unregistered.nodeMarker) || existsSync(unregistered.broMarker));

      for (const state of ['missing', 'non-executable'] as const) {
        const dir = project(state, state);
        const result = invoke(dir, 'post-tool', state);
        assert.equal(result.r.status, 0);
        assert.ok(
          existsSync(result.nodeMarker) || existsSync(result.broMarker),
          `${state} launcher skipped plugin`
        );
      }
    });
  });

  test('project-local run.sh still invokes bro when it owns the Devin hook chain', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const project = join(f.root, 'project');
      const hooksDir = join(project, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(project, 'bro.config.json'), '{}');
      mkdirSync(join(project, '.devin'));
      writeFileSync(
        join(project, '.devin', 'hooks.v1.json'),
        JSON.stringify({
          hooks: [{ event: 'PostToolUse', command: '"$DEVIN_PROJECT_DIR/hooks/run.sh" post-tool' }],
        })
      );
      const localRunSh = join(hooksDir, 'run.sh');
      writeFileSync(localRunSh, readFileSync(RUN_SH, 'utf8'));
      chmodSync(localRunSh, 0o755);

      const bin = join(f.root, 'bin');
      mkdirSync(bin);
      const bro = join(bin, 'bro');
      writeFileSync(bro, '#!/bin/sh\nprintf ran > "$BRO_MARKER"\nprintf ran\n');
      chmodSync(bro, 0o755);

      const r = spawnSync('sh', [localRunSh, 'post-tool'], {
        cwd: project,
        input: JSON.stringify({
          session_id: 'devin-test-session',
          tool_name: 'bash',
          tool_input: { command: 'git push -u origin feat/test' },
        }),
        env: e2eEnv({
          DEVIN_PROJECT_DIR: project,
          BRO_MARKER: join(f.root, 'bro-called'),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        }),
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'ran');
      assert.equal(existsSync(join(f.root, 'bro-called')), true);
    });
  });

  test('pre-tool is a known event — silent and green while no connector guards', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'pre-tool', {
        session_id: 's1',
        tool_name: 'bash',
        tool_input: { command: 'gh pr merge 12' },
      });
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '');
    });
  });
});

describe('hooks e2e — BRO_HOOKS=0 machine-backend trees (bro-ddksm)', () => {
  const OFF = { BRO_HOOKS: '0' };

  test('session-start emits nothing — no rehydrate probes run', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = runCli(['hooks', 'session-start'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's-off' }),
        env: { ...OFF, XDG_STATE_HOME: join(f.root, 'xdg-state') },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '');
    });
  });

  test('an armed session on a dirty worktree is not even gated', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, true);
      arm(f, 's-off', 'work');
      const r = runCli(['hooks', 'stop'], {
        cwd: wt,
        input: JSON.stringify({ session_id: 's-off' }),
        env: { ...OFF, XDG_STATE_HOME: join(f.root, 'xdg-state') },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), '');
    });
  });

  test('permission answers nothing — the host falls through to its own policy', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // 'bro act status' is a self-tool command — without the flag the
      // hook auto-approves it; off means no opinion
      const r = runCli(['hooks', 'permission'], {
        cwd: f.main,
        input: JSON.stringify({
          session_id: 's-off',
          tool_name: 'exec',
          tool_input: { command: 'bro act status' },
        }),
        env: { ...OFF, XDG_STATE_HOME: join(f.root, 'xdg-state') },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), '');
    });
  });

  test('run.sh exits 0 before resolving any bro binary', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = spawnSync('sh', [RUN_SH, 'session-start'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's-off' }),
        env: e2eEnv(OFF),
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    });
  });

  test('run.sh still answers a cursor permission — empty stdout is a deny', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const env = e2eEnv(OFF);
      const allow = spawnSync('sh', [RUN_SH, 'permission'], {
        cwd: f.main,
        input: JSON.stringify(cursorPayload('beforeShellExecution', { command: 'bd ready' })),
        env,
        encoding: 'utf8',
      });
      assert.equal(allow.status, 0);
      assert.match(allow.stdout, /"permission":"allow"/);
      const ask = spawnSync('sh', [RUN_SH, 'permission'], {
        cwd: f.main,
        input: JSON.stringify(cursorPayload('beforeShellExecution', { command: 'rm -rf x' })),
        env,
        encoding: 'utf8',
      });
      assert.equal(ask.status, 0);
      assert.match(ask.stdout, /"permission":"ask"/);
    });
  });

  test('Cursor no-CLI permission paths emit the CLI no-opinion response', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const bin = join(f.root, 'no-cli-bin');
      const pluginRoot = join(f.root, 'empty-cursor-plugin');
      mkdirSync(bin);
      mkdirSync(pluginRoot);
      const dirnamePath = process.env.PATH?.split(':')
        .map(entry => join(entry, 'dirname'))
        .find(existsSync);
      assert.ok(dirnamePath);
      symlinkSync(dirnamePath, join(bin, 'dirname'));

      const env = e2eEnv({
        CURSOR_PLUGIN_ROOT: pluginRoot,
        PATH: bin,
      });
      const launcher = spawnSync('/bin/sh', [CURSOR_PLUGIN_RUN_SH, 'permission'], {
        cwd: f.main,
        input: JSON.stringify(cursorPayload('beforeShellExecution', { command: 'rm -rf x' })),
        env,
        encoding: 'utf8',
      });
      assert.equal(launcher.status, 0);
      assert.equal(launcher.stdout, '{"permission":"ask"}\n');

      const manifest = JSON.parse(readFileSync(CURSOR_HOOKS_JSON, 'utf8')) as {
        hooks: { beforeShellExecution: { command: string }[] };
      };
      const inlineCommand = manifest.hooks.beforeShellExecution[0]?.command;
      assert.ok(inlineCommand);
      const inline = spawnSync('/bin/sh', ['-c', inlineCommand], {
        cwd: f.main,
        input: JSON.stringify(cursorPayload('beforeShellExecution', { command: 'rm -rf x' })),
        env,
        encoding: 'utf8',
      });
      assert.equal(inline.status, 0);
      assert.equal(inline.stdout, '{"permission":"ask"}\n');
    });
  });
});

describe('hooks e2e — perf journal', () => {
  test('deadline exits 0 and journals a deadline row', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const proc = spawnSync(process.execPath, [CLI_DIST, 'hooks', 'session-start'], {
        cwd: f.main,
        input: JSON.stringify({ session_id: 's-deadline' }),
        env: e2eEnv({
          BRO_HOOK_DEADLINE_MS: '1',
          XDG_STATE_HOME: join(f.root, 'xdg-state'),
        }),
        encoding: 'utf8',
        timeout: 3_000,
      });
      assert.equal(proc.error, undefined, 'hook exceeded the test bound');
      assert.equal(proc.status, 0, proc.stderr);
      const journal = join(f.markerDir, 'perf', 's-deadline.jsonl');
      const rows = readFileSync(journal, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>);
      assert.ok(rows.some(row => row.deadline === true));
    });
  });

  test('a hook event journals per-probe timings plus the event total', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { success: true },
      });
      assert.equal(r.code, 0);
      const journal = join(f.markerDir, 'perf', 's1.jsonl');
      assert.ok(existsSync(journal), 'perf journal must exist after a hook event');
      const rows = readFileSync(journal, 'utf8')
        .split('\n')
        .filter(l => l !== '')
        .map(l => JSON.parse(l) as Record<string, unknown>);
      assert.ok(
        rows.some(x => x.probe === 'postTool' && typeof x.connector === 'string'),
        'per-probe rows name their connector'
      );
      assert.ok(
        rows.some(
          x => x.probe === undefined && x.event === 'post-tool' && typeof x.ms === 'number'
        ),
        'the event total row closes the batch'
      );
    });
  });

  test('bro hooks perf aggregates the journal — probe stats and totals', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      hook(f, 'post-tool', {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { success: true },
      });
      const r = runCli(['hooks', 'perf'], { cwd: f.main });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /post-tool postTool \w+/);
      assert.match(r.stdout, /totals/);
      assert.match(r.stdout, /post-tool/);
      const j = runCli(['hooks', 'perf', '--json'], { cwd: f.main });
      const doc = JSON.parse(j.stdout) as { rows: unknown[] };
      assert.ok(Array.isArray(doc.rows) && doc.rows.length > 0);
    });
  });
});

describe('hooks e2e — guard injection', () => {
  const guardFixture = (defs: Record<string, unknown>[]): Fixture => {
    const { root, main } = initRepo('bro-guard-e2e-', m => {
      writeFileSync(join(m, 'bro.config.json'), JSON.stringify({ guard: { defs } }));
    });
    const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim());
    return { root, main, markerDir: join(common, 'bro', 'hooks') };
  };

  test('post-tool: a commands-match guard fires once, then the budget is spent', () => {
    const f = guardFixture([
      {
        name: 'push-nudge',
        when: { on: ['post-tool'], match: { commands: ['git push'] } },
        say: 'remember the review gate',
      },
    ]);
    inside(f.main, f.root, () => {
      const ev = {
        session_id: 's1',
        tool_input: { command: 'git push origin x' },
        tool_response: { success: true },
      };
      const r1 = hook(f, 'post-tool', ev);
      assert.equal(r1.code, 0, r1.stderr);
      assert.match(r1.stdout, /bro guard push-nudge: remember the review gate/);
      const r2 = hook(f, 'post-tool', ev);
      assert.doesNotMatch(r2.stdout, /push-nudge/);
      // the fired set is the shared file — guard:<name> beside lesson ids
      const fired = join(f.markerDir, 'fired', 's1');
      assert.match(readFileSync(fired, 'utf8'), /^guard:push-nudge$/m);
    });
  });

  test('prompt-submit: a terms guard fires on the raw prompt', () => {
    const f = guardFixture([
      {
        name: 'deploy-terms',
        when: { on: ['prompt-submit'], match: { terms: ['deploy'] } },
        say: 'deploys need the checklist',
      },
    ]);
    inside(f.main, f.root, () => {
      const r = hook(f, 'prompt-submit', { session_id: 's1', prompt: 'please deploy this' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /bro guard deploy-terms: deploys need the checklist/);
      const miss = hook(f, 'prompt-submit', { session_id: 's2', prompt: 'hello' });
      assert.doesNotMatch(miss.stdout, /deploy-terms/);
    });
  });

  test('stop: a state guard joins hints, never blocks', () => {
    const f = guardFixture([
      {
        name: 'dirty-src',
        when: { on: ['stop'], state: { diff: { changed: ['src/**'], without: ['**/*.test.*'] } } },
        say: 'src changed without a test',
      },
    ]);
    inside(f.main, f.root, () => {
      mkdirSync(join(f.main, 'src'), { recursive: true });
      writeFileSync(join(f.main, 'src', 'a.ts'), 'x\n');
      const r = hook(f, 'stop', { session_id: 's1' });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, BLOCK);
      assert.match(r.stdout, /bro guard dirty-src: src changed without a test/);
      // a second stop on a fresh session refires; the same session's spent
      const r2 = hook(f, 'stop', { session_id: 's1' });
      assert.doesNotMatch(r2.stdout, /dirty-src/);
    });
  });

  test('no guard config → no guard output, hooks stay silent', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', {
        session_id: 's1',
        tool_input: { command: 'true' },
        tool_response: { success: true },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /bro guard/);
    });
  });

  test('session context text caches across hook invocations (30s TTL)', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // stop always builds the goal context — the first hook writes the
      // cache entry under <git-common>/bro/hooks/cache/
      const r = hook(f, 'stop', { session_id: 'ctx-1', stop_hook_active: false });
      assert.equal(r.code, 0, r.stderr);
      const cacheDir = join(f.markerDir, 'cache');
      const file = readdirSync(cacheDir).find(n => n.startsWith('ctx-'));
      assert.ok(file, 'ctx cache entry missing after stop');
      const path = join(cacheDir, file);
      const first = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(typeof first.text, 'string');
      assert.match(first.text, /repo:/);

      // a rewound entry is past TTL → the next hook recomputes + rewrites
      writeFileSync(path, JSON.stringify({ ts: 0, text: first.text }));
      const r2 = hook(f, 'stop', { session_id: 'ctx-1', stop_hook_active: false });
      assert.equal(r2.code, 0, r2.stderr);
      const second = JSON.parse(readFileSync(path, 'utf8'));
      assert.ok(second.ts > first.ts, `expired entry not refreshed: ${second.ts}`);
    });
  });
});

describe('hooks e2e — run.sh fast path (bro-arm83)', () => {
  /** A fake `node` earlier on PATH is the canary: run.sh resolves the
   *  built dist before PATH `bro`, so any fast-path miss reaching
   *  resolution touches it. XDG pins isolate the user mailbox and the
   *  global config layer from the host's own state. */
  function canaryEnv(
    root: string,
    extra: Record<string, string> = {}
  ): { canary: string; env: Record<string, string> } {
    const bin = join(root, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const canary = join(root, 'node-ran');
    writeFileSync(join(bin, 'node'), `#!/bin/sh\ntouch "${canary}"\n`);
    spawnSync('chmod', ['+x', join(bin, 'node')]);
    return {
      canary,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        XDG_STATE_HOME: join(root, 'xdg-state'),
        XDG_CONFIG_HOME: join(root, 'xdg-config'),
        ...extra,
      },
    };
  }

  const launch = (cwd: string, event: string, payload: unknown, env: Record<string, string>) =>
    spawnSync('sh', [RUN_SH, event], {
      cwd,
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: e2eEnv(env),
      encoding: 'utf8',
    });

  const postTool = {
    session_id: 's1',
    tool_input: { command: 'ls -la' },
    tool_response: { success: true },
  };
  const promptSubmit = { session_id: 's1', prompt: 'hello there' };

  const isolated = (root: string) => ({
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
  });

  /** One real-node run records the guard-coverage stamp the fast path
   *  keys on — without it every event defers to Node. */
  function prime(f: Fixture): void {
    const r = launch(f.main, 'post-tool', postTool, isolated(f.root));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(f.markerDir, 'guards', '.stamp')), 'prime wrote no guard stamp');
  }

  test('a no-op post-tool and prompt-submit exit 0 without reaching node', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      prime(f);
      const { canary, env } = canaryEnv(f.root);
      for (const [event, payload] of [
        ['post-tool', postTool],
        ['prompt-submit', promptSubmit],
      ] as const) {
        const r = launch(f.main, event, payload, env);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, '');
        assert.equal(existsSync(canary), false, `${event} reached node`);
      }
    });
  });

  test('a repo without the opt-in never reaches node', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const nogit = join(f.root, 'nogit');
      mkdirSync(nogit);
      const { canary, env } = canaryEnv(f.root);
      const r = launch(nogit, 'post-tool', postTool, env);
      assert.equal(r.status, 0);
      assert.equal(existsSync(canary), false);
    });
  });

  test('a mutating command, a pending drop, or live guard state reach node', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      prime(f);

      // mutating payload
      let c = canaryEnv(join(f.root, 'c1'));
      let r = launch(
        f.main,
        'post-tool',
        { ...postTool, tool_input: { command: 'bro work enter fx-9' } },
        c.env
      );
      assert.equal(r.status, 0);
      assert.ok(existsSync(c.canary), 'mutating command did not reach node');

      // a pending broadcast drop in the repo mailbox
      const notify = join(f.markerDir, '..', 'notify');
      mkdirSync(notify, { recursive: true });
      writeFileSync(join(notify, `${Date.now()}-x.txt`), 'hello session\n');
      c = canaryEnv(join(f.root, 'c2'));
      r = launch(f.main, 'post-tool', postTool, c.env);
      assert.ok(existsSync(c.canary), 'pending drop did not reach node');

      // a guard def covering this event
      writeFileSync(join(f.markerDir, 'guards', 'post-tool'), 'x');
      c = canaryEnv(join(f.root, 'c3'));
      r = launch(f.main, 'post-tool', postTool, c.env);
      assert.ok(existsSync(c.canary), 'guards/post-tool did not reach node');
    });
  });

  test('a missing guard stamp defers to node', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const { canary, env } = canaryEnv(f.root);
      const r = launch(f.main, 'post-tool', postTool, env);
      assert.equal(r.status, 0);
      assert.ok(existsSync(canary), 'unstamped repo skipped node');
    });
  });

  test('an open drill frame and an sdd claim reach node on prompt-submit', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // sdd config before priming — a config newer than .stamp defers on
      // its own and would mask the legs under test
      writeFileSync(join(f.main, 'bro.config.json'), '{"sdd":{"mode":"nudge"}}');
      prime(f);

      // open frame in the snapshot — only "frame":null proves none
      mkdirSync(join(f.markerDir, 'cache'), { recursive: true });
      writeFileSync(join(f.markerDir, 'cache', 'drills.json'), '{"frame":{"id":"fx-1"}}');
      let c = canaryEnv(join(f.root, 'c1'));
      launch(f.main, 'prompt-submit', promptSubmit, c.env);
      assert.ok(existsSync(c.canary), 'open drill frame did not reach node');

      // frame closed but this session claims a bead under sdd
      writeFileSync(join(f.markerDir, 'cache', 'drills.json'), '{"frame":null}');
      arm(f, 's1', 'task');
      c = canaryEnv(join(f.root, 'c2'));
      launch(f.main, 'prompt-submit', promptSubmit, c.env);
      assert.ok(existsSync(c.canary), 'sdd claim did not reach node');

      // env-pinned claim instead of a marker
      spawnSync('rm', ['-f', join(f.markerDir, 's1.task')]);
      c = canaryEnv(join(f.root, 'c3'), { BRO_BEAD_ID: 'fx-9' });
      launch(f.main, 'prompt-submit', promptSubmit, c.env);
      assert.ok(existsSync(c.canary), 'env-pinned claim did not reach node');
    });
  });

  test('mailbox newline classification determines whether post-tool reaches node', () => {
    const cases = [
      {
        payload: '{"kind":"nudge","topic":"t","to":"other-session"}',
        reachesNode: false,
        message: 'foreign drop reached node',
      },
      {
        payload: '{"kind":"nudge","topic":"t","to":"other-session"}\nSECOND-LINE',
        reachesNode: true,
        message: 'interior-newline drop did not reach node',
      },
      {
        payload: '{"kind":"nudge","topic":"t","to":"other-session"}\n',
        reachesNode: false,
        message: 'trailing-newline foreign drop reached node',
      },
    ];
    for (const scenario of cases) {
      const f = hookFixture();
      inside(f.main, f.root, () => {
        prime(f);
        const notify = join(f.markerDir, '..', 'notify');
        mkdirSync(notify, { recursive: true });
        writeFileSync(join(notify, `${Date.now()}-x.txt`), scenario.payload);
        const { canary, env } = canaryEnv(f.root);
        const r = launch(f.main, 'post-tool', postTool, env);
        assert.equal(r.status, 0);
        assert.equal(existsSync(canary), scenario.reachesNode, scenario.message);
      });
    }
  });

  test('permission always reaches node; garbage stdin fails open', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const { canary, env } = canaryEnv(f.root);
      const p = launch(
        f.main,
        'permission',
        {
          session_id: 's1',
          tool_name: 'exec',
          tool_input: { command: 'bd ready' },
        },
        env
      );
      assert.equal(p.status, 0);
      assert.ok(existsSync(canary), 'permission did not reach node');

      const g = launch(f.main, 'post-tool', 'this is not json at all', env);
      assert.equal(g.status, 0);
    });
  });

  test('garbage stdin reaches node — exit 0 alone is not proof', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      prime(f);
      const { canary, env } = canaryEnv(f.root);
      const g = launch(f.main, 'post-tool', 'this is not json at all', env);
      assert.equal(g.status, 0);
      assert.ok(existsSync(canary), 'malformed payload skipped node');
    });
  });

  test('a cursor-shaped payload reaches node even outside an opted repo', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // foreign-schema detection precedes the opt-in walk — the payload
      // names its own project, so gating on cwd would drop real work
      const nogit = join(f.root, 'nogit');
      mkdirSync(nogit);
      const { canary, env } = canaryEnv(f.root);
      const r = launch(
        nogit,
        'post-tool',
        {
          hook_event_name: 'postToolUse',
          cursor_version: '1.0',
          workspace_roots: [f.main],
          turn_id: 't1',
        },
        env
      );
      assert.equal(r.status, 0);
      assert.ok(existsSync(canary), 'cursor payload skipped node in a non-opted cwd');
    });
  });

  test('a pending drop with spaces in its name still reaches node', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      prime(f);
      const notify = join(f.markerDir, '..', 'notify');
      mkdirSync(notify, { recursive: true });
      // the find loop must not word-split — a split path reads as
      // absent and the pending drop is silently skipped
      writeFileSync(join(notify, `${Date.now()}-a b.txt`), 'hello session\n');
      const { canary, env } = canaryEnv(f.root);
      const r = launch(f.main, 'post-tool', postTool, env);
      assert.equal(r.status, 0);
      assert.ok(existsSync(canary), 'spaced-name drop did not reach node');
    });
  });
});

/** Native-payload conformance (spec bro-l8c4f.8): the fixtures below are
 *  shaped like the payloads each host actually sends — field names and
 *  event names from the upstream docs, and NO artificial `success`
 *  where the host doesn't send one. The contract under test is the
 *  normalization edge: a documented success event must arm, a failure
 *  event must journal without arming, and a host that cannot observe
 *  outcomes (Codex) must still arm while journaling no `ok`. */
describe('hooks e2e — native payload conformance (bro-l8c4f.8)', () => {
  const tracePath = (f: Fixture, sessionId: string): string =>
    join(f.markerDir, 'trace', `${sessionId}.jsonl`);
  const traceRows = (f: Fixture, sessionId: string): Record<string, unknown>[] =>
    readFileSync(tracePath(f, sessionId), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as Record<string, unknown>);

  /** Claude's documented PostToolUse — fires only after a call
   *  succeeds; tool_response is tool-specific and carries no success
   *  boolean. */
  const claudePostTool = (extra: Record<string, unknown> = {}) => ({
    session_id: 's1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '',
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push -u origin feat/x', description: 'Push branch' },
    tool_response: { stdout: 'Everything up-to-date', stderr: '', interrupted: false },
    tool_use_id: 'toolu_01',
    duration_ms: 12,
    ...extra,
  });

  test('claude PostToolUse without a success field still arms and journals ok', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', claudePostTool({ cwd: f.main }));
      assert.equal(r.code, 0);
      assert.equal(markerExists(f, 's1', 'act'), true, 'a documented success event must arm');
      const rows = traceRows(f, 's1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.ok, true);
      assert.equal(rows[0]!.command, 'git push -u origin feat/x');
    });
  });

  test('claude PostToolUseFailure journals ok:false, drains the mailbox, never arms', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const notify = join(f.markerDir, '..', 'notify');
      mkdirSync(notify, { recursive: true });
      writeFileSync(join(notify, 'note-1-x.txt'), 'watcher: convoy landed');
      const r = hook(f, 'post-tool', {
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: f.main,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill', description: 'Create PR' },
        tool_use_id: 'toolu_02',
        error: 'Exit code 1\ngh: must be on a branch',
        is_interrupt: false,
        duration_ms: 4187,
      });
      assert.equal(r.code, 0);
      assert.equal(markerExists(f, 's1', 'act'), false, 'a failure event must not arm');
      assert.match(
        r.stdout,
        /watcher: convoy landed/,
        'the failure event is still a delivery tick'
      );
      // Claude validates hookSpecificOutput.hookEventName against the
      // firing event — a PostToolUseFailure trigger must get its own
      // name back, not 'PostToolUse'
      const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as {
        hookSpecificOutput?: { hookEventName?: string };
      };
      assert.equal(out.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
      const rows = traceRows(f, 's1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.ok, false);
      assert.equal(rows[0]!.command, 'gh pr create --fill');
    });
  });

  test('codex PostToolUse arms on fire and honestly records no outcome', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // Codex's PostToolUse fires on non-zero exits too and there is no
      // failure event — turn_id is the codex-specific field; the arm is
      // the documented over-approximation (the gate re-verifies), and
      // the journal must not invent an `ok`
      const r = hook(f, 'post-tool', {
        session_id: 's1',
        turn_id: 'turn-1',
        cwd: f.main,
        permission_mode: 'default',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        tool_response: 'Everything up-to-date',
        tool_use_id: 'x',
      });
      assert.equal(r.code, 0);
      assert.equal(
        markerExists(f, 's1', 'act'),
        true,
        'codex must still arm — the gate re-verifies'
      );
      const rows = traceRows(f, 's1');
      assert.equal(rows.length, 1);
      assert.equal('ok' in rows[0]!, false, 'codex outcome is unobservable — no ok field');
    });
  });

  test('devin PostToolUse with success:false journals ok:false and does not arm', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', {
        session_id: 's1',
        hook_event_name: 'PostToolUse',
        tool_name: 'exec',
        tool_input: { command: 'git push' },
        tool_response: { success: false, output: 'rejected', error: 'exit 1' },
      });
      assert.equal(r.code, 0);
      assert.equal(markerExists(f, 's1', 'act'), false);
      const rows = traceRows(f, 's1');
      assert.equal(rows[0]!.ok, false);
      assert.equal(rows[0]!.tool, 'exec');
    });
  });

  test('an edit payload journals paths, never a command, and never arms', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // the pi/omp lineage shape — what host.ts emits from a native
      // tool_result: synthesized success, tool-scoped input fields
      const r = hook(f, 'post-tool', {
        session_id: 's1',
        tool_name: 'edit',
        tool_input: { file_path: join(f.main, 'src/x.ts'), old_string: 'a', new_string: 'b' },
        tool_response: { success: true },
      });
      assert.equal(r.code, 0);
      const rows = traceRows(f, 's1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.tool, 'edit');
      assert.deepEqual(rows[0]!.paths, [join(f.main, 'src/x.ts')]);
      assert.equal('command' in rows[0]!, false, 'an edit must not read as a shell command');
      assert.equal(markerExists(f, 's1', 'act'), false, 'edits do not arm command aspects');
    });
  });

  test('claude Stop blocks an armed session once, then stop_hook_active fails open', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      const wt = linked(f, true);
      arm(f, 's1', 'work');
      const first = hook(
        f,
        'stop',
        {
          session_id: 's1',
          hook_event_name: 'Stop',
          stop_hook_active: false,
          last_assistant_message: 'done',
        },
        wt
      );
      assert.equal(first.code, 0);
      assert.match(first.stdout, BLOCK);
      // the host re-fires with stop_hook_active — the second stop must
      // pass: gates, not loops
      const again = hook(
        f,
        'stop',
        {
          session_id: 's1',
          hook_event_name: 'Stop',
          stop_hook_active: true,
          last_assistant_message: 'still done',
        },
        wt
      );
      assert.equal(again.code, 0);
      assert.equal(again.stdout.trim(), '');
    });
  });

  test('a SubagentStop-shaped payload is tolerated, never a session stall', () => {
    const f = hookFixture();
    inside(f.main, f.root, () => {
      // SubagentStop is deliberately unwired on claude — but the shape
      // must fail open if it ever arrives: stop_hook_active honored,
      // exit 0, no decision block on an already-continued event
      const r = hook(f, 'stop', {
        session_id: 's1',
        hook_event_name: 'SubagentStop',
        stop_hook_active: true,
        agent_id: 'a-1',
        agent_type: 'worker',
        agent_transcript_path: '/tmp/sub.jsonl',
        last_assistant_message: 'subtask done',
      });
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, BLOCK);
    });
  });
});
