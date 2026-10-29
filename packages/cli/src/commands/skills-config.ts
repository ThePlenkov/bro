/**
 * `skills` config section for `bro skills` — a leaf module so plugins.ts
 * can register the schema at load time without cycling through
 * skills.ts (which needs plugins.ts's loadBroConfig at run time).
 */
import { js, type ConfigSection } from '@broject/core';

export interface SkillsConfig {
  /** Source descriptors — `github:<owner>/<repo>[/<path>]`, bare
   *  `<owner>/<repo>`, `https://` URLs, `local:<relpath>`/`./<path>`.
   *  Parsed by parseSkillSource in skills.ts; non-string entries are
   *  kept (not dropped) so the command surfaces them as error rows —
   *  a config that silently normalizes to nothing reports success. */
  install: unknown[];
  /** `skills add -a` link targets. Default ['universal'] — the
   *  `.agents/skills/` plane only, no per-agent link farm. */
  agents: string[];
  /** Explicit skills CLI (path or PATH command) — skips resolution. */
  bin?: string;
}

const DEFAULT_AGENTS = ['universal'];

/** Non-empty strings of an array field — non-string entries warn and
 *  drop (a config value that normalizes to nothing is the defect the
 *  operator should see, never a silent skip). */
function strList(obj: Record<string, unknown>, key: string): string[] | undefined {
  const raw = obj[key];
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    console.error(`bro.config: skills.${key} must be a string array — got ${JSON.stringify(raw)}`);
    return undefined;
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      out.push(entry.trim());
    } else {
      console.error(
        `bro.config: skills.${key} entry dropped — not a non-empty string: ${JSON.stringify(entry)}`
      );
    }
  }
  return out;
}

/** `skills.install` keeps every entry — strings trimmed, non-strings
 *  and a non-array value preserved verbatim so parseSkillSource turns
 *  them into error rows the operator sees, never a silent skip. */
function installList(obj: Record<string, unknown>): unknown[] {
  const raw = obj.install;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [raw];
  }
  return raw.map(e => (typeof e === 'string' ? e.trim() : e)).filter(e => e !== '');
}

/** bro.config.json `skills` section — bad values warn and fall back,
 *  never crash the load. */
export const skillsSection: ConfigSection<SkillsConfig> = raw => {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    install: installList(obj),
    agents: strList(obj, 'agents') ?? DEFAULT_AGENTS,
    ...(typeof obj.bin === 'string' && obj.bin.trim() !== '' ? { bin: obj.bin.trim() } : {}),
  };
};

skillsSection.jsonSchema = js.obj({
  install: js.strList,
  agents: js.strList,
  bin: js.str,
});
