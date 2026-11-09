/**
 * The client registry — every adapter the router can render for.
 *
 * A new client is a new adapter, not a new branch here: the registry
 * is the list the CLI prints and the seam the callers resolve through.
 */
import type { ClientAdapter } from './adapter.ts';
import { claudeCodeAdapter } from './clients/claude-code.ts';

/** The known adapters — the pilot first. */
export const CLIENTS: readonly ClientAdapter[] = [claudeCodeAdapter];

/** The adapter for an id — undefined when the id names no client. */
export function clientById(id: string): ClientAdapter | undefined {
  return CLIENTS.find(c => c.id === id);
}

/** The known client ids — what an unknown id is answered with. */
export function clientIds(): string[] {
  return CLIENTS.map(c => c.id);
}
