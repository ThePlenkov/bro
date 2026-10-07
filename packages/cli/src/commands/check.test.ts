import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkSection,
  renderText,
  resolveSverka,
  runCheck,
  type CheckReport,
} from './check.ts'

/** Scripted sverka — a node shim (shebang + chmod like testrepo's fake
 *  bd). MODE env picks the payload; SVERKA_ARGS_LOG records argv so
 *  flag pass-through is assertable. */
const FAKE_SVERKA = `#!/usr/bin/env node
const fs = require('node:fs')
if (process.env.SVERKA_ARGS_LOG) {
  fs.writeFileSync(process.env.SVERKA_ARGS_LOG, JSON.stringify(process.argv.slice(2)))
}
const mode = process.env.FAKE_SVERKA_MODE || 'success'
if (process.argv.includes('--evaluate') && mode === 'collect-fails') {
  console.log(JSON.stringify({ command: 'run', error: 'COLLECTION_FAILED', message: 'artifact directory not found' }))
  process.exit(3)
}
switch (mode) {
  case 'success':
    console.log(JSON.stringify({ command: 'run', data: { planId: 'rp-1', status: 'success', steps: [
      { stepId: 'scan/a', status: 'succeeded', durationMs: 1200, stdout: 'a ok', stderr: '', exitCode: 0 },
      { stepId: 'scan/b', status: 'succeeded', durationMs: 34, exitCode: 0 },
    ] }, durationMs: 1500 }))
    break
  case 'evaluate':
    console.log(JSON.stringify({ command: 'run', data: { planId: 'rp-2', status: 'success', steps: [
      { stepId: 'lint', status: 'succeeded', durationMs: 10, exitCode: 0 },
    ], findings: 3, verdict: 'warn', summary: { error: 0, warning: 3 } }, durationMs: 20 }))
    break
  case 'failed':
    console.log(JSON.stringify({ command: 'run', data: { planId: 'rp-3', status: 'failure', steps: [
      { stepId: 'scan/a', status: 'succeeded', durationMs: 5, exitCode: 0 },
      { stepId: 'scan/b', status: 'failed', durationMs: 7, exitCode: 2, stderr: 'boom\\nmore boom' },
    ] }, durationMs: 12 }))
    process.exit(1)
    break
  case 'collect-fails':
    console.log(JSON.stringify({ command: 'run', data: { planId: 'rp-4', status: 'success', steps: [
      { stepId: 'scan/a', status: 'succeeded', durationMs: 5, exitCode: 0 },
    ] }, durationMs: 6 }))
    break
  case 'garbage':
    console.log('not json at all')
    process.exit(1)
    break
  default:
    process.exit(9)
}
`

function tmpdirWith(prefix: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeSverka(dir: string): string {
  const p = join(dir, 'sverka')
  writeFileSync(p, FAKE_SVERKA)
  chmodSync(p, 0o755)
  return p
}

const silent = () => {}

describe('checkSection', () => {
  test('defaults: empty/absent/garbage → evaluate false, no overrides', () => {
    for (const raw of [undefined, 'junk', 42, {}]) {
      assert.deepEqual(checkSection(raw), { evaluate: false, executor: undefined })
    }
  })

  test('fields normalize; bad executor warns and drops', () => {
    const cfg = checkSection({
      bin: ' /opt/sverka ',
      config: 'ci.config.ts',
      entry: 'nightly',
      executor: 'docker',
      evaluate: true,
    })
    assert.deepEqual(cfg, {
      bin: '/opt/sverka',
      config: 'ci.config.ts',
      entry: 'nightly',
      executor: 'docker',
      evaluate: true,
    })
    assert.equal(checkSection({ executor: 'podman' }).executor, undefined)
    assert.equal(checkSection({ evaluate: 'yes' }).evaluate, false)
  })
})

describe('resolveSverka', () => {
  test('config bin path wins; missing path resolves null', () => {
    const { dir, done } = tmpdirWith('bro-check-')
    try {
      const bin = fakeSverka(dir)
      const hit = resolveSverka(dir, bin)
      assert.equal(hit?.file, bin)
      assert.equal(hit?.via, 'config')
      assert.equal(resolveSverka(dir, join(dir, 'nope')), null)
      // relative to root
      const rel = resolveSverka(dir, './sverka')
      assert.equal(rel?.file, bin)
      // bare name = PATH command, trusted as-is
      const named = resolveSverka(dir, 'sverka-custom')
      assert.deepEqual(named, { file: 'sverka-custom', args: [], via: 'config' })
    } finally {
      done()
    }
  })

  test('repo-local .bin beats PATH and the bundled copy; walks up', () => {
    const { dir, done } = tmpdirWith('bro-check-')
    try {
      const local = join(dir, 'node_modules', '.bin')
      mkdirSync(local, { recursive: true })
      const bin = fakeSverka(local)
      const nested = join(dir, 'a', 'b')
      mkdirSync(nested, { recursive: true })
      const hit = resolveSverka(nested)
      assert.equal(hit?.file, bin)
      assert.equal(hit?.via, 'repo')
    } finally {
      done()
    }
  })

  test('falls back to PATH or the bundled sverka', () => {
    const { dir, done } = tmpdirWith('bro-check-')
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      fakeSverka(bin)
      const prev = process.env.PATH
      process.env.PATH = bin
      try {
        const hit = resolveSverka(dir)
        assert.equal(hit?.via, 'PATH')
        assert.equal(hit?.file, join(bin, 'sverka'))
      } finally {
        process.env.PATH = prev
      }
      // no repo-local, no PATH → bundled dep of @broject/bro (installed
      // in this workspace) resolved through node, spawned via execPath
      const prevPath = process.env.PATH
      process.env.PATH = join(dir, 'empty')
      mkdirSync(join(dir, 'empty'))
      try {
        const hit = resolveSverka(dir)
        assert.equal(hit?.via, 'bundled')
        assert.equal(hit?.file, process.execPath)
        assert.match(hit?.args[0] ?? '', /sverka[\\/]dist[\\/]bin\.mjs$/)
      } finally {
        process.env.PATH = prevPath
      }
    } finally {
      done()
    }
  })

  // @sverka/cli is the deprecated pre-rename package — a consumer repo
  // may still pin it, and that install has to keep resolving.
  test('repo-local @sverka/cli entry still resolves; sverka wins when both exist', () => {
    const { dir, done } = tmpdirWith('bro-check-')
    try {
      const legacy = join(dir, 'node_modules', '@sverka', 'cli', 'dist')
      mkdirSync(legacy, { recursive: true })
      const legacyBin = join(legacy, 'bin.mjs')
      writeFileSync(legacyBin, '')
      const hit = resolveSverka(dir)
      assert.equal(hit?.via, 'repo')
      assert.deepEqual(hit?.args, [legacyBin])

      const current = join(dir, 'node_modules', 'sverka', 'dist')
      mkdirSync(current, { recursive: true })
      const currentBin = join(current, 'bin.mjs')
      writeFileSync(currentBin, '')
      const both = resolveSverka(dir)
      assert.equal(both?.via, 'repo')
      assert.deepEqual(both?.args, [currentBin])
    } finally {
      done()
    }
  })
})

describe('runCheck', () => {
  function fixture(mode: string): { dir: string; bin: { file: string; args: string[] } } {
    const dir = mkdtempSync(join(tmpdir(), 'bro-check-'))
    const bin = { file: fakeSverka(dir), args: [] }
    process.env.FAKE_SVERKA_MODE = mode
    return { dir, bin }
  }
  const baseOpts = { evaluate: false, quiet: false, verbose: false }

  test('success run → report with steps, exit 0', () => {
    const { dir, bin } = fixture('success')
    try {
      const { report, exitCode } = runCheck(bin, dir, baseOpts, silent)
      assert.equal(exitCode, 0)
      assert.equal(report?.status, 'success')
      assert.equal(report?.steps.length, 2)
      assert.equal(report?.durationMs, 1500)
      assert.equal(report?.findings, undefined)
    } finally {
      delete process.env.FAKE_SVERKA_MODE
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('failed step → sverka exit code propagates', () => {
    const { dir, bin } = fixture('failed')
    try {
      const { report, exitCode } = runCheck(bin, dir, baseOpts, silent)
      assert.equal(exitCode, 1)
      assert.equal(report?.status, 'failure')
      assert.equal(report?.steps[1]?.status, 'failed')
    } finally {
      delete process.env.FAKE_SVERKA_MODE
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('flags pass through to sverka argv', () => {
    const { dir, bin } = fixture('success')
    const log = join(dir, 'args.json')
    process.env.SVERKA_ARGS_LOG = log
    try {
      runCheck(
        bin,
        dir,
        {
          config: 'ci.config.ts',
          entry: 'nightly',
          executor: 'docker',
          evaluate: true,
          quiet: true,
          verbose: true,
        },
        silent
      )
      const argv = JSON.parse(readFileSync(log, 'utf8')) as string[]
      for (const a of [
        'run', '--format', 'json', '--config', 'ci.config.ts',
        '--entry', 'nightly', '--executor', 'docker', '--evaluate',
        '--quiet', '--verbose',
      ]) {
        assert.ok(argv.includes(a), `missing ${a} in ${JSON.stringify(argv)}`)
      }
    } finally {
      delete process.env.SVERKA_ARGS_LOG
      delete process.env.FAKE_SVERKA_MODE
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('evaluate surfaces findings + verdict', () => {
    const { dir, bin } = fixture('evaluate')
    try {
      const { report, exitCode } = runCheck(bin, dir, { ...baseOpts, evaluate: true }, silent)
      assert.equal(exitCode, 0)
      assert.equal(report?.findings, 3)
      assert.equal(report?.verdict, 'warn')
    } finally {
      delete process.env.FAKE_SVERKA_MODE
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('COLLECTION_FAILED retries once without --evaluate and warns', () => {
    const { dir, bin } = fixture('collect-fails')
    const log = join(dir, 'args.json')
    process.env.SVERKA_ARGS_LOG = log
    const errs: string[] = []
    try {
      const { report, exitCode } = runCheck(
        bin,
        dir,
        { ...baseOpts, evaluate: true },
        (m) => errs.push(m)
      )
      assert.equal(exitCode, 0)
      assert.equal(report?.status, 'success')
      assert.equal(report?.steps.length, 1)
      assert.equal(errs.length, 1)
      assert.match(errs[0]!, /retrying without --evaluate/)
      // the retry's argv is the last write — --evaluate must be gone
      const argv = JSON.parse(readFileSync(log, 'utf8')) as string[]
      assert.ok(!argv.includes('--evaluate'))
    } finally {
      delete process.env.SVERKA_ARGS_LOG
      delete process.env.FAKE_SVERKA_MODE
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unparseable output → no report, executor exit code', () => {
    const { dir, bin } = fixture('garbage')
    const errs: string[] = []
    try {
      const { report, exitCode } = runCheck(bin, dir, baseOpts, (m) => errs.push(m))
      assert.equal(report, undefined)
      assert.equal(exitCode, 1)
      assert.match(errs[0] ?? '', /without a JSON run report/)
    } finally {
      delete process.env.FAKE_SVERKA_MODE
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderText', () => {
  const report: CheckReport = {
    status: 'failure',
    durationMs: 14781,
    exitCode: 1,
    steps: [
      { stepId: 'scan/gql', status: 'succeeded', durationMs: 1737 },
      { stepId: 'scan/rest-a', status: 'failed', durationMs: 4678, exitCode: 1, stderr: 'x\ny\nfatal: nope' },
      { stepId: 'scan/cache', status: 'cache-hit', cacheKey: 'abcdef1234567890' },
      { stepId: 'scan/skip', status: 'skipped' },
    ],
    findings: 2,
    verdict: 'fail',
  }

  test('per-step lines + totals + findings line', () => {
    const lines = renderText(report)
    assert.match(lines[0]!, /✓ scan\/gql 1\.7s/)
    assert.match(lines[1]!, /✗ scan\/rest-a 4\.7s — exit 1/)
    // failed step's stderr tail sits indented under its line
    assert.equal(lines[2], '    x')
    assert.ok(lines.some((l) => l === '    fatal: nope'))
    assert.ok(lines.some((l) => /✓ scan\/cache — cache abcdef123456/.test(l)))
    assert.ok(lines.some((l) => /- scan\/skip/.test(l)))
    // totals, then the findings line last
    assert.match(lines.at(-2)!, /4 steps · 2 ok · 1 failed · 1 other — 14\.8s/)
    assert.match(lines.at(-1)!, /findings: 2 · verdict: fail/)
  })
})
