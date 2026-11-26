import { homedir } from 'node:os';
import { join } from 'node:path';
import { ioRead, ioWriteAtomic } from './io.ts';

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

interface ProfileEntry {
  name: string;
  profile: DevinSubagentProfile;
}

interface ConfigFile {
  path: string;
}

interface DefaultModel {
  path: string;
  model: string;
}

function profileText(profile: DevinSubagentProfile): string {
  const tools =
    profile.tools === undefined
      ? ''
      : `tools:\n${profile.tools.map(tool => `  - ${tool}`).join('\n')}\n`;
  return `---\nmodel: ${profile.model}\n${tools}---\n${profile.prompt ?? ''}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function existingAgent(existing: Record<string, unknown>): Record<string, unknown> {
  return isRecord(existing.agent) ? existing.agent : {};
}

function readConfig(root: string, file: ConfigFile): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(ioRead(root, file.path));
    if (!isRecord(parsed)) return {};
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`cannot merge Devin config ${file.path}: ${(error as Error).message}`);
  }
}

function mergeDefaultModel(root: string, file: DefaultModel): void {
  const existing = readConfig(root, file);
  ioWriteAtomic(
    root,
    file.path,
    `${JSON.stringify(
      { ...existing, agent: { ...existingAgent(existing), subagent_model: file.model } },
      null,
      2
    )}\n`
  );
}

function validProfile(entry: ProfileEntry): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) return false;
  if (!isRecord(entry.profile) || typeof entry.profile.model !== 'string') return false;
  if (entry.profile.model.trim() === '') return false;
  if (entry.profile.prompt !== undefined && typeof entry.profile.prompt !== 'string') return false;
  return (
    entry.profile.tools === undefined ||
    (Array.isArray(entry.profile.tools) &&
      entry.profile.tools.every(tool => typeof tool === 'string'))
  );
}

function defaultModel(config: DevinSubagentConfig): string | undefined {
  if (typeof config.subagent_model !== 'string') return undefined;
  if (config.subagent_model.trim() === '') return undefined;
  return config.subagent_model;
}

/** Write the Devin CLI files described by bro's `agents.devin` settings.
 * Existing profile files are intentionally replaced (they are bro-owned
 * materializations); unrelated Devin config keys are merged and retained. */
export function materializeDevinSubagents(options: DevinMaterializeOptions): string[] {
  const { config } = options;
  const home = options.home ?? homedir();
  const root = home;
  const written: string[] = [];
  const profiles = config.profiles ?? config.subagents ?? {};
  const entries = Object.entries(profiles);
  for (const [name, profile] of entries) {
    if (!validProfile({ name, profile })) {
      throw new Error(`invalid Devin subagent profile: ${name}`);
    }
  }
  for (const [name, profile] of entries) {
    const path = join(home, '.config', 'devin', 'agents', `${name}.md`);
    ioWriteAtomic(root, path, profileText(profile));
    written.push(path);
  }
  const model = defaultModel(config);
  if (model !== undefined) {
    const path = join(home, '.config', 'devin', 'config.json');
    mergeDefaultModel(root, { path, model });
    written.push(path);
  }
  return written;
}
