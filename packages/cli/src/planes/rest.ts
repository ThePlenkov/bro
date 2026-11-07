/** REST projection of the plane catalog — milestone 3 of
 *  specs/bro-9rls.1.md (bro-9rls.3). Routes are GENERATED from
 *  descriptors exactly like the MCP tool surface:
 *
 *    GET  /api/v1/planes                 the index — every registered
 *                                        plane with reads, verbs, and
 *                                        live capabilities
 *    GET  /api/v1/planes/<plane>         list(?status&limit&<plane-filter>)
 *    GET  /api/v1/planes/<plane>/<name>  a declared named read, else
 *                                        get(<name>) — read names are
 *                                        enumerable so precedence is
 *                                        unambiguous
 *    POST /api/v1/planes/<plane>/<verb>  exec — body is the args object
 *                                        ({} allowed); v1 verbs are
 *                                        declared-but-unwired → 503,
 *                                        undeclared → 400
 *
 *  Error vocabulary mirrors the descriptor contract: PlaneVerbError
 *  (client bug) → 400, PlaneUnavailable (backend can't serve) → 503,
 *  unknown plane / read:false capability → 404 naming the plane. */
import { PlaneUnavailable, PlaneVerbError } from '@broject/core'
import type { PlaneDescriptor, PlaneFilter } from '@broject/core'
import type { ServeResponse } from '../commands/serve.ts'

const NOT_ALLOWED: ServeResponse = { status: 405, body: { error: 'method not allowed' } }

/** list() filter — `status`/`limit` are the declared spine; every
 *  other query key passes through to plane-specific filters. limit=0
 *  is a real value (zero rows), not a drop. */
function filterOf(query: Record<string, string>): PlaneFilter {
  const { status, limit, ...rest } = query
  const filter: PlaneFilter = { ...rest }
  if (status !== undefined) {
    filter.status = status
  }
  const n = Number(limit)
  if (limit !== undefined && Number.isFinite(n) && n >= 0) {
    filter.limit = n
  }
  return filter
}

/** POST body → verb args. Absent/empty body is `{}` — a verb taking
 *  no args shouldn't demand a JSON doc; a non-object body is a 400. */
function argsBody(raw: string | undefined, plane: string, verb: string): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') {
    return {}
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new PlaneVerbError(plane, verb, 'request body is not valid JSON')
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new PlaneVerbError(plane, verb, 'request body must be a JSON object')
  }
  return doc as Record<string, unknown>
}

/** The generated catalog index — live capabilities per plane, a
 *  failed probe reading as incapable (the degraded-not-error rule). */
async function planesIndex(catalog: PlaneDescriptor[]): Promise<ServeResponse> {
  const planes = await Promise.all(
    catalog.map(async (p) => ({
      name: p.name,
      reads: p.reads,
      verbs: p.verbs,
      capabilities: await p.capabilities().catch(() => ({ read: false, error: true })),
    }))
  )
  return { status: 200, body: { planes } }
}

/** One plane's sub-routes. `seg` is the third path component — a
 *  declared read name wins over get(ref): refs can't shadow the
 *  contract, and the catalog makes "is a read" enumerable.
 *
 *  Capability gating mirrors the spec's "absent capability = hidden":
 *  a GET requires caps.read === true, a verb requires caps[verb] ===
 *  true — anything else (false, absent, or a probe that threw) 404s
 *  naming the plane. Degraded never fakes an empty list and never
 *  silently serves. */
async function planeBranch(
  method: string,
  desc: PlaneDescriptor,
  seg: string | undefined,
  rawBody: string | undefined,
  query: Record<string, string>
): Promise<ServeResponse> {
  const caps = await desc
    .capabilities()
    .catch((): Record<string, boolean> => ({ read: false, error: true }))
  const incapable = (cap: string): ServeResponse => ({
    status: 404,
    body: { error: `plane "${desc.name}" cannot '${cap}'`, capabilities: caps },
  })
  if (method === 'GET') {
    if (caps['read'] !== true) {
      return incapable('read')
    }
    if (seg === undefined) {
      return { status: 200, body: await desc.list(filterOf(query)) }
    }
    if (desc.reads.includes(seg)) {
      return { status: 200, body: await desc.read(seg, query) }
    }
    const row = await desc.get(seg)
    return row === undefined
      ? { status: 404, body: { error: `no ${desc.name} "${seg}"` } }
      : { status: 200, body: row }
  }
  if (method === 'POST' && seg !== undefined) {
    // declared-but-unwired verbs throw PlaneUnavailable inside exec —
    // the 503 is the descriptor's own answer, not a route-level guess
    if (!desc.verbs.includes(seg)) {
      throw new PlaneVerbError(desc.name, seg, 'undeclared verb')
    }
    if (caps[seg] !== true) {
      return incapable(seg)
    }
    const result = await desc.exec(seg, argsBody(rawBody, desc.name, seg))
    return { status: 200, body: result ?? { ok: true } }
  }
  return NOT_ALLOWED
}

/** `/api/v1/planes*` dispatch — `api` is the segment list under
 *  `/api/v1/` (api[0] === 'planes'). null catalog → 404 like any
 *  unwired surface. */
export async function routePlanes(
  method: string,
  api: string[],
  rawBody: string | undefined,
  catalog: PlaneDescriptor[] | undefined,
  query: Record<string, string>
): Promise<ServeResponse> {
  if (catalog === undefined) {
    return { status: 404, body: { error: 'not found' } }
  }
  try {
    if (api.length === 1) {
      return method === 'GET' ? planesIndex(catalog) : NOT_ALLOWED
    }
    if (api.length > 3) {
      return { status: 404, body: { error: 'not found' } }
    }
    const desc = catalog.find((p) => p.name === api[1])
    if (desc === undefined) {
      return {
        status: 404,
        body: { error: `no plane "${api[1]}"`, planes: catalog.map((p) => p.name) },
      }
    }
    // row ids carry ':'/spaces (gen:seq refs, thread ids) — the wire
    // shape is percent-encoded, the descriptor wants the decoded ref
    let seg: string | undefined
    if (api.length === 3) {
      try {
        seg = decodeURIComponent(api[2]!)
      } catch {
        throw new PlaneVerbError(desc.name, api[2]!, 'malformed percent-encoding')
      }
    }
    return await planeBranch(method, desc, seg, rawBody, query)
  } catch (err) {
    if (err instanceof PlaneVerbError) {
      return { status: 400, body: { error: err.message } }
    }
    if (err instanceof PlaneUnavailable) {
      return { status: 503, body: { error: err.message } }
    }
    throw err
  }
}
