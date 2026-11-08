import type { CliContract, CliSubContract } from '@broject/core';
import {
  CONTRACT_VERSION,
  eqJson,
  isRecord,
  own,
  type ContractDoc,
  type ContractProblem,
  type Removal,
} from './contract-shared.ts';
import type { ContractCommandRow, ContractDump } from './contract-dump.ts';

/** Coerce parsed JSON into the dump shape — a --dump fixture is as
 *  untrusted as the committed file; unknown members ride along inside
 *  groups/commands, the rest degrades to defaults (drift, not a
 *  crash). */
export function asDump(parsed: unknown): ContractDump {
  if (!isRecord(parsed)) {
    return { version: CONTRACT_VERSION, groups: {}, commands: {} };
  }
  return {
    version: typeof parsed.version === 'number' ? parsed.version : CONTRACT_VERSION,
    groups: isRecord(parsed.groups) ? (parsed.groups as ContractDump['groups']) : {},
    commands: isRecord(parsed.commands) ? (parsed.commands as ContractDoc['commands']) : {},
  };
}

/** The committed file — the dump plus the tombstone ledger. */
export function asDoc(parsed: unknown): ContractDoc {
  return {
    ...asDump(parsed),
    removed: isRecord(parsed) && isRecord(parsed.removed) ? parsed.removed : {},
  };
}

/** `- <path> — reason` bullets → the announced path set. A trailing
 *  colon on the token is punctuation, not part of the path; bullets
 *  inside fenced code blocks are doc examples, not announcements. */
export function parseBreaking(md: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const m = /^\s*[-*]\s+(\S+)/.exec(line);
    const tok = m?.[1];
    if (tok) {
      out.add(tok.replace(/:$/, ''));
    }
  }
  return out;
}

/** An announcement covers its own path and every descendant —
 *  announcing a command covers everything it carried. */
function covered(path: string, announced: ReadonlySet<string>): boolean {
  for (const a of announced) {
    if (path === a || path.startsWith(`${a}.`)) {
      return true;
    }
  }
  return false;
}

/** When a whole committed map is gone, each leaf is still reported at
 *  its own dotted path — a bullet may name the map OR a single entry. */
function removedLeaves(prefix: string, committed: Record<string, unknown>): Removal[] {
  return Object.entries(committed).map(([k, v]) => ({
    path: `${prefix}.${k}`,
    value: v,
  }));
}

/** Keys present in a committed scalar map (flags/exits) but absent
 *  live are removals. Non-record committed values degrade to stale
 *  drift via eqJson, never a walk over garbage. */
function diffMap(prefix: string, committed: unknown, live: unknown): Removal[] {
  if (!isRecord(committed)) {
    return [];
  }
  if (!isRecord(live)) {
    return removedLeaves(prefix, committed);
  }
  const out: Removal[] = [];
  for (const [k, cv] of Object.entries(committed)) {
    if (own(live, k) === undefined) {
      out.push({ path: `${prefix}.${k}`, value: cv });
    }
  }
  return out;
}

/** The subs map — same leaf semantics, but each surviving key descends
 *  into its own sub-contract for flag/exit/json diffs. */
function diffSubs(prefix: string, committed: unknown, live: unknown): Removal[] {
  if (!isRecord(committed)) {
    return [];
  }
  if (!isRecord(live)) {
    return removedLeaves(prefix, committed);
  }
  const out: Removal[] = [];
  for (const [sub, cv] of Object.entries(committed)) {
    const lv = own(live, sub);
    if (lv === undefined) {
      out.push({ path: `${prefix}.${sub}`, value: cv });
    } else if (isRecord(cv) && isRecord(lv)) {
      out.push(...diffSub(`${prefix}.${sub}`, cv as CliSubContract, lv as CliSubContract));
    }
  }
  return out;
}

/** Removals inside one contract level — the bare command and each sub
 *  share the flags/exits/json shape. */
function diffSub(prefix: string, committed: CliSubContract, live: CliSubContract): Removal[] {
  const out = [
    ...diffMap(`${prefix}.flags`, committed.flags, live.flags),
    ...diffMap(`${prefix}.exits`, committed.exits, live.exits),
  ];
  if (committed.json !== undefined && live.json === undefined) {
    out.push({ path: `${prefix}.json`, value: committed.json });
  }
  return out;
}

function diffContract(name: string, committed: unknown, live: CliContract | undefined): Removal[] {
  if (!isRecord(committed)) {
    return [];
  }
  if (live === undefined || !isRecord(live)) {
    return [{ path: `${name}.contract`, value: committed }];
  }
  return [
    ...diffSub(name, committed as CliSubContract, live as CliSubContract),
    ...diffSubs(`${name}.subs`, committed.subs, live.subs),
  ];
}

/** Invocation-meaning scalars on a surviving command — a difference
 *  reroutes `bro <name>` under the same spelling. */
function groupRemoval(
  name: string,
  committed: Record<string, unknown>,
  live: ContractCommandRow
): Removal[] {
  if (committed.group !== live.group && committed.group !== undefined) {
    return [{ path: `${name}.group`, value: committed.group }];
  }
  return [];
}

function aliasOfRemoval(
  name: string,
  committed: Record<string, unknown>,
  live: ContractCommandRow
): Removal[] {
  if (committed.aliasOf === live.aliasOf) {
    return [];
  }
  return [
    {
      path: `${name}.aliasOf`,
      value: committed.aliasOf === undefined ? null : committed.aliasOf,
    },
  ];
}

function argvPrefixRemoval(
  name: string,
  committed: Record<string, unknown>,
  live: ContractCommandRow
): Removal[] {
  if (eqJson(committed.argvPrefix, live.argvPrefix)) {
    return [];
  }
  return [
    {
      path: `${name}.argvPrefix`,
      value: committed.argvPrefix === undefined ? null : committed.argvPrefix,
    },
  ];
}

function commandRemovals(
  name: string,
  committed: Record<string, unknown>,
  live: ContractCommandRow
): Removal[] {
  const out: Removal[] = [];
  out.push(...groupRemoval(name, committed, live));
  out.push(...aliasOfRemoval(name, committed, live));
  out.push(...argvPrefixRemoval(name, committed, live));
  out.push(...diffContract(name, committed.contract, live.contract));
  return out;
}

function groupRemovals(committedGroups: Record<string, unknown>, live: ContractDump): Removal[] {
  const out: Removal[] = [];
  for (const [g, v] of Object.entries(committedGroups)) {
    if (!isRecord(own(live.groups, g))) {
      out.push({ path: `groups.${g}`, value: v });
    }
  }
  return out;
}

function commandRowRemovals(
  committedCommands: Record<string, unknown>,
  live: ContractDump
): Removal[] {
  const out: Removal[] = [];
  for (const [name, c] of Object.entries(committedCommands)) {
    const l = own(live.commands, name);
    if (!isRecord(l)) {
      // absent or garbage live row — invocation-wise the command is gone
      out.push({ path: name, value: c });
    } else if (isRecord(c)) {
      out.push(...commandRemovals(name, c, l as unknown as ContractCommandRow));
    }
    // a non-record committed row is drift — the stale pass reports it
  }
  return out;
}

/** Paths present in the committed doc whose removal changes the
 *  invocation surface — commands, groups, invocation-spelling scalars
 *  (group/aliasOf/argvPrefix), and every declared contract leaf. */
function removals(committed: ContractDoc, live: ContractDump): Removal[] {
  const committedGroups = isRecord(committed.groups) ? committed.groups : {};
  const committedCommands = isRecord(committed.commands) ? committed.commands : {};
  return [...groupRemovals(committedGroups, live), ...commandRowRemovals(committedCommands, live)];
}

/** Additions and value edits inside one map — `(added)` marks keys the
 *  committed doc never had. */
function mapStale(prefix: string, committed: unknown, doc: unknown): string[] {
  if (!isRecord(doc)) {
    return [];
  }
  const committedMap = isRecord(committed) ? committed : {};
  const out: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    const c = own(committedMap, k);
    if (c === undefined) {
      out.push(`${prefix === '' ? k : `${prefix}.${k}`} (added)`);
    } else if (!eqJson(c, v)) {
      out.push(prefix === '' ? k : `${prefix}.${k}`);
    }
  }
  return out;
}

/** Committed-vs-doc drift that is NOT a surface removal — additions
 *  and meaning edits. Fixed by regeneration, never an announcement. */
function stalePaths(committed: ContractDoc, doc: ContractDoc): string[] {
  const out: string[] = [];
  if (committed.version !== doc.version) {
    out.push('version');
  }
  out.push(...mapStale('groups', committed.groups, doc.groups));
  out.push(...mapStale('', committed.commands, doc.commands));
  if (!eqJson(committed.removed, doc.removed)) {
    out.push('removed');
  }
  return out;
}

/** Announced removals tombstone into `removed`; unannounced ones are
 *  breaking problems. Mutates `removed`. */
function removalProblems(
  removalPaths: Removal[],
  announced: ReadonlySet<string>,
  removed: Map<string, unknown>
): ContractProblem[] {
  const out: ContractProblem[] = [];
  for (const r of removalPaths) {
    if (!covered(r.path, announced)) {
      out.push({
        kind: 'breaking',
        path: r.path,
        message: 'surface removed or respelled — announce it in contract/BREAKING.md',
      });
    } else {
      removed.set(r.path, r.value);
    }
  }
  return out;
}

/** Every tombstone keeps its bullet — the ledger cannot be quietly
 *  edited around. */
function ledgerProblems(
  removed: Map<string, unknown>,
  announced: ReadonlySet<string>
): ContractProblem[] {
  const out: ContractProblem[] = [];
  for (const k of removed.keys()) {
    if (!covered(k, announced)) {
      out.push({
        kind: 'ledger',
        path: `removed.${k}`,
        message: 'tombstone has no BREAKING.md bullet — the ledger cannot be quietly edited around',
      });
    }
  }
  return out;
}

/** A bullet covering no pending removal and no tombstone is a
 *  permanent hall-pass on that path — delete it when spent. */
function spentBulletProblems(
  announced: ReadonlySet<string>,
  removalPaths: Removal[],
  removed: Map<string, unknown>
): ContractProblem[] {
  const out: ContractProblem[] = [];
  for (const a of announced) {
    const single = new Set([a]);
    const used =
      removalPaths.some(r => covered(r.path, single)) ||
      [...removed.keys()].some(k => covered(k, single));
    if (!used) {
      out.push({
        kind: 'ledger',
        path: `announce.${a}`,
        message: 'bullet announces nothing — remove it; a stale bullet waives future changes',
      });
    }
  }
  return out;
}

/** The gate as data: what the committed file should become and why it
 *  can't yet. Announced removals move to `removed` (old value kept);
 *  unannounced ones are breaking problems; everything else different
 *  is stale. */
export function reconcileContract(
  committed: ContractDoc,
  live: ContractDump,
  announced: ReadonlySet<string>
): { doc: ContractDoc; problems: ContractProblem[] } {
  const removalPaths = removals(committed, live);
  const removed = new Map<string, unknown>(Object.entries(committed.removed));
  const problems = [
    ...removalProblems(removalPaths, announced, removed),
    ...ledgerProblems(removed, announced),
    ...spentBulletProblems(announced, removalPaths, removed),
  ];
  const doc: ContractDoc = {
    version: live.version,
    groups: live.groups,
    commands: live.commands,
    removed: Object.fromEntries(removed),
  };
  for (const path of stalePaths(committed, doc)) {
    problems.push({ kind: 'stale', path, message: 'run `npm run gen:contract`' });
  }
  return { doc, problems };
}
