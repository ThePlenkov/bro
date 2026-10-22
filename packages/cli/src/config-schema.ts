/**
 * Generator surface for `scripts/gen-config-schema.ts` — a tsdown entry
 * whose built twin (`dist/config-schema.js`) the script imports. The
 * document comes from the SAME registry the CLI loads: core sections +
 * every plugin's declared `.jsonSchema` (spec: specs/bro-d9dmx.md).
 */
import { configSchemaDocument } from '@broject/core'
import { pluginConfigSections } from './plugins.ts'

export function emitConfigSchemaJson(): string {
  return `${JSON.stringify(configSchemaDocument(pluginConfigSections()), null, 2)}\n`
}
