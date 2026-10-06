import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coalesceDrops,
  drainDirs,
  drainMailbox,
  DROP_TTL_MS,
  dropMailbox,
  mailboxDir,
  notifyDir,
  renderDrop,
  userMailboxDir,
} from './notify.ts'

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const withRepo = (fn: (dir: string) => void): void => {
  const dir = tmp('bro-notify-')
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Pin XDG state into a tmp dir the helper owns and removes — without it
 *  drainDirs() would read the real $HOME/.local/state mailbox and tests
 *  would eat a live session's drops. */
const withXdg = <T>(fn: (xdg: string) => T): T => {
  const dir = tmp('bro-xdg-')
  const prev = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = prev
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('mailboxDir', () => {
  test('resolves to <git-common>/bro/notify inside a repo', () => {
    withRepo((dir) => {
      assert.equal(mailboxDir(dir), join(dir, '.git', 'bro', 'notify'))
    })
  })

  test('a linked worktree resolves to the shared common dir', () => {
    withRepo((dir) => {
      const wt = join(dir, '..', `${dir.split('/').pop()}-wt`)
      execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', wt, '-b', 'w'])
      try {
        assert.equal(mailboxDir(wt), mailboxDir(dir))
      } finally {
        rmSync(wt, { recursive: true, force: true })
      }
    })
  })

  test('null outside a repo', () => {
    const dir = tmp('bro-notify-norepo-')
    try {
      assert.equal(mailboxDir(dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('userMailboxDir / notifyDir', () => {
  test('XDG_STATE_HOME wins, else ~/.local/state', () => {
    withXdg((xdg) => {
      assert.equal(userMailboxDir(), join(xdg, 'bro', 'notify'))
    })
    const prev = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    try {
      assert.match(userMailboxDir(), /\.local\/state\/bro\/notify$/)
    } finally {
      if (prev !== undefined) {
        process.env.XDG_STATE_HOME = prev
      }
    }
  })

  test('an empty XDG_STATE_HOME falls back like an unset one', () => {
    const prev = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = ''
    try {
      assert.match(userMailboxDir(), /\.local\/state\/bro\/notify$/)
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_STATE_HOME
      } else {
        process.env.XDG_STATE_HOME = prev
      }
    }
  })

  test('notifyDir picks the repo mailbox, else the user mailbox', () => {
    withRepo((dir) => {
      withXdg(() => {
        assert.equal(notifyDir(dir), mailboxDir(dir))
      })
    })
    const bare = tmp('bro-notify-bare-')
    try {
      withXdg((xdg) => {
        assert.equal(notifyDir(bare), join(xdg, 'bro', 'notify'))
      })
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('dropMailbox', () => {
  test('writes one atomic <prefix>-*.txt drop and returns its path', () => {
    const mb = tmp('bro-mb-')
    try {
      const file = dropMailbox(mb, 'gate ready', 'note')
      assert.match(file, /note-\d+-[a-z0-9]+\.txt$/)
      assert.equal(readFileSync(file, 'utf8'), 'gate ready')
      assert.ok(!readdirSync(mb).some((f) => f.includes('.tmp')))
    } finally {
      rmSync(mb, { recursive: true, force: true })
    }
  })
})

describe('drainMailbox', () => {
  test('delivers drops oldest-first, verbatim — once per session', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        writeFileSync(join(mb, 'note-100-a.txt'), 'first')
        writeFileSync(join(mb, 'note-200-b.txt'), 'two\n  indented')
        writeFileSync(join(mb, '.note-300.tmp'), 'half-written')
        assert.deepEqual(drainMailbox(dir, 's1'), ['first', 'two\n  indented'])
        // same session: no redelivery
        assert.deepEqual(drainMailbox(dir, 's1'), [])
        // the cursor lives in the mailbox dir
        assert.ok(existsSync(join(mb, '.seen-s1')))
      })
    })
  })

  test('orders by drop time across prefixes — watch-* does not wait on note-*', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        writeFileSync(join(mb, 'watch-100-a.txt'), 'older watch')
        writeFileSync(join(mb, 'note-200-b.txt'), 'newer note')
        writeFileSync(join(mb, 'watch-50-c.txt'), 'oldest watch')
        assert.deepEqual(drainMailbox(dir, 's1'), [
          'oldest watch',
          'older watch',
          'newer note',
        ])
      })
    })
  })

  test('broadcast: a different session still gets the drops', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(mb, 'for everyone', 'note')
        assert.deepEqual(drainMailbox(dir, 's1'), ['for everyone'])
        // s1's drain must not eat it — s2 is the intended recipient case
        assert.deepEqual(drainMailbox(dir, 's2'), ['for everyone'])
        // and the writer session echoing it back is delivery, not loss
        assert.deepEqual(drainMailbox(dir, 's3'), ['for everyone'])
      })
    })
  })

  test('a drop older than the TTL is reaped undelivered', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        const stale = join(mb, 'note-100-a.txt')
        writeFileSync(stale, 'ancient')
        const old = new Date(Date.now() - DROP_TTL_MS - 1000)
        utimesSync(stale, old, old)
        assert.deepEqual(drainMailbox(dir, 's1'), [])
        assert.equal(existsSync(stale), false)
      })
    })
  })

  test('drains the user mailbox too — drops written outside a repo', () => {
    withRepo((dir) => {
      withXdg(() => {
        dropMailbox(userMailboxDir(), 'from a repo-less writer', 'note')
        assert.deepEqual(drainMailbox(dir, 's1'), ['from a repo-less writer'])
      })
    })
  })

  test('no mailboxes anywhere is an empty drain, not an error', () => {
    const dir = tmp('bro-notify-empty-')
    try {
      withXdg((xdg) => {
        assert.deepEqual(drainDirs(dir), [join(xdg, 'bro', 'notify')])
        assert.deepEqual(drainMailbox(dir, 's1'), [])
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('addressed drop reaches only its recipient and deletes on read', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'ask', payload: 'pick A or B', to: 'fixer-1', source: 'sdd-2' }),
          'note'
        )
        // a different agent sees nothing and must not consume it
        assert.deepEqual(
          drainMailbox(dir, 'sA', { for: { sessionId: 'sA', agentId: 'fixer-9' } }),
          []
        )
        assert.equal(readdirSync(mb).filter((f) => f.endsWith('.txt')).length, 1)
        // an orchestrator session (no agentId) does not match an agent address
        assert.deepEqual(drainMailbox(dir, 'sB', { for: { sessionId: 'sB' } }), [])
        // the addressed worker drains it — and the file is gone
        const got = drainMailbox(dir, 'sW', { for: { sessionId: 'sW', agentId: 'fixer-1' } })
        assert.equal(got.length, 1)
        assert.match(got[0]!, /pick A or B/)
        assert.equal(readdirSync(mb).filter((f) => f.endsWith('.txt')).length, 0)
      })
    })
  })

  test('to=orchestrator drains for a sessionless-agent consumer only', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'build done', to: 'orchestrator', source: 'w-1' }),
          'note'
        )
        // a spawned worker (carries an agentId) is never the orchestrator
        assert.deepEqual(drainMailbox(dir, 'sA', { for: { agentId: 'w-2' } }), [])
        const got = drainMailbox(dir, 's1', { for: { sessionId: 's1' } })
        assert.equal(got.length, 1)
        assert.match(got[0]!, /build done/)
        assert.equal(readdirSync(mb).filter((f) => f.endsWith('.txt')).length, 0)
      })
    })
  })

  test('broadcast drops still fan out next to addressed ones', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(mb, 'plain note for all', 'note')
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'only for me', to: 'agent-x' }),
          'note'
        )
        assert.deepEqual(drainMailbox(dir, 'sA', { for: { sessionId: 'sA' } }), [
          'plain note for all',
        ])
        const got = drainMailbox(dir, 'sB', { for: { sessionId: 'sB', agentId: 'agent-x' } })
        assert.equal(got.length, 2)
        // same-millisecond drops order by filename — assert membership, not position
        assert.ok(got.includes('plain note for all'))
        assert.ok(got.some((t) => t.includes('only for me')))
      })
    })
  })

  test('a rejected keep leaves addressed drops pending — a filtered drain does not eat them', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        const file = dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'ask', payload: 'later', to: 'me' }),
          'note'
        )
        assert.deepEqual(
          drainMailbox(dir, 's1', { for: { agentId: 'me' }, keep: () => false }),
          []
        )
        assert.ok(existsSync(file))
        assert.equal(drainMailbox(dir, 's1', { for: { agentId: 'me' } }).length, 1)
        assert.equal(existsSync(file), false)
      })
    })
  })
})

describe('coalesceDrops', () => {
  test('a newer same-key drop supersedes pending ones from the same source', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        const note = (payload: string) =>
          JSON.stringify({ topic: 'notify', kind: 'info', payload, key: 'pr-7', source: 'watch' })
        dropMailbox(mb, note('v1'), 'note')
        // publish order: the new write coalesces pending same-key drops first
        coalesceDrops(mb, 'pr-7', { source: 'watch', topic: 'notify' })
        dropMailbox(mb, note('v2'), 'note')
        const txts = drainMailbox(dir, 's1')
        assert.equal(txts.length, 1)
        assert.match(txts[0]!, /v2/)
      })
    })
  })

  test('same key from another source is an independent note, not superseded', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'mine', key: 'k', source: 'a' }),
          'note'
        )
        // b publishes key 'k': coalescing removes b's pending drops only, then b's drop lands
        coalesceDrops(mb, 'k', { source: 'b', topic: 'notify' })
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'theirs', key: 'k', source: 'b' }),
          'note'
        )
        assert.equal(drainMailbox(dir, 's1').length, 2)
      })
    })
  })

  test('a drop with no key never coalesces', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(mb, 'one', 'note')
        dropMailbox(mb, 'two', 'note')
        coalesceDrops(mb, 'k', { source: 'w', topic: 'notify' }) // nothing carries key 'k' — no-op
        assert.equal(drainMailbox(dir, 's1').length, 2)
      })
    })
  })

  test('same key+source on a different topic is an independent drop', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'kept', key: 'k', source: 'w' }),
          'note'
        )
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'watch', kind: 'info', payload: 'kept too', key: 'k', source: 'w' }),
          'note'
        )
        // a new 'watch' drop with key 'k' from 'w' supersedes only the watch one
        coalesceDrops(mb, 'k', { source: 'w', topic: 'watch' })
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'watch', kind: 'info', payload: 'fresh', key: 'k', source: 'w' }),
          'note'
        )
        const txts = drainMailbox(dir, 's1')
        assert.equal(txts.length, 2)
        assert.ok(txts.some((t) => t.includes('kept')))
        assert.ok(txts.some((t) => t.includes('fresh')))
      })
    })
  })

  test('same key+source+topic addressed to another recipient is independent', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'ask', payload: 'for a', key: 'k', source: 'w', to: 'a' }),
          'note'
        )
        coalesceDrops(mb, 'k', { source: 'w', topic: 'notify', to: 'b' })
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'ask', payload: 'for b', key: 'k', source: 'w', to: 'b' }),
          'note'
        )
        // addressed drops stay pending for their recipient — count the
        // mailbox, not a drain by a third session
        assert.equal(readdirSync(mb).filter((f) => !f.startsWith('.')).length, 2)
      })
    })
  })

  test('a broadcast drop never supersedes an addressed one (and back)', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        const pending = () => readdirSync(mb).filter((f) => !f.startsWith('.')).length
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'addressed', key: 'k', source: 'w', to: 'a' }),
          'note'
        )
        // broadcast publisher (no to) must not remove the addressed drop
        coalesceDrops(mb, 'k', { source: 'w', topic: 'notify' })
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'broadcast', key: 'k', source: 'w' }),
          'note'
        )
        // and an addressed publisher must not remove the broadcast drop
        coalesceDrops(mb, 'k', { source: 'w', topic: 'notify', to: 'b' })
        dropMailbox(
          mb,
          JSON.stringify({ topic: 'notify', kind: 'info', payload: 'for b', key: 'k', source: 'w', to: 'b' }),
          'note'
        )
        assert.equal(pending(), 3)
      })
    })
  })
})

describe('renderDrop', () => {
  test('typed envelopes render addressing; plain notes stay verbatim', () => {
    assert.equal(renderDrop('plain heartbeat'), 'plain heartbeat')
    assert.equal(
      renderDrop(
        JSON.stringify({
          topic: 'notify',
          kind: 'ask',
          payload: 'pick one',
          to: 'orchestrator',
          source: 'fixer-1',
          cause: 'note-1-a.txt',
        })
      ),
      '[ask fixer-1 → orchestrator] pick one ↳note-1-a.txt'
    )
    assert.equal(
      renderDrop(JSON.stringify({ topic: 'notify', kind: 'note', payload: 'plain json note' })),
      'plain json note'
    )
  })
})
