/**
 * The debt connector — open review-debt findings as session-start
 * context. The ledger is local state, so the only probe is the count.
 */
import type { Connector } from '@broject/core';
import { readDebtRecords } from './store.ts';

export const debtConnector: Connector = {
  name: 'debt',
  hooks: () => ({
    sessionStart(ctx) {
      try {
        const open = readDebtRecords(ctx.dir).filter(r => r.status === 'open').length;
        return open > 0 ? [`debt: ${open} open finding(s) — \`bro debt next\` picks one`] : [];
      } catch {
        return [];
      }
    },
  }),
  // mode gating (specs/bro-izpyk.2.md): review-debt counts matter to the
  // sessions that act on them — code and review planes; plan/observe
  // stay passive.
  activeIn: {
    sessionStart: ['code', 'review', 'orchestrate'],
  },
};
