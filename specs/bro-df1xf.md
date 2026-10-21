# bro-df1xf — serve: drain the request body before answering 413

## Problem

`readBody` throws `HttpError(413)` the moment the running size crosses
`MAX_BODY_BYTES`, abandoning the request stream mid-body. The response
then goes out while the client is still uploading — the socket carries
unread inbound data, so the kernel answers the next inbound segment
with RST. On loopback that races the client reading the 413: undici
observes `TypeError: fetch failed / read ECONNRESET` instead of a
status. Observed on PR #577's full-file run of serve.test.ts at the
300KiB-body wire test; passes in isolation because timing decides
whether the RST lands before or after the response is read.

## Design

`readBody` keeps reading after the cap trips — chunks stop being
buffered but the stream is consumed to end — then throws 413. The
socket is clean when `send(res, 413)` runs: no unread request data, no
RST race, keep-alive stays usable.

Bounded in both directions: the drain stops after `limit` further
bytes past the trip chunk — ~2·limit on the wire at chunk granularity
(the contract is boundedness, not exact bytes). An upload still
streaming past that is abusive — a hosted tunnel exposes webhook
routes unauthenticated, before HMAC verification — so the stream is
paused and the handler answers `413` with `Connection: close`: the
status goes out on a live socket, then Node tears the connection down
on the response's tail (destroying the request mid-read would kill
the socket under the response, which is the ECONNRESET this spec
exists to remove). A client that never finishes inside the bound is
held by Node's `requestTimeout`, same as any slow request today. The
memory cap itself is unchanged — over-limit bytes are never buffered.

Scope: the fix lives in `readBody`, the single chokepoint for JSON
write bodies. Guard refusals that answer before `readBody` (401/403/415)
keep their early-response semantics — the reported flake is the 413
path, and guard-tripping bodies in tests are kernel-buffer small.

## Test

The existing wire test (`health, JSON envelope, 413 cap, and bad-JSON
400 all hold on the wire`) is the reproduction — it must pass
reliably in the full-file run, not only under `--test-name-pattern`.
