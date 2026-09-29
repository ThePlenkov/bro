/**
 * The act connector — the review-gate capability's contribution to the
 * agent lifecycle: the current PR's gate state at session start, a PR
 * URL in a prompt → its gate snapshot, and the stop-gate blocker when
 * the session armed 'act'. All host access goes through the resolved
 * ReviewFacade; this connector owns no vendor calls.
 */
import { loadConfig, reviewHost, type Connector, type PrTarget } from '@broject/core'
import { evaluateExitGate } from './exit-gate.ts'
import { mergeSlotHolder } from './merge-slot.ts'
import { fetchPrActState } from './state.ts'

/** One-line gate summary for a PR — null when no PR/host resolves. */
async function gateLine(dir: string, target?: PrTarget): Promise<string | null> {
  try {
    const cfg = loadConfig(dir)
    const rev = reviewHost(dir, cfg.connectors)
    let t = target
    if (!t) {
      const cur = rev.currentPr()
      if (!cur || cur.state !== 'OPEN') {
        return null
      }
      t = { repo: rev.resolveRepo([]), pr: cur.pr }
    }
    const state = await fetchPrActState(rev, t, {
      ignoreChecks: cfg.act.ignoreChecks,
      maxRounds: cfg.act.maxRounds,
    })
    const gate = evaluateExitGate(state)
    const link = rev.prLink(t.repo, state.pr)
    return gate.ok
      ? `pr ${link}: gate OK`
      : `pr ${link}: gate BLOCKED (${gate.blockers.join('; ')}) — \`bro act status\``
  } catch {
    return null
  }
}

/** Current-branch open PR blocker text, or null when clean/absent. */
async function blockerLine(dir: string): Promise<string | null> {
  try {
    const cfg = loadConfig(dir)
    const rev = reviewHost(dir, cfg.connectors)
    const cur = rev.currentPr()
    if (!cur || cur.state !== 'OPEN') {
      return null
    }
    const state = await fetchPrActState(
      rev,
      { repo: rev.resolveRepo([]), pr: cur.pr },
      { ignoreChecks: cfg.act.ignoreChecks, maxRounds: cfg.act.maxRounds }
    )
    // The same gate `bro act status` enforces: open threads, pending/failed
    // CI and AI reviewers, SAST findings, unknown mergeability, BEHIND.
    const gate = evaluateExitGate(state)
    return gate.ok ? null : `bro: PR [#${cur.pr}](${cur.url}): ${gate.blockers.join('; ')}`
  } catch {
    // no repo/PR/auth — nothing to gate on
    return null
  }
}

/** Merge-slot holder line — a session seeing the slot held knows not to
 *  start a merge right now. Fail-open: no beads → no line. */
function mergeSlotLine(): string | null {
  try {
    const holder = mergeSlotHolder()
    return holder ? `merge slot: held by ${holder} — serialize merges via \`bro act merge\`` : null
  } catch {
    return null
  }
}

export const actConnector: Connector = {
  name: 'act',
  hooks: () => ({
    async sessionStart(ctx) {
      const out: string[] = []
      const gate = await gateLine(ctx.dir)
      if (gate) {
        out.push(gate)
      }
      const slot = mergeSlotLine()
      if (slot) {
        out.push(slot)
      }
      return out
    },
    async promptSubmit(ctx, prompt) {
      try {
        const t = reviewHost(ctx.dir, loadConfig(ctx.dir).connectors).parsePrRef(prompt)
        const line = t ? await gateLine(ctx.dir, t) : null
        return line ? [line] : []
      } catch {
        return []
      }
    },
    async stopGate(ctx) {
      const line = await blockerLine(ctx.dir)
      if (!line) {
        return []
      }
      return [
        {
          aspect: 'act',
          block:
            `${line} — ` +
            'list with `bro act threads` — fix inline or defer to a debt bead ' +
            '(reply + resolve); when fix_rounds exceeds act.maxRounds only ' +
            'defer counts; recheck `bro act status`',
          passive: `${line} (current branch — this session did not touch it)`,
        },
      ]
    },
  }),
}
