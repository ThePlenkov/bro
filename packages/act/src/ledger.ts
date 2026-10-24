/**
 * Shared ledger housekeeping — the JSONL append/compaction pattern every
 * bro ledger under `<git-common>/bro/` follows.
 *
 * A ledger is an append-only JSONL file that must stay bounded: a
 * long-lived repo dir would otherwise grow without limit. Compaction
 * keeps the tail, which is what a trailing-window read needs.
 *
 * Both the check-history ledger and the resolve ledger use this — the
 * two ledgers differ in their record shape, not in how they are kept
 * bounded.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

/** Compact once the file passes this size. */
export const MAX_LEDGER_BYTES = 256 * 1024
/** How much of the tail survives a compaction. */
export const KEEP_LEDGER_BYTES = 128 * 1024

/**
 * Trim the ledger to its tail when it grows past the cap.
 *
 * Best-effort: a failure leaves the ledger as it was — compaction is
 * housekeeping, never a reason to lose a record.
 */
export function compactLedger(file: string): void {
  try {
    if (statSync(file).size <= MAX_LEDGER_BYTES) {
      return
    }
    const raw = readFileSync(file, 'utf8')
    const tail = raw.slice(raw.length - KEEP_LEDGER_BYTES)
    // cut to the first whole line — a half-line is not a record
    const cut = tail.indexOf('\n')
    writeFileSync(`${file}.tmp`, cut >= 0 ? tail.slice(cut + 1) : tail)
    renameSync(`${file}.tmp`, file)
  } catch {
    // compaction is housekeeping — a failure never blocks the record
  }
}

/**
 * Parse a JSONL ledger into records, skipping malformed lines.
 *
 * A torn line (a crash mid-append) is skipped, not fatal — the rest of
 * the ledger still reads.
 */
export function parseLedger<T>(file: string, isRecord: (e: unknown) => e is T): T[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const e: unknown = JSON.parse(line)
      if (isRecord(e)) {
        out.push(e)
      }
    } catch {
      // a torn line is skipped, not fatal
    }
  }
  return out
}
