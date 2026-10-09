/** `bro mcp` — a stdio MCP server over the plane catalog
 *  (specs/bro-9rls.1.md). Tools are generated from descriptors —
 *  `bro_<plane>_list`/`_get` on every plane, `bro_<plane>_<read>` for
 *  declared named reads — and gated by live `capabilities()`. v1 is
 *  read-only: write verbs stay unexposed until the session-authz
 *  question in the spec is settled.
 *
 *  Plane exposure rides `mcp.planes`: absent/empty `mcp` section =
 *  every read plane (spawning the server IS the consent), `[]` = none,
 *  a list = allowlist. Backend selection stays on `connectors.*`. */
import { planes } from '@broject/core'
import { catalogTools, serveMcp } from '@broject/mcp'
import '../planes/index.ts'
import { loadBroConfig } from '../plugins.ts'
import { VERSION } from '../version.ts'

function usage(): never {
  console.error(`usage:
  bro mcp                 stdio MCP server over the read planes
                          (register it in any MCP-capable client:
                          Windsurf, Zed, Goose, Gemini CLI, Copilot,
                          Claude Desktop — tools appear as bro_<plane>_<read>)
  bro mcp --tools         print the generated tools/list payload and exit
                          (capability-gated, same as a client's view)
  bro mcp --help`)
  process.exit(2)
}

export async function runMcpCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  const dir = process.cwd()
  const cfg = loadBroConfig(dir)
  const allow = cfg.mcp.planes as string[] | undefined
  const catalog = planes(dir, { connectors: cfg.connectors }).filter(
    (p) => allow === undefined || allow.includes(p.name)
  )
  if (argv.includes('--tools')) {
    console.log(JSON.stringify(await catalogTools(catalog), null, 2))
    return
  }
  await serveMcp({ catalog, name: 'bro', version: VERSION })
}
