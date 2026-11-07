/** `bro notify` e2e — the mailbox's write side, against the built CLI:
 *  drops land atomically in <git-common>/bro/notify, fall back to the
 *  XDG state mailbox outside a repo, and empty text is a usage error. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { git, initRepo, inside, runCli } from './testrepo.ts'

describe('bro notify', () => {
  test('drops an atomic note-*.txt into <git-common>/bro/notify', () => {
    const { root, main } = initRepo('bro-notify-')
    inside(main, root, () => {
      const r = runCli(['notify', 'gate', 'ready'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim())
      const mb = join(common, 'bro', 'notify')
      const files = readdirSync(mb).filter((f) => !f.startsWith('.'))
      assert.equal(files.length, 1)
      assert.match(files[0]!, /^note-\d+-[a-z0-9]+\.txt$/)
      assert.equal(readFileSync(join(mb, files[0]!), 'utf8'), 'gate ready')
      // stdout names the dropped file — scripts can confirm the landing
      assert.match(r.stdout.trim(), new RegExp(`${files[0]!}$`))
    })
  })

  test('outside a repo the drop lands in the XDG state mailbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-notify-norepo-'))
    try {
      const xdg = join(dir, 'xdg')
      const r = runCli(['notify', 'repo-less event'], {
        cwd: dir,
        env: { XDG_STATE_HOME: xdg },
      })
      assert.equal(r.code, 0, r.stderr)
      const files = readdirSync(join(xdg, 'bro', 'notify'))
      assert.equal(files.length, 1)
      assert.equal(readFileSync(join(xdg, 'bro', 'notify', files[0]!), 'utf8'), 'repo-less event')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no text is a usage error, not an empty drop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-notify-empty-'))
    try {
      mkdirSync(join(dir, 'xdg'))
      const r = runCli(['notify'], { cwd: dir, env: { XDG_STATE_HOME: join(dir, 'xdg') } })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /usage: bro notify/)
      assert.equal(readdirSync(join(dir, 'xdg')).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('--to/--kind/--in-reply-to/--key write a typed envelope', () => {
    const { root, main } = initRepo('bro-notify-typed-')
    inside(main, root, () => {
      const r = runCli(
        ['notify', '--to', 'orchestrator', '--kind', 'ask', '--in-reply-to', 'bro-22jd', '--key', 'q-1', 'need a call'],
        { cwd: main }
      )
      assert.equal(r.code, 0, r.stderr)
      const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim())
      const mb = join(common, 'bro', 'notify')
      const files = readdirSync(mb).filter((f) => !f.startsWith('.'))
      assert.equal(files.length, 1)
      const ev = JSON.parse(readFileSync(join(mb, files[0]!), 'utf8'))
      assert.equal(ev.topic, 'notify')
      assert.equal(ev.kind, 'ask')
      assert.equal(ev.to, 'orchestrator')
      assert.equal(ev.cause, 'bro-22jd')
      assert.equal(ev.key, 'q-1')
      assert.equal(ev.payload, 'need a call')
    })
  })

  test('an invalid --kind is a usage error, nothing is dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-notify-badkind-'))
    try {
      mkdirSync(join(dir, 'xdg'))
      const r = runCli(['notify', '--kind', 'shout', 'hi'], {
        cwd: dir,
        env: { XDG_STATE_HOME: join(dir, 'xdg') },
      })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /--kind must be one of/)
      assert.equal(readdirSync(join(dir, 'xdg')).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a repeated --key supersedes the pending drop from the same source', () => {
    const { root, main } = initRepo('bro-notify-coalesce-')
    inside(main, root, () => {
      const env = { BRO_AGENT_ID: 'watch-1' }
      const r1 = runCli(['notify', '--key', 'pr-7', '--kind', 'result', 'v1'], { cwd: main, env })
      assert.equal(r1.code, 0, r1.stderr)
      const r2 = runCli(['notify', '--key', 'pr-7', '--kind', 'result', 'v2'], { cwd: main, env })
      assert.equal(r2.code, 0, r2.stderr)
      const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim())
      const mb = join(common, 'bro', 'notify')
      const files = readdirSync(mb).filter((f) => !f.startsWith('.'))
      assert.equal(files.length, 1, 'the stale keyed drop was retired on publish')
      const ev = JSON.parse(readFileSync(join(mb, files[0]!), 'utf8'))
      assert.equal(ev.payload, 'v2')
      assert.equal(ev.source, 'watch-1')
    })
  })

  test('the same --key from another source stays an independent drop', () => {
    const { root, main } = initRepo('bro-notify-sources-')
    inside(main, root, () => {
      runCli(['notify', '--key', 'pr-7', 'from a'], { cwd: main, env: { BRO_AGENT_ID: 'a' } })
      runCli(['notify', '--key', 'pr-7', 'from b'], { cwd: main, env: { BRO_AGENT_ID: 'b' } })
      const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim())
      const mb = join(common, 'bro', 'notify')
      const files = readdirSync(mb).filter((f) => !f.startsWith('.'))
      assert.equal(files.length, 2)
    })
  })

  test('message text behind `--` keeps option-looking words verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-notify-dashes-'))
    try {
      mkdirSync(join(dir, 'xdg'))
      const r = runCli(['notify', '--', 'deploy', '--help', 'now'], {
        cwd: dir,
        env: { XDG_STATE_HOME: join(dir, 'xdg') },
      })
      assert.equal(r.code, 0, r.stderr)
      const files = readdirSync(join(dir, 'xdg', 'bro', 'notify'))
      assert.equal(files.length, 1)
      assert.equal(
        readFileSync(join(dir, 'xdg', 'bro', 'notify', files[0]!), 'utf8'),
        'deploy --help now'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown option is a usage error, not a swallowed word', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-notify-unkflag-'))
    try {
      mkdirSync(join(dir, 'xdg'))
      const r = runCli(['notify', '--knd', 'ask', 'hi'], {
        cwd: dir,
        env: { XDG_STATE_HOME: join(dir, 'xdg') },
      })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /unknown option --knd/)
      assert.equal(readdirSync(join(dir, 'xdg')).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a session env pins source so two publishers do not collide', () => {
    const { root, main } = initRepo('bro-notify-sessrc-')
    inside(main, root, () => {
      runCli(['notify', '--key', 'k', 'from session'], {
        cwd: main,
        env: { BRO_SESSION_ID: 'ses-9' },
      })
      const common = resolve(main, git(['rev-parse', '--git-common-dir'], main).trim())
      const mb = join(common, 'bro', 'notify')
      const files = readdirSync(mb).filter((f) => !f.startsWith('.'))
      assert.equal(files.length, 1)
      const ev = JSON.parse(readFileSync(join(mb, files[0]!), 'utf8'))
      assert.equal(ev.source, 'ses-9')
    })
  })
})
