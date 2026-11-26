/** Resolve the hook client at the CLI/connector boundary.
 *
 * This is intentionally kept in lockstep with hooks/run.sh. Core remains
 * vendor-neutral; only the integration edge knows client environment markers
 * and payload fingerprints.
 */
const HOOK_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function configuredHostOf(env: NodeJS.ProcessEnv): string | undefined {
  const host = env.BRO_HOOK_HOST;
  return host !== undefined && HOOK_HOST_RE.test(host) ? host : undefined;
}

function markerHostOf(env: NodeJS.ProcessEnv): string | undefined {
  const envHosts: Array<[string | undefined, string]> = [
    [env.CURSOR_PLUGIN_ROOT, 'cursor'],
    [env.DEVIN_PLUGIN_ROOT, 'devin'],
    [env.CLAUDE_PLUGIN_ROOT, 'claude'],
    [env.CURSOR_PROJECT_DIR, 'cursor'],
    [env.DEVIN_PROJECT_DIR, 'devin'],
    [env.PLUGIN_ROOT, 'codex'],
  ];
  const marker = envHosts.find(([value]) => value !== undefined && value !== '');
  return marker?.[1];
}

function payloadHostOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const serialized = JSON.stringify(raw);
  return serialized.includes('"cursor_version"') || serialized.includes('"workspace_roots"')
    ? 'cursor'
    : serialized.includes('"turn_id"')
      ? 'codex'
      : undefined;
}

export function hookHostOf(env: NodeJS.ProcessEnv, raw?: unknown): string {
  return configuredHostOf(env) ?? markerHostOf(env) ?? payloadHostOf(raw) ?? 'unknown';
}
