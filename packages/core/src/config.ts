/**
 * bro configuration. Resolution order: bro.config.json in cwd → defaults.
 * Keep it a JSON file — bro runs as a compiled CLI, importing user TS at
 * runtime is not worth the loader dance for v0.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DebtStore = 'jsonl' | 'beads' | 'both'
export type Personality = 'terse' | 'mentor' | 'sarcastic'

export interface BroConfig {
  store: DebtStore
  personality: Personality
  debt: {
    /** Directory holding the review-debt ledger, relative to cwd. */
    dir: string
  }
}

export const DEFAULT_CONFIG: BroConfig = {
  store: 'jsonl',
  personality: 'terse',
  debt: { dir: '.agents/review-debt' },
}

export function loadConfig(cwd: string = process.cwd()): BroConfig {
  const path = join(cwd, 'bro.config.json')
  if (!existsSync(path)) {
    return DEFAULT_CONFIG
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BroConfig>
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      debt: { ...DEFAULT_CONFIG.debt, ...parsed.debt },
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
