/** The mutation gate — a leaf module so ANY command file can gate a
 *  claim without importing the plugin registry (plugins.ts → commands →
 *  work.ts would TDZ-crash — see plugins.ts's workConnector note).
 *  plugins.ts registers its merged section list here at module init;
 *  until then the gate validates core + caller-supplied sections only. */
import {
  configPolicyErrors,
  type ConfigDiagnostic,
  type ConfigSection,
} from '@broject/core'

let policySections: () => Record<string, ConfigSection<unknown>> = () => ({})

export function registerPolicySections(
  fn: () => Record<string, ConfigSection<unknown>>
): void {
  policySections = fn
}

/** Invalid *policy* config refused a mutation — the audit's
 *  "authoritative paths validate before side effects". Carries the
 *  diagnostics so the caller renders paths + layers, not a summary. */
export class ConfigPolicyError extends Error {
  readonly diagnostics: ConfigDiagnostic[]
  constructor(diagnostics: [ConfigDiagnostic, ...ConfigDiagnostic[]]) {
    const first = diagnostics[0]
    super(
      `invalid ${first.layer} config — ${first.path}: ${first.message} (${first.file})` +
        (diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : '') +
        '\nfix the config or set BRO_CONFIG_FORCE=1 to proceed anyway'
    )
    this.name = 'ConfigPolicyError'
    this.diagnostics = diagnostics
  }
}

/** Fail-closed gate for authoritative mutations (spawn claims, queue
 *  claims): policy sections are the committed config everyone shares,
 *  so an invalid value there is refused BEFORE the side effect.
 *  Operator sections (providers/fleet/agents/…) warn via doctor but
 *  never gate — they're machine-local by definition. Hooks and
 *  read-only paths never call this. `BRO_CONFIG_FORCE=1` is the
 *  deliberate escape hatch (spec: specs/bro-d9dmx.md). */
export function assertMutableConfig(dir: string): void {
  if (process.env.BRO_CONFIG_FORCE === '1') {
    return
  }
  const errors = configPolicyErrors(dir, policySections())
  if (errors.length > 0) {
    throw new ConfigPolicyError(errors as [ConfigDiagnostic, ...ConfigDiagnostic[]])
  }
}
