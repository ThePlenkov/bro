/**
 * The one seam used by long-running commands to own a wait.
 *
 * Hosts opt in by exporting BRO_SUPERVISION_HOST (the value is deliberately
 * boring: it is also useful when diagnosing a shell invocation).  The CLI
 * remains useful without a host, so an adapter failure is a fallback rather
 * than a reason to lose the wait.
 */

export type SupervisionSubstrate = 'host' | 'detached';

export interface SupervisionSpec<T> {
  name: string;
  detached: () => Promise<T>;
  /** Explicitly retain the process-based escape hatch. */
  detachedOnly?: boolean;
  /** The environment to probe; defaults to the current process. */
  env?: NodeJS.ProcessEnv;
  /** Host-native poll operation. Absent means this host cannot own it. */
  native?: () => Promise<T>;
  message?: (value: T) => string;
}

export interface SupervisionResult<T> {
  substrate: SupervisionSubstrate;
  handle: T;
  /** Present for the detached path so callers can explain ownership. */
  reason?: string;
}

export interface SupervisionHost {
  supervise<T>(spec: SupervisionSpec<T>): Promise<T>;
}

const hosts = new Map<string, SupervisionHost>();

/** Register a host adapter once when its extension is loaded. */
export function registerSupervisionHost(name: string, host: SupervisionHost): () => void {
  hosts.set(name, host);
  return () => {
    if (hosts.get(name) === host) hosts.delete(name);
  };
}

/** Return the host marker without treating an empty marker as capability. */
export function supervisionHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.BRO_SUPERVISION_HOST?.trim();
  return value === '' ? undefined : value;
}

/** Probe the host and run a wait on it, falling back to the detached runner. */
export async function supervise<T>(spec: SupervisionSpec<T>): Promise<SupervisionResult<T>> {
  const hostName = spec.detachedOnly ? undefined : supervisionHost(spec.env);
  const host = hostName === undefined ? undefined : hosts.get(hostName);
  if (host !== undefined) {
    try {
      return { substrate: 'host', handle: await host.supervise(spec) };
    } catch {
      // A host can disappear while an extension is reloading. The wait must
      // still be armed, and the caller receives an explicit ownership reason.
    }
  }
  return {
    substrate: 'detached',
    handle: await spec.detached(),
    reason: spec.detachedOnly
      ? 'detached explicitly requested'
      : hostName === undefined
        ? 'no host supervision capability'
        : `host supervision unavailable: ${hostName}`,
  };
}
