/**
 * The catalog command both CLIs run — the brouter bin and bro's own
 * spelling (`bro router models`) are two shells over one
 * implementation. (The `client` command — a thin client's model block —
 * is `@broject/client-adapters` now.)
 */
import type { RouterEndpoint } from './gateway.ts';
import type { ServedModel } from './catalog.ts';
import { readCatalog } from './gateway.ts';

/** The served catalog — the router's answer, read over HTTP. */
export async function runModels(endpoint: RouterEndpoint): Promise<{
  models: ServedModel[];
  dropped: number;
}> {
  return readCatalog(endpoint);
}
