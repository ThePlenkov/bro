import type { MaybePromise } from '@broject/core';
import type { StageCall } from './runner.ts';

/** The narrow read seam stages use; the learn store stays outside pipeline. */
export interface StageProbeHit {
  id?: string;
  lesson: string;
  score?: number;
}

export interface StageProbeResult {
  question: string;
  hits: readonly StageProbeHit[];
}

export type StageProbe = (question: string, call: StageCall) => MaybePromise<StageProbeResult>;

/** Stable, journal-friendly provenance attached to a stage payload. */
export interface StageLearning {
  question: string;
  lessons: StageProbeHit[];
}

export async function probeStage(
  probe: StageProbe | undefined,
  question: string,
  call: StageCall
): Promise<StageLearning | undefined> {
  if (probe === undefined) return undefined;
  const result = await probe(question, call);
  return {
    question: result.question,
    lessons: result.hits.map(hit => ({ ...hit })),
  };
}
