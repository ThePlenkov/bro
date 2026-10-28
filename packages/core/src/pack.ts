/**
 * Pack manifest schema + parsing + composition (spec: specs/distro/bro-5phkq.md)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardProblems, type Guard } from './guards.ts';
import { parseProviderEntry, isEnvName, type ProviderEntry } from './providers.ts';

export interface PackRequires {
  bro?: string;
}

export interface PackManifest {
  $schema?: string;
  name: string;
  version: string;
  requires?: PackRequires;
  skills?: string[];
  formulas?: string[];
  guards?: Guard[];
  providers?: Record<string, ProviderEntry>;
  hooks?: Array<{
    event: string;
    command: string;
    timeoutMs?: number;
    failOpen?: boolean;
  }>;
  [k: string]: unknown;
}

export interface PackParseError {
  ok: false;
  error: string;
}

export interface PackParseOk {
  ok: true;
  manifest: PackManifest;
}

export type PackParseResult = PackParseOk | PackParseError;

const CREDENTIAL_PATTERNS = [
  /sk-[A-Za-z0-9]/,
  /ts_(?:live|test)_/,
  /Bearer\s/i,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
];

function looksLikeCredential(v: string): boolean {
  for (const re of CREDENTIAL_PATTERNS) {
    if (re.test(v)) return true;
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseProviderEntryStrict(
  name: string,
  raw: unknown
): { ok: true; entry: ProviderEntry } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `providers.${name} must be an object` };
  }
  // Reject unknown fields
  const allowed = new Set([
    'type',
    'baseUrl',
    'model',
    'apiKeyEnv',
    'apiKeyCommand',
    'models',
    'command',
    'profile',
    'sessionRm',
    'autoApprove',
  ]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `providers.${name}.${k} is not allowed` };
    }
  }
  // Screen for credentials
  if (typeof (raw as any).apiKeyEnv === 'string') {
    const v = (raw as any).apiKeyEnv;
    if (!isEnvName(v)) {
      return {
        ok: false,
        error: `providers.${name}.apiKeyEnv must NAME an env var (SCREAMING_SNAKE)`,
      };
    }
    if (looksLikeCredential(v)) {
      return {
        ok: false,
        error: `providers.${name}.apiKeyEnv must not contain a credential value`,
      };
    }
  }
  if (typeof (raw as any).apiKeyCommand === 'string') {
    const v = (raw as any).apiKeyCommand;
    if (looksLikeCredential(v)) {
      return {
        ok: false,
        error: `providers.${name}.apiKeyCommand must not contain a credential value`,
      };
    }
  }
  const entry = parseProviderEntry(name, raw);
  if (entry === null) {
    return { ok: false, error: `providers.${name} is invalid` };
  }
  return { ok: true, entry };
}

export function parsePack(raw: unknown): PackParseResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'pack.json must be an object' };
  }
  const name = (raw as any).name;
  const version = (raw as any).version;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'pack.json name is required' };
  }
  if (typeof version !== 'string' || version.trim() === '') {
    return { ok: false, error: 'pack.json version is required' };
  }

  const manifest: PackManifest = {
    ...(raw as any),
    name: name.trim(),
    version: version.trim(),
  };

  // Validate guards strictly
  if (Array.isArray((raw as any).guards)) {
    for (let i = 0; i < (raw as any).guards.length; i++) {
      const probs = guardProblems((raw as any).guards[i]);
      if (probs.length > 0) {
        return { ok: false, error: `guards[${i}]: ${probs[0]}` };
      }
    }
  }

  // Validate providers strictly
  if (isPlainObject((raw as any).providers)) {
    const providers: Record<string, ProviderEntry> = {};
    for (const [pname, pval] of Object.entries((raw as any).providers)) {
      const res = parseProviderEntryStrict(pname, pval);
      if (!res.ok) {
        return res;
      }
      providers[pname] = res.entry;
    }
    manifest.providers = providers;
  }

  // Validate hooks shape
  if (Array.isArray((raw as any).hooks)) {
    for (let i = 0; i < (raw as any).hooks.length; i++) {
      const h = (raw as any).hooks[i];
      if (!isPlainObject(h) || typeof h.event !== 'string' || typeof h.command !== 'string') {
        return { ok: false, error: `hooks[${i}] must have event and command` };
      }
    }
  }

  return { ok: true, manifest };
}

export function readPackManifest(packDir: string): PackParseResult {
  const manifestPath = join(packDir, 'pack.json');
  if (!existsSync(manifestPath)) {
    // legacy - return ok with minimal manifest?
    return { ok: false, error: 'pack.json not found' };
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return parsePack(raw);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
