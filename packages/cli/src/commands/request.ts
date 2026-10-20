/**
 * `bro request <repo-or-alias> <title>` — the bilateral same-machine
 * path over the mesh machinery (specs/cross-repo/bro-oam4). The
 * argument resolves peer alias → mesh:// URI → checkout path →
 * local-peer basename → sibling checkout. A target that lands on a
 * live checkout gets the request DELIVERED into its own store
 * (`export:<id>` pinned for the worker's `bd ship`); anything else
 * is the plain own-store post — `bro mesh request` verbatim.
 */
import { basename } from 'node:path'
import { gitCommonDir } from '@broject/core'
import {
  deliverGithub,
  deliverRequest,
  deliverWasteland,
  ensurePeerBinding,
  resolveTarget,
  selfRig,
  wireDep,
  type ResolvedTarget,
} from '@broject/mesh'
import { flagValue, meshPeers, parseRefs, runMeshCommand } from './mesh.ts'

const USAGE = `Usage: bro request <repo-or-alias> <title> [--body T] [--priority N] [--ref K:R]… [--for BEAD] [--as ALIAS]

Posts a request envelope to another rig. <repo-or-alias> resolves:
peer alias, mesh://<org>/<repo>, a checkout path, a local peer's
basename, or a sibling checkout (<name> or <name>--<slug>). A live
same-machine checkout receives the bead directly; remote targets
get the own-store post the peer pulls. --for blocks a local bead
on external:<rig>:<id> — a marker, not a gate.
`

function resolveOrExit(dir: string, arg: string): ResolvedTarget {
  const resolved = resolveTarget(dir, arg, meshPeers(dir))
  if (resolved.ambiguous !== undefined) {
    console.error(`error: "${arg}" is ambiguous — matching sibling checkouts:`)
    for (const c of resolved.ambiguous) {
      console.error(`  ${c}`)
    }
    process.exit(2)
  }
  if (resolved.target === undefined) {
    console.error(`error: ${resolved.error ?? 'cannot resolve target'}`)
    process.exit(2)
  }
  return resolved.target
}

function selfRigOrExit(dir: string): string {
  const rig = selfRig(dir)
  if (rig === null) {
    console.error('this rig is unaddressed — set mesh.rig or a forge-url origin (see `bro mesh me`)')
    process.exit(2)
  }
  if (gitCommonDir(dir) === null) {
    console.error('bro request: not inside a git repository')
    process.exit(2)
  }
  return rig
}

function parsePriority(rest: string[]): number | undefined {
  const prio = flagValue(rest, '--priority')
  if (prio === undefined) {
    return undefined
  }
  const priority = Number(prio)
  const inRange = priority >= 0 && priority <= 4
  if (!Number.isInteger(priority) || !inRange) {
    console.error('error: --priority wants 0-4')
    process.exit(2)
  }
  return priority
}

// the binding is what makes wait/inbox/the anchor reachable later —
// basename unless the caller names it
function bindPeer(dir: string, checkout: string, rest: string[], rig: string): void {
  const alias = flagValue(rest, '--as') ?? basename(checkout)
  const bound = ensurePeerBinding(dir, alias, rig, checkout)
  if (bound.error !== undefined) {
    console.error(`! request delivered but peer binding failed: ${bound.error}`)
  } else if (bound.added) {
    console.log(`peer ${alias} → ${rig} (${checkout})`)
  } else if (bound.note !== undefined) {
    console.log(bound.note)
  }
}

function wireFor(dir: string, rest: string[], rig: string, id?: string): void {
  const waiting = flagValue(rest, '--for')
  if (waiting === undefined) {
    return
  }
  if (id === undefined) {
    console.error(`! request delivered but no thread id returned — dep wiring skipped`)
    return
  }
  const depErr = wireDep(dir, waiting, rig, id)
  if (depErr !== undefined) {
    console.error(`! request delivered but dep wiring failed: ${depErr}`)
  } else {
    console.log(`${waiting} now blocked by external:${rig}:${id}`)
  }
}

/** Remote planes (specs/cross-repo/bro-kim1e) — the peer has no
 *  checkout to clone into: the request posts over the transport's
 *  own channel (issue + record comment, or a wanted row) and a
 *  mirror bead lands in OUR store, external_ref = the remote thread.
 *  No `external:` dep is wired — bd can't resolve a github/wasteland
 *  ref, so `--for` is advisory-only here, said so, never silent.
 *  Returns false when the target isn't a remote-plane peer. */
function remoteRequest(dir: string, t: ResolvedTarget, titleText: string, rest: string[]): boolean {
  const peer = t.peer
  if (peer?.transport !== 'github' && peer?.transport !== 'wasteland') {
    return false
  }
  const rig = selfRigOrExit(dir)
  const deliver = peer.transport === 'github' ? deliverGithub : deliverWasteland
  const posted = deliver(dir, peer, {
    from: rig,
    title: titleText,
    body: flagValue(rest, '--body'),
    refs: parseRefs(rest, '--ref'),
    priority: parsePriority(rest),
  })
  if (posted.error !== undefined) {
    console.error(`error: ${posted.error}`)
    process.exit(1)
  }
  console.log(`request ${posted.mirror} → ${peer.alias} (${peer.transport})`)
  console.log(`  remote thread ${posted.thread}`)
  if (flagValue(rest, '--for') !== undefined) {
    console.error(`! --for not wired on ${peer.transport} planes — track with \`bro mesh wait\` instead`)
  }
  console.log(`thread: ${posted.thread} — track it with \`bro mesh wait ${posted.thread}\``)
  return true
}

export function runRequestCommand(argv: string[]): void {
  const dir = process.cwd()
  const [target, titleText, ...rest] = argv
  const titleBad = titleText === undefined || titleText.startsWith('--')
  if (target === undefined || titleBad) {
    console.error(USAGE)
    process.exit(2)
  }

  const t = resolveOrExit(dir, target)
  if (remoteRequest(dir, t, titleText, rest)) {
    return
  }

  // no live checkout → the own-store post, flag-for-flag `bro mesh request`
  if (t.checkout === undefined) {
    runMeshCommand(['request', t.rig, titleText, ...rest])
    return
  }

  if (t.rigWarning !== undefined) {
    console.error(`! ${t.rigWarning}`)
  }
  const rig = selfRigOrExit(dir)

  const posted = deliverRequest(t.checkout, {
    from: rig,
    to: t.rig,
    title: titleText,
    body: flagValue(rest, '--body'),
    refs: parseRefs(rest, '--ref'),
    priority: parsePriority(rest),
  })
  if (posted.error !== undefined) {
    console.error(`error: ${posted.error}`)
    process.exit(1)
  }
  console.log(`request ${posted.id} → ${t.rig}`)

  bindPeer(dir, t.checkout, rest, t.rig)
  wireFor(dir, rest, t.rig, posted.id)
  console.log(`thread: ${posted.id} — track it with \`bro mesh wait ${posted.id}\``)
}
