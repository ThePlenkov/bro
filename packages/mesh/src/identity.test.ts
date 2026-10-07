import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatRigUri, parseRigDescriptor, parseRigUri, rigFromRemoteUrl } from './identity.ts'

describe('rig uri', () => {
  test('mesh://<org>/<repo> parses and round-trips', () => {
    const rig = parseRigUri('mesh://sverka-dev/sverka')
    assert.deepEqual(rig, { org: 'sverka-dev', repo: 'sverka' })
    assert.equal(formatRigUri(rig!), 'mesh://sverka-dev/sverka')
  })

  test('rejects non-uris', () => {
    assert.equal(parseRigUri('sverka-dev/sverka'), null)
    assert.equal(parseRigUri('mesh://sverka-dev'), null)
    assert.equal(parseRigUri('mesh://a/b/c'), null)
    assert.equal(parseRigUri('http://x/y'), null)
    assert.equal(parseRigUri(''), null)
  })
})

describe('rigFromRemoteUrl', () => {
  test('https, .git suffix, ssh, ssh:// all derive <org>/<repo>', () => {
    const want = { org: 'theplenkov', repo: 'bro' }
    assert.deepEqual(rigFromRemoteUrl('https://github.com/ThePlenkov/bro.git'), want)
    assert.deepEqual(rigFromRemoteUrl('https://github.com/ThePlenkov/bro'), want)
    assert.deepEqual(rigFromRemoteUrl('git@github.com:ThePlenkov/bro.git'), want)
    assert.deepEqual(rigFromRemoteUrl('ssh://git@github.com/ThePlenkov/bro'), want)
  })

  test('non-forge urls return null — no guessed identity', () => {
    assert.equal(rigFromRemoteUrl('file:///home/x/repo'), null)
    assert.equal(rigFromRemoteUrl('/home/x/repo'), null)
    assert.equal(rigFromRemoteUrl(''), null)
  })

  test('trailing slash after .git still strips the suffix', () => {
    assert.deepEqual(rigFromRemoteUrl('https://github.com/ThePlenkov/bro.git/'), {
      org: 'theplenkov',
      repo: 'bro',
    })
    assert.equal(rigFromRemoteUrl('https://github.com/onlyorg/'), null)
  })
})

describe('rig descriptor', () => {
  test('parses the spec example', () => {
    const d = parseRigDescriptor({
      rig: 'mesh://sverka-dev/sverka',
      orchestrator: 'bro@0.2',
      accepts: ['request'],
      inbox: 'beads',
    })
    assert.equal(d?.rig, 'mesh://sverka-dev/sverka')
    assert.equal(d?.inbox, 'beads')
  })

  test('a descriptor with an invalid rig uri is not a descriptor', () => {
    assert.equal(parseRigDescriptor({ rig: 'nope' }), null)
    assert.equal(parseRigDescriptor('x'), null)
    assert.equal(parseRigDescriptor(null), null)
  })
})
