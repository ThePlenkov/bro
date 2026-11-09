/**
 * brouter — the client seam.
 *
 * A thin client (Claude Code, Codex, a REPL) holds the router's model
 * list in its OWN vocabulary: its own settings file, its own key, its
 * own model knowledge. The adapter is what translates — the router
 * says "these models are served", the adapter says "here is how this
 * client sees them".
 *
 * The seam is deliberately small: an adapter never talks to the
 * router, never reads a token, never spawns anything. It renders a
 * block and describes the wiring; the caller does the rest.
 */
import type { ServedModel } from './catalog.ts';

/** Where the router lives — the loopback endpoint and the credential
 *  the router's own plane demands. */
export interface RouterEndpoint {
  url: string;
  token: string;
}

/** The per-client seam. */
export interface ClientAdapter {
  /** the stable id — `claude-code` */
  readonly id: string;
  /** the human title */
  readonly title: string;
  /** the settings file the client reads by default */
  readonly defaultSettingsPath: string;
  /** the settings key that carries the model block */
  readonly settingsKey: string;
  /** the block, in the client's vocabulary */
  renderModelBlock(models: ServedModel[]): Record<string, unknown>;
  /** the wiring (env) the client needs to reach the router — NEVER a
   *  credential: a settings file is the wrong place for a secret */
  wire(router: RouterEndpoint): Record<string, unknown>;
}

/** Merge the model block into a client's settings — non-destructive:
 *  every other key survives, the block replaces the one key it owns.
 *  A client needing more than one key overrides the merge, not this
 *  helper. */
export function mergeSettings(
  settings: Record<string, unknown>,
  key: string,
  block: Record<string, unknown>
): Record<string, unknown> {
  return { ...settings, [key]: block };
}
