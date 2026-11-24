/**
 * ACP session settle — at PR completion each unique recorded acp
 * session gets its provider's `sessionRm` template run detached, then
 * `acpSessionId` clears on the matched registry entries (spec
 * bro-5qsnr §5). Matching is by molStep name or path-resolved
 * worktree. Every leg is advisory — a settle failure never blocks.
 *
 * Leaf module — imports externals + the env shape as a type.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AgentRegistryEntry,
  type ProviderEntry,
  patchAgentRegistry,
  readAgentRegistry,
} from '@broject/core';
import type { AgentConnectorEnv } from './core.ts';

/** The two path forms a settle target carries — the resolved path and
 *  its realpath; a symlinked entry dir can record either. */
interface SettlePath {
  resolved: string;
  real: string;
}

/** An entry's recorded worktree against the target — either path form
 *  matching either of the target's counts (a symlinked tree resolves
 *  differently per side). */
function entryMatchesWorktree(entry: AgentRegistryEntry, target: SettlePath): boolean {
  const wt =
    typeof entry.worktree === 'string' && entry.worktree !== '' ? entry.worktree : undefined;
  if (wt === undefined) {
    return false;
  }
  const resolved = resolve(wt);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }
  return real === target.real || resolved === target.resolved;
}

/** The entries the settle touches — matched by molStep name or by
 *  path-resolved worktree against the target. */
function settleMatchedEntries(
  registry: Record<string, AgentRegistryEntry>,
  molSteps: ReadonlySet<string>,
  worktree: SettlePath | undefined
): Array<[string, AgentRegistryEntry]> {
  const matched: Array<[string, AgentRegistryEntry]> = [];
  for (const [molStep, entry] of Object.entries(registry)) {
    const byStep = molSteps.size > 0 && molSteps.has(molStep);
    const byTree = worktree !== undefined && entryMatchesWorktree(entry, worktree);
    const hit = byStep || byTree;
    if (hit) {
      matched.push([molStep, entry]);
    }
  }
  return matched;
}

/** The unique session ids the matched entries recorded → their
 *  minting provider. */
function settleIdProviders(matched: Array<[string, AgentRegistryEntry]>): Map<string, string> {
  const idProvider = new Map<string, string>();
  for (const [, entry] of matched) {
    const sid = entry.acpSessionId;
    const prov = entry.provider;
    if (typeof sid !== 'string' || sid === '') {
      continue;
    }
    if (typeof prov !== 'string' || prov === '') {
      continue;
    }
    if (idProvider.has(sid)) {
      continue;
    }
    idProvider.set(sid, prov);
  }
  return idProvider;
}

/** Run each unique session's `sessionRm` template detached — the
 *  provider entry must be an acp entry carrying the template, the id
 *  shell-safe (`[\w.-]+` — the template substitutes it into a `-c`
 *  string). */
function settleRmSessions(
  providers: Record<string, ProviderEntry>,
  idProvider: ReadonlyMap<string, string>,
  settled: string[]
): void {
  for (const [sessionId, providerName] of idProvider) {
    const prov = providers[providerName];
    const template = prov?.type === 'acp' ? prov.sessionRm : undefined;
    const runnable = /^[\w.-]+$/.test(sessionId) && template !== undefined && template !== '';
    if (!runnable) {
      continue;
    }
    const rm = template.replaceAll('{sessionId}', sessionId);
    try {
      const child = spawn('/bin/sh', ['-c', rm], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      settled.push(sessionId);
    } catch {
      // advisory — a failed settle never blocks
    }
  }
}

/** Clear `acpSessionId` on the matched rows — skipped where the row
 *  already lost its entry (a parallel reaper owns it now). */
function clearSettledSessions(
  dir: string,
  registry: Record<string, AgentRegistryEntry>,
  matched: Array<[string, AgentRegistryEntry]>
): void {
  for (const [molStep, entry] of matched) {
    const hasSession = typeof entry.acpSessionId === 'string' && entry.acpSessionId !== '';
    if (!hasSession) {
      continue;
    }
    try {
      if (registry[molStep] !== undefined) {
        patchAgentRegistry(dir, molStep, { acpSessionId: undefined });
      }
    } catch {
      // advisory
    }
  }
}

/** Settle recorded acp sessions at PR completion — run each unique
 *  provider `sessionRm` template detached, then clear `acpSessionId`
 *  on the matched registry entries (spec bro-5qsnr §5). Returns the
 *  settled session ids for the caller's log line. Failures are
 *  advisory — never a settle blocker. */
export function settleAcpSessions(
  dir: string,
  env: AgentConnectorEnv,
  opts: { worktree?: string; molSteps?: string[] } = {}
): string[] {
  const settled: string[] = [];
  try {
    const registry = readAgentRegistry(dir);
    // the target's two path forms — realpath falls back to the
    // resolved path where it cannot resolve (a tree already gone
    // still settles by its recorded name)
    const worktreeResolved = opts.worktree === undefined ? undefined : resolve(opts.worktree);
    let worktree: SettlePath | undefined;
    if (worktreeResolved !== undefined) {
      let real: string;
      try {
        real = realpathSync(worktreeResolved);
      } catch {
        real = worktreeResolved;
      }
      worktree = { resolved: worktreeResolved, real };
    }
    const matched = settleMatchedEntries(registry, new Set(opts.molSteps ?? []), worktree);
    settleRmSessions(env.providers ?? {}, settleIdProviders(matched), settled);
    clearSettledSessions(dir, registry, matched);
  } catch {
    // advisory — a registry read failure still returns what settled
  }
  return settled;
}
