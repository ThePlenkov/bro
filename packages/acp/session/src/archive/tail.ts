/** The archive feed — the byte-windowed tail read and the JSONL row
 *  parse every `.events.jsonl` consumer shares. */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ArchiveRow } from './rows.ts';

/** The open-tail cap — a dead session's archive or log can run to
 *  megabytes; the pane scrolls back through the last chunk, not the
 *  corpus. */
export const TAIL_BYTES = 64 * 1024;

/** statSync().size or 0 — the tail math's floor. */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A chunk of an append-only file — from byte `from` to EOF. */
export function readTailSlice(
  path: string,
  from: number
): { text: string; size: number } | undefined {
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const start = Math.min(Math.max(0, from), size);
    const len = size - start;
    if (len === 0) return { text: '', size };
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), size };
  } finally {
    closeSync(fd);
  }
}

/** Every complete JSONL row in a slice — blank lines skip, a torn
 *  tail row (still being written) drops and the next complete read
 *  picks it up. Non-record values (a stray `null` or `[...]` line)
 *  drop too — `feed()` reads `row.kind` unconditionally. */
export function parseArchiveRows(text: string): ArchiveRow[] {
  const rows: ArchiveRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const row: unknown = JSON.parse(line);
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        rows.push(row as ArchiveRow);
      }
    } catch {
      // partial line — dropped until the row completes on disk
    }
  }
  return rows;
}

/** The complete-line boundary of a slice — the byte count through
 *  the last `\n` (0 when nothing terminates yet). A resume reader
 *  advances its offset by exactly this so a torn tail row (writer
 *  mid-append) re-reads whole on the next pump instead of being
 *  split and lost. */
export function completePart(text: string): number {
  return text.lastIndexOf('\n') + 1;
}

/** The tail-windowed slice of an append-only file — at most `cap`
 *  bytes ending at EOF (`cap <= 0` reads the whole file), advanced
 *  past the first (partial) line so a mid-file read never starts
 *  mid-record. `offset` is where the live pump resumes. */
export function tailWindow(
  path: string,
  cap = TAIL_BYTES
): { text: string; offset: number } | undefined {
  const from = cap <= 0 ? 0 : Math.max(0, sizeOf(path) - cap);
  const slice = readTailSlice(path, from);
  if (slice === undefined) return undefined;
  const start = from > 0 ? slice.text.indexOf('\n') + 1 : 0;
  const body = slice.text.slice(start);
  const end = completePart(body);
  return { text: body.slice(0, end), offset: from + start + end };
}

/** One replay of an archive's tail — the bounded window, parsed to
 *  rows. The duplicated "window + boundary-skip + parse" pump three
 *  frontends carried, converged: replay via this, then ride appends
 *  with readTailSlice + parseArchiveRows from `offset`. */
export function tailArchive(
  path: string,
  cap = TAIL_BYTES
): { rows: ArchiveRow[]; offset: number } | undefined {
  const w = tailWindow(path, cap);
  return w === undefined ? undefined : { rows: parseArchiveRows(w.text), offset: w.offset };
}
