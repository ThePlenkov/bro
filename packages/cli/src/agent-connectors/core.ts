/** Agent connector registry and public facade. Spawn mechanics live in spawn-harness.ts. */
import type { AgentConnector, ConnectorCtx } from '@broject/core';
import {
  loadAgentEnv,
  type AgentConnectorEnv,
  type AgentConnectorFactory,
} from './spawn-harness.ts';
import { makeNativeConnector } from './native.ts';
import { makeTmuxConnector } from './tmux.ts';
import { makeGascityConnector } from './gascity.ts';
import { makeDockerConnector } from './docker.ts';
import { makeCopilotConnector } from './copilot.ts';

export * from './spawn-harness.ts';
export type { AgentConnectorEnv, AgentConnectorFactory } from './spawn-harness.ts';

interface RegistryEntry {
  name: string;
  make: AgentConnectorFactory;
  builtin?: boolean;
  matchDir?: (dir: string, env: AgentConnectorEnv) => boolean;
  matchRemote?: (url: string, env: AgentConnectorEnv) => boolean;
}
const registry: RegistryEntry[] = [];

const builtinConnectors = {
  native: makeNativeConnector,
  tmux: makeTmuxConnector,
  gascity: makeGascityConnector,
  docker: makeDockerConnector,
  copilot: makeCopilotConnector,
} as const;
for (const [name, make] of Object.entries(builtinConnectors))
  registerAgentConnector(name, make, {}, { builtin: true });

export function registerAgentConnector(
  name: string,
  make: AgentConnectorFactory,
  matchers: Pick<RegistryEntry, 'matchDir' | 'matchRemote'> = {},
  opts: { builtin?: boolean } = {}
): (() => void) | undefined {
  if (registry.some(entry => entry.name === name)) {
    console.error(`warning: agent connector "${name}" already registered — skipped`);
    return undefined;
  }
  const entry: RegistryEntry = { name, make, ...matchers, builtin: opts.builtin === true };
  registry.push(entry);
  return () => {
    const index = registry.indexOf(entry);
    if (index >= 0) registry.splice(index, 1);
  };
}
export function unregisterAgentConnector(name: string): void {
  const entry = registry.find(item => item.name === name);
  if (entry?.builtin === true) {
    console.error(`warning: agent connector "${name}" is built-in — unregister skipped`);
    return;
  }
  if (entry !== undefined) registry.splice(registry.indexOf(entry), 1);
}
export function agentConnectorNames(): string[] {
  return registry.map(entry => entry.name);
}
export function eachAgentConnector(
  ctx: ConnectorCtx,
  env: AgentConnectorEnv = loadAgentEnv(ctx.dir),
  onFactoryError?: (name: string, error: unknown) => void
): AgentConnector[] {
  return registry.flatMap(entry => {
    try {
      return [entry.make(ctx, env)];
    } catch (error) {
      if (onFactoryError === undefined) throw error;
      onFactoryError(entry.name, error);
      return [];
    }
  });
}
export function resolveAgentConnector(
  ctx: ConnectorCtx,
  opts: { connector?: string } = {},
  env: AgentConnectorEnv = loadAgentEnv(ctx.dir)
): AgentConnector {
  const prefer = opts.connector ?? env.connectors.agents;
  const entry =
    prefer === undefined
      ? registry.find(item => item.matchDir?.(ctx.dir, env) ?? true)
      : registry.find(item => item.name === prefer);
  if (entry === undefined) {
    throw new Error(
      `agent connector "${prefer ?? ''}" is not registered (known: ${agentConnectorNames().join(', ') || 'none'})`
    );
  }
  return entry.make(ctx, env);
}

export { makeNativeConnector };
export { makeTmuxConnector };
export { makeGascityConnector } from './gascity.ts';
