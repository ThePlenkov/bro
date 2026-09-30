/** `bro check` e2e — the spawned CLI against a fake sverka on PATH.
 *  Exit codes and the JSON envelope are the assertion targets, so these
 *  run through runCli (the built dist), not in-process. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo, runCli } from './testrepo.ts'

const FAKE_SVERKA = `#!/usr/bin/env node
console.log(JSON.stringify({ command: 'run', data: { planId: 'rp-e2e', status: 'success', steps: [
  { stepId: 'p/a', status: 'succeeded', durationMs: 12, exitCode: 0 },
] }, durationMs: 15 }))
`

/** Repo + a bin/ dir carrying the fake sverka; PATH points at it. */
function fixture(): { root: string; main: string; binDir: string } {
  const { root, main } = initRepo('bro-check-e2e-')
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  const sverka = join(binDir, 'sverka')
  writeFileSync(sverka, FAKE_SVERKA)
  chmodSync(sverka, 0o755)
  return { root, main, binDir }
}

function env(binDir: string): Record<string, string> {
  return { PATH: `${binDir}:${process.env.PATH}` }
}

describe('bro check e2e', () => {
  test('happy path — step lines, totals, exit 0', () => {
    const { root, main, binDir } = fixture()
    try {
      const r = runCli(['check'], { cwd: main, env: env(binDir) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /✓ p\/a 12ms/)
      assert.match(r.stdout, /1 steps · 1 ok — 15ms/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--json passes sverka data through under the check envelope', () => {
    const { root, main, binDir } = fixture()
    try {
      const r = runCli(['check', '--json'], { cwd: main, env: env(binDir) })
      assert.equal(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as {
        command: string
        data: { planId?: string; status?: string; steps?: unknown[] }
        durationMs: number
      }
      assert.equal(out.command, 'check')
      assert.equal(out.data.planId, 'rp-e2e')
      assert.equal(out.data.status, 'success')
      assert.equal(out.data.steps?.length, 1)
      assert.equal(out.durationMs, 15)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('unknown option and stray positional exit 2', () => {
    const { root, main, binDir } = fixture()
    try {
      for (const args of [['check', '--evalute'], ['check', 'bogus-arg']]) {
        const r = runCli(args, { cwd: main, env: env(binDir) })
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, /bro check --help/)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
