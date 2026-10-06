/** Hook-gate e2e — `bro hooks <event>` spawned as the real CLI the way
 *  plugin hosts invoke it: JSON on stdin, control JSON on stdout, exit 0
 *  or the session stalls. The matrix covers the two contracts a
 *  regression here would silently break: fail-open (a wedged/missing
 *  probe never stalls a session) and arming (only a session that touched
 *  the thing is blocked; ambient state is passive context). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  CLI_DIST,
  e2eEnv,
  git,
  initRepo,
  installFakeBd,
  inside,
  runCli,
} from './testrepo.ts'
import { spawnSync } from 'node:child_process'

interface Fixture {
  root: string
  main: string
  /** <git-common>/bro/hooks — shared across linked worktrees. */
  markerDir: string
}

function hookFixture(): Fixture {
  const { root, main } = initRepo('bro-hooks-e2e-', (m) => {
    writeFileSync(join(m, 'bro.config.json'), '{}')
  })
  // --git-common-dir is relative ('.git') in the main worktree
  const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim())
  return { root, main, markerDir: join(common, 'bro', 'hooks') }
}

/** Arm `aspect` for a session by writing the same marker post-tool
 *  would — the file is the contract, not the classifier. */
function arm(f: Fixture, sessionId: string, aspect: string, detail = 'x'): void {
  mkdirSync(f.markerDir, { recursive: true })
  writeFileSync(join(f.markerDir, `${sessionId}.${aspect}`), `${Date.now()}\n${detail}\n`)
}

const markerExists = (f: Fixture, sessionId: string, aspect: string): boolean =>
  existsSync(join(f.markerDir, `${sessionId}.${aspect}`))

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
  })
}

/** A linked worktree, optionally dirty. */
function linked(f: Fixture, dirty: boolean): string {
  const wt = join(f.root, 'main--w')
  git(['worktree', 'add', '-q', wt, '-b', 'work/w'], f.main)
  if (dirty) {
    writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n')
  }
  return wt
}

const BLOCK = /"decision":"block"/

describe('hooks e2e — stop gate', () => {
  test('armed work session in a dirty linked worktree is blocked', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const wt = linked(f, true)
      arm(f, 's1', 'work')
      const r = hook(f, 'stop', { session_id: 's1' }, wt)
      assert.equal(r.code, 0)
      assert.match(r.stdout, BLOCK)
      assert.match(r.stdout, /uncommitted/)
    })
  })

  test('unarmed session in the same dirty worktree is not blocked — ambient is passive', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const wt = linked(f, true)
      const r = hook(f, 'stop', { session_id: 's2' }, wt)
      assert.equal(r.code, 0)
      assert.doesNotMatch(r.stdout, BLOCK)
    })
  })

  test('stop_hook_active suppresses the block — gates, not loops', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const wt = linked(f, true)
      arm(f, 's1', 'work')
      const r = hook(f, 'stop', { session_id: 's1', stop_hook_active: true }, wt)
      assert.equal(r.code, 0)
      assert.equal(r.stdout.trim(), '')
    })
  })

  test('armed work session in a clean worktree gets the hint, not a block', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const wt = linked(f, false)
      arm(f, 's1', 'work')
      const r = hook(f, 'stop', { session_id: 's1' }, wt)
      assert.equal(r.code, 0)
      assert.doesNotMatch(r.stdout, BLOCK)
      assert.match(r.stdout, /bro work leave/)
    })
  })
})

describe('hooks e2e — post-tool arming', () => {
  const postTool = (cmd: string, success = true) => ({
    tool_input: { command: cmd },
    tool_response: { success },
    session_id: 's1',
  })

  test('git push arms the act aspect', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('git push origin work/x'))
      assert.equal(r.code, 0)
      assert.equal(markerExists(f, 's1', 'act'), true)
    })
  })

  test('bro work enter arms work + task and cites the governing skill', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('bro work enter fx-9'))
      assert.equal(r.code, 0)
      assert.equal(markerExists(f, 's1', 'work'), true)
      assert.equal(markerExists(f, 's1', 'task'), true)
      assert.match(r.stdout, /skills\/work\/SKILL\.md/)
    })
  })

  test('a failed tool call arms nothing', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('git push origin work/x', false))
      assert.equal(r.code, 0)
      assert.equal(markerExists(f, 's1', 'act'), false)
    })
  })
})

describe('hooks e2e — session trace journal', () => {
  /** <git-common>/bro/hooks/trace/<session>.jsonl */
  const tracePath = (f: Fixture, sessionId: string): string =>
    join(f.markerDir, 'trace', `${sessionId}.jsonl`)

  test('every post-tool event journals one trace line — success or not', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const ok = hook(f, 'post-tool', {
        tool_name: 'exec',
        tool_input: { command: 'true' },
        tool_response: { success: true },
        session_id: 's1',
      })
      assert.equal(ok.code, 0)
      const fail = hook(f, 'post-tool', {
        tool_name: 'edit',
        tool_input: { file_path: join(f.main, 'x.ts') },
        tool_response: { success: false },
        session_id: 's1',
      })
      // the fail-open contract covers failed landings too — a nonzero
      // exit here would stall the session while the journal still passes
      assert.equal(fail.code, 0)
      const lines = readFileSync(tracePath(f, 's1'), 'utf8').trim().split('\n')
      assert.equal(lines.length, 2)
      const first = JSON.parse(lines[0]!) as Record<string, unknown>
      assert.equal(first.tool, 'exec')
      assert.equal(first.command, 'true')
      assert.equal(first.ok, true)
      const second = JSON.parse(lines[1]!) as Record<string, unknown>
      assert.equal(second.tool, 'edit')
      assert.deepEqual(second.paths, [join(f.main, 'x.ts')])
      assert.equal(second.ok, false)
      // the journal is a subdir — never a flat <session>.trace.jsonl
      // sibling the stop gate would read as an arming aspect
      assert.equal(existsSync(join(f.markerDir, 's1.trace.jsonl')), false)
    })
  })

  test('the journal trims to the keep window once it crosses the byte cap', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      // >256KB of prior events — the next append must drop the oldest
      const prior = Array.from({ length: 600 }, (_, i) =>
        JSON.stringify({ ts: i, tool: 'exec', command: `c${i} ${'x'.repeat(512)}` })
      )
      mkdirSync(join(f.markerDir, 'trace'), { recursive: true })
      writeFileSync(tracePath(f, 's1'), `${prior.join('\n')}\n`)
      const r = hook(f, 'post-tool', {
        tool_name: 'exec',
        tool_input: { command: 'true' },
        tool_response: { success: true },
        session_id: 's1',
      })
      assert.equal(r.code, 0)
      const lines = readFileSync(tracePath(f, 's1'), 'utf8').trim().split('\n')
      assert.equal(lines.length, 500)
      const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>
      assert.equal(last.command, 'true')
    })
  })

  test('no session id → no journal', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', {
        tool_input: { command: 'true' },
        tool_response: { success: true },
      })
      assert.equal(r.code, 0)
      assert.equal(existsSync(join(f.markerDir, 'trace')), false)
    })
  })
})

describe('hooks e2e — post-tool mailbox drain', () => {
  /** <git-common>/bro/notify — sibling of the marker dir. */
  const mailbox = (f: Fixture): string => join(f.markerDir, '..', 'notify')
  const postTool = (sessionId: string, success = true) => ({
    tool_input: { command: 'true' },
    tool_response: { success },
    session_id: sessionId,
  })

  test('a pending drop is injected once per session — broadcast, not first-consumer-wins', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      mkdirSync(mailbox(f), { recursive: true })
      writeFileSync(join(mailbox(f), 'note-1-ab12.txt'), 'watcher: gate ready on s-9')
      const r = hook(f, 'post-tool', postTool('s1'))
      assert.equal(r.code, 0)
      assert.match(r.stdout, /PostToolUse/)
      assert.match(r.stdout, /mailbox message/)
      assert.match(r.stdout, /watcher: gate ready on s-9/)
      // delivered once to s1 — a second probe stays quiet…
      const again = hook(f, 'post-tool', postTool('s1'))
      assert.doesNotMatch(again.stdout, /watcher: gate ready/)
      // …but the drop stays for other sessions — the intended
      // parent isn't eaten by whoever drained first
      const other = hook(f, 'post-tool', postTool('s2'))
      assert.match(other.stdout, /watcher: gate ready on s-9/)
    })
  })

  test('a failed tool call is still a delivery tick — and does not re-deliver', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      mkdirSync(mailbox(f), { recursive: true })
      writeFileSync(join(mailbox(f), 'note-1-ab12.txt'), 'fixer died')
      const r = hook(f, 'post-tool', postTool('s1', false))
      assert.match(r.stdout, /fixer died/)
      const again = hook(f, 'post-tool', postTool('s1'))
      assert.doesNotMatch(again.stdout, /fixer died/)
    })
  })

  test('an empty mailbox emits nothing', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', postTool('s1'))
      assert.equal(r.code, 0)
      assert.equal(r.stdout.trim(), '')
    })
  })
})

describe('hooks e2e — permission + fail-open', () => {
  test('permission auto-approves bro/bd, stays silent on other tools', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const ok = hook(f, 'permission', { tool_input: { command: 'bd ready -n 5' } })
      assert.equal(ok.code, 0)
      assert.match(ok.stdout, /"decision":"approve"/)
      const no = hook(f, 'permission', { tool_input: { command: 'rm -rf build' } })
      assert.equal(no.code, 0)
      assert.doesNotMatch(no.stdout, /approve/)
    })
  })

  test('garbage stdin, unknown events, and non-bro dirs all fail open', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const bad = runCli(['hooks', 'stop'], { cwd: f.main, input: '{not json' })
      assert.equal(bad.code, 0)
      const unknown = hook(f, 'future-event', { session_id: 's1' })
      assert.equal(unknown.code, 0)
      // a directory that never opted in (no bro.config.json/.beads) —
      // walk-up may still find an ambient store above tmpdir, so the
      // contract is exit 0 + never a block, not silence
      const bare = join(f.root, 'bare')
      mkdirSync(bare)
      const outside = hook(f, 'stop', { session_id: 's1' }, bare)
      assert.equal(outside.code, 0)
      assert.doesNotMatch(outside.stdout, BLOCK)
    })
  })
})

describe('hooks e2e — commit provenance (prepare-commit-msg)', () => {
  const msgFile = (f: Fixture): string => join(f.main, 'COMMIT_MSG.txt')

  /** A `bro` on PATH that execs the CLI under test — what the installed
   *  shim resolves first (the npx fallback would hit the network). */
  const fakeBro = (f: Fixture): string => {
    const bin = join(f.root, 'brobin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'bro'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_DIST}" "$@"\n`)
    spawnSync('chmod', ['+x', join(bin, 'bro')])
    return bin
  }

  test('the event writes env-pinned trailers into the message file', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      writeFileSync(msgFile(f), 'feat: thing\n')
      const r = runCli(['hooks', 'prepare-commit-msg', msgFile(f)], {
        cwd: f.main,
        env: {
          AI_AGENT: 'devin_3000-11-3_agent',
          BRO_SESSION_ID: 'native-abc',
          BRO_BEAD_ID: 'fx-9',
        },
      })
      assert.equal(r.code, 0)
      const msg = readFileSync(msgFile(f), 'utf8')
      assert.match(msg, /^Agent: devin$/m)
      assert.match(msg, /^Session: native-abc$/m)
      assert.match(msg, /^Bead: fx-9$/m)
    })
  })

  test('the molecule parent resolves through bd show — and a repeat run adds nothing', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const { binDir, db } = installFakeBd(f.root, [
        { id: 'fx-9', parent: 'fx-mol-1', status: 'in_progress' },
      ])
      writeFileSync(msgFile(f), 'feat: thing\n')
      const env = {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_BD_DB: db,
        BRO_AGENT: 'devin',
        BRO_BEAD_ID: 'fx-9',
      }
      const r = runCli(['hooks', 'prepare-commit-msg', msgFile(f)], { cwd: f.main, env })
      assert.equal(r.code, 0)
      const once = readFileSync(msgFile(f), 'utf8')
      assert.match(once, /^Molecule: fx-mol-1$/m)
      runCli(['hooks', 'prepare-commit-msg', msgFile(f)], { cwd: f.main, env })
      const twice = readFileSync(msgFile(f), 'utf8')
      assert.equal(twice, once) // doNothing — provenance is first-writer-wins
      assert.equal(twice.match(/^Agent:/gm)?.length, 1)
    })
  })

  test('install writes the shim and a real commit lands trailers end-to-end', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const inst = runCli(['hooks', 'install'], { cwd: f.main })
      assert.equal(inst.code, 0, inst.stderr)
      const shim = join(f.main, '.git', 'hooks', 'prepare-commit-msg')
      assert.equal(existsSync(shim), true)
      writeFileSync(join(f.main, 'work.txt'), 'x\n')
      git(['add', '-A'], f.main)
      const commit = spawnSync('git', ['commit', '-qm', 'feat: tagged'], {
        cwd: f.main,
        env: e2eEnv({
          PATH: `${fakeBro(f)}:${process.env.PATH}`,
          AI_AGENT: 'devin_3000-11-3_agent',
          BRO_BEAD_ID: 'fx-9',
        }),
        encoding: 'utf8',
      })
      assert.equal(commit.status, 0, commit.stderr)
      const body = git(['log', '-1', '--format=%B'], f.main)
      assert.match(body, /^Agent: devin$/m)
      assert.match(body, /^Bead: fx-9$/m)
      // uninstall restores a clean hooks dir
      const un = runCli(['hooks', 'uninstall'], { cwd: f.main })
      assert.equal(un.code, 0)
      assert.equal(existsSync(shim), false)
    })
  })

  test('a config-less repo still tags — the installed shim is the opt-in, not broEnabled', () => {
    const { root, main } = initRepo('bro-githooks-bare-') // no bro.config.json/.beads
    inside(main, root, () => {
      writeFileSync(join(main, 'm.txt'), 'feat: x\n')
      const r = runCli(['hooks', 'prepare-commit-msg', join(main, 'm.txt')], {
        cwd: main,
        env: { AI_AGENT: 'devin_1' },
      })
      assert.equal(r.code, 0)
      assert.match(readFileSync(join(main, 'm.txt'), 'utf8'), /^Agent: devin$/m)
    })
  })
})

function cursorPayload(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: event,
    cursor_version: '1.7.2',
    conversation_id: 's1',
    ...extra,
  }
}

describe('hooks e2e — cursor schema', () => {
  test('session-start emits additional_context, not the Claude envelope', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'session-start', cursorPayload('sessionStart', { session_id: 's1' }))
      assert.equal(r.code, 0)
      assert.match(r.stdout, /"additional_context":/)
      assert.match(r.stdout, /parallel-friendly/)
      assert.doesNotMatch(r.stdout, /hookSpecificOutput/)
    })
  })

  test('postToolUse arms from tool_input.command and emits additional_context', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(
        f,
        'post-tool',
        cursorPayload('postToolUse', {
          tool_name: 'Shell',
          tool_input: { command: 'gh pr merge 3 --squash' },
        })
      )
      assert.equal(r.code, 0)
      assert.match(r.stdout, /additional_context/)
      assert.match(r.stdout, /bro debt collect/)
      assert.equal(markerExists(f, 's1', 'act'), true)
    })
  })

  test('postToolUseFailure does not arm', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(
        f,
        'post-tool',
        cursorPayload('postToolUseFailure', { tool_input: { command: 'git push' } })
      )
      assert.equal(r.code, 0)
      assert.equal(markerExists(f, 's1', 'act'), false)
      assert.doesNotMatch(r.stdout, /additional_context/)
    })
  })

  test('stop follow-up fires once; a later loop_count and an abort stay quiet', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const wt = linked(f, true)
      arm(f, 's1', 'work')
      const first = hook(f, 'stop', cursorPayload('stop', { status: 'completed', loop_count: 0 }), wt)
      assert.equal(first.code, 0)
      assert.match(first.stdout, /"followup_message":/)
      assert.match(first.stdout, /uncommitted/)
      assert.doesNotMatch(first.stdout, /"decision"/)
      const again = hook(f, 'stop', cursorPayload('stop', { status: 'completed', loop_count: 1 }), wt)
      assert.equal(again.stdout.trim(), '')
      const aborted = hook(f, 'stop', cursorPayload('stop', { status: 'aborted', loop_count: 0 }), wt)
      assert.equal(aborted.stdout.trim(), '')
    })
  })

  test('permission in a repo that has not opted in still answers', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const bare = join(f.root, 'bare')
      mkdirSync(bare)
      const env = { XDG_STATE_HOME: join(f.root, 'xdg-state') }
      const allow = runCli(['hooks', 'permission'], {
        cwd: bare,
        input: JSON.stringify(cursorPayload('beforeShellExecution', { command: 'bd ready' })),
        env,
      })
      assert.equal(allow.code, 0)
      assert.match(allow.stdout, /"permission":"allow"/)
      const ask = runCli(['hooks', 'permission'], {
        cwd: bare,
        input: JSON.stringify(cursorPayload('beforeShellExecution', { command: 'bro act status && true' })),
        env,
      })
      assert.equal(ask.code, 0)
      assert.match(ask.stdout, /"permission":"ask"/)
    })
  })

  test('permission allows a self-tool and asks on a chain', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const allow = hook(f, 'permission', cursorPayload('beforeShellExecution', { command: 'bd ready -n 5' }))
      assert.match(allow.stdout, /"permission":"allow"/)
      const ask = hook(
        f,
        'permission',
        cursorPayload('beforeShellExecution', { command: 'bro act status && rm -rf x' })
      )
      assert.match(ask.stdout, /"permission":"ask"/)
      assert.doesNotMatch(ask.stdout, /allow/)
    })
  })

  test('the first prompt rehydrates once; preCompact lets the next prompt do it again', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      arm(f, 'other-session', 'work', 'fx-9')
      const first = hook(f, 'prompt-submit', cursorPayload('beforeSubmitPrompt', { prompt: 'hello' }))
      assert.match(first.stdout, /additional_context/)
      assert.match(first.stdout, /fx-9/)
      assert.match(first.stdout, /"continue":true/)
      const second = hook(f, 'prompt-submit', cursorPayload('beforeSubmitPrompt', { prompt: 'hello again' }))
      assert.doesNotMatch(second.stdout, /fx-9/)
      hook(f, 'pre-compact', cursorPayload('preCompact'))
      const third = hook(f, 'prompt-submit', cursorPayload('beforeSubmitPrompt', { prompt: 'after compact' }))
      assert.match(third.stdout, /fx-9/)
    })
  })

  test('session-start marks the session hydrated so the next prompt does not repeat it', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      arm(f, 'other-session', 'work', 'fx-9')
      const start = hook(f, 'session-start', cursorPayload('sessionStart', { session_id: 's1' }))
      assert.match(start.stdout, /fx-9/)
      const prompt = hook(f, 'prompt-submit', cursorPayload('beforeSubmitPrompt', { prompt: 'hello' }))
      assert.doesNotMatch(prompt.stdout, /fx-9/)
    })
  })

  test('CURSOR_PROJECT_DIR wins over cwd; a non-cursor payload ignores it', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const elsewhere = join(f.root, 'elsewhere')
      mkdirSync(elsewhere)
      const wt = linked(f, true)
      arm(f, 's1', 'work')
      const env = { CURSOR_PROJECT_DIR: wt, XDG_STATE_HOME: join(f.root, 'xdg-state') }
      const hit = runCli(['hooks', 'stop'], {
        cwd: elsewhere,
        input: JSON.stringify(cursorPayload('stop', { status: 'completed', loop_count: 0 })),
        env,
      })
      assert.equal(hit.code, 0)
      assert.match(hit.stdout, /followup_message/)
      assert.match(hit.stdout, /uncommitted/)
      const miss = runCli(['hooks', 'stop'], {
        cwd: elsewhere,
        input: JSON.stringify({ session_id: 's1' }),
        env,
      })
      assert.equal(miss.code, 0)
      assert.doesNotMatch(miss.stdout, /followup_message/)
      assert.doesNotMatch(miss.stdout, /"decision"/)
    })
  })

  test('workspace_roots is the project when cwd is outside the repo', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const elsewhere = join(f.root, 'elsewhere')
      mkdirSync(elsewhere)
      const wt = linked(f, true)
      arm(f, 's1', 'work')
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
      })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /followup_message/)
      assert.match(r.stdout, /uncommitted/)
    })
  })
})

describe('hooks e2e — session-start + the run.sh launcher', () => {
  test('session-start in the main checkout emits the parallel-friendly nudge', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'session-start', { session_id: 's1' })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /parallel-friendly/)
    })
  })

  test("a foreign session's live work marker surfaces as passive context", () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      arm(f, 'other-session', 'work', 'fx-9')
      const r = hook(f, 'session-start', { session_id: 's1' })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /parallel work detected/)
      assert.match(r.stdout, /fx-9/)
    })
  })

  // the launcher is part of the fail-open contract — it's what plugin
  // hosts actually exec; dist must resolve without PATH help
  const RUN_SH = resolve(CLI_DIST, '..', '..', '..', '..', 'hooks', 'run.sh')
  const runSh = (cwd: string, event: string, input: string) =>
    spawnSync('sh', [RUN_SH, event], { cwd, input, env: e2eEnv(), encoding: 'utf8' })

  test('run.sh emits the armed dirty-worktree block through the real launch path', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const wt = linked(f, true)
      arm(f, 's1', 'work')
      const r = runSh(wt, 'stop', JSON.stringify({ session_id: 's1' }))
      assert.equal(r.status, 0)
      assert.match(r.stdout, BLOCK)
    })
  })

  test('run.sh exits 0 on an unknown event — hooks never stall the session', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = runSh(f.main, 'bogus-event', '{}')
      assert.equal(r.status, 0)
    })
  })

  test('pre-tool is a known event — silent and green while no connector guards', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'pre-tool', {
        session_id: 's1',
        tool_name: 'bash',
        tool_input: { command: 'gh pr merge 12' },
      })
      assert.equal(r.code, 0)
      assert.equal(r.stdout.trim(), '')
    })
  })
})

describe('hooks e2e — perf journal', () => {
  test('a hook event journals per-probe timings plus the event total', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      const r = hook(f, 'post-tool', {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { success: true },
      })
      assert.equal(r.code, 0)
      const journal = join(f.markerDir, 'perf', 's1.jsonl')
      assert.ok(existsSync(journal), 'perf journal must exist after a hook event')
      const rows = readFileSync(journal, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      assert.ok(
        rows.some((x) => x.probe === 'postTool' && typeof x.connector === 'string'),
        'per-probe rows name their connector'
      )
      assert.ok(
        rows.some((x) => x.probe === undefined && x.event === 'post-tool' && typeof x.ms === 'number'),
        'the event total row closes the batch'
      )
    })
  })

  test('bro hooks perf aggregates the journal — probe stats and totals', () => {
    const f = hookFixture()
    inside(f.main, f.root, () => {
      hook(f, 'post-tool', {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { success: true },
      })
      const r = runCli(['hooks', 'perf'], { cwd: f.main })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /post-tool postTool \w+/)
      assert.match(r.stdout, /totals/)
      assert.match(r.stdout, /post-tool/)
      const j = runCli(['hooks', 'perf', '--json'], { cwd: f.main })
      const doc = JSON.parse(j.stdout) as { rows: unknown[] }
      assert.ok(Array.isArray(doc.rows) && doc.rows.length > 0)
    })
  })
})
