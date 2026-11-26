// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

//#region packages/agent-plugins/adapter-core/src/core.ts
/** How long a normal hook probe may take. */
const HOOK_TIMEOUT_MS = 15e3;
/** session-start/post-compaction list `bd ready` and scan worktrees —
*  measured at 20-40s in a loaded repo. */
const REHYDRATION_TIMEOUT_MS = 45e3;
/** Cap on a hook's stdout — a runaway child must not eat the heap. */
const MAX_OUTPUT = 1 << 20;
/** A hung CLI must not wedge an adapter: `/bro`, `bro_status` and the
*  bro tool are interactive reads, and a wedged dolt lock can stall
*  them forever. The kill takes the detached process group down. */
const RUN_TIMEOUT_MS = 6e4;
/** How long a failed CLI resolution stays cached before a retry —
*  PATH, a local install or npx can appear mid-session, but
*  re-probing the npx rung on every keystroke would be worse than
*  the outage. */
const RESOLVE_RETRY_MS = 6e4;
const HOOKS_COMMAND = "hooks";
const STATUS_COMMAND = "status";
const JSON_FLAG = "--json";
const NPX_COMMAND = "npx";
const NPX_YES_FLAG = "-y";
const NPX_OFFLINE_FLAG = "--prefer-offline";
const BRO_MARKERS = [
	"bro.config.ts",
	"bro.config.json",
	"bro.config.local.ts",
	"bro.config.local.json",
	".beads"
];
/** The curated command family — first-class slash aliases for bro's
*  workflow verbs. `verb` is the CLI argv head; `name` is the slash
*  name, renamed to `bro:<name>` when the host owns it natively
*  (AGT-1 §command family — a host-native command always wins).
*  `/wtf` passes any args through untouched — the wtf routine owns
*  multilingual frustration input itself. */
const BRO_COMMANDS = [
	{
		name: "act",
		verb: "act",
		description: "bro act — PR review gate, threads, resolve"
	},
	{
		name: "wtf",
		verb: "wtf",
		description: "bro wtf — frustration → retrospect capture, any language"
	},
	{
		name: "retro",
		verb: "retrospect",
		description: "bro retrospect — learn + backlog review"
	},
	{
		name: "learn",
		verb: "learn",
		description: "bro learn — lessons and backlog"
	},
	{
		name: "drill",
		verb: "drill",
		description: "bro drill — deep research routine, scoped investigation"
	},
	{
		name: "judge",
		verb: "judge",
		description: "bro judge — typed decision on session state"
	},
	{
		name: "loop",
		verb: "loop",
		description: "bro loop — iterations with exit condition or formula"
	},
	{
		name: "goal",
		verb: "goal",
		description: "bro goal — goal tracking, hooks remind every turn"
	}
];
/**
* `node` on PATH, not process.execPath — a host may ship as a compiled
* binary whose execPath IS that binary, so running it with our own
* entry script would re-enter the host instead of running the script.
*/
function jsRuntime() {
	return process.platform === "win32" ? "node.exe" : "node";
}
/** The bro CLI bundled next to this adapter (`dist/index.js`). */
function siblingCli() {
	for (const rel of ["./index.js", "../dist/index.js"]) {
		const candidate = fileURLToPath(new URL(rel, import.meta.url));
		if (existsSync(candidate)) return candidate;
	}
	return null;
}
/** The bro CLI of the checkout this adapter was loaded from — the
*  development path: the adapter's own source tree wins over any
*  published package, so a local edit is live without a rebuild. */
function checkoutCli() {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = join(dir, "packages", "cli", "dist", "index.js");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
/**
* SIGKILL a hung child on a timer. The child is spawned detached, so
* killing the pid's group takes the grandchildren down too — a hook
* that spawns `bd` must not leave a dolt server behind.
*/
function killAfter(child, ms, onTimeout) {
	const timer = setTimeout(() => {
		try {
			if (child.pid !== void 0) process.kill(-child.pid, "SIGKILL");
		} catch {
			try {
				child.kill("SIGKILL");
			} catch {}
		}
		onTimeout();
	}, ms);
	timer.unref?.();
	return timer;
}
/** Does this command exit zero? Used to probe whether a candidate CLI
*  actually speaks bro's hook protocol — an older bro on PATH fails the
*  probe instead of failing every hook. */
async function exitsZero(cmd, args) {
	const { promise, resolve } = Promise.withResolvers();
	let child;
	try {
		child = spawn(cmd, args, {
			stdio: [
				"pipe",
				"ignore",
				"ignore"
			],
			windowsHide: true,
			detached: process.platform !== "win32"
		});
	} catch {
		return false;
	}
	const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(false));
	child.on("error", () => {
		clearTimeout(timer);
		resolve(false);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		resolve(code === 0);
	});
	child.stdin?.on("error", () => {});
	child.stdin?.end("");
	return promise;
}
/**
* The CLI ladder, in order: the pinned command, the bundled sibling,
* the checkout's dist, `bro` on PATH, and finally the pinned npx
* package. Every tier is probed with `bro hooks` — the silent
* capability probe — so a tier that resolves to something that is not
* bro is skipped rather than failing every hook.
*/
async function resolveCommand(opts = {}) {
	return await pinnedCommand(opts.command) ?? await checkoutResolved() ?? await pathResolved() ?? await npxResolved(opts);
}
async function pinnedCommand(pinned) {
	if (typeof pinned === "string") return pinnedStringCommand(pinned);
	if (typeof pinned !== "object" || pinned === null) return null;
	const cmd = typeof pinned.cmd === "string" ? pinned.cmd : "";
	const args = Array.isArray(pinned.args) ? pinned.args.filter((a) => typeof a === "string") : [];
	return cmd !== "" && await exitsZero(cmd, [...args, "hooks"]) ? {
		cmd,
		args
	} : null;
}
async function pinnedStringCommand(pinned) {
	const [cmd, ...args] = pinned.split(/\s+/).filter((p) => p !== "");
	return cmd !== void 0 && await exitsZero(cmd, [...args, "hooks"]) ? {
		cmd,
		args
	} : null;
}
async function checkoutResolved() {
	for (const entry of [siblingCli(), checkoutCli()]) if (entry !== null && await exitsZero(jsRuntime(), [entry, "hooks"])) return {
		cmd: jsRuntime(),
		args: [entry]
	};
	return null;
}
async function pathResolved() {
	return await exitsZero("bro", ["hooks"]) ? {
		cmd: "bro",
		args: []
	} : null;
}
async function npxResolved(opts) {
	const specs = opts.npxSpecs ?? (opts.npxPin !== void 0 ? [opts.npxPin] : []);
	if (specs.length === 0 || !await exitsZero(NPX_COMMAND, ["--version"])) return null;
	for (const spec of specs) if (await exitsZero(NPX_COMMAND, [
		NPX_YES_FLAG,
		NPX_OFFLINE_FLAG,
		spec,
		HOOKS_COMMAND
	])) return {
		cmd: NPX_COMMAND,
		args: [
			NPX_YES_FLAG,
			NPX_OFFLINE_FLAG,
			spec
		]
	};
	return null;
}
/**
* The env an in-process adapter stamps on its `bro hooks` spawn so the
* CLI's adapter emit path can journal the session into the hook spool
* (specs/bro-izpyk.9.md): `BRO_HOOK_HOST` is the ledger host name (and
* the launch marker — presence means "direct adapter call, no run.sh"),
* `BRO_HOOK_PROOT` this module's own directory (the installed plugin
* root), `BRO_HOOK_ADAPTER` the adapter version parsed off the npx pin.
* A CLI that predates the marker ignores the env — rollout is safe in
* both directions.
*/
function hookEmitEnv(kind, opts = {}) {
	const env = {
		BRO_HOOK_HOST: kind,
		BRO_HOOK_PROOT: dirname(fileURLToPath(import.meta.url))
	};
	const at = opts.npxPin?.lastIndexOf("@") ?? -1;
	if (opts.npxPin !== void 0 && at > 0) env.BRO_HOOK_ADAPTER = opts.npxPin.slice(at + 1);
	return env;
}
async function callHook(command, call) {
	return (await callHookDetailed(command, call)).control;
}
/**
* callHook with the failure class attached. The stop gate needs to tell
* "bro had nothing to say" apart from "bro could not answer": both are
* fail-open, but the second must not pass invisibly. A clean exit with
* empty stdout is silence (failure null) — only real outage kinds set it.
*/
async function callHookDetailed(command, call) {
	const { event, payload, cwd, timeoutMs, extraEnv } = call;
	let input;
	try {
		input = JSON.stringify(payload);
	} catch {
		return {
			control: null,
			failure: { kind: "input" }
		};
	}
	if (input === void 0) return {
		control: null,
		failure: { kind: "input" }
	};
	const { promise, resolve } = Promise.withResolvers();
	let child;
	try {
		child = spawn(command.cmd, [
			...command.args,
			HOOKS_COMMAND,
			event
		], {
			cwd,
			env: extraEnv === void 0 ? void 0 : {
				...process.env,
				...extraEnv
			},
			stdio: [
				"pipe",
				"pipe",
				"ignore"
			],
			windowsHide: true,
			detached: process.platform !== "win32"
		});
	} catch {
		return {
			control: null,
			failure: { kind: "spawn" }
		};
	}
	let settled = false;
	const settle = (result) => {
		if (!settled) {
			settled = true;
			resolve(result);
		}
	};
	const timer = killAfter(child, timeoutMs, () => settle({
		control: null,
		failure: {
			kind: "timeout",
			timeoutMs
		}
	}));
	let out = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		const remaining = MAX_OUTPUT - out.length;
		if (remaining > 0) out += chunk.slice(0, remaining);
	});
	child.on("error", () => {
		clearTimeout(timer);
		settle({
			control: null,
			failure: { kind: "spawn" }
		});
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (code !== 0) {
			settle({
				control: null,
				failure: {
					kind: "exit",
					code
				}
			});
			return;
		}
		const control = parseControl(out);
		if (control === null && out.trim() !== "") {
			settle({
				control: null,
				failure: { kind: "output" }
			});
			return;
		}
		settle({
			control,
			failure: null
		});
	});
	child.stdin?.on("error", () => {});
	child.stdin?.end(input);
	return promise;
}
/**
* Scan for the first parseable control line — unrelated chatter on
* stdout must not swallow the answer.
*/
/** Non-null plain object — the control-line shape. */
function isRecord(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function parseControl(out) {
	for (const line of out.split("\n")) {
		const text = line.trim();
		if (text === "") continue;
		try {
			const parsed = JSON.parse(text);
			if (isRecord(parsed)) return parsed;
		} catch {}
	}
	return null;
}
/**
* The context half of a control object: bro's "here is what you should
* know" text. Empty means the hook had nothing to add.
*/
function contextOf(control) {
	const text = control?.hookSpecificOutput?.additionalContext;
	return typeof text === "string" ? text.trim() : "";
}
/**
* The repo opts in by carrying any project/local bro.config.* or
* .beads/ — the same gate `bro hooks` applies (core's repoOptedIn).
* Duplicated here because a shipped adapter cannot import @broject/core;
* keep the list in sync with CONFIG_LAYER_FILES.
*/
function broEnabled(startDir) {
	let dir = startDir;
	for (;;) {
		if (BRO_MARKERS.some((marker) => existsSync(join(dir, marker)))) return true;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}
/** `bro status --json` — the board the widget renders. Null on any
*  failure; the board is a convenience, never a gate. */
async function statusJson(command, cwd) {
	const { promise, resolve } = Promise.withResolvers();
	let child;
	try {
		child = spawn(command.cmd, [
			...command.args,
			STATUS_COMMAND,
			JSON_FLAG
		], {
			cwd,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			windowsHide: true,
			detached: process.platform !== "win32"
		});
	} catch {
		return null;
	}
	const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(null));
	let out = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		const remaining = MAX_OUTPUT - out.length;
		if (remaining > 0) out += chunk.slice(0, remaining);
	});
	child.on("error", () => {
		clearTimeout(timer);
		resolve(null);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (code !== 0) {
			resolve(null);
			return;
		}
		try {
			const parsed = JSON.parse(out);
			resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
		} catch {
			resolve(null);
		}
	});
	return promise;
}
const ELLIPSIS = "…";
/** Return the terminal column width of a string without splitting Unicode
* code points. Combining marks occupy no columns; wide CJK and emoji occupy
* two. This small implementation keeps the bundled adapters dependency-free. */
function displayWidth(text) {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 768 && code <= 879 || code >= 6832 && code <= 6911 || code >= 7616 && code <= 7679 || code >= 8400 && code <= 8447 || code >= 65056 && code <= 65071) continue;
		if (code >= 8203 && code <= 8205 || code >= 65024 && code <= 65039) continue;
		width += code >= 4352 && code <= 4447 || code >= 9001 && code <= 9002 || code >= 11904 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65040 && code <= 65049 || code >= 65072 && code <= 65135 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 126976 && code <= 129791 || code >= 131072 && code <= 196605 || code >= 196608 && code <= 262141 ? 2 : 1;
	}
	return width;
}
/** Clip to a width, marking the cut. */
function clip(text, width) {
	if (displayWidth(text) <= width) return text;
	const target = Math.max(0, width - displayWidth(ELLIPSIS));
	let used = 0;
	let prefix = "";
	for (const char of text) {
		const charWidth = displayWidth(char);
		if (used + charWidth > target) break;
		prefix += char;
		used += charWidth;
	}
	return `${prefix}${ELLIPSIS}`;
}
/**
* The widget board — one compact summary line, then the top in-progress
* beads and running fleet agents. A string array is the simplest board
* any host can render.
*/
function boardLines(s) {
	const running = runningAgents(s);
	return [
		`bro · ${boardParts(s, running).join(" · ")}`,
		...beadLines(s),
		...agentLines(running)
	];
}
function runningAgents(s) {
	return (s.fleet?.agents ?? []).filter((a) => a.state === "running");
}
function boardParts(s, running) {
	const beads = s.beads?.inProgress ?? [];
	const cap = (s.fleet?.maxConcurrent ?? 0) > 0 ? `/${s.fleet?.maxConcurrent}` : "";
	const parts = [
		`◐ ${beads.length} bead${beads.length === 1 ? "" : "s"}`,
		`fleet ${running.length}${cap}`,
		`ready ${s.beads?.readyTotal ?? 0}`
	];
	if (s.drill?.frame) parts.push(`drill ${s.drill.frame.id}`);
	if ((s.dirty ?? 0) > 0) parts.push(`dirty ${s.dirty}`);
	return parts;
}
function beadLines(s) {
	return (s.beads?.inProgress ?? []).slice(0, 3).map((b) => `  ◐ ${b.id ?? "?"}  ${clip(b.title ?? "", 64)}${b.link ? `  ${b.link}` : ""}`);
}
function agentLines(running) {
	return running.slice(0, 2).map((a) => `  ▶ ${a.id ?? "?"}  ${a.backend ?? ""}${a.step ? `  ${a.step}` : ""}`);
}
/** The footer crumb — the one-glance form of the same board. */
function statusCrumb(s) {
	return `bro ◐${s.beads?.inProgress?.length ?? 0} ⬢${(s.fleet?.agents ?? []).filter((a) => a.state === "running").length}`;
}
/**
* The lazy, retrying CLI resolver every adapter shares: resolution
* costs spawn probes, so it runs on first use and a *failed* answer
* expires after RESOLVE_RETRY_MS instead of poisoning the instance —
* PATH, a local install or npx can appear mid-session.
*/
function createCommandResolver(opts = {}) {
	let resolved;
	let failedAt;
	const cacheFresh = () => {
		if (resolved === void 0) return false;
		return failedAt === void 0 || Date.now() - failedAt < RESOLVE_RETRY_MS;
	};
	return () => {
		if (cacheFresh() && resolved !== void 0) return resolved;
		failedAt = void 0;
		resolved = resolveCommand(opts).then((cmd) => {
			if (cmd === null) failedAt = Date.now();
			return cmd;
		});
		return resolved;
	};
}

//#endregion
//#region packages/agent-plugins/adapter-core/src/host.ts
/** The board's widget key — one slot, owned by bro. */
const BOARD_KEY = "bro";
const CONTEXT_MESSAGE_TYPE = "bro-context";
const TEXT_CONTENT_TYPE = "text";
const TUI_MODE = "tui";
const SESSION_START_EVENT = "session-start";
const POST_COMPACTION_EVENT = "post-compaction";
const PRE_COMPACT_EVENT = "pre-compact";
const PROMPT_SUBMIT_EVENT = "prompt-submit";
const POST_TOOL_EVENT = "post-tool";
const STOP_EVENT = "stop";
/** The event names this lineage shares. A host that spells one
*  differently overrides it — pi's settle gate is not omp's stop. */
const LINEAGE_EVENTS = {
	sessionStart: "session_start",
	sessionBeforeCompact: "session_before_compact",
	sessionCompact: "session_compact",
	beforeAgentStart: "before_agent_start",
	toolResult: "tool_result",
	turnEnd: "turn_end",
	sessionShutdown: "session_shutdown"
};
/**
* Build a binding for a host in this lineage.
*
* Everything the lineage agrees on — the session id, the cwd, the paint
* check, the message shapes, the event names — is filled in here. A
* binding is left holding only what its host actually spells
* differently, which is the whole point: a binding that re-copies the
* lineage's shape is a binding that will drift.
*/
function sharedBinding(host) {
	return {
		events: {
			...LINEAGE_EVENTS,
			stop: host.stop
		},
		on: host.on,
		sessionId(ctx) {
			return ctx.sessionManager.getSessionId() ?? "";
		},
		cwd(ctx) {
			return ctx.cwd;
		},
		canPaint(ctx) {
			return ctx.mode === TUI_MODE;
		},
		paint: host.paint,
		clear(ctx) {
			ctx.ui.setWidget(BOARD_KEY, void 0);
			ctx.ui.setStatus(BOARD_KEY, void 0);
		},
		notify: host.notify,
		argumentCompletions: void 0,
		refuseStop: host.refuseStop,
		stopAlreadyRefused: host.stopAlreadyRefused,
		stopAborted: host.stopAborted,
		promptOf(event) {
			const turn = event;
			return typeof turn.prompt === "string" ? turn.prompt : "";
		},
		inject(text) {
			return { message: {
				customType: CONTEXT_MESSAGE_TYPE,
				content: text,
				display: false
			} };
		},
		appendToolResult(event, text) {
			const result = event;
			const content = Array.isArray(result.content) ? [...result.content] : [];
			content.push({
				type: TEXT_CONTENT_TYPE,
				text
			});
			return { content };
		},
		npxPin: host.npxPin,
		nativeCommands: host.nativeCommands,
		hookEnv: hookEmitEnv(host.kind, { npxPin: host.npxPin })
	};
}
/**
* Wire bro into a host. `api` is the host's own extension API — the
* driver passes it through so the client can register commands and
* tools without a second channel.
*/
function createBroDriver(host, api) {
	let board = null;
	/** Monotonic token — a refresh that finishes after a newer one
	*  started must not overwrite the newer snapshot. */
	let refreshSeq = 0;
	/** Hydration text + the session it belongs to. Sessions can overlap
	*  (a replaced session's handler still pending while the new one
	*  starts), so the cache and the "already injected" claim are keyed
	*  by session id — one session's context never lands in another,
	*  and the claim is taken synchronously so two concurrent
	*  before-agent handlers cannot both inject. */
	let hydration;
	let hydrated;
	/** The session whose rehydration probe FAILED (not merely came back
	*  empty) — a failed probe is not the session's verdict: bro may not
	*  have been resolvable yet, so a later turn may re-probe once. */
	let hydrationFailed;
	/** The session that already spent its one re-probe — a broken install
	*  must not turn every turn into a spawn. */
	let hydrationRetried;
	/** Pre-compaction carry — kept apart from the hydration probe so a
	*  post-compaction re-probe cannot overwrite what must survive the
	*  summary. Consumed (cleared) by the next hydrate() that runs. */
	let carry;
	/** Set when the stop gate already refused this session — gates, not
	*  loops: the blocker goes back once per session, a later stop is
	*  let through, and a NEW session starts with a fresh gate (the
	*  flag dies with its session instead of leaking into the next). */
	let gatedSession;
	/** Resolve the CLI once — the shared lazy+retrying resolver. Probing
	*  costs a spawn even where bro is inert, so it stays lazy; a failed
	*  resolution expires instead of poisoning the extension instance. */
	const command = createCommandResolver({ npxPin: host.npxPin });
	/** Probe one bro hook. Fail-open: every failure is "no opinion". */
	const probe = async (event, payload, cwd, timeoutMs = HOOK_TIMEOUT_MS) => {
		if (!broEnabled(cwd)) return null;
		const cmd = await command();
		return cmd === null ? null : callHook(cmd, {
			event,
			payload,
			cwd,
			timeoutMs,
			extraEnv: host.hookEnv
		});
	};
	const paint = (ctx) => {
		if (!host.canPaint(ctx)) return;
		if (board === null) {
			host.clear(ctx);
			return;
		}
		host.paint(ctx, boardLines(board), statusCrumb(board));
	};
	const refreshBoard = async (ctx) => {
		const cwd = host.cwd(ctx);
		const seq = ++refreshSeq;
		if (!broEnabled(cwd)) {
			board = null;
			paint(ctx);
			return;
		}
		const cmd = await command();
		if (cmd === null || seq !== refreshSeq) return;
		const next = await statusJson(cmd, cwd);
		if (seq !== refreshSeq) return;
		if (host.cwd(ctx) !== cwd) {
			board = null;
			paint(ctx);
			return;
		}
		board = next;
		paint(ctx);
	};
	/** Hydration runs once per session (re-primed on compaction); the
	*  answer is injected at the next turn start, not pushed into the
	*  transcript eagerly — the user may sit at the prompt for minutes.
	*  A pre-compaction carry rides along: it was already shown to the
	*  model once, so it must survive the summary re-probe. */
	const hydrate = (ctx, event) => {
		const cwd = host.cwd(ctx);
		const sessionId = host.sessionId(ctx);
		const priorCarry = carry?.sessionId === sessionId ? carry.text : "";
		carry = void 0;
		const raw = probe(event, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS);
		const started = raw.then(contextOf).then((text) => priorCarry === "" ? text : text === "" ? priorCarry : `${priorCarry}\n\n${text}`);
		hydration = {
			sessionId,
			promise: started
		};
		if (hydrated === sessionId) hydrated = void 0;
		hydrationFailed = void 0;
		raw.then((control) => {
			if (control === null && hydration?.promise === started) hydrationFailed = sessionId;
		}).catch(() => {});
		started.then((text) => {
			if (hydration?.promise === started && text === "") hydration = void 0;
		}).catch(() => {});
	};
	/** The session's context text, consumed from the cached probe. An
	*  empty answer is not the session's verdict: the claim is released
	*  and a failed probe is re-run once (fire-and-forget — the next turn
	*  picks the answer up, this turn never waits on it). */
	const consumeHydration = async (sessionId, cwd) => {
		const pending = hydration;
		if (pending === void 0) return "";
		if (pending.sessionId !== sessionId || hydrated === sessionId) return "";
		hydrated = sessionId;
		const text = (await pending.promise).trim();
		if (text !== "") return text;
		hydrated = void 0;
		retryHydration(sessionId, cwd);
		return "";
	};
	const retryHydration = (sessionId, cwd) => {
		if (hydrationFailed !== sessionId || hydrationRetried === sessionId) return;
		hydrationRetried = sessionId;
		hydration = {
			sessionId,
			promise: probe(SESSION_START_EVENT, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS).then(contextOf)
		};
	};
	/** Register one handler if the host has that event. */
	const bind = (name, handler) => {
		if (name === void 0) return;
		host.on(name, handler);
	};
	bind(host.events.sessionStart, (_event, ctx) => {
		gatedSession = void 0;
		hydrate(ctx, SESSION_START_EVENT);
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionCompact, (_event, ctx) => {
		hydrate(ctx, POST_COMPACTION_EVENT);
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionBeforeCompact, async (_event, ctx) => {
		const cwd = host.cwd(ctx);
		const sessionId = host.sessionId(ctx);
		const text = contextOf(await probe(PRE_COMPACT_EVENT, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS));
		if (text === "") return;
		carry = {
			sessionId,
			text
		};
		const pending = hydration;
		if (pending !== void 0 && pending.sessionId === sessionId) {
			hydration = {
				sessionId,
				promise: pending.promise.then((base) => base === "" ? text : `${base}\n\n${text}`)
			};
			carry = void 0;
		}
	});
	bind(host.events.beforeAgentStart, async (event, ctx) => {
		const cwd = host.cwd(ctx);
		const sessionId = host.sessionId(ctx);
		const nudge = probe(PROMPT_SUBMIT_EVENT, {
			session_id: sessionId,
			prompt: host.promptOf(event)
		}, cwd).then(contextOf);
		const parts = [];
		const hydrationText = await consumeHydration(sessionId, cwd);
		if (hydrationText !== "") parts.push(hydrationText);
		const nudgeText = (await nudge).trim();
		if (nudgeText !== "") parts.push(nudgeText);
		if (parts.length === 0) return;
		return host.inject(parts.join("\n\n"));
	});
	bind(host.events.toolResult, async (event, ctx) => {
		const cwd = host.cwd(ctx);
		const tool = event;
		const text = contextOf(await probe(POST_TOOL_EVENT, {
			session_id: host.sessionId(ctx),
			tool_name: tool.toolName ?? "",
			tool_input: tool.input ?? {},
			tool_response: { success: tool.isError !== true }
		}, cwd));
		if (text === "") return;
		return host.appendToolResult(event, text);
	});
	const alreadyGated = (event, sessionId) => gatedSession === sessionId || host.stopAlreadyRefused(event) === true;
	const notifyHint = (ctx, control) => {
		const hint = contextOf(control);
		if (hint !== "") host.notify(ctx, hint, "info");
	};
	const stopReason = (control) => {
		const reason = typeof control.reason === "string" ? control.reason.trim() : "";
		return reason === "" ? "unfinished bro work" : reason;
	};
	const stopGate = async (event, ctx, sessionId) => {
		if (host.stopAborted?.(event) === true) return;
		const control = await probe(STOP_EVENT, {
			session_id: sessionId,
			stop_hook_active: alreadyGated(event, sessionId)
		}, host.cwd(ctx));
		if (control?.decision !== "block") {
			notifyHint(ctx, control);
			return;
		}
		gatedSession = sessionId;
		refreshBoard(ctx).catch(() => {});
		return host.refuseStop(stopReason(control));
	};
	/** In-flight stop probes by session id — two concurrent stops must
	*  not both run the probe and both block: the second awaits the
	*  first's verdict, by which point `already` is true and bro's
	*  one-shot rule lets it through. */
	const stopsInFlight = /* @__PURE__ */ new Map();
	bind(host.events.stop, (event, ctx) => {
		const sessionId = host.sessionId(ctx);
		const inFlight = stopsInFlight.get(sessionId);
		if (inFlight !== void 0) return inFlight;
		const run$1 = stopGate(event, ctx, sessionId).finally(() => {
			stopsInFlight.delete(sessionId);
		});
		stopsInFlight.set(sessionId, run$1);
		return run$1;
	});
	bind(host.events.turnEnd, (_event, ctx) => {
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionShutdown, (_event, ctx) => {
		host.clear(ctx);
	});
	/** Run a bro subcommand — resolve the CLI first, then hand off. */
	const run = async (args, cwd) => runBro(await command(), args, cwd);
	/** `/bro <args>` and every family alias share one dispatch: split,
	*  run, surface. Bare family names never reach here — they always
	*  carry their verb. */
	const dispatchArgs = async (argv, ctx) => {
		const result = await run(argv, host.cwd(ctx));
		const text = (result.stdout || result.stderr).trim();
		if (result.code !== 0) {
			host.notify(ctx, `bro ${argv.join(" ")}: exit ${result.code}`, "error");
			return;
		}
		api.sendMessage({
			customType: "bro-output",
			content: `$ bro ${argv.join(" ")}\n${text}`,
			display: true
		}, { triggerTurn: false });
	};
	/** The shared surfaces. `/bro` is a thin passthrough — `bro
	*  act|next|fleet|drill` reachable without leaving the editor — and
	*  `bro_status` hands the model the same board JSON the widget
	*  renders. Both are the same on every host, so both live here. */
	api.registerCommand("bro", {
		description: "bro — board refresh, or run `bro <args>` (act|next|fleet|drill|…)",
		getArgumentCompletions: host.argumentCompletions,
		async handler(args, ctx) {
			const trimmed = args.trim();
			if (trimmed === "") {
				await refreshBoard(ctx);
				host.notify(ctx, "bro: board refreshed", "info");
				return;
			}
			await dispatchArgs(trimmed.split(/\s+/), ctx);
		}
	});
	const natives = new Set(host.nativeCommands ?? []);
	for (const c of BRO_COMMANDS) {
		const name = natives.has(c.name) ? `bro:${c.name}` : c.name;
		api.registerCommand(name, {
			description: c.description,
			getArgumentCompletions: host.argumentCompletions,
			async handler(args, ctx) {
				await dispatchArgs([c.verb, ...args.trim().split(/\s+/).filter((a) => a !== "")], ctx);
			}
		});
	}
	api.registerTool({
		name: "bro_status",
		label: "bro status",
		description: "Read the bro project board: in-progress beads, ready count, fleet agents, drill frame, branch/dirty state. Read-only.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		loadMode: "essential",
		approval: "read",
		async execute(...args) {
			const ctx = args[4];
			const result = await run(["status", "--json"], host.cwd(ctx));
			return {
				content: [{
					type: "text",
					text: result.code === 0 ? result.stdout : "bro status unavailable"
				}],
				details: void 0
			};
		}
	});
	return {
		get board() {
			return board;
		},
		run,
		refresh: (ctx) => refreshBoard(ctx),
		api
	};
}
/** Run a bro subcommand and capture its output — the read side of the
*  CLI, used by the client's own command and tools. A hung CLI must
*  not wedge the driver: the child gets RUN_TIMEOUT_MS and then the
*  whole process group dies (it is detached, so -pid takes dolt
*  descendants with it). */
async function runBro(command, args, cwd, timeoutMs = RUN_TIMEOUT_MS) {
	if (command === null) return {
		code: 127,
		stdout: "",
		stderr: "bro CLI not found"
	};
	const child = spawnBro(command, args, cwd);
	if (child === null) return {
		code: 127,
		stdout: "",
		stderr: "spawn failed"
	};
	return collectBro(child, timeoutMs);
}
function spawnBro(command, args, cwd) {
	try {
		return spawn(command.cmd, [...command.args, ...args], {
			cwd,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			detached: process.platform !== "win32"
		});
	} catch {
		return null;
	}
}
function collectBro(child, timeoutMs) {
	const { promise, resolve } = Promise.withResolvers();
	let out = "";
	let err = "";
	let settled = false;
	const settle = (result) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(result);
	};
	const timer = setTimeout(() => {
		killTree(child);
		settle({
			code: 1,
			stdout: out,
			stderr: `${err}\nbro CLI timed out after ${timeoutMs}ms`.trim()
		});
	}, timeoutMs);
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		if (out.length < 1 << 20) out += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		if (err.length < 1 << 20) err += chunk;
	});
	child.on("error", () => settle({
		code: 127,
		stdout: "",
		stderr: "spawn failed"
	}));
	child.on("close", (code) => settle({
		code: code ?? 1,
		stdout: out,
		stderr: err
	}));
	return promise;
}
function killTree(child) {
	try {
		if (child.pid !== void 0 && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {}
}

//#endregion
//#region packages/agent-plugins/pi/src/pi.ts
/** The published version of this adapter — the npx fallback pin. The
*  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = "@broject/bro@0.3.0";
/**
* The pi binding: the host's own shape, nothing else. Every behavioral
* decision lives in the shared driver, so this file is the whole of
* "what is different about pi".
*/
function binding(pi) {
	return {
		...sharedBinding({
			kind: "pi",
			npxPin: NPX_PIN,
			nativeCommands: [
				"settings",
				"model",
				"thinking",
				"scoped-models",
				"login",
				"logout",
				"llama",
				"new",
				"resume",
				"name",
				"session",
				"tree",
				"fork",
				"clone",
				"compact",
				"import",
				"copy",
				"export",
				"share",
				"bug",
				"trust",
				"mcp",
				"reload",
				"hotkeys",
				"changelog",
				"quit"
			],
			stop: "agent_before_settle",
			on(event, handler) {
				pi.on(event, handler);
			},
			notify(ctx, text, level) {
				try {
					ctx.ui.notify(text, level);
				} catch {}
			},
			refuseStop(reason) {
				return {
					continue: true,
					entries: [{
						type: "custom_message",
						customType: "bro-stop-gate",
						content: reason,
						display: true
					}]
				};
			},
			stopAlreadyRefused() {
				return false;
			},
			stopAborted(event) {
				const outcome = event.outcome;
				return outcome === "aborted" || outcome === "error";
			},
			paint(ctx, lines, _crumb) {
				try {
					let one;
					if (lines.length > 0) {
						const links = lines.slice(1).map((l) => (l.match(/\[#\d+\]\([^)]+\)/) ?? [])[0]).filter((x) => typeof x === "string");
						one = [links.length > 0 ? `${lines[0]}  ${links.join(" ")}` : lines[0]];
					}
					ctx.ui.setWidget(BOARD_KEY, one, { placement: "aboveEditor" });
					ctx.ui.setStatus(BOARD_KEY, void 0);
				} catch {}
			}
		}),
		argumentCompletions(prefix) {
			const items = [
				"act",
				"act status",
				"debt",
				"drill",
				"convoy",
				"next",
				"loop",
				"stack",
				"fleet",
				"agents",
				"work",
				"spec",
				"sync",
				"doctor",
				"plugins",
				"setup",
				"wait",
				"review",
				"self",
				"plan",
				"mesh",
				"check",
				"help"
			];
			const p = prefix.trim().toLowerCase();
			return (p === "" ? items : items.filter((x) => x.startsWith(p))).map((x) => ({
				label: x,
				value: x
			}));
		}
	};
}
/** The extension entry point — pi calls this with its API. */
function broExtension(pi) {
	const driver = createBroDriver(binding(pi), pi);
	pi.on("agent_settled", (_e, ctx) => {
		driver.refresh(ctx).catch(() => {});
	});
}
/**
* Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
* foreign file holding this slot; the marker survives generation into
* integrations/pi/bro.ts.
*/
const adapter = {
	id: "bro",
	kind: "pi-extension"
};

//#endregion
export { adapter, broExtension as default };