/**
 * The customer channel — `<git-common>/bro/pipeline/<run_id>.
 * customer.jsonl`, one append-only JSONL file per run (spec
 * specs/bro-7d5nb.md §stage semantics — accept/answer). It carries
 * the customer's out-of-band input the suspended run wakes on:
 *
 *   {kind:"verdict", item, verdict, accepted_by, notes?, ts} — what
 *       `bro pipeline accept <item> …` writes; the accept gate reads
 *       it back through its `verdictStore` seam
 *   {kind:"answer",  item, answers, by?, ts} — what
 *       `bro pipeline answer <item> …` writes; intake's `questions`
 *       park wakes on the enriched spec
 *
 * Per-run, not per-item: a verdict physically cannot settle a run it
 * was not written for — a re-run of the same item gets a fresh empty
 * channel, and stale input from a dead run's file never leaks. Same
 * shared plane and append conventions as the journals: the common
 * git dir (linked worktrees share it, nothing lands in git), plain
 * append with torn-tail separation, malformed lines dropped on read.
 *
 * Signing (spec §trust): a record MAY carry `signature` — an
 * hmac-sha256 over `runId|item|kind|content|signer|ts` keyed by the
 * channel key {@link pipelineKey} resolves. The label fields a
 * worker can read out of the journal prove nothing; the MAC is what
 * separates a customer's record from a forgery.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MaybePromise } from '@broject/core';
import { appendJsonlRow, type JournalLocator, pipelineDir } from './journal.ts';
import type { StageCall } from './runner.ts';

/** The channel file's suffix — `<run_id>.customer.jsonl` sits beside
 *  `<run_id>.journal.jsonl`. */
export const CUSTOMER_SUFFIX = '.customer.jsonl';

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** The customer's accept-gate verdict — the record `bro pipeline
 *  accept` appends. `accepted_by` is the signer's identity: the gate
 *  passes only when it equals the run's recorded `customer`. */
export interface CustomerVerdict {
  kind: 'verdict';
  /** the pipeline item — audit provenance (the file already keys the run) */
  item: string;
  /** one of the accept stage's declared verdicts — accepted|rejected|abandon */
  verdict: string;
  /** who signed — the run's recorded customer identity, never the worker */
  accepted_by: string;
  /** the customer's fix scope — required non-empty on `rejected` */
  notes?: string;
  /** the keyed MAC over the record ({@link signCustomerRecord}) —
   *  present iff the writer resolved a channel key; the accept gate
   *  requires it whenever one is configured */
  signature?: string;
  ts: string;
}

/** The customer's answers to intake's `questions` — the record
 *  `bro pipeline answer` appends. `answers` is free-form (a qid→answer
 *  map, a text message): the stage that consumes it owns the shape. */
export interface CustomerAnswer {
  kind: 'answer';
  item: string;
  answers: unknown;
  /** who answered — optional; intake does not gate on it */
  by?: string;
  /** the keyed MAC over the record ({@link signCustomerRecord}) —
   *  the content slot binds a digest of `answers`, so the payload
   *  itself verifies, not just the envelope */
  signature?: string;
  ts: string;
}

/** A drain marker — the intake pass consumed the channel rows it
 *  saw: the `answer` records it covered are already annotated on the
 *  item and must never re-feed a later wake.
 *
 *  `upto` is the marker's BOUND — the channel row count the draining
 *  pass read. A bare position marker could not say that: a row
 *  appended between the feed's read and the marker lands BEFORE the
 *  marker and position-bound reads would count it consumed — input
 *  the customer gave, silently lost (the run re-parks at questions
 *  waiting for it forever). Markers written before `upto` existed
 *  bind by their own position instead — the only rows they can
 *  honestly vouch for are the ones that preceded them. */
export interface CustomerConsumed {
  kind: 'consumed';
  item: string;
  /** channel rows covered — index bound: rows `>= upto` stay pending */
  upto?: number;
  ts: string;
}

export type CustomerRecord = CustomerVerdict | CustomerAnswer | CustomerConsumed;

/** `<git-common>/bro/pipeline/<run_id>.customer.jsonl` — null outside
 *  a repo. Same path-safety rule as the journal: an unsafe run id
 *  throws, it never escapes the dir. */
export function customerChannelPath(loc: JournalLocator): string | null {
  if (!RUN_ID_RE.test(loc.runId)) {
    throw new Error(`customer channel: unsafe run id ${JSON.stringify(loc.runId)}`);
  }
  const dir = pipelineDir(loc);
  return dir === null ? null : join(dir, `${loc.runId}${CUSTOMER_SUFFIX}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Append one record to a run's channel — the torn-tail append the
 *  journals use. */
export function appendCustomerRecord(file: string, rec: CustomerRecord): void {
  appendJsonlRow(file, rec);
}

/** The whole channel file — parsed record lines only; a torn last
 *  line or a non-record value drops like the journal's malformed
 *  rows. A PRESENT but unreadable file throws (ENOENT alone means
 *  "no customer input yet") — silent emptiness would strand the gate. */
export function readCustomerFile(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const row: unknown = JSON.parse(line);
      if (isRecord(row)) {
        rows.push(row);
      }
    } catch {
      // torn write — skip
    }
  }
  return rows;
}

/** A row the gate treats as verdict input: an explicit `kind:"verdict"`
 *  record, or a kind-less record still carrying a `verdict` field (a
 *  hand-written row the gate should see — and still fully validate).
 *  An unrecognized `kind` is NOT a candidate: the writer of record is
 *  the CLI, and a row claiming another kind must not be misread as a
 *  verdict. */
const isVerdictCandidate = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && (v.kind === 'verdict' || (v.kind === undefined && 'verdict' in v));

/** The latest verdict candidate — LAST row wins (a corrected record
 *  supersedes an earlier malformed one). Returned raw: shape and
 *  identity validation belong to the gate, which fails closed on a
 *  malformed record rather than silently skipping it. */
export function latestVerdict(rows: unknown[]): Record<string, unknown> | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (isVerdictCandidate(r)) {
      return r;
    }
  }
  return undefined;
}

/** The durable `verdictStore` binding — reads THIS run's customer
 *  channel for the latest verdict record; undefined means the
 *  customer has not answered (no repo, no channel, or no verdict row
 *  yet — all read identically as "still waiting"). */
export function fileVerdictStore(dir: string) {
  return (call: StageCall): Record<string, unknown> | undefined => {
    const file = customerChannelPath({ dir, runId: call.runId });
    if (file === null) {
      return undefined;
    }
    return latestVerdict(readCustomerFile(file));
  };
}

/** A well-formed `upto` — the channel row count a marker records:
 *  a non-negative integer, nothing else. */
const isUpto = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** One consumed marker's index bound — `upto` when the marker
 *  records the row count it saw, else its own position +1 (a
 *  pre-`upto` marker vouches only for the rows before it). A
 *  malformed `upto` reads as a legacy marker — never a wider bound
 *  than the marker can prove. */
const markerBound = (r: Record<string, unknown>, i: number): number =>
  isUpto(r.upto) ? r.upto : i + 1;

/** Rows not yet covered by a `consumed` marker — the pending answer
 *  input a waking intake drains. A marker bounds by the row count it
 *  saw (`upto`): a record appended between the feed's read and the
 *  marker lands inside the marker's position but OUTSIDE its bound,
 *  so it stays pending instead of being silently eaten. A marker
 *  without `upto` (pre-bound writes) vouches only for rows before
 *  its own position. Verdict rows ride the same file: they are not
 *  intake input, but the next marker covers them too — the accept
 *  store reads the whole file regardless. */
export function pendingAnswers(rows: unknown[]): unknown[] {
  let start = 0;
  rows.forEach((r, i) => {
    if (isRecord(r) && r.kind === 'consumed') {
      start = Math.max(start, markerBound(r, i));
    }
  });
  return rows.slice(start);
}

/** What the intake wake drains — the pending channel rows plus the
 *  marker append. `consume` must run only AFTER the records' payload
 *  is durable on the item: a crash between annotate and marker
 *  re-feeds the rows on the next wake (the annotate is append-shaped,
 *  so a re-drain adds a fresh `## Answers` section, never a clobber);
 *  the other order could lose the answers entirely. */
export interface AnswerFeed {
  /** every channel row since the last consumed marker — raw; the
   *  consuming stage validates each record's shape and fails closed */
  records: unknown[];
  /** append the drain marker — rows before it are never re-fed */
  consume(): MaybePromise<void>;
}

/** The durable answer-feed binding — the run's own channel file,
 *  `fileVerdictStore`'s intake-side sibling. The marker records the
 *  row count this read saw (`upto`), not just a position: a record
 *  appended between the read and the marker lands at index `>= upto`
 *  and stays pending — a bound marker can never eat a record it did
 *  not see. */
export function fileAnswerFeed(dir: string) {
  return (call: StageCall): AnswerFeed => {
    const file = customerChannelPath({ dir, runId: call.runId });
    if (file === null) {
      return { records: [], consume: () => {} };
    }
    const rows = readCustomerFile(file);
    return {
      records: pendingAnswers(rows),
      consume: () =>
        appendCustomerRecord(file, {
          kind: 'consumed',
          item: call.item,
          upto: rows.length,
          ts: new Date().toISOString(),
        }),
    };
  };
}

/** One channel append behind the seams both CLI subs share —
 *  resolves the run's channel file and appends `rec`. */
export function writeCustomerRecord(loc: JournalLocator, rec: CustomerRecord): void {
  const file = customerChannelPath(loc);
  if (file === null) {
    throw new Error(`no pipeline plane under ${loc.dir} — not a git repo`);
  }
  appendCustomerRecord(file, rec);
}

/** The shared secret a customer record's `signature` MAC proves
 *  with. Resolution order: `BRO_PIPELINE_KEY` — the badge a spawned
 *  agent-customer is handed — then `~/.config/bro/pipeline.key`,
 *  deliberately OUTSIDE the repo and every linked worktree: a
 *  worker spawned without the badge but rooted in the checkout can
 *  read the recorded customer label off the journal, yet still
 *  cannot read the material a forged signature would need.
 *
 *  The boundary is the ENVIRONMENT, not the path: keyed mode
 *  assumes the customer channel runs where the worker cannot read —
 *  a separate OS user or host, or a sandboxed spawn that drops the
 *  operator's home and env (the fleet's worker spawn drops both). A
 *  worker sharing the operator's OS user CAN read the key file —
 *  same-trust-domain spawns degrade to the unsigned label-check
 *  semantics below; that boundary is a deployment fact, not
 *  something this module can enforce.
 *
 *  Hardening, not trust: a key file with ANY group/other permission
 *  bit set reads as ABSENT — a world-readable key is a leaked key:
 *  it no longer separates the customer from any reader, so trusting
 *  it would sign forgery with operator authority.
 *
 *  Absent → undefined: the unsigned mode, where `accepted_by` is a
 *  self-asserted label the gate merely label-checks — operator
 *  trust, not cryptographic identity.
 *
 *  `over` is the test seam — inject `env`/`home` so tests never
 *  touch the real operator environment. */
export function pipelineKey(over?: { env?: NodeJS.ProcessEnv; home?: string }): string | undefined {
  const env = over?.env ?? process.env;
  const badge = env.BRO_PIPELINE_KEY?.trim();
  if (badge !== undefined && badge !== '') {
    return badge;
  }
  const file = join(over?.home ?? homedir(), '.config', 'bro', 'pipeline.key');
  try {
    // any group/other permission bit → the key is readable beyond
    // its owner, so it counts as absent (0600/0400 are the only
    // trusted modes)
    if ((statSync(file).mode & 0o077) !== 0) {
      return undefined;
    }
    const key = readFileSync(file, 'utf8').trim();
    return key === '' ? undefined : key;
  } catch {
    return undefined; // no key file — unsigned mode
  }
}

/** The fields a record's MAC binds — every field the accept gate
 *  compares is inside the message, so an edited signer, verdict, or
 *  timestamp cannot re-verify. `content` is a DIGEST of the
 *  record's decision bytes — {@link verdictDigest} for a verdict
 *  (the `{verdict, notes}` payload, so rewritten fix-scope notes
 *  break the MAC too), {@link contentDigest} of the answers payload
 *  for an answer: swapped payload bytes fail to verify, not just
 *  the envelope. */
export interface SignatureInput {
  runId: string;
  item: string;
  kind: 'verdict' | 'answer';
  content?: string;
  /** `accepted_by` for a verdict, `by` for an answer */
  signer?: string;
  ts?: string;
}

/** A record's content slot — sha256 of the canonical JSON the
 *  writer signed (object key order survives the file's
 *  parse/stringify round-trip, so the digest the verifier computes
 *  matches the writer's). */
export const contentDigest = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** A verdict record's content slot — sha256 of the canonical
 *  `{verdict, notes}` payload (an absent `notes` drops out of the
 *  JSON, same bytes on both sides). The MAC binds the decision
 *  bytes: a worker rewriting `rejected`'s fix-scope notes under a
 *  copied signature breaks this digest exactly like a forged label. */
export const verdictDigest = (r: { verdict: unknown; notes: unknown }): string =>
  contentDigest({ verdict: r.verdict, notes: r.notes });

/** The pipe-joined MAC message — fixed positional fields, each
 *  verbatim, so no boundary can be smuggled (an `|` inside a field
 *  shifts the parse visibly; the digest slot already hex-encodes
 *  free-form content). */
const signedMessage = (input: SignatureInput): string =>
  [
    input.runId,
    input.item,
    input.kind,
    input.content ?? '',
    input.signer ?? '',
    input.ts ?? '',
  ].join('|');

/** A record's `signature` stamp — `hmac-sha256(key, message)` hex. */
export const signCustomerRecord = (key: string, input: SignatureInput): string =>
  createHmac('sha256', key).update(signedMessage(input)).digest('hex');

/** The input a raw channel record's signature was computed over —
 *  the field-position map depends on `kind` (`accepted_by` for a
 *  verdict, `by` for an answer; the verdict word vs. the answers
 *  digest). Callers prove the record's shape first — the gate's
 *  shape checks precede its signature check. */
const inputFor = (runId: string, raw: Record<string, unknown>): SignatureInput =>
  raw.kind === 'answer'
    ? {
        runId,
        item: raw.item as string,
        kind: 'answer',
        content: contentDigest(raw.answers),
        signer: raw.by as string | undefined,
        ts: raw.ts as string | undefined,
      }
    : {
        runId,
        item: raw.item as string,
        kind: 'verdict',
        content: verdictDigest({ verdict: raw.verdict, notes: raw.notes }),
        signer: raw.accepted_by as string | undefined,
        ts: raw.ts as string | undefined,
      };

/** The verification target — the key, the run the record claims to
 *  belong to, and the raw channel record itself (shape proven by
 *  the caller's earlier gates). */
export interface VerifyTarget {
  key: string;
  runId: string;
  record: Record<string, unknown>;
}

/** Does the record's `signature` verify under `key` for `runId`?
 *  Constant-time compare on the 64-hex form; anything else — a
 *  missing field, a non-string, a non-MAC value — is not a
 *  signature at all: when a key is configured a verdict claiming
 *  authenticity without a verifiable MAC IS a forgery, and the gate
 *  parks it `verdict-forged` rather than shape-malformed. */
export function recordSignatureValid(t: VerifyTarget): boolean {
  const sig = t.record.signature;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) {
    return false;
  }
  const expected = signCustomerRecord(t.key, inputFor(t.runId, t.record));
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
