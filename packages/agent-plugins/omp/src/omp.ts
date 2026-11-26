/**
 * bro as an omp extension — the board on omp's TUI, plus the same
 * lifecycle mechanics the shell adapters carry, over omp's in-process
 * extension API.
 *
 * ## Why omp gets its own adapter
 *
 * omp is not pi. The extension *shape* is the same (`pi.on`,
 * `registerCommand`, `registerTool`), but the vocabulary is not, and
 * the differences are the interesting part:
 *
 *   - **omp has a native stop gate.** `session_stop` accepts
 *     `{ decision: "block", reason }` and re-fires with
 *     `stop_hook_active: true` — exactly bro's one-shot gate contract,
 *     with the host enforcing it. pi had to fake it with
 *     `agent_before_settle` plus a hand-rolled continuation, and
 *     opencode had to re-prompt as a synthetic turn. Here bro's
 *     `decision: "block"` maps straight onto the host's own slot, and
 *     the host's `stop_hook_active` flag goes straight back into bro's
 *     hook payload.
 *
 *   - **omp's modes are native.** Plan, Goal, Vibe, Prewalk and Advisor
 *     all exist in omp already. bro does not reimplement them — bro is
 *     the *state plane* they run over, not a second set of modes. The
 *     wiring below is deliberately thin: bro's durable state (beads,
 *     claims, PR gates) is injected into the session, and the modes
 *     keep their own semantics.
 *
 *   - **omp's widget slot takes plain strings.** `ctx.ui.setWidget`
 *     accepts `string[]`, which is all the board needs.
 *
 * ## The bro surfaces
 *
 *   board     `bro status --json` → ctx.ui.setWidget + setStatus,
 *             refreshed on session start, turn end and after a gate.
 *   hooks     omp lifecycle events → `bro hooks <event>` with the
 *             payload on stdin — the same contract hooks/run.sh and the
 *             other adapters speak. The control object on stdout is
 *             translated into omp's own result slots.
 *   /bro      the CLI without leaving the editor.
 *   bro_* tools  the board and the PR gate as model-callable reads.
 *
 * ## Fail-open
 *
 * The whole contract: the CLI resolves lazily (sibling dist → checkout
 * → PATH → npx pin), every spawn is async, and a missing bro or a
 * non-bro repo yields no widget, no context, no gate — never an error
 * thrown into omp.
 */
import {
  BOARD_KEY,
  type BroHostBinding,
  createBroDriver,
  sharedBinding,
} from '@broject/adapter-core/host';
import type { OmpApi, OmpContext } from './omp-api.ts';
import { installOmpSupervision, OMP_SUPERVISION_HOST } from './omp-supervision.ts';
import { installModeBridges } from './omp-modes.ts';

/** The published version of this adapter — the npx fallback pin. The
 *  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = '@broject/bro@0.3.0';
const JSON_FLAG = '--json';
const PREWALK_KIND = 'prewalk';
const FLEET_COMMAND = 'fleet';
const STATUS_COMMAND = 'status';
const DEBT_COMMAND = 'debt';
const NEXT_COMMAND = 'next';

/**
 * The omp binding: the host's own shape, nothing else. Every
 * behavioral decision lives in the shared driver, so this file is the
 * whole of "what is different about omp". The API is captured in the
 * closure — a module-level variable would leak one session's host into
 * another's.
 */
function binding(pi: OmpApi): BroHostBinding<OmpContext> {
  return {
    ...sharedBinding<OmpContext>({
      kind: 'omp',
      npxPin: NPX_PIN,
      // omp owns `/goal` (goal mode lifecycle) and `/loop` (count/
      // duration/--while/--until iteration) natively — verified against
      // the 18.x binary's usage strings. The bro aliases for those two
      // register as `bro:goal`/`bro:loop`; the rest of the family gets
      // bare names (no native `/act|wtf|retro|learn|drill|judge` found).
      nativeCommands: ['goal', 'loop'],
      stop: 'session_stop',
      on(event, handler) {
        pi.on(event, handler);
      },
      paint(ctx, lines, crumb) {
        ctx.ui.setWidget(BOARD_KEY, lines);
        ctx.ui.setStatus(BOARD_KEY, crumb);
      },
      notify(ctx, text, level) {
        ctx.ui.notify(text, level);
      },
      refuseStop(reason) {
        // omp's native stop refusal: the reason is handed back to the
        // model, which continues the turn with the blocker in hand.
        return { decision: 'block' as const, reason };
      },
      stopAlreadyRefused(event) {
        const stop = event as { stop_hook_active?: boolean };
        return stop.stop_hook_active === true;
      },
    }),
  };
}

/** JSON-schema → zod for the parameter shapes the shared driver
 *  declares. Unknown/unsupported nodes degrade to `z.any()` — a loose
 *  schema still validates, a wrong guess would reject real params. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function schemaToZod(schema: unknown, z: NonNullable<OmpApi['zod']>): unknown {
  if (!isPlainRecord(schema)) {
    return z.any();
  }
  // already a schema-builder product (safeParse is zod's tell)
  if (typeof (schema as { safeParse?: unknown }).safeParse === 'function') {
    return schema;
  }
  if (Array.isArray(schema.enum) && schema.enum.every(v => typeof v === 'string')) {
    return z.enum(schema.enum as string[]);
  }
  return zodForType(schema, z);
}

function zodForType(s: Record<string, unknown>, z: NonNullable<OmpApi['zod']>): unknown {
  switch (s.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(schemaToZod(s.items, z));
    case 'object':
      return zodObject(s, z);
    default:
      return z.any();
  }
}

function zodObject(s: Record<string, unknown>, z: NonNullable<OmpApi['zod']>): unknown {
  const props = isPlainRecord(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const shape: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(props)) {
    const built = schemaToZod(sub, z) as { optional?: () => unknown };
    shape[key] = required.has(key) ? built : (built?.optional?.() ?? built);
  }
  return z.object(shape);
}

/** omp's registerTool wants a schema-builder product for `parameters`
 *  (zod/arktype/typebox — raw JSON schema is dropped silently, which is
 *  how bro_status went missing from the model's tool list) and reads
 *  omp-native `loadMode`/`approval` policy fields the shared hints
 *  carry. Everything else passes through verbatim. */
function adaptApiForOmp(pi: OmpApi): OmpApi {
  const z = pi.zod;
  if (z === undefined) {
    return pi;
  }
  // Proxy, not spread: the api's methods live on the prototype — a
  // shallow copy would drop them, and unbound calls would lose `this`.
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (tool: Parameters<OmpApi['registerTool']>[0]) =>
          target.registerTool({ ...tool, parameters: schemaToZod(tool.parameters, z) });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The extension entry point — omp calls this with its API. */
export default function broExtension(pi: OmpApi): void {
  // Child bro commands inherit this capability marker. The facade still
  // falls back safely when a shell is launched outside this extension.
  process.env.BRO_SUPERVISION_HOST = OMP_SUPERVISION_HOST;
  installOmpSupervision(pi);
  const api = adaptApiForOmp(pi);
  const driver = createBroDriver(binding(api), api);

  /** The mode bridges — bro's durable state handed to omp's native Plan,
   *  Goal and Vibe modes. See omp-modes.ts for why bro adds state
   *  rather than a second implementation of each mode. */
  installModeBridges(pi, {
    board: () => driver.board,
    async modeContext(kind, cwd) {
      const args =
        kind === PREWALK_KIND
          ? [FLEET_COMMAND, STATUS_COMMAND, JSON_FLAG]
          : [DEBT_COMMAND, NEXT_COMMAND, JSON_FLAG];
      const result = await driver.run(args, cwd);
      if (result.code !== 0 || result.stdout.trim() === '') {
        return null;
      }
      const label = kind === PREWALK_KIND ? 'provider routing' : 'review debt';
      return `bro ${label} (read-only):\n${result.stdout.trim()}`;
    },
  });
}

/**
 * Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
 * foreign file holding this slot; the marker survives generation into
 * integrations/omp/bro.ts.
 */
export const adapter = { id: 'bro', kind: 'omp-extension' } as const; // NOSONAR typescript:S7734 — the sentinel is a published marker, not a second entry point
