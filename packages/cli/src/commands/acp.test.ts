import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { capture } from './testrepo.ts'
import { runAcpCommand } from './acp.ts'

const acp = (argv: string[]) => capture(() => runAcpCommand(argv))

describe('bro acp — usage', () => {
  test('missing subcommand, unknown subcommand, missing --, empty tail → usage exit 2', async () => {
    const bare = await acp([])
    assert.equal(bare.code, 2)
    assert.match(bare.err.join('\n'), /usage: bro acp proxy/)

    const bad = await acp(['bogus'])
    assert.equal(bad.code, 2)

    // `--` is mandatory — without it a downstream flag could be
    // misread as ours
    const noSep = await acp(['proxy', 'devin', 'acp'])
    assert.equal(noSep.code, 2)
    assert.match(noSep.err.join('\n'), /requires `--`/)

    const empty = await acp(['proxy', '--'])
    assert.equal(empty.code, 2)
    assert.match(empty.err.join('\n'), /empty agent command/)
  })
})
