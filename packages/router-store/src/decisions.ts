/**
 * The decision journal — one row per route/ask/spawn decision (spec
 * bro-0ykhg.4). Written BEFORE the work it routes starts, so a crash
 * between the decision and the spawn still leaves the replayable
 * inputs: task text and carried fields, the surviving candidates, the
 * table/formula snapshots and hashes, the judge configuration identity
 * and the stage answers.
 *
 * The journal lives in router.db — the router runs without beads, the
 * bus, or a repository. `context_id` is the project namespace outcomes
 * group under; old rows without a decision id are counted
 * non-joinable by the readers, never silently assigned an outcome.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import type { RouterDb } from './store.ts';
import { decisions } from './schema.ts';
import { redactSecrets, tightenStoreFiles } from './privacy.ts';

/** The decision kinds the journal records — the surface that asked. */
export type DecisionKind = 'route' | 'ask' | 'spawn';

/** A store handle's writable face — the journal writes through it so
 *  file modes re-tighten after each write. */
export interface StoreFace {
  db: RouterDb;
  path: string;
}

/** One journaled decision — everything the replay and the outcome join
 *  need. Text-bearing fields are redacted before they land; a
 *  `persistText: false` caller (retention 0) stores NULL for the
 *  free-text and replay-snapshot fields while keeping the hashes and
 *  structured inputs the stats read-model needs. */
export interface DecisionInput {
  /** the surface — 'route', 'ask', or 'spawn' */
  kind: DecisionKind;
  /** the stable project namespace — required, never guessed here */
  contextId: string;
  /** the task text the decision read */
  taskText?: string;
  /** the carried inputs — type/complexity/priority/features/labels/
   *  paths/repo, as the caller supplied them (already an object) */
  task?: unknown;
  /** the feature map — the P(success|route,features) bucket source */
  features?: Record<string, string | number | boolean>;
  /** the surviving candidates at decision time */
  candidates?: unknown;
  /** the route table snapshot */
  table?: unknown;
  /** the table's file path — context resolution only, never stored */
  tablePath?: string;
  /** the formula's raw text, when one drove the pick */
  formulaText?: string;
  /** the formula's path, when declared */
  formulaPath?: string;
  /** the judge configuration identity — provider/model/mode, never creds */
  judge?: unknown;
  /** the stage answers — T0/T1/T2 verdicts for replay */
  stages?: unknown;
  /** the route the decision landed on */
  route?: string;
  /** the chain head the route resolved to */
  provider?: string;
  model?: string;
  /** who picked — 'table', 'model', 'formula', 'cache' */
  picked?: string;
  /** the run links known at journal time — bead id, worker, run, PR */
  beadId?: string;
  worker?: string;
  runId?: string;
  pr?: string;
  /** false disables text/snapshot persistence entirely (retention 0) */
  persistText?: boolean;
  /** the decision's own id — minted when absent; callers that must pin
   *  it BEFORE journaling pass it in */
  decisionId?: string;
  /** epoch ms — defaults to now */
  at?: number;
}

/** A journaled decision row, as stored. */
export interface DecisionRow {
  decisionId: string;
  contextId: string;
  createdAt: number;
  taskText: string | null;
  taskJson: string | null;
  featuresJson: string | null;
  candidatesJson: string | null;
  tableJson: string | null;
  tableHash: string | null;
  formulaText: string | null;
  formulaHash: string | null;
  formulaPath: string | null;
  judgeConfig: string | null;
  stageAnswers: string | null;
  route: string | null;
  provider: string | null;
  model: string | null;
  picked: string | null;
  beadId: string | null;
  worker: string | null;
  runId: string | null;
  pr: string | null;
}

/** Canonical JSON — sorted keys, so equal values hash and compare
 *  equal regardless of the writer's key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** sha256 over the canonical form — the table/formula hash identity. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** sha256 over raw bytes — the formula file's own identity. */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const jsonOrNull = (value: unknown): string | null =>
  value === undefined ? null : redactSecrets(canonicalJson(value));

const textOrNull = (value: string | undefined): string | null =>
  value === undefined ? null : redactSecrets(value);

/** Journal one decision — best-effort like every ledger write: the
 *  record is observability, never a gate, so a failure costs the row,
 *  not the decision. Returns whether the row landed. An existing id is
 *  a no-op (idempotent journal). */
export async function recordDecision(store: StoreFace, input: DecisionInput): Promise<boolean> {
  const { db, path } = store;
  const persist = input.persistText !== false;
  try {
    await db
      .insert(decisions)
      .values({
        decisionId: input.decisionId ?? randomUUID(),
        contextId: input.contextId,
        createdAt: input.at ?? Date.now(),
        taskText: persist ? textOrNull(input.taskText) : null,
        taskJson: jsonOrNull(input.task),
        featuresJson: jsonOrNull(input.features),
        candidatesJson: persist ? jsonOrNull(input.candidates) : null,
        tableJson: persist ? jsonOrNull(input.table) : null,
        tableHash: input.table === undefined ? null : contentHash(input.table),
        formulaText: persist ? textOrNull(input.formulaText) : null,
        formulaHash: input.formulaText === undefined ? null : textHash(input.formulaText),
        formulaPath: input.formulaPath ?? null,
        judgeConfig: jsonOrNull(input.judge),
        stageAnswers: persist ? jsonOrNull(input.stages) : null,
        route: input.route ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        picked: input.picked ?? null,
        beadId: input.beadId ?? null,
        worker: input.worker ?? null,
        runId: input.runId ?? null,
        pr: input.pr ?? null,
      })
      .onConflictDoNothing({ target: decisions.decisionId });
    tightenStoreFiles(path);
    return true;
  } catch {
    return false;
  }
}

/** Mint a decision id BEFORE journaling — the id the caller pins on the
 *  worker registry entry and the bead while the row is still being
 *  written. */
export function newDecisionId(): string {
  return randomUUID();
}

/** One journaled decision — undefined when the id was never journaled
 *  (an outcome for it fails loud at the write). */
export async function getDecision(
  db: RouterDb,
  decisionId: string
): Promise<DecisionRow | undefined> {
  try {
    const rows = await db.select().from(decisions).where(eq(decisions.decisionId, decisionId));
    return rows[0] as DecisionRow | undefined;
  } catch {
    return undefined;
  }
}

/** Repair the run links — pin reconciliation writes the bead/worker/
 *  run/PR the journal already knows (or learns) after a crash between
 *  the journal write and the pin writes. Only supplied fields move;
 *  an absent link is never cleared. */
export async function linkDecision(
  store: StoreFace,
  decisionId: string,
  links: { beadId?: string; worker?: string; runId?: string; pr?: string }
): Promise<boolean> {
  const set: Record<string, string> = {};
  if (links.beadId !== undefined) set['beadId'] = links.beadId;
  if (links.worker !== undefined) set['worker'] = links.worker;
  if (links.runId !== undefined) set['runId'] = links.runId;
  if (links.pr !== undefined) set['pr'] = links.pr;
  if (Object.keys(set).length === 0) {
    return true;
  }
  try {
    await store.db.update(decisions).set(set).where(eq(decisions.decisionId, decisionId));
    tightenStoreFiles(store.path);
    return true;
  } catch {
    return false;
  }
}

/** Decisions matching ANY supplied run link — the reconciliation read:
 *  which journaled decisions belong to this bead/run/PR/worker. */
export async function findDecisions(
  db: RouterDb,
  links: { beadId?: string; runId?: string; pr?: string; worker?: string }
): Promise<DecisionRow[]> {
  const clauses = [
    links.beadId !== undefined ? eq(decisions.beadId, links.beadId) : undefined,
    links.runId !== undefined ? eq(decisions.runId, links.runId) : undefined,
    links.pr !== undefined ? eq(decisions.pr, links.pr) : undefined,
    links.worker !== undefined ? eq(decisions.worker, links.worker) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (clauses.length === 0) {
    return [];
  }
  try {
    const rows = await db
      .select()
      .from(decisions)
      .where(or(...clauses));
    return rows as DecisionRow[];
  } catch {
    return [];
  }
}
