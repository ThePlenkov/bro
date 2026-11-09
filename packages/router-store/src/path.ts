/**
 * The router's store path — where the ledger lives on this machine.
 *
 * NOT the git common dir: the router runs without beads, without the
 * bus, without a git repo (spec bro-olfvd). The ledger is the ROUTER's
 * state, so it belongs to the router's own state directory — XDG state,
 * the place for things that are state rather than configuration.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `${XDG_STATE_HOME:-~/.local/state}/brouter/router.db` — the ledger. */
export function routerStorePath(env: Record<string, string | undefined> = process.env): string {
  const state = env['XDG_STATE_HOME'];
  const home = env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : homedir();
  const base = state !== undefined && state.trim() !== '' ? state : join(home, '.local', 'state');
  return join(base, 'brouter', 'router.db');
}
