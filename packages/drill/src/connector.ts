/**
 * The drill connector — open-frame state for the agent lifecycle: the
 * frame line at session start and prompt submit, and the stop-gate
 * contribution under the 'drill' arming aspect.
 */
import type { Connector } from '@broject/core'
import { currentFrameAsync } from './frames.ts'

/** The open-frame line, or null — the same text every surface shares.
 *  Async: the frame lookup is two bd spawns that would serialize and
 *  freeze the probe sweep in sync form. */
async function frameLine(dir?: string): Promise<string | null> {
  try {
    const frame = await currentFrameAsync(dir)
    if (!frame) {
      return null
    }
    return `drill frame open: ${frame.id} "${frame.title}" [depth=${frame.depth}] — close with \`bro drill up --result "…"\``
  } catch {
    return null
  }
}

export const drillConnector: Connector = {
  name: 'drill',
  hooks: () => ({
    async sessionStart(ctx) {
      const line = await frameLine(ctx.dir)
      return line ? [line] : []
    },
    async promptSubmit(ctx) {
      const line = await frameLine(ctx.dir)
      return line ? [line] : []
    },
    async stopGate(ctx) {
      const line = await frameLine(ctx.dir)
      if (!line) {
        return []
      }
      return [
        {
          aspect: 'drill',
          block: `bro: ${line}`,
          passive: `bro: ${line} (opened outside this session — informational)`,
        },
      ]
    },
  }),
}
