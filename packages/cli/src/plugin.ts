/**
 * Plugin API surface — `import ... from '@theplenkov/bro/plugin'`.
 *
 * Side-effect-free by contract: the CLI entry (index.ts) runs main() on
 * import; this module must never do that. Everything a plugin author or
 * bro.config.ts needs — the contract, config helpers, output printer —
 * re-exported from the bundled core.
 */
export { defineConfig, definePlugin } from '@bro/core'
export type {
  BroConfig,
  BroPlugin,
  ConfigSection,
  PlanSchema,
  Printer,
  StoreBackend,
} from '@bro/core'
export { makePrinter } from '@bro/core'
