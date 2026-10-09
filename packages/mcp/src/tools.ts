/**
 * Tool generation from plane descriptors — the pure half of the MCP
 * transport (specs/bro-9rls.1.md). Every tool is `bro_<plane>_<op>`:
 * `list` and `get` exist on every plane; each entry in the descriptor's
 * `reads` emits `bro_<plane>_<read>`. A capability-false `read` hides
 * the whole plane's tools — an absent capability is an absent tool,
 * never a fake empty list.
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

/** A plane is readable only when capabilities() certifies `read:
 *  true` — a probe that throws or omits `read` is the same verdict:
 *  the plane can't certify it can serve, so it is not advertised
 *  (absent capability = absent tool). */
async function readable(plane: PlaneDescriptor): Promise<boolean> {
  const caps = await plane
    .capabilities()
    .catch(() => ({ read: false }) as Record<string, boolean>)
  return caps['read'] === true
}

/** capabilities → tools/list. Unreadable planes hide entirely. */
export async function catalogTools(catalog: PlaneDescriptor[]): Promise<PlaneTool[]> {
  const out: PlaneTool[] = []
  const ok = await Promise.all(catalog.map(readable))
  for (const [i, plane] of catalog.entries()) {
    if (ok[i] === true) {
      out.push(...planeTools(plane))
    }
  }
  return out
}

/** tools/call dispatch — name is matched against the catalog by
 *  `bro_<plane>_<op>` where <op> is list | get | a declared read.
 *  A name that doesn't resolve is a client bug (PlaneVerbError);
 *  the thrown error is rendered as an { error } tool result by the
 *  server, never a stack trace. */
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
    // the same gate tools/list applies — a hidden plane's tools are
    // absent, so a call against one is unavailable, not dispatchable
    if (!(await readable(plane))) {
      throw new PlaneUnavailable(
        plane.name,
        `read capability absent — its tools are not advertised; enumerate tools/list first`
      )
    }
    const op = name.slice(prefix.length)
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
    if (plane.reads.includes(op)) {
      return plane.read(op, args)
    }
    throw new PlaneVerbError(
      plane.name,
      op,
      `unknown tool '${name}' — plane '${plane.name}' declares: list, get, ${plane.reads.join(', ') || '(no named reads)'}`
    )
  }
  throw new PlaneUnavailable(
    'mcp',
    `unknown tool '${name}' — no plane matches; enumerate tools/list first`
  )
}
