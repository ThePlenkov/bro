/** request resolution — the `<repo-or-alias>` matrix: alias → URI →
 *  explicit path → local-peer basename → sibling checkout. Rig pins
 *  (`bro.config.json` `mesh.rig`) keep fixtures git-free. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { resolveTarget } from './request.ts'
import type { MeshPeer } from './peers.ts'

const root = () => mkdtempSync(join(tmpdir(), 'bro-mesh-req-'))

/** A beads checkout pinned to `rig` — no git needed. */
function checkout(dir: string, rig: string): string {
  mkdirSync(join(dir, '.beads'), { recursive: true })
  writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ mesh: { rig } }))
  return dir
}

const remotePeer: MeshPeer = {
  alias: 'far',
  rig: 'mesh://acme/far',
  remote: 'https://github.com/acme/far.git',
  transport: 'beads-remote',
}

describe('resolveTarget', () => {
  test('peer alias — beads-remote posts own-store, local delivers', () => {
    const dir = root()
    try {
      const localDir = checkout(join(dir, 'near'), 'mesh://acme/near')
      const localPeer: MeshPeer = {
        alias: 'near',
        rig: 'mesh://acme/near',
        remote: localDir,
        transport: 'local',
      }
      const far = resolveTarget(dir, 'far', [remotePeer, localPeer])
      assert.equal(far.target?.rig, 'mesh://acme/far')
      assert.equal(far.target?.checkout, undefined)

      const near = resolveTarget(dir, 'near', [remotePeer, localPeer])
      assert.equal(near.target?.rig, 'mesh://acme/near')
      assert.equal(near.target?.checkout, localDir)
      assert.equal(near.target?.peer?.alias, 'near')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mesh:// uri resolves verbatim to an own-store post', () => {
    const dir = root()
    try {
      const r = resolveTarget(dir, 'mesh://Acme/Widgets', [])
      assert.equal(r.target?.rig, 'mesh://acme/widgets')
      assert.equal(r.target?.checkout, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an explicit path delivers into the checkout', () => {
    const dir = root()
    try {
      const target = checkout(join(dir, 'target'), 'mesh://acme/target')
      const abs = resolveTarget(dir, target, [])
      assert.equal(abs.target?.checkout, target)
      assert.equal(abs.target?.rig, 'mesh://acme/target')

      const viaDot = resolveTarget(target, '.', [])
      assert.equal(viaDot.target?.checkout, target)

      const notCheckout = resolveTarget(dir, join(dir, 'nope'), [])
      assert.match(notCheckout.error ?? '', /not a beads checkout/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a local peer remote basename resolves without naming the alias', () => {
    const dir = root()
    try {
      const localDir = checkout(join(dir, 'near'), 'mesh://acme/near')
      const peer: MeshPeer = {
        alias: 'n',
        rig: 'mesh://acme/near',
        remote: localDir,
        transport: 'local',
      }
      const r = resolveTarget(dir, 'near', [peer])
      assert.equal(r.target?.checkout, localDir)
      assert.equal(r.target?.peer?.alias, 'n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('sibling checkouts: bare <name> wins; several --slugs are ambiguous', () => {
    const dir = root()
    try {
      const main = join(dir, 'main')
      mkdirSync(main)
      checkout(join(dir, 'sib'), 'mesh://acme/sib')
      checkout(join(dir, 'work--slug1'), 'mesh://acme/w1')
      checkout(join(dir, 'work--slug2'), 'mesh://acme/w2')

      const bare = resolveTarget(main, 'sib', [])
      assert.equal(bare.target?.checkout, join(dir, 'sib'))
      assert.equal(bare.target?.rig, 'mesh://acme/sib')

      const one = resolveTarget(main, 'nosib', [])
      // no bare nosib, no nosib--* — unresolvable
      assert.match(one.error ?? '', /cannot resolve/)

      const multi = resolveTarget(main, 'work', [])
      assert.ok(multi.ambiguous)
      assert.equal(multi.ambiguous?.length, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a single --slug sibling resolves when no bare name exists', () => {
    const dir = root()
    try {
      const main = join(dir, 'main')
      mkdirSync(main)
      const wt = checkout(join(dir, 'work--only'), 'mesh://acme/only')
      const r = resolveTarget(main, 'work', [])
      assert.equal(r.target?.checkout, wt)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a checkout without a resolvable rig is unaddressed, never guessed', () => {
    const dir = root()
    // a global-layer mesh.rig pin would rescue the rig — pin XDG away
    // so 'unaddressed' is tested, not this machine's config
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(dir, 'no-global')
    try {
      const main = join(dir, 'main')
      mkdirSync(main)
      const bare = join(dir, 'mute')
      mkdirSync(join(bare, '.beads'), { recursive: true })
      const r = resolveTarget(main, 'mute', [])
      assert.match(r.error ?? '', /unaddressed/)
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
