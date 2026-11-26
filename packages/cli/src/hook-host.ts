/** Resolve the hook client at the CLI/connector boundary.
 *
 * This is intentionally kept in lockstep with hooks/run.sh. Core remains
 * vendor-neutral; only the integration edge knows client environment markers
 * and payload fingerprints.
 */
const HOOK_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function hookHostOf(env: NodeJS.ProcessEnv, raw?: unknown): string {
  const configuredHost =
    env.BRO_HOOK_HOST !== undefined && HOOK_HOST_RE.test(env.BRO_HOOK_HOST)
      ? env.BRO_HOOK_HOST
      : undefined;
  const envHosts: Array<[string | undefined, string]> = [
    [env.CURSOR_PLUGIN_ROOT, 'cursor'],
    [env.DEVIN_PLUGIN_ROOT, 'devin'],
    [env.CLAUDE_PLUGIN_ROOT, 'claude'],
    [env.CURSOR_PROJECT_DIR, 'cursor'],
    [env.DEVIN_PROJECT_DIR, 'devin'],
    [env.PLUGIN_ROOT, 'codex'],
  ];
  const marker = envHosts.find(([value]) => value !== undefined && value !== '');
  const serialized = raw === undefined || raw === null ? undefined : JSON.stringify(raw);
  const payloadHost =
    serialized?.includes('"cursor_version"') || serialized?.includes('"workspace_roots"')
      ? 'cursor'
      : serialized?.includes('"turn_id"')
        ? 'codex'
        : undefined;
  return configuredHost ?? marker?.[1] ?? payloadHost ?? 'unknown';
}
