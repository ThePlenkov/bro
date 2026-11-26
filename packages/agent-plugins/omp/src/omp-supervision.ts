import {
  registerSupervisionHost,
  type SupervisionHost,
  type SupervisionSpec,
} from '@broject/core';
import type { OmpApi } from './omp-api.ts';

const DEFAULT_POLL_MS = 5_000;

/**
 * Install omp's in-process supervision adapter. A timer is deliberately
 * unref'd: an extension wait must never keep the editor alive by itself.
 * Completion is a steer message, rather than a notification, so the model
 * receives the verdict on its next scheduling point.
 */
export function installOmpSupervision(
  api: Pick<OmpApi, 'sendMessage'>,
  intervalMs = DEFAULT_POLL_MS
): () => void {
  const host: SupervisionHost = {
    async supervise<T>(spec: SupervisionSpec<T>): Promise<T> {
      if (spec.native === undefined) {
        throw new Error('omp supervision requires a native poll');
      }
      const native = spec.native;
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        let inFlight = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          fn();
        };
        const poll = async (): Promise<void> => {
          if (settled || inFlight) return;
          inFlight = true;
          try {
            const value = await native();
            const message = spec.message?.(value) ?? `${spec.name} settled`;
            api.sendMessage(
              { customType: 'bro-supervision', content: message, display: false, details: value },
              { deliverAs: 'steer', triggerTurn: true }
            );
            finish(() => resolve(value));
          } catch (error) {
            finish(() => reject(error));
          } finally {
            inFlight = false;
          }
        };
        const timer = setInterval(() => void poll(), Math.max(1, intervalMs));
        timer.unref();
        void poll().catch(() => undefined);
      });
    },
  };
  return registerSupervisionHost('omp', host);
}

export const OMP_SUPERVISION_HOST = 'omp';
