---

drill: "bro-gblja"
scope: "convoy unmarked runner spawns bypass batch wall and quota"
parent-chain: ["bro-gblja"]
date: "2026-10-28T14:12:43.118Z"
result: "BRO_BATCH is an opt-in per-call-site pin — only delegate/drive/loop set it. convoy-run (the mol fan-out, convoy-run.ts:561) and dogfood (505+602) spawn fleet-nature devin workers UNMARKED: invisible to maxBatchWorkers AND exempt from batchWallRefusal — they spawn straight into rate_limited walls and add unmanaged lanes while the account is saturated. All spawned workers DO carry BRO_AGENT_ID (agentEnvPins), so maxWorkers is the catch-all lane that sees unmarked spawns; maxBatchWorkers alone cannot deliver 'one devin worker at a time'. Evidence: all 10 registry rate_limited deaths are devin/devin-acp; unmarked sites: convoy-run.ts:561, dogfood.ts:505+602, agents.ts:937+1273 (operator, intentional per bro-9h86l), serve.ts:1927."
prevention: ["convoy-run: pin BRO_BATCH on runner spawns — mol runners are fleet-owned batch work; unmarked they bypass the provider wall (spawn into rate_limited reset windows) and the fleet's own cap", "spawnStepAgent: make the lane explicit — required lane: batch|interactive (or default-batch + interactive opt-out) so a new spawn path cannot silently inherit neither wall nor cap; the marker at call sites is opt-in, convoy-run forgot it", "dogfood runner+analyst spawns: classify lane — bro-managed self-test capacity spends the same account pool; mark batch or document the intentional exemption"]
---

# drill report — convoy unmarked runner spawns bypass batch wall and quota

## Result

BRO_BATCH is an opt-in per-call-site pin — only delegate/drive/loop set it. convoy-run (the mol fan-out, convoy-run.ts:561) and dogfood (505+602) spawn fleet-nature devin workers UNMARKED: invisible to maxBatchWorkers AND exempt from batchWallRefusal — they spawn straight into rate_limited walls and add unmanaged lanes while the account is saturated. All spawned workers DO carry BRO_AGENT_ID (agentEnvPins), so maxWorkers is the catch-all lane that sees unmarked spawns; maxBatchWorkers alone cannot deliver 'one devin worker at a time'. Evidence: all 10 registry rate_limited deaths are devin/devin-acp; unmarked sites: convoy-run.ts:561, dogfood.ts:505+602, agents.ts:937+1273 (operator, intentional per bro-9h86l), serve.ts:1927.

## Prevention

- convoy-run: pin BRO_BATCH on runner spawns — mol runners are fleet-owned batch work; unmarked they bypass the provider wall (spawn into rate_limited reset windows) and the fleet's own cap (bro-gy1ez)
- spawnStepAgent: make the lane explicit — required lane: batch|interactive (or default-batch + interactive opt-out) so a new spawn path cannot silently inherit neither wall nor cap; the marker at call sites is opt-in, convoy-run forgot it (bro-1houf)
- dogfood runner+analyst spawns: classify lane — bro-managed self-test capacity spends the same account pool; mark batch or document the intentional exemption (bro-42rfh)

## Trail

- children:
  (none)
- evidence:
  (none)
