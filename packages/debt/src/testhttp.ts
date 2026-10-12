/** Test-only HTTP/env plumbing shared by the collector tests — like
 *  testtmp.ts it is never re-exported from index.ts, so it stays out
 *  of dist (bro-7qrdp). */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DebtRecord } from './types.ts'

/** Scripted curl on PATH — answers by URL substring via a JSON map file.
 *  Absent key → `emptyPage`, the collector's empty-list payload, so its
 *  paging loop terminates. */
export function withFakeCurl(
  cases: Record<string, string>,
  emptyPage: string,
  fn: () => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-curl-'))
  const mapPath = join(dir, 'map.json')
  writeFileSync(mapPath, JSON.stringify(cases))
  writeFileSync(
    join(dir, 'curl'),
    [
      '#!/usr/bin/env node',
      'const map = JSON.parse(require("fs").readFileSync(process.env.FAKE_CURL_MAP, "utf8"))',
      'const args = process.argv.slice(2).join(" ")',
      'for (const [k, v] of Object.entries(map)) {',
      '  if (args.includes(k)) { console.log(v); process.exit(0) }',
      '}',
      `console.log(${JSON.stringify(emptyPage)})`,
    ].join('\n')
  )
  chmodSync(join(dir, 'curl'), 0o755)
  const prevPath = process.env.PATH
  const prevMap = process.env.FAKE_CURL_MAP
  process.env.PATH = `${dir}:${prevPath}`
  process.env.FAKE_CURL_MAP = mapPath
  try {
    fn()
  } finally {
    process.env.PATH = prevPath
    if (prevMap === undefined) {
      delete process.env.FAKE_CURL_MAP
    } else {
      process.env.FAKE_CURL_MAP = prevMap
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Env vars set for fn, restored after — the skip paths delete them
 *  explicitly so ambient vars can't leak in. */
export function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
}

/** An open review-thread ledger row for the dedupe specs — `source`
 *  absent so it reads as the plain PR sweep. */
export function openThread(over: Partial<DebtRecord>): DebtRecord {
  return {
    thread_id: 'PRRT_1',
    status: 'open',
    path: '',
    line: null,
    body: '',
    ...over,
  } as DebtRecord
}
