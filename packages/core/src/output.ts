/**
 * Personality-aware output. v0: terse is the only voice; the seam is here so
 * sarcastic/mentor land without touching call sites.
 */
import type { Personality } from './config.ts'

export interface Printer {
  info(msg: string): void
  warn(msg: string): void
  data(line: string): void
}

export function makePrinter(_personality: Personality): Printer {
  return {
    info: (msg) => console.error(msg),
    warn: (msg) => console.error(`warning: ${msg}`),
    data: (line) => console.log(line),
  }
}
