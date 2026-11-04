/**
 * The commands both CLIs run — the brouter bin and bro's own spelling
 * (`bro serve client`) are two shells over one implementation.
 */
import type { ClientAdapter, RouterEndpoint } from './adapter.ts';
import { mergeSettings } from './adapter.ts';
import { readCatalog } from './gateway.ts';
import { clientById, clientIds } from './registry.ts';
import { expandHome, readSettings, writeSettings } from './settings.ts';
import type { ServedModel } from './catalog.ts';

/** A client's request — what a CLI parses into. */
export interface ClientRequest {
  /** the client id */
  client: string;
  /** merge the block into the client's settings file */
  write: boolean;
  /** the settings file (the adapter's default when absent) */
  settings?: string;
  /** report the wiring (env) the client needs to reach the router */
  wire: boolean;
  /** the JSON shape for the output */
  json: boolean;
}

/** What a client command did. */
export interface ClientOutcome {
  /** the model block, in the client's vocabulary */
  block: Record<string, unknown>;
  /** the served models it was rendered from */
  models: ServedModel[];
  /** the settings file that was written (only with `write`) */
  written?: string;
  /** the wiring (env) the client needs to reach the router */
  wiring: Record<string, unknown>;
}

/** The adapter for a client id — an unknown id is an error naming the
 *  known ones (never a silent default: a wrong client would write the
 *  wrong file). */
export function requireClient(id: string): ClientAdapter {
  const client = clientById(id);
  if (client === undefined) {
    throw new Error(`unknown client "${id}" — known: ${clientIds().join(', ')}`);
  }
  return client;
}

/** Render the model block for a client and, with `write`, merge it into
 *  the client's settings file. The merge is non-destructive: every
 *  other key survives. */
export async function runClient(
  request: ClientRequest,
  endpoint: RouterEndpoint
): Promise<ClientOutcome> {
  const client = requireClient(request.client);
  const { models } = await readCatalog(endpoint);
  const block = client.renderModelBlock(models);
  const wiring = client.wire(endpoint);
  const outcome: ClientOutcome = { block, models, wiring };
  if (!request.write) return outcome;
  const path = expandHome(request.settings ?? client.defaultSettingsPath);
  writeSettings(path, mergeSettings(readSettings(path), client.settingsKey, block));
  outcome.written = path;
  return outcome;
}

/** The served catalog — the router's answer, read over HTTP. */
export async function runModels(endpoint: RouterEndpoint): Promise<{
  models: ServedModel[];
  dropped: number;
}> {
  return readCatalog(endpoint);
}
