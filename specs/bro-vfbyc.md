# bro-vfbyc — conductor: a trimmed reply retires the session it diverged from

## Problem

The output cap (`max_output_tokens`, `max_completion_tokens`/`max_tokens`)
and the stop-sequence filter cut the reply AT THE WIRE — post-turn for
buffered responses, mid-stream for SSE. The retained acp session still
holds the FULL generation in its own context: text and tool calls the
client never received (PR #589 review, greptile P1, deferred). Two
failure shapes follow:

- `/v1/responses`: a `previous_response_id` chain continues that session —
  the next turn generates off hidden context; the model "remembers"
  output the client never saw.
- `/v1/chat/completions` and `/v1/messages`: the client resends its
  history with the trimmed assistant echo, but `tailTurns` drops all
  assistant messages — the echo that could self-correct never reaches
  the session, so it keeps building on its full reply.

## Design

`conv.lastReply` already records the emitted (cut) view — the recorded
reply stays byte-identical to what the client saw, so a resend carrying
nothing new still replays it from a divergent session. What is missing
is refusing to CONTINUE off the divergence.

- `ConvSession.divergent` — set in `settleConv` whenever the emitted
  reply is not the full generation: the cap cut it (`capBlocks`,
  `RespLive.capped`/`ChatLive.capped`) or the stop filter swallowed
  post-marker output (`stops.hit`).
- `continuationTurn`: after the empty-tail replay bail, a divergent
  session never prompts —
  - fingerprinted request (chat/messages): evict, then `freshTurn` —
    the resent full history (trimmed echo included) re-seeds a session
    whose context IS the client's view.
  - chained request (`previous_response_id`): evict + `ChainBroken` —
    the delta alone cannot rebuild context; the client re-issues
    unchained with full input. Wire shape: 400 invalid_request_error.
- `RespLive.capped`/`ChatLive.capped` become public so the settle path
  ORs the live stream cut with the post-hoc `capBlocks` verdict.

## Non-goals

- Propagating the cap into generation (session/cancel mid-turn) — the
  char cap is already an estimate, cancel retention semantics are
  backend-dependent; retiring the session is the honest answer.
- No true token accounting — `capCharsOf` stays an estimate.

## Plan

- [ ] `ConvSession.divergent` + `settleConv` flag param; three callsites
  pass it (messages: `stops.hit`; responses: `capped`; chat: `capped ||
  stops.hit`, each OR'd with the live leg's own cut).
- [ ] `continuationTurn` divergent guard: replay still allowed; real
  turn → evict + fresh (fingerprinted) or evict + ChainBroken (chained).
- [ ] `capped` public on `RespLive`/`ChatLive`.
- [ ] Tests: capped responses chain → 400 + no second prompt; capped
  chat resend → fresh session sees the trimmed echo; identical resend
  after a cap still replays; stop-cut messages turn retires its session.
