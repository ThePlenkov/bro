/**
 * The drill connector — open-frame state for the agent lifecycle: the
 * frame line at session start and prompt submit, and the stop-gate
 * contribution under the 'drill' arming aspect.
 */
import type { Connector } from '@broject/core'
import { currentFrame } from './frames.ts'

/** The open-frame line, or null — the same text every surface shares. */
function frameLine(): string | null {
  try {
    const frame = currentFrame()
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
    sessionStart() {
      const line = frameLine()
      return line ? [line] : []
    },
    promptSubmit() {
      const line = frameLine()
      return line ? [line] : []
    },
    stopGate() {
      const line = frameLine()
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
