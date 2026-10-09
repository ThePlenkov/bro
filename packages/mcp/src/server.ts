/**
 * `bro mcp` — the stdio MCP server binding for the plane catalog
 * (specs/bro-9rls.1.md). v1 is read-only: tools/list is generated from
 * descriptors + live capabilities each call, tools/call dispatches
 * through callTool, and every failure lands as an `{ error }` tool
 * result — a caller gets `degraded`, never a stack trace.
 *
 * The SDK is a dynamic import: a repo that never runs `bro mcp` never
 * pays for it, and the CLI stays free of a hard MCP dependency.
 */
import type { PlaneDescriptor } from '@broject/core'
import { callTool, catalogTools } from './tools.ts'

export interface McpServeOpts {
  /** the config-filtered catalog for this repo */
  catalog: PlaneDescriptor[]
  name?: string
  version?: string
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

const textResult = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
})

export async function serveMcp(opts: McpServeOpts): Promise<void> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  )

  const server = new Server(
    {
      name: opts.name ?? 'bro',
      version: opts.version ?? '0.0.0',
    },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await catalogTools(opts.catalog),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      const result = await callTool(
        opts.catalog,
        name,
        (args ?? undefined) as Record<string, unknown> | undefined
      )
      return textResult(result)
    } catch (err) {
      return {
        ...textResult({ error: errText(err), tool: name }),
        isError: true as const,
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
