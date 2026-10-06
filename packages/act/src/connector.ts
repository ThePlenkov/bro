/**
 * The act connector — the review-gate capability's contribution to the
 * agent lifecycle: the current PR's gate state at session start, a PR
 * URL in a prompt → its gate snapshot, and the stop-gate blocker when
 * the session armed 'act'. All host access goes through the resolved
 * ReviewFacade; this connector owns no vendor calls.
 */
import { loadConfig, reviewHost, type Connector, type PrTarget } from '@broject/core'
import { checkHistory } from './check-history.ts'
import { evaluateExitGate } from './exit-gate.ts'
import { mergeSlotHolderAsync } from './merge-slot.ts'
import { hasLiveWatch, listWatches, watchRetire } from './pending-watch.ts'
import { fetchPrActState } from './state.ts'

/** The bound-dir PR — async when the host has the twin, else a resolved
 *  sync call (a facade without currentPrAsync still answers, just not
 *  non-blocking). */
const currentPr = (rev: ReturnType<typeof reviewHost>) =>
  rev.currentPrAsync === undefined
    ? Promise.resolve(rev.currentPr())
    : rev.currentPrAsync()

const resolvedRepo = (rev: ReturnType<typeof reviewHost>) =>
  rev.resolveRepoAsync === undefined
    ? Promise.resolve(rev.resolveRepo([]))
    : rev.resolveRepoAsync([])

/** One-line gate summary for a PR — null when no PR/host resolves. */
async function gateLine(dir: string, target?: PrTarget): Promise<string | null> {
  try {
    const cfg = loadConfig(dir)
    const rev = reviewHost(dir, cfg.connectors)
    let t = target
    if (!t) {
      const cur = await currentPr(rev)
      if (!cur || cur.state !== 'OPEN') {
        return null
      }
      t = { repo: await resolvedRepo(rev), pr: cur.pr }
    }
    const state = await fetchPrActState(rev, t, {
      ignoreChecks: cfg.act.ignoreChecks,
      checkHistory: checkHistory(dir),
      maxRounds: cfg.act.maxRounds,
      docsPaths: cfg.act.docsPaths,
      docsMaxRounds: cfg.act.docsMaxRounds,
    })
    const gate = evaluateExitGate(state)
    const link = rev.prLink(t.repo, state.pr)
    const alertSuffix =
      gate.alerts.length === 0 ? '' : `; alert: ${gate.alerts.join('; ')}`
    return gate.ok
      ? `pr ${link}: gate OK${alertSuffix}`
      : `pr ${link}: gate BLOCKED (${gate.blockers.join('; ')})${alertSuffix} — \`bro act status\``
  } catch {
    return null
  }
}

/** A live watch marker covering `pr` — any mode counts (the agent chose
 *  merge or watch-only deliberately); a dead-pid marker is unwatched by
 *  definition. `null` (store unreadable) is fail-open: a gate must never
 *  fabricate a block on a probe failure. */
function watchCover(dir: string, pr: number): boolean {
  try {
    return hasLiveWatch(dir, pr) ?? true
  } catch {
    return true
  }
}

interface PrProbe {
  pr: number
  url: string
  gate: ReturnType<typeof evaluateExitGate>
}

/** Current-branch open PR + its gate, or null when absent/closed. */
async function prProbe(dir: string): Promise<PrProbe | null> {
  try {
    const cfg = loadConfig(dir)
    const rev = reviewHost(dir, cfg.connectors)
    const cur = await currentPr(rev)
    if (!cur || cur.state !== 'OPEN') {
      return null
    }
    const state = await fetchPrActState(
      rev,
      { repo: await resolvedRepo(rev), pr: cur.pr },
      {
        ignoreChecks: cfg.act.ignoreChecks,
        checkHistory: checkHistory(dir),
        maxRounds: cfg.act.maxRounds,
        docsPaths: cfg.act.docsPaths,
        docsMaxRounds: cfg.act.docsMaxRounds,
      }
    )
    // The same gate `bro act status` enforces: open threads, pending/failed
    // CI and AI reviewers, SAST findings, unknown mergeability, BEHIND.
    return { pr: cur.pr, url: cur.url, gate: evaluateExitGate(state) }
  } catch {
    // no repo/PR/auth — nothing to gate on
    return null
  }
}

/** Merge-slot holder line — a session seeing the slot held knows not to
 *  start a merge right now. Fail-open: no beads → no line. */
async function mergeSlotLine(): Promise<string | null> {
  try {
    const holder = await mergeSlotHolderAsync()
    return holder ? `merge slot: held by ${holder} — serialize merges via \`bro act merge\`` : null
  } catch {
    return null
  }
}

/** Pending-watch markers left by `bro act wait`: a dead pid means the
 *  session that promised to watch died mid-poll — flag the stale promise
 *  and retire the marker to claim the report. The claim says nothing
 *  about delivery, so a retired marker keeps re-flagging on later
 *  session starts until it ages out. A live pid is parallel work —
 *  passive context only. */
function watchLines(dir: string): string[] {
  try {
    const out: string[] = []
    for (const { watch, file, alive, reported } of listWatches(dir)) {
      if (alive) {
        out.push(
          `act watch active on ${watch.link} (pid ${watch.pid}) — another process is polling`
        )
        continue
      }
      // the retire is an atomic claim — a racing session start already
      // reporting this stale promise loses the rename and skips it. An
      // already-retired marker still re-flags: the claim proves nothing
      // about delivery, so a warning dropped with its session (hook
      // budget, crash) resurfaces until the marker ages out.
      if (reported !== true && !watchRetire(file)) {
        continue
      }
      const mode = watch.merge ? ' (was set to merge on green)' : ''
      out.push(
        `stale act watch on ${watch.link}${mode} — the watching session died; ` +
          `check \`bro act status --pr ${watch.pr}\``
      )
    }
    return out
  } catch {
    // detection is passive — a probe failure must not break rehydrate
    return []
  }
}

export const actConnector: Connector = {
  name: 'act',
  hooks: () => ({
    async sessionStart(ctx) {
      // watch markers first — local fs only, so a slow gate probe that
      // blows the hook budget can't strand a stale-promise report
      const out: string[] = watchLines(ctx.dir)
      const gate = await gateLine(ctx.dir)
      if (gate) {
        out.push(gate)
      }
      const slot = await mergeSlotLine()
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
      const p = await prProbe(ctx.dir)
      if (!p) {
        return []
      }
      const watched = watchCover(ctx.dir, p.pr)
      const head = `bro: PR [#${p.pr}](${p.url})`
      if (!p.gate.ok) {
        const line = `${head}: ${p.gate.blockers.join('; ')}`
        const watchNote = watched ? 'live act watch' : 'no live act watch'
        return [
          {
            aspect: 'act',
            block:
              `${line} (${watchNote}) — ` +
              'list with `bro act threads` — fix inline or defer to a debt bead ' +
              '(reply + resolve); when fix_rounds exceeds the round cap ' +
              '(act.maxRounds — tighter on docs-only PRs) only defer ' +
              'counts; recheck `bro act status`',
            passive: `${line} (${watchNote}; current branch — this session did not touch it)`,
          },
        ]
      }
      if (watched) {
        return []
      }
      // green gate is not "done" — a pushed PR ends the turn only while
      // somebody keeps polling it. A turn-bound `act wait` dies with the
      // turn (bro-97lk): the block points at the detached form.
      const line = `${head}: gate OK but no live act watch`
      return [
        {
          aspect: 'act',
          block:
            `${line} — arm one: \`bro act wait ${p.pr} --merge --cleanup\` ` +
            'detached (setsid/systemd-run/tmux — a watcher in a turn-bound ' +
            'shell dies with the turn); or state the exact open state and ' +
            'stop again',
          passive: `${line} (current branch — this session did not touch it)`,
        },
      ]
    },
  }),
}
