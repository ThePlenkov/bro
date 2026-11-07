import type { PlaneDescriptor } from '@broject/core';
import type { ContractDump } from './contract-dump.ts';
import { isRecord, own, type ContractProblem } from './contract-shared.ts';

/** The ops a transport can actually serve: every named read plus the
 *  per-transport verb allowlists (`mcpVerbs` for tools, `restVerbs` for
 *  POST routes). Declared verbs outside every allowlist are
 *  declared-but-unwired (their exec throws PlaneUnavailable), so they
 *  serve nothing yet and need no twin until a spec exposes one.
 *  Deduped — an op named in more than one list is one exposure, so its
 *  missing twin is one problem, not two. */
function exposedOps(plane: PlaneDescriptor): string[] {
  return [...new Set([...plane.reads, ...(plane.mcpVerbs ?? []), ...(plane.restVerbs ?? [])])];
}

/** Every transport-exposed plane op mirrors a CLI contract entry — the
 *  descriptor's `cli` map names its twin. An op with no declared twin,
 *  or a twin the registry lacks, forks the transport surface from the
 *  CLI contract (spec bro-xiq2m). Checked against the live dump so a
 *  --dump fixture gets the same verdict the real registry would; the
 *  committed file can't hide a missing twin either — a live-only
 *  command is already a stale drift problem. */
export function planeParityProblems(
  catalog: readonly PlaneDescriptor[],
  live: ContractDump
): ContractProblem[] {
  const problems: ContractProblem[] = [];
  for (const plane of catalog) {
    for (const op of exposedOps(plane)) {
      const twin = plane.cli?.[op];
      const path = `planes.${plane.name}.${op}`;
      if (twin === undefined) {
        problems.push({
          kind: 'breaking',
          path,
          message: `plane op has no CLI twin — declare cli.${op} on the descriptor`,
        });
      } else if (!isRecord(own(live.commands, twin))) {
        problems.push({
          kind: 'breaking',
          path,
          message: `CLI twin '${twin}' is not in the contract — the transport surface outgrew the CLI`,
        });
      }
    }
  }
  return problems;
}
