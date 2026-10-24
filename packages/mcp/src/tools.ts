/**
 * Tool generation from plane descriptors — the pure half of the MCP
 * transport (specs/bro-9rls.1.md). Every tool is `bro_<plane>_<op>`:
 * `list` and `get` exist on every plane; each entry in the descriptor's
 * `reads` emits `bro_<plane>_<read>`. A capability-false `read` hides
 * the plane's read tools — an absent capability is an absent tool,
 * never a fake empty list.
 *
 * Write surface: the descriptor's `mcpVerbs` allowlist (verbs a spec
 * assigned to this transport — v1 stays read-only except those) emits
 * `bro_<plane>_<verb>` gated on the verb's own live capability, so a
 * wired verb can serve even while `read` is false.
 *
 * This module is SDK-free on purpose: generation and dispatch are
 * unit-testable without the stdio transport, and a repo that never
 * runs `bro mcp` never pays for the SDK.
 */
import {
  PlaneUnavailable,
  PlaneVerbError,
  type PlaneDescriptor,
} from '@broject/core'

export interface PlaneTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const OBJECT_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: true }

/** 'list'/'get'/'read' args arrive as one JSON object — the descriptor
 *  declares the shape per named read via readArgs; undeclared reads
 *  get a permissive object schema. */
function argSchema(plane: PlaneDescriptor, read: string): Record<string, unknown> {
  return plane.readArgs?.[read] ?? OBJECT_SCHEMA
}

const LIST_DESCRIPTION = 'list rows — pass filter args per the schema'
const GET_DESCRIPTION = 'one row by its stable key (id), null when absent'

/** The read tools a plane exposes — gated on `read` upstream. */
export function planeTools(plane: PlaneDescriptor): PlaneTool[] {
  const tools: PlaneTool[] = [
    {
      name: `bro_${plane.name}_list`,
      description: `${plane.name}: ${LIST_DESCRIPTION}`,
      inputSchema: argSchema(plane, 'list'),
    },
    {
      name: `bro_${plane.name}_get`,
      description: `${plane.name}: ${GET_DESCRIPTION}`,
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'the row\'s stable key (id)' },
        },
        required: ['ref'],
      },
    },
  ]
  for (const read of plane.reads) {
    tools.push({
      name: `bro_${plane.name}_${read}`,
      description: `${plane.name}.${read} — named read declared by the plane descriptor`,
      inputSchema: argSchema(plane, read),
    })
  }
  return tools
}

/** One verb tool per `mcpVerbs` entry — the verb must also be declared
 *  in `verbs` (mcpVerbs selects from the contract, it doesn't extend
 *  it). Gated on the verb's own capability upstream, never on `read`. */
function verbTools(plane: PlaneDescriptor): PlaneTool[] {
  return (plane.mcpVerbs ?? [])
    .filter((verb) => plane.verbs.includes(verb))
    .map((verb) => ({
      name: `bro_${plane.name}_${verb}`,
      description: `${plane.name}.${verb} — declared verb exposed to MCP`,
      inputSchema: plane.verbArgs?.[verb] ?? OBJECT_SCHEMA,
    }))
}

/** A name that is both a declared read and an exposed verb makes
 *  `bro_<plane>_<op>` ambiguous — reads and execs are different
 *  contracts under one tool name, so the descriptor fails loud
 *  instead of silently picking a side. */
function assertUnambiguousOps(plane: PlaneDescriptor): void {
  const overlap = (plane.mcpVerbs ?? []).filter((v) => plane.reads.includes(v))
  if (overlap.length > 0) {
    throw new PlaneVerbError(
      plane.name,
      overlap[0] as string,
      `plane '${plane.name}' declares ${overlap.join(', ')} as both read and mcpVerb — ambiguous op name`
    )
  }
}

/** One live-capability probe per plane — catalog and dispatch share
 *  the verdict: `read` gates the read tools, each `mcpVerbs` entry its
 *  own capability. A throwing probe certifies nothing. */
async function capabilities(plane: PlaneDescriptor): Promise<Record<string, boolean>> {
  return plane.capabilities().catch(() => ({ read: false }) as Record<string, boolean>)
}

/** capabilities → tools/list. `read: false` hides the read tools; a
 *  false verb capability hides just that verb's tool. */
export async function catalogTools(catalog: PlaneDescriptor[]): Promise<PlaneTool[]> {
  const out: PlaneTool[] = []
  for (const plane of catalog) {
    assertUnambiguousOps(plane)
    const caps = await capabilities(plane)
    if (caps['read'] === true) {
      out.push(...planeTools(plane))
    }
    out.push(...verbTools(plane).filter((t) => caps[t.name.slice(`bro_${plane.name}_`.length)] === true))
  }
  return out
}

/** tools/call dispatch — name is matched against the catalog by
 *  `bro_<plane>_<op>` where <op> is list | get | a declared read | a
 *  declared mcpVerb. A name that doesn't resolve is a client bug
 *  (PlaneVerbError); a capability-false op is unavailable
 *  (PlaneUnavailable) — the same absent-capability = absent-tool
 *  contract tools/list advertises. */
export async function callTool(
  catalog: PlaneDescriptor[],
  name: string,
  args: Record<string, unknown> | undefined
): Promise<unknown> {
  // longest plane name first — a `work_archive` plane must win
  // `bro_work_archive_*` over `work`, or the shorter prefix eats
  // the call and misreads the suffix as an op
  for (const plane of [...catalog].sort((a, b) => b.name.length - a.name.length)) {
    const prefix = `bro_${plane.name}_`
    if (!name.startsWith(prefix)) {
      continue
    }
    assertUnambiguousOps(plane)
    const caps = await capabilities(plane)
    const op = name.slice(prefix.length)
    // the same gate tools/list applies — a capability-false op's tool
    // was never advertised, so a call against one is unavailable, not
    // dispatchable
    const declared = op === 'list' || op === 'get' || plane.reads.includes(op)
    const verb = (plane.mcpVerbs ?? []).includes(op) && plane.verbs.includes(op)
    if (!declared && !verb) {
      throw new PlaneVerbError(
        plane.name,
        op,
        `unknown tool '${name}' — plane '${plane.name}' declares: list, get, ` +
          `${[...plane.reads, ...(plane.mcpVerbs ?? [])].join(', ') || '(no named reads or verbs)'}`
      )
    }
    if ((declared && caps['read'] !== true) || (verb && caps[op] !== true)) {
      throw new PlaneUnavailable(
        plane.name,
        `'${op}' capability absent — its tool is not advertised; enumerate tools/list first`
      )
    }
    if (verb) {
      return plane.exec(op, args ?? {})
    }
    if (op === 'list') {
      return plane.list(args)
    }
    if (op === 'get') {
      const ref = args?.ref
      if (typeof ref !== 'string' || ref === '') {
        throw new PlaneVerbError(plane.name, 'get', 'ref is required')
      }
      return (await plane.get(ref)) ?? null
    }
    return plane.read(op, args)
  }
  throw new PlaneUnavailable(
    'mcp',
    `unknown tool '${name}' — no plane matches; enumerate tools/list first`
  )
}
