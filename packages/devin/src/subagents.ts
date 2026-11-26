import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DevinSubagentProfile {
  model: string;
  tools?: string[];
  prompt?: string;
}

export interface DevinSubagentConfig {
  subagent_model?: string;
  profiles?: Record<string, DevinSubagentProfile>;
  subagents?: Record<string, DevinSubagentProfile>;
}

export interface DevinMaterializeOptions {
  config: DevinSubagentConfig;
  home?: string;
}

function profileText(profile: DevinSubagentProfile): string {
  const tools =
    profile.tools === undefined
      ? ''
      : `tools:\n${profile.tools.map(tool => `  - ${tool}`).join('\n')}\n`;
  return `---\nmodel: ${profile.model}\n${tools}---\n${profile.prompt ?? ''}\n`;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

function mergeDefaultModel(path: string, model: string): void {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot merge Devin config ${path}: ${(error as Error).message}`);
    }
  }
  const agent =
    typeof existing.agent === 'object' && existing.agent !== null && !Array.isArray(existing.agent)
      ? (existing.agent as Record<string, unknown>)
      : {};
  writeAtomic(
    path,
    `${JSON.stringify({ ...existing, agent: { ...agent, subagent_model: model } }, null, 2)}\n`
  );
}

/** Write the Devin CLI files described by bro's `agents.devin` settings.
 * Existing profile files are intentionally replaced (they are bro-owned
 * materializations); unrelated Devin config keys are merged and retained. */
export function materializeDevinSubagents(options: DevinMaterializeOptions): string[] {
  const { config } = options;
  const home = options.home ?? homedir();
  const written: string[] = [];
  const profiles = config.profiles ?? config.subagents ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ||
      typeof profile.model !== 'string' ||
      profile.model.trim() === ''
    ) {
      throw new Error(`invalid Devin subagent profile: ${name}`);
    }
    const path = join(home, '.config', 'devin', 'agents', `${name}.md`);
    writeAtomic(path, profileText(profile));
    written.push(path);
  }
  if (typeof config.subagent_model === 'string' && config.subagent_model.trim() !== '') {
    const path = join(home, '.config', 'devin', 'config.json');
    mergeDefaultModel(path, config.subagent_model);
    written.push(path);
  }
  return written;
}
