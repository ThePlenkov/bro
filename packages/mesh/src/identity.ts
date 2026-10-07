/**
 * mesh identity — `mesh://<org>/<repo>` rig URIs and the repo-root rig
 * descriptor (`.bro-rig.json`, the `.town.json` precedent).
 *
 * Provenance is the transport, not the envelope (spec Trust): a rig's
 * URI is declared in the peer binding — never trusted from an inbound
 * envelope's `from`.
 */

export interface RigRef {
  org: string
  repo: string
}

const RIG_URI = /^mesh:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

export function parseRigUri(uri: string): RigRef | null {
  const m = RIG_URI.exec(uri.trim())
  // rig ids compare like forge paths do — case-insensitively; the
  // canonical form is lowercase so every downstream `===` holds
  return m === null ? null : { org: m[1]!.toLowerCase(), repo: m[2]!.toLowerCase() }
}

export function formatRigUri(rig: RigRef): string {
  return `mesh://${rig.org}/${rig.repo}`
}

/** Derive this repo's rig URI from its origin remote — https or ssh
 *  GitHub-style URLs both reduce to `<org>/<repo>`. A repo without a
 *  parseable origin is unaddressed: callers must treat null as "this
 *  rig cannot be written to by name" and surface it, not guess. */
export function rigFromRemoteUrl(url: string): RigRef | null {
  let rest = url.trim()
  while (rest.endsWith('/')) {
    rest = rest.slice(0, -1)
  }
  if (rest.endsWith('.git')) {
    rest = rest.slice(0, -'.git'.length)
  }
  // https://host/org/repo — take the two path segments after the host
  if (/^https?:\/\//.test(rest) || rest.startsWith('ssh://')) {
    rest = rest.slice(rest.indexOf('://') + 3)
    const slash = rest.indexOf('/')
    rest = slash === -1 ? '' : rest.slice(slash + 1)
  } else if (rest.startsWith('git@')) {
    // git@host:org/repo — after the colon
    const colon = rest.indexOf(':')
    rest = colon === -1 ? '' : rest.slice(colon + 1)
  } else {
    return null
  }
  const parts = rest.split('/').filter((p) => p !== '')
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return null
  }
  return { org: parts[0].toLowerCase(), repo: parts[1].toLowerCase() }
}

/** The descriptor a rig commits at its repo root — mirrors the spec
 *  example. `accepts` lists envelope kinds it will pick up; `inbox`
 *  names the store peers should pull ('beads' today). */
export interface RigDescriptor {
  rig: string
  orchestrator?: string
  accepts?: string[]
  inbox?: string
}

export function parseRigDescriptor(raw: unknown): RigDescriptor | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const d = raw as { rig?: unknown; orchestrator?: unknown; accepts?: unknown; inbox?: unknown }
  if (typeof d.rig !== 'string' || parseRigUri(d.rig) === null) {
    return null
  }
  return {
    rig: formatRigUri(parseRigUri(d.rig)!),
    orchestrator: typeof d.orchestrator === 'string' ? d.orchestrator : undefined,
    accepts: Array.isArray(d.accepts) ? d.accepts.filter((a): a is string => typeof a === 'string') : undefined,
    inbox: typeof d.inbox === 'string' ? d.inbox : undefined,
  }
}
