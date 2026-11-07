/**
 * The decision model — the judge that picks the route.
 *
 * The provider may name a LANE (`providers.<name>` — the operator's own
 * entry) or a MODEL THE ROUTER SERVES (`<entry>/<model>` — jev, openai,
 * anthropic, anything in the served catalog). A served model is proxied
 * through the router's own gateway: the decision model is just another
 * model the router fronts.
 *
 * The wire follows the host. A lane may serve the native typed
 * judgment (the systemone wire); the router's gateway speaks
 * openai-compat, so a PROXIED model answers in prose — prose-grade
 * evidence, never a calibrated judgment. Under "enforce" that is a
 * config error, the same rule the fleet's router keeps.
 */
import { isSystemoneFamily, loadConfig } from '@broject/core';
import type { FleetRouter, ProviderEntry } from '@broject/core';
import { readRouterEndpoint } from './gateway.ts';

/** The env var the router's token rides in for a proxied call — the api
 *  kind reads its key from the environment. */
const ROUTER_TOKEN_ENV = 'BRO_ROUTER_TOKEN';

/** Where the decision model's provider points. */
export type DecisionProvider =
  | { kind: 'lane'; name: string; entry: ProviderEntry }
  | { kind: 'served'; name: string; entry: ProviderEntry };

/** The proxied entry — the router's own gateway, serving one model.
 *
 *  The wire is openai-compat because that is what the gateway speaks:
 *  /v1/chat/completions, /v1/messages, /v1/responses, /v1/models. The
 *  native typed judgment (the systemone wire) is NOT on its routes, so
 *  a proxied model answers in prose — prose-grade evidence, never a
 *  calibrated judgment. */
function proxiedEntry(model: string, url: string, token: string): ProviderEntry {
  process.env[ROUTER_TOKEN_ENV] = token;
  return {
    type: 'api',
    baseUrl: url,
    models: { [model]: 'openai-compat' },
    model,
    apiKeyEnv: ROUTER_TOKEN_ENV,
  };
}

/** The provider the decision model names — a lane, or a served model. */
export function decisionProvider(dir: string, router: FleetRouter): DecisionProvider {
  const providers = loadConfig(dir).providers ?? {};
  const lane = providers[router.provider];
  if (lane !== undefined) {
    return { kind: 'lane', name: router.provider, entry: lane };
  }
  const endpoint = readRouterEndpoint(dir);
  if (endpoint === undefined) {
    throw new Error(
      `no router found — start one (bro serve) to serve "${router.provider}", ` +
        'or name a configured lane in providers'
    );
  }
  return {
    kind: 'served',
    name: router.provider,
    entry: proxiedEntry(router.provider, endpoint.url, endpoint.token),
  };
}

/** The wire the provider speaks — 'systemone' is the typed contract. */
function wireOf(entry: ProviderEntry): string | undefined {
  if (entry.type !== 'api') {
    return undefined;
  }
  const model = entry.model;
  return model === undefined ? undefined : entry.models[model];
}

/** The typed-grade gate — enforce's price. A prose-grade surface may
 *  journal its opinion (shadow) but may not decide the route. */
export function requireTypedGrade(provider: DecisionProvider): void {
  if (provider.kind === 'served') {
    const family = isSystemoneFamily(provider.name) ? ' — the model is systemone-family' : '';
    throw new Error(
      `brouter.router.provider "${provider.name}" is served through the router${family}, ` +
        'and the router answers in prose: a typed judgment is required under "enforce" ' +
        '(a lane that speaks the systemone wire decides instead)'
    );
  }
  const wire = wireOf(provider.entry);
  if (wire === undefined || wire === 'systemone') {
    return;
  }
  throw new Error(
    `brouter.router.provider "${provider.name}" speaks prose (${wire}) — ` +
      'a typed judgment is required under "enforce"'
  );
}
