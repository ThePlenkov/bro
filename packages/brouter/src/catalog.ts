/**
 * brouter — the model-centric router: the catalog it serves and the
 * clients it fronts.
 *
 * The router's contract with a client is ONE thing — the model list.
 * The gateway serves it (`GET /v1/models`), a client renders it in its
 * own vocabulary, and both sides stay vendor-blind: the id is the
 * honest `<entry>/<model>` string, never a re-spelled one.
 *
 * This module owns the SHARED vocabulary: what a served model is, how
 * a family is read off an id, and how a catalog payload becomes rows.
 * Client-specific spellings (which model a client borrows its handling
 * from, which settings key carries the block) live in the adapters —
 * a client version's model knowledge is the client's business.
 */

/** One model the router serves — the row every consumer reads. */
export interface ServedModel {
  /** the honest id a client asks for: `<entry>/<model>` */
  id: string;
  /** the human label the catalog carries */
  label?: string;
  /** the catalog's own description — where the model comes from */
  description?: string;
  /** the entry (the lane) the model is served by — the router's own
   *  answer, not a guess read back off the id */
  source?: string;
}

/** The model families a client may recognize. `other` is a model whose
 *  id names no family the client knows — it still gets served, it just
 *  borrows no family-specific handling. */
export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other';

/** The family an id names — read off the id's SEGMENTS, never off its
 *  head: `opencode-acp/claude-opus-5-5-medium` is an opus even though
 *  its head is a lane. A segment, not a substring: `sonnet` inside
 *  `sonnetizer` names no family. */
export function modelFamily(id: string): ModelFamily {
  const segments = new Set(id.toLowerCase().split(/[^a-z0-9]+/));
  if (segments.has('fable')) return 'fable';
  if (segments.has('opus')) return 'opus';
  if (segments.has('sonnet')) return 'sonnet';
  if (segments.has('haiku')) return 'haiku';
  return 'other';
}

/** The Anthropic-shaped catalog payload — `/v1/models` answers this. */
interface CatalogPayload {
  data?: unknown;
}

/** The catalog rows → the served models. A row without a usable id is
 *  not a model: it is dropped, and the count of what was dropped rides
 *  the answer (a short catalog must be distinguishable from a whole
 *  one). */
function readString(bag: Record<string, unknown>, key: string): string {
  const value = bag[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** The row → the served model. The lane comes from the row's own
 *  `source` field — the router knows which lane served it and says so.
 *  It is NOT re-read off the id: an id is `<entry>/<model>`, and a
 *  model's own name may carry a slash of its own, so the id's head is
 *  a guess where the row's field is a fact. */
function toServedModel(row: unknown): ServedModel | null {
  if (typeof row !== 'object' || row === null) return null;
  const bag = row as Record<string, unknown>;
  const id = readString(bag, 'id');
  if (id === '') return null;
  const label = readString(bag, 'display_name');
  const description = readString(bag, 'description');
  const source = readString(bag, 'source');
  return {
    id,
    ...(label === '' ? {} : { label }),
    ...(description === '' ? {} : { description }),
    ...(source === '' ? {} : { source }),
  };
}

export function servedModels(payload: unknown): { models: ServedModel[]; dropped: number } {
  const body = (payload ?? {}) as CatalogPayload;
  const rows = Array.isArray(body.data) ? body.data : [];
  const models: ServedModel[] = [];
  let dropped = 0;
  for (const row of rows) {
    const model = toServedModel(row);
    if (model === null) {
      dropped++;
    } else {
      models.push(model);
    }
  }
  return { models, dropped };
}
