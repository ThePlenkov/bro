# bro-d6mcd — acp client: expose the streaming surface

`@broject/providers` `acpChat`/`acpCall` resolve the whole turn:
`acpOp` awaits `session.prompt()` + `session.readText()` — the only
update-draining code inside is the session handle's own buffer. No
consumer can observe `agent_message_chunk` (or tool_call lifecycle
updates) as they arrive, so any host built on the lib is structurally
unable to stream.

`acpConverse`/`acpPooledTurn` (the conductor leg, landing via
`bro-om6m8.2`) already prove the mechanics: drain
`session.nextUpdate()` until `stop`, feed every `SessionUpdate` to a
caller's `onUpdate`, accumulate the message text. The SDK ships the
same `ActiveSession.nextUpdate()` on main — the one-shot path just
never got wired to it.

## Change

- `AcpSeam` gains `onUpdate?: (update: SessionUpdate) => void` —
  the acp-only seam already carries `peer`/`cwd`; a per-call sink is a
  seam, not a `ProviderWireOpts` field shared with the api kind.
- `acpOp` drains the turn itself: `session.prompt()` raced against
  `nextUpdate()` until the `stop` message (the same loop shape the
  pooled path uses; when `bro-om6m8.2` lands, `acpOp` can fold onto
  its `pumpTurn` helper — deliberately not a dependency of this PR).
  Every update forwards to `opts.acp?.onUpdate` before the text
  accumulator sees it. Absent callback = whole-turn callers keep
  their exact contract (`{content, model, usage}` unchanged,
  `end_turn` enforcement identical).
- `acpChat`/`acpCall` need no signature change — `opts` already
  threads through `acpRoundTrip` → `acpOp`.

## Non-goals

- No new consumer is built here — `bro-d6mcd` is the *surface*; wiring
  the conductor's SSE deltas onto it is the follow-up that closes the
  review-deferred thread (and `bro-wwo7e`/`bro-dojl5` own their own
  consumers).
- `readText`'s buffer stays for SDK-internal use; nothing else calls
  it after this change.
- No change to `stopReason !== 'end_turn'` semantics or auth mapping.

## Verify

- `acp.test.ts`: a scripted `AgentApp` peer emitting two
  `agent_message_chunk` updates mid-turn — assert `onUpdate` fired
  per update (kinds in order) while the resolved text still equals
  the concat.
- Same test with no `onUpdate` — unchanged whole-turn result.
- A `tool_call` update forwarded to the sink (not just text chunks).
- Typecheck; `npm test` on the affected suites.
