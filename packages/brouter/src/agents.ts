/**
 * The agent clients — the agent CLIs the router can drive or front.
 *
 * A client is a PROGRAM on this machine: Claude Code, Codex, Gemini…
 * Three facts matter to the operator, and they are different facts:
 *
 *  - **installed** — the binary is on PATH;
 *  - **configured** — a provider entry names this client (the router
 *    has a wire to it);
 *  - **ready** — both: the router can actually reach it.
 *
 * The registry is the router's own list of the clients it knows. An
 * unknown client still shows up in the inventory as CONFIGURED (the
 * config named it) — the registry never hides a configured entry, it
 * only fails to describe one it has no name for.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadConfig, type ProviderEntry } from '@broject/core';

/** One agent CLI the router knows. */
export interface AgentClient {
  /** the stable id — `claude`, `codex` */
  id: string;
  /** the human title */
  title: string;
  /** the binary on PATH */
  binary: string;
  /** the acp command, when the client speaks ACP */
  acp?: string;
}

/** The known agent clients. */
export const AGENT_CLIENTS: readonly AgentClient[] = [
  { id: 'claude', title: 'Claude Code', binary: 'claude' },
  { id: 'codex', title: 'Codex', binary: 'codex' },
  { id: 'gemini', title: 'Gemini CLI', binary: 'gemini', acp: 'gemini --acp' },
  { id: 'devin', title: 'Devin', binary: 'devin', acp: 'devin acp' },
  { id: 'opencode', title: 'OpenCode', binary: 'opencode', acp: 'opencode acp' },
  { id: 'kilo', title: 'Kilo Code', binary: 'kilo', acp: 'kilo --acp' },
  { id: 'dirac', title: 'Dirac', binary: 'dirac', acp: 'dirac --acp' },
  { id: 'omp', title: 'OMP', binary: 'omp', acp: 'omp acp' },
  { id: 'pi', title: 'Pi', binary: 'pi' },
  { id: 'goose', title: 'Goose', binary: 'goose' },
];

/** Is the binary on PATH? A PATH walk, not a spawn — the inventory
 *  must not start a process per client. */
export function isInstalled(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env['PATH'];
  if (path === undefined || path === '') return false;
  return path
    .split(delimiter)
    .filter(dir => dir !== '')
    .some(dir => existsSync(join(dir, binary)));
}

/** The binary a provider entry runs — the first token of its command. */
function entryBinary(entry: ProviderEntry): string | undefined {
  if (entry.type === 'api') return undefined;
  const first = entry.command.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? undefined : first;
}

/** One client's row in the inventory. */
export interface ClientInventoryRow {
  id: string;
  title: string;
  /** the binary on PATH */
  binary: string;
  /** the binary is on PATH */
  installed: boolean;
  /** the provider entry that names this client */
  configured?: string;
  /** the connector kind of that entry */
  connector?: string;
  /** installed AND configured — the router can reach it */
  ready: boolean;
}

/** The inventory: every known client plus every configured entry the
 *  registry has no name for. */
export function clientInventory(
  dir: string,
  env: NodeJS.ProcessEnv = process.env
): ClientInventoryRow[] {
  const providers = loadConfig(dir).providers ?? {};
  const rows: ClientInventoryRow[] = [];
  const seen = new Set<string>();
  for (const client of AGENT_CLIENTS) {
    const entry = Object.entries(providers).find(
      ([, e]) => e.type !== 'api' && entryBinary(e) === client.binary
    );
    const installed = isInstalled(client.binary, env);
    seen.add(client.binary);
    rows.push({
      id: client.id,
      title: client.title,
      binary: client.binary,
      installed,
      ...(entry === undefined ? {} : { configured: entry[0], connector: entry[1].type }),
      ready: installed && entry !== undefined,
    });
  }
  // a configured entry the registry has no name for is still a client
  for (const [name, entry] of Object.entries(providers)) {
    const binary = entryBinary(entry);
    if (binary === undefined || seen.has(binary)) continue;
    seen.add(binary);
    const installed = isInstalled(binary, env);
    rows.push({
      id: binary,
      title: binary,
      binary,
      installed,
      configured: name,
      connector: entry.type,
      ready: installed,
    });
  }
  return rows;
}

/** The connector registry — the kinds the router speaks, with the
 *  entries behind each. */
export interface ConnectorRow {
  /** the kind: acp | api | cli */
  kind: string;
  /** the entries of this kind */
  entries: string[];
}

/** The connectors, in the order the kinds matter (acp first — the
 *  router's lanes are agents). */
export function connectorInventory(dir: string): ConnectorRow[] {
  const providers = loadConfig(dir).providers ?? {};
  const kinds = ['acp', 'api', 'cli'];
  const rows: ConnectorRow[] = [];
  for (const kind of kinds) {
    const entries = Object.entries(providers)
      .filter(([, entry]) => entry.type === kind)
      .map(([name]) => name);
    if (entries.length > 0) rows.push({ kind, entries });
  }
  return rows;
}
