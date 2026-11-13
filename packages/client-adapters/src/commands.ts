/**
 * The client command — render a client's model block from the served
 * catalog and, with `write`, merge it into the client's settings file.
 *
 * The catalog is read through brouter's public API (`readCatalog` —
 * the router's `/v1/models` over HTTP); this package never re-implements
 * the read, and brouter never imports the adapters.
 */
import { readCatalog, type RouterEndpoint, type ServedModel } from '@broject/brouter';
import type { ClientAdapter } from './adapter.ts';
import { mergeSettings } from './adapter.ts';
import { clientById, clientIds } from './registry.ts';
import { expandHome, readSettings, writeSettings } from './settings.ts';
import { type SettingsChange, settingsDiff } from './settings-diff.ts';

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
  /** the settings file the block lands in */
  path: string;
  /** the diff — what the write changes (empty when nothing changes) */
  changes: SettingsChange[];
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
 *  other key survives.
 *
 *  The diff is computed BEFORE the write — the dry-run and the write
 *  read the same file and say the same thing, so what the operator
 *  saw is what landed. */
export async function runClient(
  request: ClientRequest,
  endpoint: RouterEndpoint
): Promise<ClientOutcome> {
  const client = requireClient(request.client);
  const { models } = await readCatalog(endpoint);
  const block = client.renderModelBlock(models);
  const wiring = client.wire(endpoint);
  const path = expandHome(request.settings ?? client.defaultSettingsPath);
  const current = readSettings(path);
  const planned = mergeSettings(current, client.settingsKey, block);
  const outcome: ClientOutcome = {
    block,
    models,
    wiring,
    path,
    changes: settingsDiff(current, planned),
  };
  if (!request.write) return outcome;
  writeSettings(path, planned);
  outcome.written = path;
  return outcome;
}
