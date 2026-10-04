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
})
