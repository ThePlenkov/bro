/**
 * The gateway's API surfaces — each under its OWN base path, so a
 * client's base URL picks the dialect and no base ever mixes two wire
 * shapes:
 *
 *    /anthropic/v1/messages               the Anthropic Messages surface
 *    /anthropic/v1/messages/count_tokens
 *    /openai/v1/chat/completions          the OpenAI chat surface
 *    /openai/v1/responses                 the OpenAI responses surface
 *    /systemone/v1/systemone              the typed-judgment surface
 *
 * The flat `/v1/…` address stays the legacy path: there the path itself
 * names the dialect. One model answers on EVERY surface — the mount picks
 * the WIRE a client speaks, the model id never changes (a LiteLLM-style
 * proxy: one model, many dialects).
 */

/** The wire dialects the gateway can speak. */
export const API_SURFACES = ['anthropic', 'openai', 'systemone'] as const;
export type ApiSurface = (typeof API_SURFACES)[number];

/** A surface's base path — the mount every endpoint of that wire sits
 *  under ('/anthropic', '/openai', '/systemone'). */
export const surfaceMount = (surface: ApiSurface): string => `/${surface}`;

/** The surface a request path names, and the path under it. An undefined
 *  surface is the legacy flat address ('/v1/…'). */
export function resolveSurface(pathname: string): {
  surface: ApiSurface | undefined;
  path: string;
} {
  for (const surface of API_SURFACES) {
    const mount = surfaceMount(surface);
    if (pathname === mount || pathname.startsWith(`${mount}/`)) {
      return { surface, path: pathname.slice(mount.length) };
    }
  }
  return { surface: undefined, path: pathname };
}

/** The endpoints each surface owns. A mounted base speaks ONE dialect:
 *  the anthropic base never answers a chat completion, the openai base
 *  never answers a message — a client that mixes them gets a 404 that
 *  names the right address, never a wrong-shaped answer. The catalog
 *  belongs to both: a model is listed wherever it can be served. */
export const SURFACE_ENDPOINTS: Record<ApiSurface, readonly string[]> = {
  anthropic: ['POST /v1/messages', 'POST /v1/messages/count_tokens', 'GET /v1/models'],
  openai: ['POST /v1/chat/completions', 'POST /v1/responses', 'GET /v1/models'],
  // the typed-judgment surface has no gateway endpoint yet — the judge
  // facade answers it in-process; the mount is claimed so a systemone
  // client never lands on an anthropic-shaped answer
  systemone: [],
};

/** Is this path a provider-plane path? The flat '/v1/…' and every
 *  mounted '/<surface>/v1/…' are. */
export function isProviderPath(pathname: string): boolean {
  return resolveSurface(pathname).path.startsWith('/v1/');
}

/** The path the wire's own endpoint sits at, under its mount — the
 *  address a client of that dialect is told to use. */
export function surfaceAddress(surface: ApiSurface, endpoint: string): string {
  return `${surfaceMount(surface)}${endpoint}`;
}
