/**
 * The bro.config JSON Schema contract (spec: specs/bro-d9dmx.md). Every
 * registered `ConfigSection` carries a `.jsonSchema` next to its parser;
 * this module turns that registry into:
 *
 * - `configSchemaDocument` — the emitted draft-07 document
 *   `schemas/bro.config.schema.json` ships to IDEs and agents;
 * - `configDiagnostics` — per-layer validation errors naming the
 *   layer + file a bad value came from (the audit's layer-provenance
 *   requirement): what `bro doctor` reports and `--strict` fails on;
 * - `configPolicyErrors` — the same restricted to *policy* sections
 *   (CONFIG_SECTION_LAYERS): what the mutation gate refuses on.
 *
 * The validator covers only the keywords the section schemas use —
 * sections describe the accepted input shape, not full semantics
 * (secret-in-command guards, model allowlists stay in the parsers).
 * Fail-open is unchanged everywhere else: `loadConfig` callers and
 * hooks never touch this module.
 */
import {
  CONFIG_LAYER_FILES,
  CONFIG_SECTION_LAYERS,
  CORE_SECTIONS,
  deepMerge,
  loadConfigLayers,
  PERSONALITIES,
  STORE_BACKENDS,
  type ConfigLayerHit,
  type ConfigLayerName,
  type ConfigSection,
  type JsonSchema,
} from './config.ts';
import { basename } from 'node:path';
import { validateSchemaValue, type SchemaError } from './schema-validator.ts';

// the validator moved to schema-validator.ts — these re-exports keep
// the public surface (index.ts, tests, embedders) unchanged
export { validateSchemaValue };
export type { SchemaError };

/** The canonical `$schema` URL `bro setup` writes — unpkg serves the
 *  copy shipped inside the published @broject/bro package. */
export const CONFIG_SCHEMA_URL = 'https://unpkg.com/@broject/bro/schemas/bro.config.schema.json';

export interface ConfigDiagnostic {
  layer: ConfigLayerName;
  file: string;
  /** Top-level config key the error lives under. */
  key: string;
  /** Dotted path from the config root — `sdd.mode`, `act.ignoreChecks[2].name`. */
  path: string;
  message: string;
}

/** `configKey → jsonSchema` over the same merged registry loadConfig
 *  normalizes through — core wins a collision, sections without a
 *  declared schema are uncheckable and skipped. */
export function jsonSchemasFor(
  sections: Record<string, ConfigSection<unknown>> = {}
): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const [key, fn] of Object.entries({ ...sections, ...CORE_SECTIONS })) {
    if (typeof fn === 'function' && fn.jsonSchema !== undefined) {
      out[key] = fn.jsonSchema;
    }
  }
  return out;
}

/** Top-level scalars that are not plugin sections — validated like
 *  sections and emitted into the document. `store` is the legacy v0.1.0
 *  spelling; `$schema` is the self-reference IDEs write. */
const TOP_LEVEL_JSON_SCHEMAS: Record<string, JsonSchema> = {
  $schema: { type: 'string' },
  stores: { type: 'array', items: { enum: STORE_BACKENDS } },
  store: { enum: STORE_BACKENDS },
  personality: { enum: PERSONALITIES },
  plugins: { type: 'array', items: { type: 'string', minLength: 1, pattern: String.raw`\S` } },
  pack: { type: 'string', minLength: 1, pattern: String.raw`\S` },
};

/** Validate every loaded layer's raw config against the registered
 *  schemas — the diagnostic counterpart of loadConfig, reading through
 *  the SAME loadConfigLayers path so worktree inheritance and layer
 *  precedence are identical. Unknown keys are skipped — the
 *  unknown-key typo check is doctor's job (external plugin configKeys
 *  can't be enumerated statically). */
/** `ConfigDiagnostic.key` value for a file that failed to load at all —
 *  no section key exists to name, and the unreadable file is what the
 *  diagnostic (and the policy gate) must see. */
export const BROKEN_FILE_KEY = '(unreadable)'; // skipcq: SCT-A000 — sentinel label, not a credential

/** The layer a broken file belonged to — the basename names it since
 *  each layer's candidate names are distinct. */
function layerOfFile(file: string): ConfigLayerName {
  const name = basename(file);
  for (const layer of ['local', 'project', 'global'] as const) {
    if ((CONFIG_LAYER_FILES[layer] as readonly string[]).includes(name)) {
      return layer;
    }
  }
  return 'project';
}

/** `path message` strings the merged view validates against — a
 *  per-layer 'requires' present here is cross-layer completion. */
function mergedErrorSet(
  merged: Record<string, unknown>,
  schemas: Record<string, JsonSchema>
): Set<string> {
  const errs = new Set<string>();
  for (const [key, v] of Object.entries(merged)) {
    const schema = schemas[key];
    if (schema === undefined) {
      continue;
    }
    for (const e of validateSchemaValue(v, schema, key)) {
      errs.add(`${e.path} ${e.message}`);
    }
  }
  return errs;
}

interface DiagCtx {
  hit: ConfigLayerHit;
  schemas: Record<string, JsonSchema>;
  mergedErrs: Set<string>;
}

/** One layer key's violations — a 'requires' the merged config
 *  satisfies is cross-layer completion, not a violation here. */
function keyViolations(dctx: DiagCtx, key: string, v: unknown): ConfigDiagnostic[] {
  const { hit, schemas, mergedErrs } = dctx;
  const schema = schemas[key];
  if (schema === undefined) {
    return [];
  }
  const input = key === 'plugins' && hit.pluginsRaw !== undefined ? hit.pluginsRaw : v;
  const out: ConfigDiagnostic[] = [];
  for (const e of validateSchemaValue(input, schema, key)) {
    if (e.message.startsWith('requires ') && !mergedErrs.has(`${e.path} ${e.message}`)) {
      continue;
    }
    out.push({ layer: hit.layer, file: hit.file, key, path: e.path, message: e.message });
  }
  return out;
}

/** Diagnostics for one loaded layer's raw config — `plugins` validates
 *  the RAW array (the parser filters bad entries out of the normalized
 *  view; the file is what must be judged). */
function layerViolations(
  hit: ConfigLayerHit,
  schemas: Record<string, JsonSchema>,
  mergedErrs: Set<string>
): ConfigDiagnostic[] {
  const dctx: DiagCtx = { hit, schemas, mergedErrs };
  return Object.entries(hit.raw).flatMap(([key, v]) => keyViolations(dctx, key, v));
}

export function configDiagnostics(
  cwd: string = process.cwd(),
  sections: Record<string, ConfigSection<unknown>> = {},
  only?: readonly ConfigLayerName[]
): ConfigDiagnostic[] {
  const { layers, broken } = loadConfigLayers(cwd, only);
  const schemas = { ...TOP_LEVEL_JSON_SCHEMAS, ...jsonSchemasFor(sections) };
  // The merged view is what loadConfig actually consumes — a `required`
  // field completed by ANOTHER layer is layered composition, not a
  // violation in each layer alone (spec fields compose via deepMerge).
  const merged = layers.reduce<Record<string, unknown>>((m, hit) => deepMerge(m, hit.raw), {});
  const mergedErrs = mergedErrorSet(merged, schemas);
  const out = layers.flatMap(hit => layerViolations(hit, schemas, mergedErrs));
  // A file that failed to load contributes nothing to the merged view —
  // silently reporting "all layers validate" for an unparsed file is a
  // false negative the gate can't afford
  for (const file of broken) {
    out.push({
      layer: layerOfFile(file),
      file,
      key: BROKEN_FILE_KEY,
      path: BROKEN_FILE_KEY,
      message: 'config file exists but failed to load — skipped',
    });
  }
  return out;
}

/** Diagnostics restricted to *policy* sections — the committed config
 *  everyone shares. Operator sections (providers, fleet, agents, …) are
 *  machine-local by definition: they warn, they never gate a mutation. */
export function configPolicyErrors(
  cwd: string = process.cwd(),
  sections: Record<string, ConfigSection<unknown>> = {}
): ConfigDiagnostic[] {
  return configDiagnostics(cwd, sections).filter(d =>
    d.key === BROKEN_FILE_KEY
      ? // a broken project/local file could hold invalid policy we
        // can't see — refuse; a broken global file is the user's own
        // and never gates repo work
        d.layer !== 'global'
      : CONFIG_SECTION_LAYERS[d.key] === 'policy'
  );
}

/** Assemble the emitted document — top scalars + every registered
 *  section, keys sorted so `check:config-schema` diffs meaningfully.
 *  `additionalProperties: true` at the root: external plugin configKeys
 *  can't be enumerated statically, and the unknown-key typo check stays
 *  doctor's job. */
export function configSchemaDocument(
  sections: Record<string, ConfigSection<unknown>> = {}
): JsonSchema {
  const properties = { ...TOP_LEVEL_JSON_SCHEMAS, ...jsonSchemasFor(sections) };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: CONFIG_SCHEMA_URL,
    title: 'bro.config',
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))
    ),
    additionalProperties: true,
  };
}
