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
import { gitCommonDir, hasHelpFlag, printUsage, CommandError, EXIT } from '@broject/core'
import {
  deliverGithub,
  deliverRequest,
  deliverWasteland,
  ensurePeerBinding,
  resolveTarget,
  selfRig,
  wireDep,
  type MeshPeer,
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

function failAmbiguous(input: { arg: string; ambiguous: string[] }): never {
  const lines = [`error: "${input.arg}" is ambiguous — matching sibling checkouts:`]
  for (const c of input.ambiguous) {
    lines.push(`  ${c}`)
  }
  throw new CommandError(lines.join('\n'), EXIT.usage)
}

function resolveOrExit(input: { dir: string; arg: string }): ResolvedTarget {
  const resolved = resolveTarget(input.dir, input.arg, meshPeers(input.dir))
  if (resolved.ambiguous !== undefined) {
    failAmbiguous({ arg: input.arg, ambiguous: resolved.ambiguous })
  }
  if (resolved.target === undefined) {
    throw new CommandError(`error: ${resolved.error ?? 'cannot resolve target'}`, EXIT.usage)
  }
  return resolved.target
}

function selfRigOrExit(input: { dir: string }): string {
  const rig = selfRig(input.dir)
  if (rig === null) {
    throw new CommandError('this rig is unaddressed — set mesh.rig or a forge-url origin (see `bro mesh me`)', EXIT.usage)
  }
  if (gitCommonDir(input.dir) === null) {
    throw new CommandError('bro request: not inside a git repository', EXIT.usage)
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
    throw new CommandError('error: --priority wants 0-4', EXIT.usage)
  }
  return priority
}

/** The outcome line(s) for a binding attempt — never a hard error:
 *  the request already landed. */
function reportBound(b: { alias: string; rig: string; checkout: string; bound: ReturnType<typeof ensurePeerBinding> }): void {
  if (b.bound.error !== undefined) {
    console.error(`! request delivered but peer binding failed: ${b.bound.error}`)
  } else if (b.bound.added) {
    console.log(`peer ${b.alias} → ${b.rig} (${b.checkout})`)
  } else if (b.bound.note !== undefined) {
    console.log(b.bound.note)
  }
}

// the binding is what makes wait/inbox/the anchor reachable later —
// basename unless the caller names it
function bindPeer(b: { dir: string; checkout: string; rest: string[]; rig: string }): void {
  const alias = flagValue(b.rest, '--as') ?? basename(b.checkout)
  reportBound({ alias, rig: b.rig, checkout: b.checkout, bound: ensurePeerBinding(b.dir, alias, b.rig, b.checkout) })
}

/** The --for leg — advisory lines only: a missing thread id or a
 *  failed dep write warns, the delivered request still stands. */
function wireFor(w: { dir: string; rest: string[]; rig: string; id?: string }): void {
  const waiting = flagValue(w.rest, '--for')
  if (waiting === undefined) {
    return
  }
  if (w.id === undefined) {
    console.error(`! request delivered but no thread id returned — dep wiring skipped`)
    return
  }
  const depErr = wireDep(w.dir, waiting, w.rig, w.id)
  if (depErr !== undefined) {
    console.error(`! request delivered but dep wiring failed: ${depErr}`)
  } else {
    console.log(`${waiting} now blocked by external:${w.rig}:${w.id}`)
  }
}

/** The report lines after a remote post — mirror, remote thread id,
 *  the `--for` advisory, and the tracking hint. */
function reportRemote(r: { peer: MeshPeer; thread: string | undefined; mirror: string | undefined; rest: string[] }): void {
  console.log(`request ${r.mirror} → ${r.peer.alias} (${r.peer.transport})`)
  console.log(`  remote thread ${r.thread}`)
  if (flagValue(r.rest, '--for') !== undefined) {
    console.error(`! --for not wired on ${r.peer.transport} planes — track with \`bro mesh wait\` instead`)
  }
  console.log(`thread: ${r.thread} — track it with \`bro mesh wait ${r.thread}\``)
}

function remoteRequest(input: { dir: string; t: ResolvedTarget; titleText: string; rest: string[] }): boolean {
  const peer = input.t.peer
  if (peer?.transport !== 'github' && peer?.transport !== 'wasteland') {
    return false
  }
  const rig = selfRigOrExit({ dir: input.dir })
  const deliver = peer.transport === 'github' ? deliverGithub : deliverWasteland
  const posted = deliver(input.dir, peer, {
    from: rig,
    title: input.titleText,
    body: flagValue(input.rest, '--body'),
    refs: parseRefs(input.rest, '--ref'),
    priority: parsePriority(input.rest),
  })
  if (posted.error !== undefined) {
    throw new CommandError(`error: ${posted.error}`, EXIT.error)
  }
  reportRemote({ peer, thread: posted.thread, mirror: posted.mirror, rest: input.rest })
  return true
}

/** Same-machine delivery — the request bead lands directly in the
 *  target checkout's store, then the binding and any `--for` dep
 *  wire up on our side. */
function checkoutRequest(input: { dir: string; t: ResolvedTarget; titleText: string; rest: string[] }): void {
  const { dir, t, titleText, rest } = input
  if (t.rigWarning !== undefined) {
    console.error(`! ${t.rigWarning}`)
  }
  const rig = selfRigOrExit({ dir })
  const posted = deliverRequest(t.checkout ?? '', {
    from: rig,
    to: t.rig,
    title: titleText,
    body: flagValue(rest, '--body'),
    refs: parseRefs(rest, '--ref'),
    priority: parsePriority(rest),
  })
  if (posted.error !== undefined) {
    throw new CommandError(`error: ${posted.error}`, EXIT.error)
  }
  console.log(`request ${posted.id} → ${t.rig}`)

  bindPeer({ dir, checkout: t.checkout ?? '', rest, rig: t.rig })
  wireFor({ dir, rest, rig: t.rig, id: posted.id })
  console.log(`thread: ${posted.id} — track it with \`bro mesh wait ${posted.id}\``)
}

export function runRequestCommand(argv: string[]): void {
  const dir = process.cwd()
  const [target, titleText, ...rest] = argv
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, 0)
  }
  const titleBad = titleText === undefined || titleText.startsWith('--')
  if (target === undefined || titleBad) {
    throw new CommandError(USAGE.trim(), EXIT.usage)
  }

  const t = resolveOrExit({ dir, arg: target })
  if (remoteRequest({ dir, t, titleText, rest })) {
    return
  }

  // no live checkout → the own-store post, flag-for-flag `bro mesh request`
  if (t.checkout === undefined) {
    runMeshCommand(['request', t.rig, titleText, ...rest])
    return
  }
  checkoutRequest({ dir, t, titleText, rest })
}
