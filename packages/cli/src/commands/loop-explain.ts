/**
 * The spawn path's explanation — why the bead landed on this route.
 *
 * The loop's own file is a four-thousand-line command; the explanation
 * lives here so the routing story has its own small module. The verdict
 * rides with the lane (`routeTableLane` returns it), so the reasons the
 * resolver computed — the candidates, the rejects, the wall that removed
 * a model — survive the trip.
 *
 * stderr: stdout stays the run log.
 */
import { healthKey, renderExplanation, withSlice } from '@broject/core';
import type { ExplainSlice, Explanation } from '@broject/core';
import { chainModelFacts, healthFacts, routeFacts } from '@broject/brouter';
import type { RouteTableLane } from './loop-routes.ts';

/** The explanation — the slices the operator asked for, and nothing else. */
export function explainSpawn(input: {
  /** the slices — absent means the run says nothing about its routing */
  slices?: ExplainSlice[];
  /** the bead the run is about to spawn */
  bead: string;
  /** the route table's verdict */
  routed: RouteTableLane;
}): void {
  const { slices, bead, routed } = input;
  if (slices === undefined) {
    return;
  }
  let explanation: Explanation = { slices: {} };
  explanation = withSlice(explanation, 'route', routeFacts(routed.decision));
  explanation = withSlice(
    explanation,
    'model',
    chainModelFacts(routed.decision.chain, routed.decision.route?.name)
  );
  const keys = routed.decision.chain.map(e => healthKey(e.provider, e.model));
  explanation = withSlice(explanation, 'health', healthFacts(routed.snapshot, keys));
  console.error(`loop: ${bead}`);
  console.error(renderExplanation(explanation, slices));
}
