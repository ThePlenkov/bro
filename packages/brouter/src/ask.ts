/**
 * `brouter ask` — one question to an ACP agent, the answer printed.
 *
 * The protocol is the binding's: `acpConverse` runs initialize →
 * session/new → model pin → prompt → pump and hands back the agent's
 * text. brouter adds the CLI around it — the provider's name, the
 * deadline, the shape of the answer.
 */
import { getProvider, loadConfig, type ProviderEntry } from '@broject/core';
import { acpConverse } from '@broject/providers';

/** The ask request. */
export interface AskRequest {
  /** the provider entry — absent resolves to the first acp entry */
  provider?: string;
  /** the question */
  question: string;
  /** the model to pin — the entry's own pin when absent */
  model?: string;
  /** the round-trip budget */
  timeoutMs?: number;
  /** the working directory of the session */
  cwd?: string;
}

/** What the agent answered. */
export interface AskOutcome {
  provider: string;
  model: string;
  stopReason: string;
  text: string;
}

/** The acp entries, in config order. */
export function acpProviders(dir: string): string[] {
  const providers = loadConfig(dir).providers ?? {};
  return Object.entries(providers)
    .filter(([, entry]) => entry.type === 'acp')
    .map(([name]) => name);
}

/** The provider an ask runs against — the named one, else the first
 *  acp entry. An unknown name is an error naming the known ones. */
export function resolveProvider(dir: string, name?: string): string {
  const configured = loadConfig(dir).providers ?? {};
  if (name !== undefined && name.trim() !== '') {
    const wanted = name.trim();
    const entry = configured[wanted];
    if (entry === undefined) {
      throw new Error(
        `unknown provider "${wanted}" — configured: ${Object.keys(configured).join(', ') || 'none'}`
      );
    }
    if (entry.type !== 'acp') {
      throw new Error(`provider "${wanted}" is a ${entry.type} entry — ask needs an acp one`);
    }
    return wanted;
  }
  const first = acpProviders(dir)[0];
  if (first === undefined) {
    throw new Error('no acp provider configured — add providers.<name> to bro.config.json');
  }
  return first;
}

/** The entry behind a provider name — an acp one, always. */
export function acpEntry(dir: string, name: string): Extract<ProviderEntry, { type: 'acp' }> {
  const entry = getProvider(loadConfig(dir).providers ?? {}, name);
  if (entry.type !== 'acp') {
    throw new Error(
      `provider "${name}" is a ${entry.type} entry — the acp clients need an acp one`
    );
  }
  return entry;
}

/** Ask one question. */
export async function runAsk(request: AskRequest, dir: string): Promise<AskOutcome> {
  const provider = resolveProvider(dir, request.provider);
  const entry = acpEntry(dir, provider);
  const timeoutMs = request.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const result = await acpConverse(
    provider,
    entry,
    {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.cwd === undefined ? {} : { acp: { cwd: request.cwd } }),
    },
    request.question,
    () => undefined,
    deadline
  );
  return {
    provider,
    model: result.model,
    stopReason: result.stopReason,
    text: result.text,
  };
}
