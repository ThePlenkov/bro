import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      // cmd writes \r\n — normalize so the assertion is platform-neutral
      assert.match(snap.output.replaceAll('\r\n', '\n'), /shell-line\nworks/)
    } finally {
      t.dispose()
    }
  })

  test('an args-empty command that is an executable path — spaces included — runs directly', async (t_) => {
    if (process.platform === 'win32') {
      t_.skip('needs a chmod-able shebang script')
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'bro term '))
    try {
      const script = join(dir, 'check')
      writeFileSync(script, '#!/bin/sh\necho spaced-path-ok\n')
      chmodSync(script, 0o755)
      const t = new AcpTerminals()
      try {
        const { terminalId } = await t.create(ctx(create(script)))
        const status = await t.waitForExit(ctx(wait(terminalId)))
        assert.equal(status.exitCode, 0)
        const snap = await t.output(ctx(out(terminalId)))
        assert.match(snap.output, /spaced-path-ok/)
      } finally {
        t.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a shell line longer than the file-name limit still runs — ENAMETOOLONG falls back too', async () => {
    const t = new AcpTerminals()
    try {
      const { terminalId } = await t.create(ctx(create(`echo ${'x'.repeat(300)}`)))
      const status = await t.waitForExit(ctx(wait(terminalId)))
      assert.equal(status.exitCode, 0)
      const snap = await t.output(ctx(out(terminalId)))
      assert.match(snap.output, /x{300}/)
    } finally {
      t.dispose()
    }
  })

  test('a fallback spawn never outruns cleanup — dispose during ENOENT starts no work', async () => {
    const t = new AcpTerminals()
    const { terminalId } = await t.create(ctx(create('no-such-cmd-zzz && echo leaked')))
    const pending = t.waitForExit(ctx(wait(terminalId)))
    // dispose lands before the async 'error' tick — without the stopped
    // gate a shell would spawn now and the waiter would resolve {127}
    t.dispose()
    const status = await pending
    assert.equal(status.exitCode, null)
    assert.equal(status.signal, null)
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

  test('follow returns the atomic snapshot, then live data and exit (bro-eua0d)', async () => {
    const t = new AcpTerminals()
    try {
      assert.equal(t.size, 0)
      const { terminalId } = await t.create(
        ctx(create('sh', ['-c', 'echo first; sleep 60']))
      )
      assert.equal(t.size, 1)
      const chunks: string[] = []
      const exits: unknown[] = []
      const f = t.follow(terminalId, {
        data: (c) => chunks.push(c),
        exit: (s) => exits.push(s),
      })
      assert.equal(f.completed, false, 'live terminal — taps attached')
      // wait for 'first' — either already in the snapshot or a live chunk
      for (let i = 0; i < 100 && ![f.snapshot.output, ...chunks].join('').includes('first'); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.match([f.snapshot.output, ...chunks].join(''), /first/)
      await t.kill(ctx(kil(terminalId)))
      for (let i = 0; i < 100 && exits.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.equal(exits.length, 1, 'the exit tap fires once')
      assert.equal((exits[0] as { signal: string }).signal, 'SIGTERM')
      // a completed terminal still follows — snapshot carries the verdict,
      // no callbacks fire, stop is a no-op
      const dead = t.follow(terminalId, {
        data: () => assert.fail('no data on a completed terminal'),
        exit: () => assert.fail('no exit on a completed terminal'),
      })
      assert.equal(dead.completed, true, 'final terminal — no taps, snapshot is the verdict')
      assert.equal(dead.snapshot.exitStatus?.signal, 'SIGTERM')
      dead.stop()
      f.stop()
      assert.throws(() => t.follow('term-nope' as TerminalId, { data: () => {}, exit: () => {} }), /Unknown terminal/)
      assert.throws(() => t.snapshot('term-nope' as TerminalId), /Unknown terminal/)
    } finally {
      t.dispose()
    }
  })

  test('a follow mid-character skips decoder-pending bytes — no doubled U+FFFD', async () => {
    const t = new AcpTerminals()
    try {
      // 😀 is f0 9f 98 80 — the lead byte lands alone, the rest after a
      // delay, so the entry decoder sits mid-character at follow() time
      const { terminalId } = await t.create(
        ctx(create('sh', ['-c', "printf '\\360'; sleep 0.5; printf '\\237\\230\\200'"]))
      )
      // poll until the lead byte is buffered — through snapshot()'s
      // plain toString a lone pending byte reads as U+FFFD
      for (let i = 0; i < 100 && !t.snapshot(terminalId).output.includes('\uFFFD'); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.match(t.snapshot(terminalId).output, /\uFFFD/, 'setup — the decoder holds a partial char')
      const chunks: string[] = []
      const f = t.follow(terminalId, {
        data: (c) => chunks.push(c),
        exit: () => {},
      })
      assert.equal(f.completed, false)
      assert.equal(
        f.snapshot.output,
        '',
        'the pending byte stays with the live decoder — the tap emits the whole char once'
      )
      for (let i = 0; i < 200 && !chunks.join('').includes('😀'); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.equal(chunks.join(''), '😀')
      f.stop()
    } finally {
      t.dispose()
    }
  })
})
