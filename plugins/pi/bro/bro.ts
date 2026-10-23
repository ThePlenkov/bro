// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

//#region packages/cli/src/adapter/core.ts
/** How long a normal hook probe may take. */
const HOOK_TIMEOUT_MS = 15e3;
/** session-start/post-compaction list `bd ready` and scan worktrees —
*  measured at 20-40s in a loaded repo. */
const REHYDRATION_TIMEOUT_MS = 45e3;
/** Cap on a hook's stdout — a runaway child must not eat the heap. */
const MAX_OUTPUT = 1 << 20;
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
	if (opts.command !== void 0 && opts.command !== "") {
		const [cmd, ...args] = opts.command.split(/\s+/).filter((p) => p !== "");
		if (cmd !== void 0 && await exitsZero(cmd, [...args, "hooks"])) return {
			cmd,
			args
		};
	}
	for (const entry of [siblingCli(), checkoutCli()]) if (entry !== null && await exitsZero(jsRuntime(), [entry, "hooks"])) return {
		cmd: jsRuntime(),
		args: [entry]
	};
	if (await exitsZero("bro", ["hooks"])) return {
		cmd: "bro",
		args: []
	};
	if (opts.npxPin !== void 0 && await exitsZero("npx", ["--version"])) return {
		cmd: "npx",
		args: [
			"-y",
			"--prefer-offline",
			opts.npxPin
		]
	};
	return null;
}
/**
* Run one `bro hooks <event>` with the payload on stdin; resolve null on
* every failure mode — spawn error, timeout, nonzero exit, garbage out.
*/
async function callHook(command, event, payload, cwd, timeoutMs) {
	const { promise, resolve } = Promise.withResolvers();
	let child;
	try {
		child = spawn(command.cmd, [
			...command.args,
			"hooks",
			event
		], {
			cwd,
			stdio: [
				"pipe",
				"pipe",
				"ignore"
			],
			detached: process.platform !== "win32"
		});
	} catch {
		return null;
	}
	let settled = false;
	const settle = (value) => {
		if (!settled) {
			settled = true;
			resolve(value);
		}
	};
	const timer = killAfter(child, timeoutMs, () => settle(null));
	let out = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		const remaining = MAX_OUTPUT - out.length;
		if (remaining > 0) out += chunk.slice(0, remaining);
	});
	child.on("error", () => {
		clearTimeout(timer);
		settle(null);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		settle(code === 0 ? parseControl(out) : null);
	});
	child.stdin?.on("error", () => {});
	child.stdin?.end(JSON.stringify(payload));
	return promise;
}
/**
* Scan for the first parseable control line — unrelated chatter on
* stdout must not swallow the answer.
*/
function parseControl(out) {
	for (const line of out.split("\n")) {
		const text = line.trim();
		if (text === "") continue;
		try {
			const parsed = JSON.parse(text);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
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
	const markers = [
		"bro.config.ts",
		"bro.config.json",
		"bro.config.local.ts",
		"bro.config.local.json",
		".beads"
	];
	let dir = startDir;
	for (;;) {
		if (markers.some((m) => existsSync(join(dir, m)))) return true;
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
			"status",
			"--json"
		], {
			cwd,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
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
/** Clip to a width, marking the cut. */
function clip(text, width) {
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}${ELLIPSIS}` : text;
}
/**
* The widget board — one compact summary line, then the top in-progress
* beads and running fleet agents. A string array is the simplest board
* any host can render.
*/
function boardLines(s) {
	const beads = s.beads?.inProgress ?? [];
	const running = (s.fleet?.agents ?? []).filter((a) => a.state === "running");
	const cap = (s.fleet?.maxConcurrent ?? 0) > 0 ? `/${s.fleet?.maxConcurrent}` : "";
	const parts = [
		`◐ ${beads.length} bead${beads.length === 1 ? "" : "s"}`,
		`fleet ${running.length}${cap}`,
		`ready ${s.beads?.readyTotal ?? 0}`
	];
	if (s.drill?.frame) parts.push(`drill ${s.drill.frame.id}`);
	if ((s.dirty ?? 0) > 0) parts.push(`dirty ${s.dirty}`);
	const lines = [`bro · ${parts.join(" · ")}`];
	for (const b of beads.slice(0, 3)) lines.push(`  ◐ ${b.id ?? "?"}  ${clip(b.title ?? "", 64)}`);
	for (const a of running.slice(0, 2)) {
		const step = a.step ? `  ${a.step}` : "";
		lines.push(`  ▶ ${a.id ?? "?"}  ${a.backend ?? ""}${step}`);
	}
	return lines;
}
/** The footer crumb — the one-glance form of the same board. */
function statusCrumb(s) {
	return `bro ◐${s.beads?.inProgress?.length ?? 0} ⬢${(s.fleet?.agents ?? []).filter((a) => a.state === "running").length}`;
}

//#endregion
//#region packages/cli/src/adapter/host.ts
/** The board's widget key — one slot, owned by bro. */
const BOARD_KEY = "bro";
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
			return ctx.mode === "tui";
		},
		paint: host.paint,
		clear(ctx) {
			ctx.ui.setWidget(BOARD_KEY, void 0);
			ctx.ui.setStatus(BOARD_KEY, void 0);
		},
		notify: host.notify,
		refuseStop: host.refuseStop,
		stopAlreadyRefused: host.stopAlreadyRefused,
		promptOf(event) {
			const turn = event;
			return typeof turn.prompt === "string" ? turn.prompt : "";
		},
		inject(text) {
			return { message: {
				customType: "bro-context",
				content: text,
				display: false
			} };
		},
		appendToolResult(event, text) {
			const result = event;
			const content = Array.isArray(result.content) ? [...result.content] : [];
			content.push({
				type: "text",
				text
			});
			return { content };
		}
	};
}
/**
* Wire bro into a host. `api` is the host's own extension API — the
* driver passes it through so the client can register commands and
* tools without a second channel.
*/
function createBroDriver(host, api) {
	let resolved;
	let board = null;
	/** Cached hydration text — primed on session start (the only window
	*  where the 20-40s probe cost overlaps the user's first prompt),
	*  then injected once into context and re-primed across compaction. */
	let hydration;
	let injected = false;
	/** Set when the stop gate already refused this session — gates, not
	*  loops: the blocker goes back once, a later stop is let through. */
	let gated = false;
	/** Resolve the CLI once. Probing costs a spawn even where bro is
	*  inert, so it stays lazy. */
	const command = () => {
		resolved ??= resolveCommand({ npxPin: host.npxPin });
		return resolved;
	};
	/** Probe one bro hook. Fail-open: every failure is "no opinion". */
	const probe = async (event, payload, cwd, timeoutMs = HOOK_TIMEOUT_MS) => {
		if (!broEnabled(cwd)) return null;
		const cmd = await command();
		return cmd === null ? null : callHook(cmd, event, payload, cwd, timeoutMs);
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
		if (!broEnabled(cwd)) return;
		const cmd = await command();
		if (cmd === null) return;
		board = await statusJson(cmd, cwd);
		paint(ctx);
	};
	/** Hydration runs once per session (re-primed on compaction); the
	*  answer is injected at the next turn start, not pushed into the
	*  transcript eagerly — the user may sit at the prompt for minutes. */
	const hydrate = (ctx, event) => {
		const cwd = host.cwd(ctx);
		const started = probe(event, { session_id: host.sessionId(ctx) }, cwd, REHYDRATION_TIMEOUT_MS).then(contextOf);
		hydration = started;
		injected = false;
		started.then((text) => {
			if (hydration === started && text === "") hydration = void 0;
		}).catch(() => {});
	};
	/** Register one handler if the host has that event. */
	const bind = (name, handler) => {
		if (name === void 0) return;
		host.on(name, handler);
	};
	bind(host.events.sessionStart, (_event, ctx) => {
		hydrate(ctx, "session-start");
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionCompact, (_event, ctx) => {
		gated = false;
		hydrate(ctx, "post-compaction");
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionBeforeCompact, async (_event, ctx) => {
		const cwd = host.cwd(ctx);
		const text = contextOf(await probe("pre-compact", { session_id: host.sessionId(ctx) }, cwd, REHYDRATION_TIMEOUT_MS));
		if (text === "") return;
		const carry = text;
		hydration = (hydration ?? Promise.resolve("")).then((base) => base === "" ? carry : `${base}\n\n${carry}`);
	});
	bind(host.events.beforeAgentStart, async (event, ctx) => {
		const cwd = host.cwd(ctx);
		const nudge = probe("prompt-submit", {
			session_id: host.sessionId(ctx),
			prompt: host.promptOf(event)
		}, cwd).then(contextOf);
		const parts = [];
		if (!injected && hydration !== void 0) {
			const text = (await hydration).trim();
			if (text !== "") parts.push(text);
			injected = true;
		}
		const nudgeText = (await nudge).trim();
		if (nudgeText !== "") parts.push(nudgeText);
		if (parts.length === 0) return;
		return host.inject(parts.join("\n\n"));
	});
	bind(host.events.toolResult, async (event, ctx) => {
		const cwd = host.cwd(ctx);
		const tool = event;
		const text = contextOf(await probe("post-tool", {
			session_id: host.sessionId(ctx),
			tool_name: tool.toolName ?? "",
			tool_input: tool.input ?? {},
			tool_response: { success: tool.isError !== true }
		}, cwd));
		if (text === "") return;
		return host.appendToolResult(event, text);
	});
	bind(host.events.stop, async (event, ctx) => {
		const already = gated || host.stopAlreadyRefused(event);
		const control = await probe("stop", {
			session_id: host.sessionId(ctx),
			stop_hook_active: already
		}, host.cwd(ctx));
		if (control?.decision !== "block") {
			const hint = contextOf(control);
			if (hint !== "") host.notify(ctx, hint, "info");
			return;
		}
		gated = true;
		const reason = typeof control.reason === "string" ? control.reason.trim() : "";
		refreshBoard(ctx).catch(() => {});
		return host.refuseStop(reason === "" ? "unfinished bro work" : reason);
	});
	bind(host.events.turnEnd, (_event, ctx) => {
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionShutdown, (_event, ctx) => {
		host.clear(ctx);
	});
	/** Run a bro subcommand — resolve the CLI first, then hand off. */
	const run = async (args, cwd) => runBro(await command(), args, cwd);
	/** The shared surfaces. `/bro` is a thin passthrough — `bro
	*  act|next|fleet|drill` reachable without leaving the editor — and
	*  `bro_status` hands the model the same board JSON the widget
	*  renders. Both are the same on every host, so both live here. */
	api.registerCommand("bro", {
		description: "bro — board refresh, or run `bro <args>` (act|next|fleet|drill|…)",
		async handler(args, ctx) {
			const trimmed = args.trim();
			if (trimmed === "") {
				await run(["status", "--json"], host.cwd(ctx));
				host.notify(ctx, "bro: board refreshed", "info");
				return;
			}
			const result = await run(trimmed.split(/\s+/), host.cwd(ctx));
			const text = (result.stdout || result.stderr).trim();
			if (result.code !== 0) {
				host.notify(ctx, `bro ${trimmed}: exit ${result.code}`, "error");
				return;
			}
			api.sendMessage({
				customType: "bro-output",
				content: `$ bro ${trimmed}\n${text}`,
				display: true
			}, { triggerTurn: false });
		}
	});
	api.registerTool({
		name: "bro_status",
		label: "bro status",
		description: "Read the bro project board: in-progress beads, ready count, fleet agents, drill frame, branch/dirty state. Read-only.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const result = await run(["status", "--json"], host.cwd(ctx));
			return { content: [{
				type: "text",
				text: result.code === 0 ? result.stdout : "bro status unavailable"
			}] };
		}
	});
	return {
		get board() {
			return board;
		},
		run,
		api
	};
}
/** Run a bro subcommand and capture its output — the read side of the
*  CLI, used by the client's own command and tools. */
async function runBro(command, args, cwd) {
	if (command === null) return {
		code: 127,
		stdout: "",
		stderr: "bro CLI not found"
	};
	const { promise, resolve } = Promise.withResolvers();
	let child;
	try {
		child = spawn(command.cmd, [...command.args, ...args], {
			cwd,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			detached: process.platform !== "win32"
		});
	} catch {
		resolve({
			code: 127,
			stdout: "",
			stderr: "spawn failed"
		});
		return promise;
	}
	let out = "";
	let err = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		if (out.length < 1 << 20) out += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		if (err.length < 1 << 20) err += chunk;
	});
	child.on("error", () => resolve({
		code: 127,
		stdout: "",
		stderr: "spawn failed"
	}));
	child.on("close", (code) => resolve({
		code: code ?? 1,
		stdout: out,
		stderr: err
	}));
	return promise;
}

//#endregion
//#region packages/cli/src/adapter/pi.ts
/** The published version of this adapter — the npx fallback pin. The
*  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = "@broject/bro@0.2.5";
/**
* The pi binding: the host's own shape, nothing else. Every behavioral
* decision lives in the shared driver, so this file is the whole of
* "what is different about pi".
*/
function binding(pi) {
	return {
		...sharedBinding({
			stop: "agent_before_settle",
			on(event, handler) {
				pi.on(event, handler);
			},
			paint(ctx, lines, crumb) {
				ctx.ui.setWidget(BOARD_KEY, lines, { placement: "aboveEditor" });
				ctx.ui.setStatus(BOARD_KEY, crumb);
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
			}
		}),
		npxPin: NPX_PIN
	};
}
/** The extension entry point — pi calls this with its API. */
function broExtension(pi) {
	const driver = createBroDriver(binding(pi), pi);
	pi.on("agent_settled", (_e, ctx) => {
		driver.run(["status", "--json"], ctx.cwd).catch(() => {});
	});
}
/**
* Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
* foreign file holding this slot; the marker survives generation into
* plugins/pi/bro/bro.ts.
*/
const adapter = {
	id: "bro",
	kind: "pi-extension"
};

//#endregion
export { adapter, broExtension as default };