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
})
