/** The end-of-run audit's census and close-out legs — the tail scans
 *  that name what a loop run leaves behind (open loop PRs, beads still
 *  in_progress), the printed report, the provably-done litter sweep,
 *  and the exit-path `bro sync`. `endAudit` orchestrates them from
 *  loop.ts. Split out of loop.ts — the module was already over the
 *  CodeScene file-size bar and the wave-2 extractions pushed it past
 *  the single-module function count too. */
import type { ClaimRow, ReviewFacade, TaskStore } from '@broject/core';
import type { LoopConfig } from '@broject/loop';
import { runSyncCommand } from './sync.ts';
import { type LitterReap, reapLoopLitter } from './work.ts';

/** The audit's ctx — the fields the census and close-out read, typed
 *  here so the module never reaches back into loop.ts's Ctx. */
interface LoopAuditCtx {
  root: string;
  repo: string;
  rev: ReviewFacade;
  tasks: TaskStore;
  stack?: string;
  cfg: Pick<LoopConfig, 'parkedKeep' | 'parkedTtlDays'>;
  json: boolean;
}

/** Progress lines — stderr under --json so stdout stays a clean
 *  event stream. */
const say = (ctx: Pick<LoopAuditCtx, 'json'>, msg: string): void => {
  if (ctx.json) {
    console.error(msg);
  } else {
    console.log(msg);
  }
};

/** Open PRs on local loop/* branches — exact per-branch lookup, so the
 *  audit is bounded by the repo's own tail set, not a global PR cap. */
export function openLoopPrs(ctx: LoopAuditCtx, branches: string[]): string[] {
  const out: string[] = [];
  for (const b of branches) {
    try {
      for (const pr of ctx.rev.prsForBranch(b)) {
        out.push(`${ctx.rev.prLink(ctx.repo, pr)} (${b})`);
      }
    } catch {
      out.push(`warning: PR lookup failed for ${b} — host unreachable`);
    }
  }
  return out;
}

/** Beads left in_progress, split by this run's claims vs pre-existing —
 *  a shared store holds other sessions' claims too. */
export function claimedTails(
  tasks: TaskStore,
  seen: Set<string>
): { own: string[]; other: string[] } {
  try {
    const rows = tasks.list({ status: 'in_progress' });
    const fmt = (r: { id: string; title?: string }) =>
      `${r.id} ${(r.title ?? '').replace(/\s+/g, ' ').slice(0, 60)}`.trim();
    return {
      own: rows.filter(r => seen.has(r.id)).map(fmt),
      other: rows.filter(r => !seen.has(r.id)).map(fmt),
    };
  } catch {
    return { own: [], other: ['warning: claimed-task audit failed — store unavailable'] };
  }
}

/** The audit's printed report: what the sweep reaped, then every tail
 *  that survived it — 'clean' only when no section has anything left. */
export function sayLoopAudit(
  ctx: LoopAuditCtx,
  reap: LitterReap | undefined,
  sections: [string, string[]][]
): void {
  say(ctx, 'loop audit:');
  for (const r of reap?.released ?? []) {
    say(ctx, `  released claim: ${r}`);
  }
  for (const g of reap?.repaired ?? []) {
    say(ctx, `  re-registered: ${g}`);
  }
  for (const k of reap?.killed ?? []) {
    say(ctx, `  killed: ${k}`);
  }
  for (const r of reap?.reaped ?? []) {
    say(ctx, `  reaped: ${r}`);
  }
  for (const b of reap?.branches ?? []) {
    say(ctx, `  deleted branch: ${b}`);
  }
  for (const e of reap?.errors ?? []) {
    say(ctx, `  reap error: ${e}`);
  }
  if (sections.every(([, items]) => items.length === 0)) {
    say(ctx, '  clean — no loop tails');
    return;
  }
  for (const [label, items] of sections) {
    for (const item of items) {
      say(ctx, `  ${label}: ${item}`);
    }
  }
}

/** The close-out litter sweep — reap the provably-done leftovers before
 *  the audit names what survived. A sweep failure is a warning line,
 *  never a crash. `sessionClaims` is the prefetched claims leg — the
 *  same union `work prune --loop` threads (bro-izpyk.10); undefined
 *  runs the keep-planes marker-only. */
export function sweepLoopLitter(
  ctx: LoopAuditCtx,
  parkedClaims: ReadonlySet<string>,
  sessionClaims?: ClaimRow[]
): LitterReap | undefined {
  try {
    return reapLoopLitter({
      root: ctx.root,
      tasks: ctx.tasks,
      rev: { repo: ctx.repo, facade: ctx.rev },
      stackPrefix: ctx.stack === undefined ? undefined : `stack/${ctx.stack}/`,
      parkedKeep: ctx.cfg.parkedKeep,
      parkedTtlDays: ctx.cfg.parkedTtlDays,
      keepClaims: parkedClaims,
      sessionClaims,
    });
  } catch (err) {
    say(
      ctx,
      `  warning: litter sweep failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/** The audit's exit-path `bro sync` — fail-open by contract. Sync code
 *  throws its failures (the CLI keeps the same verdict via main's
 *  catch), but a stray process.exit anywhere in the subtree must still
 *  degrade to a warning: an exit here kills the runner mid-write and
 *  drops the audit lines still buffered on stdout (bro-qjbwq). */
export function syncAfterAudit(
  ctx: { json: boolean },
  sync: () => void = () => runSyncCommand([])
): void {
  const realExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`bro sync called process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  try {
    sync();
  } catch (err) {
    say(
      ctx,
      `  warning: bro sync failed — ${err instanceof Error ? err.message : String(err)} ` +
        `— infra; the next run's audit retries`
    );
  } finally {
    process.exit = realExit;
  }
}
