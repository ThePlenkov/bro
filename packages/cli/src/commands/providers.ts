/** `bro providers` — the provider registry's read surface.
 *
 *   bro providers models [name…]
 *
 * The catalog surface: every provider's model list rendered as
 * `<provider>/<model>` — the uniform `provider/model` vocabulary the
 * hosts' pickers (claude's `/bro:models`, a fleet --model flag, a
 * judge pin) all share. Source per kind:
 *
 *   api — the `models` allowlist (config-declared, offline)
 *   acp — session/new's model config option, enumerated over ACP
 *   cli — the entry's `models` shell template (one id per line)
 *
 * A pinned default `model` always renders, even when no catalog
 * surface exists — `bro providers models` never prints an empty
 * provider silently.
 */
import { execFileSync } from 'node:child_process'
import { loadConfig } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import type { AcpSeam } from '@broject/providers'

const USAGE = `usage:
  bro providers models [name…]  list every provider's models as <provider>/<model>
`
const die = (msg: string): never => {
  console.error(`bro providers: ${msg}`)
  process.exit(1)
}

interface Opts {
  /** Test seam — injected in-process acp peer (AcpSeam.peer). */
  acp?: AcpSeam
  /** Test seam — replaces the models-template exec. */
  exec?: (command: string) => string
  /** Test seam — the registry; default loads cwd config. */
  providers?: Record<string, ProviderEntry>
  /** Test seam — stdout capture; default console.log. */
  out?: (line: string) => void
}

/** A catalog row — `id` is `<name>/<model-id>`; `name` is the
 *  provider's own display label when it advertises one (acp options
 *  carry a human name; api/cli catalogs are id-only). The conductor's
 *  `/v1/models` maps `name` onto display_name. */
export interface CatalogModel {
  id: string
  name?: string
}

/** The catalog as `<name>/<model-id>` rows — the same list
 *  `bro providers models` renders, exported for the serve conductor's
 *  `/v1/models` surface (spec bro-wxfls: the catalog may be a
 *  different entry than the messages backend). */
export async function catalogModels(
  name: string,
  entry: ProviderEntry,
  opts: { acp?: AcpSeam; exec?: (command: string) => string } = {}
): Promise<CatalogModel[]> {
  return providerModels(name, entry, opts)
}

/** One provider's catalog rows — `id` is `<name>/<model-id>` each. */
async function providerModels(
  name: string,
  entry: ProviderEntry,
  opts: Opts
): Promise<CatalogModel[]> {
  const render = (id: string, modelName?: string): CatalogModel => ({
    id: `${name}/${id}`,
    name: modelName,
  })
  switch (entry.type) {
    case 'api':
      // the allowlist IS the catalog — a model not declared can't run
      return Object.keys(entry.models).map((id) => render(id))
    case 'cli': {
      const ids: string[] = []
      if (entry.models !== undefined) {
        const exec = opts.exec ?? ((cmd: string) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' })) // NOSONAR — operator-configured models template, same contract as command
        ids.push(
          ...exec(entry.models)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '')
        )
      }
      if (entry.model !== undefined && !ids.includes(entry.model)) {
        ids.push(entry.model)
      }
      return ids.map((id) => render(id))
    }
    case 'acp': {
      const { acpModels } = await import('@broject/providers')
      const listed = await acpModels(name, entry, { acp: opts.acp })
      if (entry.model !== undefined && !listed.some((m) => m.value === entry.model)) {
        listed.push({ value: entry.model })
      }
      return listed.map((m) => render(m.value, m.name))
    }
  }
}

export async function runProvidersCommand(argv: string[], opts: Opts = {}): Promise<void> {
  const [verb, ...names] = argv
  if (verb !== 'models') {
    console.log(USAGE)
    process.exit(verb === undefined ? 0 : 1)
  }
  const providers = opts.providers ?? loadConfig(process.cwd()).providers ?? {}
  const wanted =
    names.length > 0
      ? names.map((n) => {
          const entry = providers[n]
          if (entry === undefined) {
            die(
              `providers.${n} is not configured — configured: ${Object.keys(providers).join(', ') || 'none'}`
            )
          }
          return [n, entry] as const
        })
      : (Object.entries(providers) as [string, ProviderEntry][])
  const out = opts.out ?? ((line: string) => console.log(line))
  let failed = 0
  for (const [name, entry] of wanted) {
    try {
      for (const row of await providerModels(name, entry, opts)) {
        out(row.id)
      }
    } catch (err) {
      failed += 1
      console.error(
        `bro providers: ${name} — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  if (failed > 0) {
    process.exit(1)
  }
}
