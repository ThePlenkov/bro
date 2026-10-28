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

const PROVIDER_ALLOWED_KEYS = new Set([
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

function checkProviderUnknownKeys(name: string, raw: Record<string, unknown>): string | null {
  for (const k of Object.keys(raw)) {
    if (!PROVIDER_ALLOWED_KEYS.has(k)) {
      return `providers.${name}.${k} is not allowed`;
    }
  }
  return null;
}

function checkProviderApiKeyEnv(name: string, raw: Record<string, unknown>): string | null {
  if (typeof raw.apiKeyEnv !== 'string') return null;
  const v = raw.apiKeyEnv;
  if (!isEnvName(v)) {
    return `providers.${name}.apiKeyEnv must NAME an env var (SCREAMING_SNAKE)`;
  }
  if (looksLikeCredential(v)) {
    return `providers.${name}.apiKeyEnv must not contain a credential value`;
  }
  return null;
}

function checkProviderApiKeyCommand(name: string, raw: Record<string, unknown>): string | null {
  if (typeof raw.apiKeyCommand !== 'string') return null;
  const v = raw.apiKeyCommand;
  if (looksLikeCredential(v)) {
    return `providers.${name}.apiKeyCommand must not contain a credential value`;
  }
  return null;
}

function parseProviderEntryStrict(
  name: string,
  raw: unknown
): { ok: true; entry: ProviderEntry } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `providers.${name} must be an object` };
  }
  const r = raw as Record<string, unknown>;
  const unknownErr = checkProviderUnknownKeys(name, r);
  if (unknownErr) return { ok: false, error: unknownErr };
  const envErr = checkProviderApiKeyEnv(name, r);
  if (envErr) return { ok: false, error: envErr };
  const cmdErr = checkProviderApiKeyCommand(name, r);
  if (cmdErr) return { ok: false, error: cmdErr };
  const entry = parseProviderEntry(name, raw);
  if (entry === null) {
    return { ok: false, error: `providers.${name} is invalid` };
  }
  return { ok: true, entry };
}

function validateGuards(rawGuards: unknown): PackParseResult | null {
  if (!Array.isArray(rawGuards)) return null;
  for (let i = 0; i < rawGuards.length; i++) {
    const probs = guardProblems(rawGuards[i]);
    if (probs.length > 0) {
      return { ok: false, error: `guards[${i}]: ${probs[0]}` };
    }
  }
  return null;
}

function validateProviders(
  rawProviders: unknown
): { ok: true; providers: Record<string, ProviderEntry> } | PackParseError {
  if (!isPlainObject(rawProviders)) {
    return { ok: true, providers: {} as Record<string, ProviderEntry> };
  }
  const providers: Record<string, ProviderEntry> = {};
  for (const [pname, pval] of Object.entries(rawProviders)) {
    const res = parseProviderEntryStrict(pname, pval);
    if (!res.ok) {
      return res;
    }
    providers[pname] = res.entry;
  }
  return { ok: true, providers };
}

function validateHooks(rawHooks: unknown): PackParseResult | null {
  if (!Array.isArray(rawHooks)) return null;
  for (let i = 0; i < rawHooks.length; i++) {
    const h = rawHooks[i];
    if (!isPlainObject(h)) return { ok: false, error: `hooks[${i}] must have event and command` };
    const ho = h as Record<string, unknown>;
    if (typeof ho.event !== 'string' || typeof ho.command !== 'string') {
      return { ok: false, error: `hooks[${i}] must have event and command` };
    }
  }
  return null;
}

export function parsePack(raw: unknown): PackParseResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'pack.json must be an object' };
  }
  const r = raw as Record<string, unknown>;
  const name = r.name;
  const version = r.version;
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

  const guardRes = validateGuards(r.guards);
  if (guardRes) return guardRes;

  const provRes = validateProviders(r.providers);
  if (!provRes.ok) return provRes;
  if (r.providers && isPlainObject(r.providers)) {
    manifest.providers = provRes.providers;
  }

  const hookRes = validateHooks(r.hooks);
  if (hookRes) return hookRes;

  return { ok: true, manifest };
}

export function readPackManifest(packDir: string): PackParseResult {
  const manifestPath = join(packDir, 'pack.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, error: 'pack.json not found' };
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return parsePack(raw);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
