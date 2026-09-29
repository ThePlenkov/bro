/**
 * The debt connector — open review-debt findings as session-start
 * context. The ledger is local state, so the only probe is the count.
 */
import type { Connector } from '@bro/core'
import { readDebtRecords } from './store.ts'

export const debtConnector: Connector = {
  name: 'debt',
  hooks: () => ({
    sessionStart(ctx) {
      try {
        const open = readDebtRecords(ctx.dir).filter((r) => r.status === 'open').length
        return open > 0 ? [`debt: ${open} open finding(s) — \`bro debt next\` picks one`] : []
      } catch {
        return []
      }
    },
  }),
}
