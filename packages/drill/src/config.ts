import { isAbsolute } from 'node:path'
import type { ConfigSection } from '@broject/core'

export const DRILL_REPORT_MODES = ['off', 'prompt', 'always'] as const
export type DrillReportMode = (typeof DRILL_REPORT_MODES)[number]

export interface DrillConfig {
  report: {
    /** Directory holding published drill reports, relative to the repo root. */
    dir: string
    /** off (default): only an explicit --report writes. prompt: ask on a TTY,
     *  degrade to off non-interactively. always: write on every `drill up` —
     *  persistent frames only, ephemeral wisps still need --report. */
    mode: DrillReportMode
  }
}

export const DEFAULT_DRILL_CONFIG: DrillConfig = {
  report: { dir: 'drills', mode: 'off' },
}

/** `drill` config section — currently only `drill.report` (the durable
 *  md artifact policy for `bro drill up`). Bad values warn + fall back. */
export const drillSection: ConfigSection<DrillConfig> = (raw) => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const rep = (
    typeof obj.report === 'object' && obj.report !== null ? obj.report : {}
  ) as Record<string, unknown>
  if (
    rep.mode !== undefined &&
    !(DRILL_REPORT_MODES as readonly unknown[]).includes(rep.mode)
  ) {
    console.error(
      `bro.config: drill.report.mode must be one of ${DRILL_REPORT_MODES.map((m) => `"${m}"`).join('|')} — got ${JSON.stringify(rep.mode)}`
    )
  }
  // dir is repo-relative by contract — an absolute path or a `..`
  // segment would let reports land outside the worktree
  const dir = typeof rep.dir === 'string' ? rep.dir.trim() : ''
  const dirBad = dir !== '' && (isAbsolute(dir) || dir.split(/[\\/]+/).includes('..'))
  if (dirBad) {
    console.error(
      `bro.config: drill.report.dir must stay inside the repo — got ${JSON.stringify(rep.dir)}`
    )
  }
  return {
    report: {
      dir: dir === '' || dirBad ? DEFAULT_DRILL_CONFIG.report.dir : dir,
      mode: (DRILL_REPORT_MODES as readonly unknown[]).includes(rep.mode)
        ? (rep.mode as DrillReportMode)
        : DEFAULT_DRILL_CONFIG.report.mode,
    },
  }
}
