# bro-84zrj — bro exec taskFinish report-back

A shell command's completion must reach the session that launched it.
`bro exec <cmd>` runs the argv under `sh -c`, passes stdio through,
keeps a 4 KB interleaved tail, and on exit fires the new
`taskFinish` connector probe (parallel, fail-open, one probe budget).
Its own exit code is the child's.

The herdr connector (`agents.herdr.reportBack`) answers the probe when
the pane is herdr-controlled (`HERDR_PANE_ID` + `HERDR_SOCKET_PATH`):
`herdr agent get` names the pane's agent kind, the config map opts
kinds in (`{"devin": true}` or `true` for all), and the verdict lands
as `herdr agent prompt <pane>` — the report-back for agent kinds whose
host has no task-exit wake (devin). Outside herdr the probe is a no-op.
