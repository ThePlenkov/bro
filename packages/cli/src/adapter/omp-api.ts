/**
 * The structural omp surface.
 *
 * Declared, never imported — the shipped plugin is loaded by omp at
 * runtime, and a dependency on `@oh-my-pi/pi-coding-agent` would drag
 * omp's whole type tree into this repo for fidelity omp itself
 * guarantees. Field names are verbatim; upstream is the only place they
 * should change. (Same convention as the pi and opencode adapters.)
 */
import type { BroContext } from './host.ts'

/** A UI notification level. */
export type OmpLevel = 'info' | 'warning' | 'error'

/** The UI surface an extension may touch. */
export interface OmpUi {
  notify(message: string, type?: OmpLevel): void
  setStatus(key: string, text: string | undefined): void
  setWidget(key: string, content: string[] | undefined): void
}

/** The session reader — the id is what bro's markers are keyed by. */
export interface OmpSessionReader {
  getSessionId(): string | undefined
}

/** The context every handler receives — the lineage's shape, spelled
 *  out here so the shipped plugin carries no import of its own. */
export interface OmpContext extends BroContext {
  ui: OmpUi
  sessionManager: OmpSessionReader
}

/** A tool result — the content blocks the model reads. */
export interface OmpToolResult {
  content: Array<{ type: 'text'; text: string }>
}

/** A tool definition. */
export interface OmpToolDefinition {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: OmpContext
  ): Promise<OmpToolResult>
}

/** The extension API omp hands to a plugin factory. */
export interface OmpApi {
  on(event: string, handler: (event: unknown, ctx: OmpContext) => unknown): void
  registerCommand(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: OmpContext) => Promise<void> | void
    }
  ): void
  registerTool(tool: OmpToolDefinition): void
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
  ): void
}
