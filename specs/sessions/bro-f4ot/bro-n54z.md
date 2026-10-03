# bro-n54z — bro fleet --live: TUI refresh dashboard over agents facade

Parent: `bro-f4ot` (agents facade + bro fleet). `bro fleet` (bro-g4vn)
renders one table and exits; `bro watch` (bro-vf1j) is the machine
heartbeat. `--live` is the human at the terminal: the same fleet view,
refreshed in place until quit.

## Problem

Watching a fleet today means re-running `bro fleet` in a loop —
`watch -n2 bro fleet` repaints in place, but its keys aren't ours to
bind, stderr warnings land outside the frame, and a collect slower
than the interval can't stretch the cadence. A supervisor human wants
a stable dashboard: table redraws
in place, `lost — respawn?` rows stay visible, one key quits. The data
plane already exists (`collectAgents` + `fleetRows`); only the render
loop is missing.

## Design

`bro fleet --live` runs the one-shot collection on a cadence and
repaints a full-screen frame:

```text
bro fleet --live            full-screen table, refresh every 2s
bro fleet --live --every N  refresh every N seconds
```

`--every` implies `--live` — both forms are the TTY dashboard and
exit 2 without a TTY.

- **Same rows, same honesty rules** — the frame is `fleetTableLines`
  over `collectAgents`/`fleetRows`; a degraded backend still renders
  `unknown`, never `lost`. Warnings (degraded/conflict/PR errors)
  render as a footer block, not stderr — stderr would scroll under
  the frame.
- **Screen discipline** — alternate screen + hidden cursor on entry,
  restored on every exit path (q, Esc, Ctrl-C, SIGINT/SIGTERM,
  error). No scrollback pollution, no stranded raw mode.
- **Tick discipline** — `setTimeout` chained after each collection
  completes, never `setInterval`: a slow backend stretches the
  interval instead of stacking overlapping collects. A `resize` event
  repaints immediately.
- **Keys** — `q`, Esc, Ctrl-C quit. Raw mode on stdin; everything else
  is ignored.
- **Not a TTY → not live.** `--live` without a TTY exits 2 pointing at
  `bro watch --every N` (the non-interactive heartbeat) — a repaint
  loop into a pipe is noise. `--live` + `--json` is a usage error for
  the same reason.
- **Still read-only** — `--live` collects and renders; it never
  claims, mutates, or respawns. The respawn decision stays a surface,
  not a button.

No deps: ANSI escapes + `stdin` raw mode, same as the rest of the CLI.

## Plan

- [ ] `fleet.ts`: `fleetArgs` (`--json|--live|--every N`), the live
      loop (alt-screen enter/restore, chained setTimeout tick, key +
      resize handlers), frame render = header + table + warnings +
      footer
- [ ] `fleet.test.ts`: arg parsing (live/every/json conflicts, --every
      bounds), frame composition
- [ ] plugin summary for `fleet` mentions `--live`
- [ ] `npm test` (exact CI command)
