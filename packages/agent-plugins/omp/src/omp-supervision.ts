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
  const host: SupervisionHost = new OmpSupervisionHost(api, intervalMs);
  return registerSupervisionHost('omp', host);
}

class OmpSupervisionHost implements SupervisionHost {
  constructor(
    private readonly api: Pick<OmpApi, 'sendMessage'>,
    private readonly intervalMs: number
  ) {}

  supervise<T>(spec: SupervisionSpec<T>): Promise<T> {
    const native = spec.native;
    if (native === undefined) {
      throw new Error('omp supervision requires a native poll');
    }
    return new Promise<T>((resolve, reject) => {
      const poller = new OmpPoller(this.api, spec, native, resolve, reject);
      poller.start(this.intervalMs);
    });
  }
}

class OmpPoller<T> {
  private settled = false;
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly api: Pick<OmpApi, 'sendMessage'>,
    private readonly spec: SupervisionSpec<T>,
    private readonly native: () => Promise<T>,
    private readonly resolve: (value: T) => void,
    private readonly reject: (reason?: unknown) => void
  ) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.poll(), Math.max(1, intervalMs));
    this.timer.unref();
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.settled || this.inFlight) return;
    this.inFlight = true;
    try {
      const value = await this.native();
      this.sendResult(value);
      this.finish(() => this.resolve(value));
    } catch (error) {
      this.finish(() => this.reject(error));
    } finally {
      this.inFlight = false;
    }
  }

  private sendResult(value: T): void {
    const message = this.spec.message?.(value) ?? `${this.spec.name} settled`;
    this.api.sendMessage(
      { customType: 'bro-supervision', content: message, display: false, details: value },
      { deliverAs: 'steer', triggerTurn: true }
    );
  }

  private finish(callback: () => void): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    callback();
  }
}

export const OMP_SUPERVISION_HOST = 'omp';
