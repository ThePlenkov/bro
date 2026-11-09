/**
 * The configured providers — the router's own inventory.
 *
 * The provider entries live in the repo's config (`providers.<name>`,
 * one file for both CLIs). This module reads them and renders the
 * inventory: which provider is configured, of what kind, what it talks
 * to, and which model it pins.
 *
 * The inventory is the operator's map of the router: `brouter ask` and
 * `brouter acp` name a provider from THIS list.
 */
import { loadConfig, type ProviderEntry } from '@broject/core';

/** One configured provider, as the inventory renders it. */
export interface ProviderRow {
  /** the entry's name — how a consumer names it */
  name: string;
  /** the kind: api | acp | cli */
  type: string;
  /** what it talks to — the command (acp/cli) or the host (api) */
  target?: string;
  /** the pinned model */
  model?: string;
  /** how many models the entry serves (an api allowlist) */
  models?: number;
  /** the catalog template (a cli entry) — the ids come from it */
  catalog?: string;
}

/** One entry → its row. */
function row(name: string, entry: ProviderEntry): ProviderRow {
  switch (entry.type) {
    case 'api':
      return {
        name,
        type: entry.type,
        target: entry.baseUrl,
        ...(entry.model === undefined ? {} : { model: entry.model }),
        models: Object.keys(entry.models).length,
      };
    case 'acp':
      return {
        name,
        type: entry.type,
        target: entry.command,
        ...(entry.model === undefined ? {} : { model: entry.model }),
      };
    case 'cli':
      return {
        name,
        type: entry.type,
        target: entry.command,
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(entry.models === undefined ? {} : { catalog: entry.models }),
      };
  }
}

/** Every configured provider, in config order. */
export function configuredProviders(dir: string): ProviderRow[] {
  const config = loadConfig(dir);
  return Object.entries(config.providers ?? {}).map(([name, entry]) => row(name, entry));
}
