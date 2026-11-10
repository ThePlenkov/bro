/**
 * The claude-code adapter — the pilot.
 *
 * Claude Code discovers a gateway's models over `GET /v1/models` and
 * KEEPS ONLY the ids matching `/(claude|anthropic)/i`: an honest
 * `<entry>/<model>` id never reaches the picker (measured against the
 * live gateway: 547 served, 89 survive). The client's own settings
 * path does not filter — `modelPicker.options` rows are curated rows,
 * taken verbatim — so the model block lands there.
 *
 * `behavesAs` is the client's own vocabulary: the row borrows the
 * client-side handling (prompt profile, capability, effort defaults,
 * context window) of a model THIS client version knows. Without it the
 * client warns "isn't recognized · context assumed to be 200k tokens".
 * The targets are the client's, not the router's — a client release
 * retires them.
 */
import { modelFamily, type ModelFamily, type ServedModel } from '../catalog.ts';
import type { ClientAdapter, RouterEndpoint } from '../adapter.ts';

/** The model each family borrows its handling from — pinned to the
 *  client versions this adapter was written against (Claude Code
 *  2.1.309). */
export const CLAUDE_CODE_BEHAVES_AS: Record<ModelFamily, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  // a model whose id names no family the client knows still gets served;
  // it borrows the mid-tier handling, which is the least surprising
  other: 'claude-sonnet-5-5',
};

/** One picker row — the client's own shape. */
export interface ClaudeCodeRow {
  model: string;
  label?: string;
  description?: string;
  behavesAs?: string;
}

/** The served models → the picker rows. The id is verbatim: the client
 *  sends it back exactly as it was given. */
export function claudeCodeRows(models: ServedModel[]): ClaudeCodeRow[] {
  return models.map(m => ({
    model: m.id,
    ...(m.label === undefined || m.label === '' ? {} : { label: m.label }),
    ...(m.description === undefined || m.description === '' ? {} : { description: m.description }),
    behavesAs: CLAUDE_CODE_BEHAVES_AS[modelFamily(m.id)],
  }));
}

/** The claude-code adapter. */
export const claudeCodeAdapter: ClientAdapter = {
  id: 'claude-code',
  title: 'Claude Code',
  defaultSettingsPath: '~/.claude/settings.json',
  settingsKey: 'modelPicker',
  renderModelBlock(models) {
    return {
      options: claudeCodeRows(models),
      // the picker shows Default + the served models; the built-in
      // lineup AND the client's own filtered discovery are hidden
      replaceBuiltInOptions: true,
    };
  },
  wire(router: RouterEndpoint) {
    return { env: { ANTHROPIC_BASE_URL: router.url } };
  },
};
