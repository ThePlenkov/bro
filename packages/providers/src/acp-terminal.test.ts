import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  CreateTerminalRequest,
  KillTerminalRequest,
  ReleaseTerminalRequest,
  TerminalId,
  TerminalOutputRequest,
  WaitForTerminalExitRequest,
} from '@agentclientprotocol/sdk'
import { AcpTerminals } from './acp-terminal.ts'

const create = (command: string, args: string[] = [], outputByteLimit?: number): CreateTerminalRequest => ({
  sessionId: 'sess-1',
  command,
  args,
  ...(outputByteLimit === undefined ? {} : { outputByteLimit }),
})
const out = (terminalId: TerminalId): TerminalOutputRequest => ({ sessionId: 'sess-1', terminalId })
const wait = (terminalId: TerminalId): WaitForTerminalExitRequest => ({ sessionId: 'sess-1', terminalId })
const rel = (terminalId: TerminalId): ReleaseTerminalRequest => ({ sessionId: 'sess-1', terminalId })
const kil = (terminalId: TerminalId): KillTerminalRequest => ({ sessionId: 'sess-1', terminalId })
const ctx = <P>(params: P) => ({ params }) as never

describe('AcpTerminals', () => {
  test('create → wait_for_exit → output → release round-trips a real child', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(ctx(create('sh', ['-c', 'echo terminal-works'])))
      const status = await t.waitForExit(ctx(wait(terminalId)))
      assert.equal(status.exitCode, 0)
      const snap = await t.output(ctx(out(terminalId)))
      assert.match(snap.output, /terminal-works/)
      assert.equal(snap.truncated, false)
      await t.release(ctx(rel(terminalId)))
      assert.throws(() => t.output(ctx(out(terminalId))), /Unknown terminal/)
    } finally {
      t.dispose()
    }
  })

  test('a whole shell line in command (args empty) runs through the shell', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(ctx(create('echo shell-line && echo works')))
      const status = await t.waitForExit(ctx(wait(terminalId)))
      assert.equal(status.exitCode, 0)
      const snap = await t.output(ctx(out(terminalId)))
      assert.match(snap.output, /shell-line\nworks/)
    } finally {
      t.dispose()
    }
  })

  test('output polls while the child still runs, exitStatus lands after', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(
        ctx(create('sh', ['-c', 'echo early; sleep 0.2; echo late']))
      )
      const first = await t.output(ctx(out(terminalId)))
      assert.equal(first.exitStatus ?? null, null)
      await t.waitForExit(ctx(wait(terminalId)))
      const last = await t.output(ctx(out(terminalId)))
      assert.match(last.output, /early/)
      assert.match(last.output, /late/)
      assert.equal(last.exitStatus?.exitCode, 0)
    } finally {
      t.dispose()
    }
  })

  test('outputByteLimit keeps the tail and reports truncated', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(
        ctx(create('sh', ['-c', 'printf %090d 0; echo MARK'], 40))
      )
      await t.waitForExit(ctx(wait(terminalId)))
      const snap = await t.output(ctx(out(terminalId)))
      assert.equal(snap.truncated, true)
      assert.ok(snap.output.length <= 40)
      assert.match(snap.output, /MARK\n?$/)
    } finally {
      t.dispose()
    }
  })

  test('the byte limit trims on a UTF-8 boundary — never a partial character', async () => {
    const t = new AcpTerminals()
    try {
      // 🙂 is 4 bytes — three of them + 'X' = 13 bytes; limit 5 keeps
      // exactly one emoji + X, cut lands mid-emoji and must skip forward
      const { terminalId } = await t.create(
        ctx(create('sh', ['-c', "printf '🙂🙂🙂X'"], 5))
      )
      await t.waitForExit(ctx(wait(terminalId)))
      const snap = await t.output(ctx(out(terminalId)))
      assert.equal(snap.truncated, true)
      assert.equal(snap.output, '🙂X')
    } finally {
      t.dispose()
    }
  })

  test('outputByteLimit 0 keeps the buffer bounded instead of unbounded', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(ctx(create('sh', ['-c', 'echo dropped'], 0)))
      await t.waitForExit(ctx(wait(terminalId)))
      const snap = await t.output(ctx(out(terminalId)))
      assert.equal(snap.output, '')
      assert.equal(snap.truncated, true)
    } finally {
      t.dispose()
    }
  })

  test('agent env merges but denylisted names cannot hijack the child', async () => {
    const t = new AcpTerminals()
    try {
      // NODE_OPTIONS=--require <missing> kills any node child at boot if
      // it leaks through the denylist; BRO_T_VAR proves env still merges
      const req: CreateTerminalRequest = {
        sessionId: 'sess-1',
        command: process.execPath,
        args: ['-e', 'console.log("env-ok-" + (process.env.BRO_T_VAR ?? "missing"))'],
        env: [
          { name: 'NODE_OPTIONS', value: '--require /nonexistent-bro-test' },
          { name: 'BRO_T_VAR', value: 'yes' },
        ],
      }
      const { terminalId } = await t.create(ctx(req))
      const status = await t.waitForExit(ctx(wait(terminalId)))
      assert.equal(status.exitCode, 0)
      const snap = await t.output(ctx(out(terminalId)))
      assert.match(snap.output, /env-ok-yes/)
    } finally {
      t.dispose()
    }
  })

  test('denylist matches case-insensitively — case variants cannot smuggle hijack vars', async () => {
    const t = new AcpTerminals()
    try {
      // win32 treats Path == PATH — a case-sensitive has() leaks the
      // hijack; brO_t_var proves normal mixed-case names still merge
      const req: CreateTerminalRequest = {
        sessionId: 'sess-1',
        command: 'sh',
        args: ['-c', 'echo "p=[$pAtH] v=[$brO_t_var]"'],
        env: [
          { name: 'pAtH', value: '/evil' },
          { name: 'brO_t_var', value: 'yes' },
        ],
      }
      const { terminalId } = await t.create(ctx(req))
      const status = await t.waitForExit(ctx(wait(terminalId)))
      assert.equal(status.exitCode, 0)
      const snap = await t.output(ctx(out(terminalId)))
      assert.match(snap.output, /p=\[\] v=\[yes\]/)
    } finally {
      t.dispose()
    }
  })

  test('release resolves a pending wait_for_exit with the real status', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(ctx(create('sh', ['-c', 'sleep 60'])))
      const pending = t.waitForExit(ctx(wait(terminalId)))
      await t.release(ctx(rel(terminalId)))
      const status = await pending
      assert.equal(status.signal, 'SIGKILL')
    } finally {
      t.dispose()
    }
  })

  test('release after exit flushes waiters even while a grandchild holds the pipe', async () => {
    const t = new AcpTerminals()
    try {
      // the backgrounded subshell inherits stdout — 'exit' fires for the
      // main child while 'close' is held open until the sleep ends
      const { terminalId } = await t.create(ctx(create('sh', ['-c', 'sleep 5 & exit 0'])))
      for (let i = 0; i < 100; i++) {
        const snap = await t.output(ctx(out(terminalId)))
        if (snap.exitStatus !== null) {
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      const pending = t.waitForExit(ctx(wait(terminalId)))
      await t.release(ctx(rel(terminalId)))
      const status = await pending
      assert.equal(status.exitCode, 0)
    } finally {
      t.dispose()
    }
  })

  test('kill stops the child but the terminal stays readable until release', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(ctx(create('sh', ['-c', 'echo hi; sleep 60'])))
      // wait for the first output to land — SIGTERM before the flush
      // races the 'data' event and the test reads an empty buffer
      for (let i = 0; i < 100; i++) {
        const snap = await t.output(ctx(out(terminalId)))
        if (snap.output.includes('hi')) {
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      await t.kill(ctx(kil(terminalId)))
      const status = await t.waitForExit(ctx(wait(terminalId)))
      assert.equal(status.signal, 'SIGTERM')
      const snap = await t.output(ctx(out(terminalId)))
      assert.match(snap.output, /hi/)
      assert.equal(snap.exitStatus?.signal, 'SIGTERM')
    } finally {
      t.dispose()
    }
  })

  test('a leaked long-running child dies with dispose', async () => {
    const t = new AcpTerminals()
    const { terminalId } = await t.create(ctx(create('sh', ['-c', 'sleep 60'])))
    t.dispose()
    assert.throws(() => t.output(ctx(out(terminalId))), /Unknown terminal/)
  })

  test('unknown terminal ids fail loud on every verb', async () => {
    const t = new AcpTerminals()
    const missing = 'term-nope' as TerminalId
    assert.throws(() => t.output(ctx(out(missing))), /Unknown terminal/)
    assert.throws(() => t.kill(ctx(kil(missing))), /Unknown terminal/)
    assert.throws(() => t.release(ctx(rel(missing))), /Unknown terminal/)
    await assert.rejects(async () => {
      await t.waitForExit(ctx(wait(missing)))
    }, /Unknown terminal/)
  })
})
