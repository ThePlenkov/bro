---

id: 9f3c71
created: 2026-10-27T18:20:31Z
parent: null
status: open
objective: >
Deep root-cause analysis of the devin free-tier rate limit: what exact
metric the provider counts, why loop's deadline-chasing spawns land in
an already-locked state, and what minimal fixes close the churn.
delegation: one isolated subagent (deep analysis, read-only)
---

# devin rate limit & deadline chasing — deep analysis

## Problem statement (compressed, no transcript)

The fleet lane (bro loop, cap 2, `devin-acp`, model `swe-2-max` = alias of
swe-2 max reasoning, free "unlimited" plan with an UNKNOWN rate metric)
has degraded into instant-death churn:

- Workers die mid-task on `-32010 Reached free model rate limit`
  (affogato retries `attempts=3` in ~1.5s, ACP Unavailable, exit 1).
- Spawn→death times recently: **14s** (17:01 boundary), **11s**
  (18:05:33 spawn, first inference errored 18:05:43 with "reset at
  19:01 UTC" although loop's block expired at 18:04:50).
- Deadline ladder drifts FORWARD on every re-hit (from `.git/bro/loop.out`
  `rate_limited until`): 04:10 → 08:59 → 09:59 → 10:59 → 13:59 → 16:59 →
  18:04 → 18:59 (provider text then says 19:01).
- Loop unblocks at registry `resetAt` (parsed from the previous error),
  never re-queries the provider, has no instant-death backoff → each
  churn round (2 workers × 3 retries) ADDS hits and pushes the deadline
  another ~hour. Self-poisoning loop.

Prior shallow conclusions (to VERIFY, not trust): quota is account-wide
per model request, counted as `COUNT(DISTINCT request_id)` in sessions.db
(raw rows double-count); "7 sessions" is just slots; metric is probably
requests-in-window (or RPM / parallel-session penalty) — user demands the
EXACT metric or a defensible model.

## Questions (in priority order)

1. **Metric**: what exactly trips the wall? Mine the provider's own
   store (locate `sessions.db` under `~/.devin*` / XDG data dirs) with
   read-only SQL: distinct request_id counts in rolling 5/15/60-min
   windows at (a) wall-onset moments today, (b) instant-death moments,
   (c) healthy mid-run moments. Find the threshold N (or the combination:
   N per window + parallel-session factor) that separates the classes.
   Also check whether request records carry model/reasoning-effort dims
   (max reasoning may cost per token, not per request).
2. **Deadline semantics**: provider quotes BOTH relative minutes and a
   clock mark ("in 54 minutes (at 19:01 UTC)"). Collect every quoted
   "at HH:MM" from today's worker logs (`grep -h "will reset in"` over
   `.git/bro/agents/*.log`) with their emission timestamps: are clock
   marks fixed (hourly HH:01?) and do NEW HITS move them? Prove or
   disprove "each re-hit pushes the deadline".
3. **Loop scheduling code**: in `packages/cli/src/commands/loop.ts` and
   `packages/cli/src/commands/agents.ts` find where `resetAt`/wall is
   parsed and stored (which field: relative minutes or clock text?),
   where the spawn-unblock check lives, and why the block expiry
   (18:04:50) preceded the real open (19:01). Identify the exact code
   line for the clock-vs-relative bug (defect #2 of bro-9eeld).
4. **Retry amplification**: how many HTTP inference calls does one
   wall-hit cost (affogato attempts=3: retries or fresh calls? plus
   session/resume overhead)? Quantify churn damage per cycle.
5. **#685 coverage**: review `origin/loop/bro-y3jvd` diff (shared rate
   gate + wall pauses): which of the three defects (stale-deadline
   chasing, relative parsing, no backoff) does it already fix, which
   remain? Map remaining fixes to concrete patches.

## Evidence inventory (read-only)

- Death logs: `.git/bro/agents/native-1d00e1b4.log` (11s case),
  `native-23c31f42.log`, `native-7faa5597.log` (33 calls/min case),
  all `.git/bro/agents/*.log` for `will reset in` ladder.
- Deadline ladder: `grep -oE "rate_limited (until|til) [0-9T:.-]+" .git/bro/loop.out | sort -u`.
- Provider store: locate `sessions.db` (likely `~/.devin/` or
  `~/.local/share/devin`); sqlite3 READ-ONLY (`sqlite3 "file:...?mode=ro"`).
- Learn: `bro learn show learn-when-triaging-a-devin-free-model-rate-li`.
- Code: `packages/cli/src/commands/loop.ts` (wall/resetAt/spawn-block),
  `packages/cli/src/commands/agents.ts` (registry resetAt), gate diff
  `git fetch origin loop/bro-y3jvd && git diff main...origin/loop/bro-y3jvd -- packages/cli/src/commands/loop.ts`.
- Config: `bro.config.local.json` (loop.interval=120, caps, dirac profile).

## Constraints

- READ-ONLY everywhere (repo, provider store, config). No code edits,
  no spawns, no kills. sqlite queries only in ro-mode.
- Do not trust prior conclusions — verify each against primary evidence.
- Wall-clock honesty: any timestamp claim must come from this run's
  command output.

## Return contract (compressed, parent-consumable)

1. **Model of the limit** — one paragraph + formula/threshold numbers
   (or the strongest supported hypothesis with confidence + what would
   falsify it).
2. **Deadline semantics verdict** — fixed marks vs relative, hit-push
   proven/disproven, with the 3 best evidence rows.
3. **Defect→fix map** — for each of the 3 loop defects: exact code
   location + minimal patch sketch + which bead owns it
   (bro-9eeld / #685 / new).
4. **prevention_plan[]** — entries with action/scope/sink/owner/evidence
   (per drill skill), so /undrill can promote them.

## Delegation plan

- One subagent (general, deep): receives THIS FILE PATH + the evidence
  inventory only (no parent transcript). Budget: long-running OK.
- Parent (watchdog session) continues lane ticks in parallel;
  non-overlapping: subagent reads history/db/code, ticks watch live state.

---

## status: closed (2026-10-27T18:31Z) — return received, prevention_plan promoted

### Findings summary (compressed)

- Metric is server-side only: sessions.db has NO request ledger
  (schema verified). Prior learn lesson COUNT(DISTINCT request_id) = WRONG.
- Two server-side limiters: hourly budget bucket (marks HH:01,
  consumption-scaled horizon) + short burst limiter (5-min grid HH:M1).
- "Re-hit pushes deadline" theory = DISPROVEN (19:01 stayed 19:01 across
  a churn round). Ladder drift = bro's own parse bugs + real re-burns.
- Root cause of instant-death churn: two exact-arithmetic parse bugs in
  packages/core/src/agents.ts — (:106) relReset captures ONE unit
  ("1 hour 55 minutes"→+1h → wall 18:04:50 vs real 19:01), and
  (:147-149) relative wins over clock mark, no "(at HH:MM UTC)" extractor
  → unblocks ~66s early every cycle. Plus no instant-death backoff
  (routing.ts accWall :343-359; agent-connectors.ts :1435-1445).
- #685 = complementary pacing (token bucket + SIGSTOP wall pause);
  fixes none of A/B/C; its "every attempt pushes the reset out" premise
  unsupported by evidence.

### prevention_plan

(5 entries returned — routed in post-drill: A/B/C → bro-9eeld code map;
#685 premise correction → bro-y3jvd comment; learn correction → bro learn add)
