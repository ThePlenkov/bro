/**
 * mesh/1 envelope — the vendor-neutral work-request record. On
 * beads-backed transports the envelope IS a bead: fields ride labels
 * and native columns, no new storage type (specs/mesh/spec.md).
 */

import { formatRigUri, parseRigUri } from './identity.ts'

/** Canonical rig uri — parse+format lowercases; invalid input returns
 *  the input so a validation pass can flag it. */
function canonRig(uri: string): string {
  const r = parseRigUri(uri)
  return r === null ? uri : formatRigUri(r)
}

export const MESH_VERSION = 'mesh/1' as const

export const MESH_KINDS = ['request', 'claim', 'result', 'accept', 'reject'] as const
export type MeshKind = (typeof MESH_KINDS)[number]

export interface MeshRef {
  kind: 'bead' | 'url' | 'pr'
  ref: string
}

export interface MeshTerms {
  priority?: string
  deadline?: string | null
}

export interface MeshEnvelope {
  v: typeof MESH_VERSION
  /** Request id — on beads transports the request bead's own id. Every
   *  lifecycle message on the same thread reuses it. */
  id: string
  kind: MeshKind
  /** All lifecycle messages share the request id as thread. */
  thread: string
  /** Advisory display field — provenance is the transport binding,
   *  never this value (Trust). */
  from: string
  to: string
  title: string
  body: string
  refs: MeshRef[]
  terms: MeshTerms
  evidence: MeshRef[]
}

export interface BeadLike {
  id: string
  title: string
  description?: string
  notes?: string
  priority?: number
  external_ref?: string | null
  labels?: string[]
}

/** Label scheme — `mesh:<field>:<value>`; a bead belongs to the mesh
 *  iff it carries `mesh:v:1`. */
const L = {
  v: (v: string) => `mesh:v:${v}`,
  kind: (k: MeshKind) => `mesh:kind:${k}`,
  thread: (t: string) => `mesh:thread:${t}`,
  from: (r: string) => `mesh:from:${r}`,
  to: (r: string) => `mesh:to:${r}`,
  ref: (r: MeshRef) => `mesh:ref:${r.kind}:${r.ref}`,
  ev: (r: MeshRef) => `mesh:ev:${r.kind}:${r.ref}`,
}

export const MESH_VERSION_LABEL = L.v('1')

const PRIORITY_NAMES = ['p0', 'p1', 'p2', 'p3', 'p4'] as const

const REF_KINDS = ['bead', 'url', 'pr'] as const

/** `mesh:ref:<kind>:<ref>` / `mesh:ev:<kind>:<ref>` — ref values may
 *  themselves contain colons (urls, pr links), so split at the second
 *  colon rather than pattern-matching. */
function labelRefs(labels: string[], prefix: string): MeshRef[] {
  return labels.flatMap((l) => {
    if (!l.startsWith(prefix)) {
      return []
    }
    const rest = l.slice(prefix.length)
    const colon = rest.indexOf(':')
    const kind = colon === -1 ? rest : rest.slice(0, colon)
    const ref = colon === -1 ? '' : rest.slice(colon + 1)
    return (REF_KINDS as readonly string[]).includes(kind) && ref !== ''
      ? [{ kind: kind as MeshRef['kind'], ref }]
      : []
  })
}

function labelValue(labels: string[], prefix: string): string | null {
  for (const l of labels) {
    if (l.startsWith(prefix)) {
      return l.slice(prefix.length)
    }
  }
  return null
}

export function envelopeLabels(env: MeshEnvelope): string[] {
  return [
    MESH_VERSION_LABEL,
    L.kind(env.kind),
    L.thread(env.thread),
    L.from(env.from),
    L.to(env.to),
    ...env.refs.map(L.ref),
    ...env.evidence.map(L.ev),
  ]
}

/** The bead URI peers use to name this record — upstream beads scheme
 *  beads://<org>/<repo>/<id>, the same form `external:` deps resolve. */
export function beadUri(fromRig: string, beadId: string): string {
  const rig = parseRigUri(fromRig)
  if (rig === null) {
    throw new Error(`invalid rig uri: ${fromRig}`)
  }
  return `beads://${rig.org}/${rig.repo}/${beadId}`
}

function parseTerms(raw: unknown): MeshTerms {
  if (typeof raw !== 'object' || raw === null) {
    return {}
  }
  const t = raw as { priority?: unknown; deadline?: unknown }
  return {
    priority: typeof t.priority === 'string' ? t.priority : undefined,
    deadline: typeof t.deadline === 'string' || t.deadline === null ? t.deadline : undefined,
  }
}

function parseRefs(raw: unknown): MeshRef[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((r) => {
    if (typeof r !== 'object' || r === null) {
      return []
    }
    const { kind, ref } = r as { kind?: unknown; ref?: unknown }
    return (kind === 'bead' || kind === 'url' || kind === 'pr') && typeof ref === 'string'
      ? [{ kind, ref }]
      : []
  })
}

/** Validate a decoded JSON record as a mesh/1 envelope — the wire
 *  shape, used by transports that carry the envelope as a document
 *  (github-issue bodies, wasteland payloads). Returns error strings;
 *  empty list means valid. */
export function validateEnvelope(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) {
    return ['envelope is not an object']
  }
  const e = raw as Record<string, unknown>
  const errs: string[] = []
  if (e.v !== MESH_VERSION) {
    errs.push(`v must be ${MESH_VERSION}`)
  }
  if (typeof e.id !== 'string' || e.id === '') {
    errs.push('id required')
  }
  if (typeof e.kind !== 'string' || !(MESH_KINDS as readonly string[]).includes(e.kind)) {
    errs.push(`kind must be one of ${MESH_KINDS.join('|')}`)
  }
  errs.push(...threadErrors(e))
  errs.push(...rigErrors(e))
  if (typeof e.title !== 'string' || e.title === '') {
    errs.push('title required')
  }
  if (e.body !== undefined && typeof e.body !== 'string') {
    errs.push('body must be a string')
  }
  for (const [field, name] of [
    [e.refs, 'refs'],
    [e.evidence, 'evidence'],
  ] as const) {
    if (field !== undefined && !Array.isArray(field)) {
      errs.push(`${name} must be an array`)
    }
  }
  return errs
}

/** thread must be a non-empty string; a request additionally threads
 *  to itself (lifecycle messages carry their own id but must point at
 *  the request's thread). */
function threadErrors(e: Record<string, unknown>): string[] {
  if (typeof e.thread !== 'string' || e.thread === '') {
    return ['thread required']
  }
  return e.kind === 'request' && e.thread !== e.id
    ? ['a request thread must equal its id']
    : []
}

function rigErrors(e: Record<string, unknown>): string[] {
  const errs: string[] = []
  for (const [field, name] of [
    [e.from, 'from'],
    [e.to, 'to'],
  ] as const) {
    if (typeof field !== 'string' || parseRigUri(field) === null) {
      errs.push(`${name} must be a mesh:// rig uri`)
    }
  }
  return errs
}

export function toEnvelope(raw: unknown): MeshEnvelope | null {
  return validateEnvelope(raw).length === 0
    ? {
        v: MESH_VERSION,
        id: (raw as MeshEnvelope).id,
        kind: (raw as MeshEnvelope).kind,
        thread: (raw as MeshEnvelope).thread,
        from: canonRig((raw as MeshEnvelope).from),
        to: canonRig((raw as MeshEnvelope).to),
        title: (raw as MeshEnvelope).title,
        body: (raw as MeshEnvelope).body ?? '',
        refs: parseRefs((raw as MeshEnvelope).refs),
        terms: parseTerms((raw as MeshEnvelope).terms),
        evidence: parseRefs((raw as MeshEnvelope).evidence),
      }
    : null
}

/** bead → envelope. A bead that is not a mesh record returns null;
 *  `request` kinds thread to themselves. */
export function envelopeFromBead(bead: BeadLike): MeshEnvelope | null {
  const labels = bead.labels ?? []
  if (!labels.includes(MESH_VERSION_LABEL)) {
    return null
  }
  const kind = labelValue(labels, 'mesh:kind:')
  const thread = labelValue(labels, 'mesh:thread:')
  const from = labelValue(labels, 'mesh:from:')
  const to = labelValue(labels, 'mesh:to:')
  if (
    kind === null ||
    !(MESH_KINDS as readonly string[]).includes(kind) ||
    thread === null ||
    from === null ||
    to === null ||
    parseRigUri(from) === null ||
    parseRigUri(to) === null ||
    (kind === 'request' && thread !== bead.id)
    // a request threads to itself — a foreign thread id means the bead
    // was hand-labelled, not posted through the mesh
  ) {
    return null
  }
  return {
    v: MESH_VERSION,
    id: bead.id,
    kind: kind as MeshKind,
    thread,
    from: canonRig(from),
    to: canonRig(to),
    title: bead.title,
    body: bead.description ?? bead.notes ?? '',
    refs: labelRefs(labels, 'mesh:ref:'),
    terms:
      typeof bead.priority === 'number'
        ? { priority: PRIORITY_NAMES[bead.priority] ?? `p${bead.priority}` }
        : {},
    evidence: labelRefs(labels, 'mesh:ev:'),
  }
}
