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
  deliverRequest,
  ensurePeerBinding,
  resolveTarget,
  selfRig,
  wireDep,
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

export function runRequestCommand(argv: string[]): void {
  const dir = process.cwd()
  const [target, titleText, ...rest] = argv
  if (target === undefined || titleText === undefined || titleText.startsWith('--')) {
    console.error(USAGE)
    process.exit(2)
  }

  const resolved = resolveTarget(dir, target, meshPeers(dir))
  if (resolved.ambiguous !== undefined) {
    console.error(`error: "${target}" is ambiguous — matching sibling checkouts:`)
    for (const c of resolved.ambiguous) {
      console.error(`  ${c}`)
    }
    process.exit(2)
  }
  if (resolved.target === undefined) {
    console.error(`error: ${resolved.error ?? 'cannot resolve target'}`)
    process.exit(2)
  }
  const t = resolved.target

  // no live checkout → the own-store post, flag-for-flag `bro mesh request`
  if (t.checkout === undefined) {
    runMeshCommand(['request', t.rig, titleText, ...rest])
    return
  }

  if (t.rigWarning !== undefined) {
    console.error(`! ${t.rigWarning}`)
  }
  const rig = selfRig(dir)
  if (rig === null) {
    console.error('this rig is unaddressed — set mesh.rig or a forge-url origin (see `bro mesh me`)')
    process.exit(2)
  }
  if (gitCommonDir(dir) === null) {
    console.error('bro request: not inside a git repository')
    process.exit(2)
  }

  const body = flagValue(rest, '--body')
  const prio = flagValue(rest, '--priority')
  const priority = prio === undefined ? undefined : Number.parseInt(prio, 10)
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 4)) {
    console.error('error: --priority wants 0-4')
    process.exit(2)
  }

  const posted = deliverRequest(t.checkout, {
    from: rig,
    to: t.rig,
    title: titleText,
    body,
    refs: parseRefs(rest, '--ref'),
    priority,
  })
  if (posted.error !== undefined) {
    console.error(`error: ${posted.error}`)
    process.exit(1)
  }
  console.log(`request ${posted.id} → ${t.rig}`)

  // the binding is what makes wait/inbox/the anchor reachable later —
  // basename unless the caller names it
  const alias = flagValue(rest, '--as') ?? basename(t.checkout)
  const bound = ensurePeerBinding(dir, alias, t.rig, t.checkout)
  if (bound.error !== undefined) {
    console.error(`! request delivered but peer binding failed: ${bound.error}`)
  } else if (bound.added) {
    console.log(`peer ${alias} → ${t.rig} (${t.checkout})`)
  }

  const waiting = flagValue(rest, '--for')
  if (waiting !== undefined) {
    const depErr = wireDep(dir, waiting, t.rig, posted.id ?? '')
    if (depErr !== undefined) {
      console.error(`! request delivered but dep wiring failed: ${depErr}`)
    } else {
      console.log(`${waiting} now blocked by external:${t.rig}:${posted.id}`)
    }
  }
  console.log(`thread: ${posted.id} — track it with \`bro mesh wait ${posted.id}\``)
}
