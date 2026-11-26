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

interface FileContent {
  path: string;
  content: string;
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

function writeAtomic(file: FileContent): void {
  mkdirSync(dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.tmp`;
  writeFileSync(temporary, file.content, 'utf8');
  renameSync(temporary, file.path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function existingAgent(existing: Record<string, unknown>): Record<string, unknown> {
  return isRecord(existing.agent) ? existing.agent : {};
}

function readConfig(file: ConfigFile): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file.path, 'utf8'));
    if (!isRecord(parsed)) return {};
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`cannot merge Devin config ${file.path}: ${(error as Error).message}`);
  }
}

function mergeDefaultModel(file: DefaultModel): void {
  const existing = readConfig(file);
  writeAtomic({
    path: file.path,
    content: `${JSON.stringify(
      { ...existing, agent: { ...existingAgent(existing), subagent_model: file.model } },
      null,
      2
    )}\n`,
  });
}

function validProfile(entry: ProfileEntry): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) return false;
  if (typeof entry.profile.model !== 'string') return false;
  return entry.profile.model.trim() !== '';
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
  const written: string[] = [];
  const profiles = config.profiles ?? config.subagents ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (!validProfile({ name, profile })) {
      throw new Error(`invalid Devin subagent profile: ${name}`);
    }
    const path = join(home, '.config', 'devin', 'agents', `${name}.md`);
    writeAtomic({ path, content: profileText(profile) });
    written.push(path);
  }
  const model = defaultModel(config);
  if (model !== undefined) {
    const path = join(home, '.config', 'devin', 'config.json');
    mergeDefaultModel({ path, model });
    written.push(path);
  }
  return written;
}
