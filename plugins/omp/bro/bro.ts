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
	return await resolvePinnedCommand(opts.command) ?? await resolveLocalCommand() ?? await resolvePathCommand() ?? await resolveNpxCommand(opts.npxPin);
}
async function resolvePinnedCommand(command) {
	if (command === void 0 || command === "") return null;
	const [cmd, ...args] = command.split(/\s+/).filter((part) => part !== "");
	return cmd !== void 0 && await exitsZero(cmd, [...args, "hooks"]) ? {
		cmd,
		args
	} : null;
}
async function resolveLocalCommand() {
	for (const entry of [siblingCli(), checkoutCli()]) if (entry !== null && await exitsZero(jsRuntime(), [entry, "hooks"])) return {
		cmd: jsRuntime(),
		args: [entry]
	};
	return null;
}
async function resolvePathCommand() {
	return await exitsZero("bro", ["hooks"]) ? {
		cmd: "bro",
		args: []
	} : null;
}
async function resolveNpxCommand(npxPin) {
	return npxPin !== void 0 && await exitsZero("npx", ["--version"]) ? {
		cmd: "npx",
		args: [
			"-y",
			"--prefer-offline",
			npxPin
		]
	} : null;
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
/** The one-line cause a diagnostic surfaces for a failed hook call. */
function hookFailureText(failure) {
	switch (failure.kind) {
		case "no-cli": return "no bro CLI resolved";
		case "input": return "the hook payload could not be serialized";
		case "spawn": return "the hook process failed to spawn";
		case "timeout": return `the hook timed out after ${failure.timeoutMs}ms`;
		case "exit": return `the hook exited ${failure.code ?? "with no exit code"}`;
		case "output": return "the hook answered with no control object";
	}
}
/**
* callHook with the failure class attached. The stop gate needs to tell
* "bro had nothing to say" apart from "bro could not answer": both are
* fail-open, but the second must not pass invisibly. A clean exit with
* empty stdout is silence (failure null) — only real outage kinds set it.
*/
async function callHookDetailed(options) {
	let input;
	try {
		input = JSON.stringify(options.payload);
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
		child = spawn(options.command.cmd, [
			...options.command.args,
			"hooks",
			options.event
		], {
			cwd: options.cwd,
			env: options.extraEnv === void 0 ? void 0 : {
				...process.env,
				...options.extraEnv
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
	const timer = killAfter(child, options.timeoutMs, () => settle({
		control: null,
		failure: {
			kind: "timeout",
			timeoutMs: options.timeoutMs
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
/** Terminal column width of one code point — wcwidth-lite. Ranges are
*  table-driven: ZERO for combining marks/joiners, WIDE for wide,
*  fullwidth and emoji blocks (two columns), one otherwise. */
const ZERO_WIDTH = [
	[768, 879],
	[8203, 8205],
	[65024, 65039]
];
const WIDE = [
	[4352, 4447],
	[11904, 12350],
	[12353, 13311],
	[13312, 19903],
	[19968, 40959],
	[40960, 42191],
	[44032, 55203],
	[63744, 64255],
	[65072, 65135],
	[65280, 65376],
	[65504, 65510],
	[126976, 129791],
	[131072, 196605],
	[196608, 262141]
];
const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
function charWidth(cp) {
	if (inRanges(cp, ZERO_WIDTH)) return 0;
	return inRanges(cp, WIDE) ? 2 : 1;
}
/** Display width in terminal columns — not string length. */
function displayWidth(text) {
	let w = 0;
	for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}
/** Clip to a display width in terminal columns, marking the cut. The
*  iteration is by code point — a surrogate pair never splits. */
function clip(text, width) {
	if (displayWidth(text) <= width) return text;
	const budget = Math.max(0, width - 1);
	let w = 0;
	let out = "";
	for (const ch of text) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (w + cw > budget) break;
		w += cw;
		out += ch;
	}
	return `${out}${ELLIPSIS}`;
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
	const optional = [[s.drill?.frame, `drill ${s.drill?.frame?.id ?? ""}`], [(s.dirty ?? 0) > 0, `dirty ${s.dirty ?? 0}`]];
	const parts = [
		`◐ ${beads.length} bead${beads.length === 1 ? "" : "s"}`,
		`fleet ${running.length}${cap}`,
		`ready ${s.beads?.readyTotal ?? 0}`,
		...optional.filter(([present]) => present).map(([, text]) => text)
	];
	const beadLine = (b) => `  ◐ ${b.id ?? "?"}  ${clip(b.title ?? "", 64)}${b.link ? `  ${b.link}` : ""}`;
	const agentLine = (a) => `  ▶ ${a.id ?? "?"}  ${a.backend ?? ""}${a.step ? `  ${a.step}` : ""}`;
	return [
		`bro · ${parts.join(" · ")}`,
		...beads.slice(0, 3).map(beadLine),
		...running.slice(0, 2).map(agentLine)
	];
}
/** The footer crumb — the one-glance form of the same board. */
function statusCrumb(s) {
	return `bro ◐${s.beads?.inProgress?.length ?? 0} ⬢${(s.fleet?.agents ?? []).filter((a) => a.state === "running").length}`;
}

//#endregion
//#region packages/agent-plugins/adapter-core/src/host.ts
/** The board's widget key — one slot, owned by bro. */
const BOARD_KEY = "bro";
/** A hung CLI must not wedge the driver: `/bro`, `bro_status` and the
*  board refresh are interactive reads, and a wedged dolt lock can
*  stall them forever. The kill takes the detached process group
*  down, so a dolt child dies with its parent. */
const RUN_TIMEOUT_MS = 6e4;
/** How long a failed CLI resolution stays cached before a retry —
*  PATH, a local install or npx can appear mid-session, but
*  re-probing the npx rung on every keystroke would be worse than
*  the outage. */
const RESOLVE_RETRY_MS = 6e4;
/** How often a dead stop probe may warn. The gate is fail-open by
*  contract — a missing CLI or a broken hook must be LOUD once (the
*  operator cannot otherwise tell "nothing armed" from "the gate never
*  ran"), then quiet: a persistently-broken install cannot spam a
*  notification at every stop event. */
const GATE_DIAG_INTERVAL_MS = 15 * 6e4;
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
			stop: host.stop,
			userInput: host.userInput
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
		argumentCompletions: void 0,
		refuseStop: host.refuseStop,
		stopAlreadyRefused: host.stopAlreadyRefused,
		stopAborted: host.stopAborted,
		promptOf(event) {
			const turn = event;
			if (typeof turn.prompt === "string") return turn.prompt;
			return typeof turn.text === "string" ? turn.text : "";
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
		},
		npxPin: host.npxPin,
		hookEnv: hookEmitEnv(host.kind, { npxPin: host.npxPin })
	};
}
/**
* Wire bro into a host. `api` is the host's own extension API — the
* driver passes it through so the client can register commands and
* tools without a second channel.
*/
function createBroDriver(host, api, deps = {}) {
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
	/** Prompt-submit probes run when the host receives input, not when the
	* agent starts. Keep their answers until that input's turn begins. */
	const promptNudges = /* @__PURE__ */ new Map();
	/** Resolve the CLI once. Probing costs a spawn even where bro is
	*  inert, so it stays lazy. A *failed* resolution is not permanent:
	*  PATH, a local install or npx can appear mid-session, so a null
	*  answer expires after RESOLVE_RETRY_MS instead of poisoning the
	*  whole extension instance. */
	let resolved;
	let resolvedFailedAt;
	const resolve = deps.resolve ?? resolveCommand;
	const command = () => {
		if (resolved !== void 0 && (resolvedFailedAt === void 0 || Date.now() - resolvedFailedAt < RESOLVE_RETRY_MS)) return resolved;
		resolvedFailedAt = void 0;
		resolved = resolve({ npxPin: host.npxPin }).then((cmd) => {
			if (cmd === null) resolvedFailedAt = Date.now();
			return cmd;
		});
		return resolved;
	};
	/** Probe one bro hook — the verdict plus the failure class when the
	*  probe could not run. A bro-disabled dir is healthy silence (both
	*  fields null), never a failure: the repo simply didn't opt in. */
	const probeResult = async (event, payload, cwd, timeoutMs = HOOK_TIMEOUT_MS) => {
		if (!broEnabled(cwd)) return {
			control: null,
			failure: null
		};
		const cmd = await command();
		return cmd === null ? {
			control: null,
			failure: { kind: "no-cli" }
		} : callHookDetailed({
			command: cmd,
			event,
			payload,
			cwd,
			timeoutMs,
			extraEnv: host.hookEnv
		});
	};
	/** Probe one bro hook. Fail-open: every failure is "no opinion". */
	const probe = async (event, payload, cwd, timeoutMs = HOOK_TIMEOUT_MS) => (await probeResult(event, payload, cwd, timeoutMs)).control;
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
		if (pending === void 0 || pending.sessionId !== sessionId || hydrated === sessionId) return "";
		hydrated = sessionId;
		const text = (await pending.promise).trim();
		if (text !== "") return text;
		hydrated = void 0;
		if (hydrationFailed === sessionId && hydrationRetried !== sessionId) {
			hydrationRetried = sessionId;
			hydration = {
				sessionId,
				promise: probe("session-start", { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS).then(contextOf)
			};
		}
		return "";
	};
	/** Register one handler if the host has that event. */
	const bind = (name, handler) => {
		if (name === void 0) return;
		host.on(name, handler);
	};
	bind(host.events.sessionStart, (_event, ctx) => {
		gatedSession = void 0;
		hydrate(ctx, "session-start");
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionCompact, (_event, ctx) => {
		hydrate(ctx, "post-compaction");
		refreshBoard(ctx).catch(() => {});
	});
	bind(host.events.sessionBeforeCompact, async (_event, ctx) => {
		const cwd = host.cwd(ctx);
		const sessionId = host.sessionId(ctx);
		const text = contextOf(await probe("pre-compact", { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS));
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
		let nudge = promptNudges.get(sessionId);
		promptNudges.delete(sessionId);
		if (nudge === void 0 && host.events.userInput === void 0) nudge = probe("prompt-submit", {
			session_id: sessionId,
			prompt: host.promptOf(event)
		}, cwd).then(contextOf);
		const parts = [];
		const hydrationText = await consumeHydration(sessionId, cwd);
		if (hydrationText !== "") parts.push(hydrationText);
		const nudgeText = nudge === void 0 ? "" : (await nudge).trim();
		if (nudgeText !== "") parts.push(nudgeText);
		if (parts.length === 0) return;
		return host.inject(parts.join("\n\n"));
	});
	bind(host.events.userInput, (event, ctx) => {
		const prompt = host.promptOf(event);
		if (prompt === "") return;
		const sessionId = host.sessionId(ctx);
		const cwd = host.cwd(ctx);
		promptNudges.set(sessionId, probe("prompt-submit", {
			session_id: sessionId,
			prompt
		}, cwd).then(contextOf));
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
	/** The last gate diagnostic stamp — one warn per interval per driver
	*  instance. In-process on purpose: the diagnostic's own contract is
	*  "never break the gate", and in-memory state is the only store that
	*  cannot itself fail (a marker file could). A driver reload simply
	*  re-arms the window. */
	let gateDiagAt = 0;
	const gateDiag = (ctx, failure) => {
		const now = Date.now();
		if (now - gateDiagAt < GATE_DIAG_INTERVAL_MS) return;
		gateDiagAt = now;
		try {
			host.notify(ctx, `bro stop gate did not run — ${hookFailureText(failure)}; the stop is unguarded`, "warning");
		} catch {}
	};
	/** The healthy probe's verdict: a block refuses the stop; anything
	*  else lets it land — surfacing bro's hint when it left one. */
	const stopVerdict = (ctx, sessionId, control) => {
		if (control?.decision !== "block") {
			const hint = contextOf(control);
			if (hint !== "") host.notify(ctx, hint, "info");
			return;
		}
		gatedSession = sessionId;
		const reason = typeof control.reason === "string" ? control.reason.trim() : "";
		refreshBoard(ctx).catch(() => {});
		return host.refuseStop(reason === "" ? "unfinished bro work" : reason);
	};
	const stopGate = async (event, ctx, sessionId) => {
		if (host.stopAborted?.(event) === true) return;
		const { control, failure } = await probeResult("stop", {
			session_id: sessionId,
			stop_hook_active: gatedSession === sessionId || host.stopAlreadyRefused(event)
		}, host.cwd(ctx));
		if (failure !== null) {
			gateDiag(ctx, failure);
			return;
		}
		return stopVerdict(ctx, sessionId, control);
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
			windowsHide: true,
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
	let settled = false;
	const settle = (result) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(result);
	};
	const timer = setTimeout(() => {
		try {
			if (child.pid !== void 0 && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {}
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

//#endregion
//#region packages/agent-plugins/omp/src/omp-modes.ts
/**
* Install the bridges. Every handler is fail-open: a missing board, an
* empty claim list, or a fact bro does not have means the bridge
* contributes nothing rather than guessing.
*/
/** One bead as `id (title)` — the name shape every bridge line shares. */
const beadName = (b) => b.title ? `${b.id ?? "?"} (${b.title})` : b.id ?? "?";
/** The goal_updated context line — drill scope, the beads the objective
*  belongs to, and the claim advice, assembled flat. */
function goalScopeContext(board) {
	const drill = board?.drill?.frame;
	const scope = drill ? `bro scope: drill frame ${drill.id ?? "?"} — ${drill.title ?? "(untitled)"}. ` : "";
	const claims = board?.beads?.inProgress ?? [];
	const named = claims.map(beadName).join(", ");
	return `${scope}${claims.length === 0 ? "" : `bro scope: this objective belongs to the bead(s) in flight — ${named}. `}${claims.length === 0 ? "bro: claim a bead for this objective (`bro flow next`) so the exit gate can judge it;" : "bro: the exit gate judges this objective against that bead;"} \`bro work goal\` carries the condition across sessions.`;
}
function installModeBridges(pi, source) {
	/**
	* **Plan mode.** omp's Plan Review is the user's decision point; bro
	* answers the question the reviewer would otherwise have to guess:
	* which bead does this plan belong to, and is that bead's spec
	* covered by the draft?
	*
	* The facts ride back through the review's own feedback channel — the
	* review surface stays omp's, and the user still chooses.
	*/
	pi.on("plan_review_requested", () => {
		const board = source.board();
		if (board === null) return;
		const claims = board.beads?.inProgress ?? [];
		if (claims.length === 0) return;
		const named = claims.map(beadName).join(", ");
		return { additionalContext: `bro: ${claims.length} bead(s) in flight — ${named}. The plan must answer the claimed bead's spec; check it with \`bro spec check\`.` };
	});
	/**
	* **Goal mode.** bro's goal is a *judged* condition; omp's is a
	* budgeted objective. The bridge names the bead the objective
	* belongs to, so the work is claimed and bro's exit gate can judge
	* it when the objective claims to be met.
	*/
	pi.on("goal_updated", (event) => {
		const update = event;
		if (update.goal === null) return;
		if ((update.goal.objective ?? update.goal.text ?? "") === "") return;
		return { additionalContext: goalScopeContext(source.board()) };
	});
	/**
	* **Vibe mode / subagents.** Two workers must never edit one unit of
	* work. omp's `before_subagent_spawn` is the seam: bro can see the
	* claim list before a worker starts.
	*/
	pi.on("before_subagent_spawn", () => {
		const board = source.board();
		if (board === null) return;
		const running = (board.fleet?.agents ?? []).filter((a) => a.state === "running");
		if (running.length === 0) return;
		const ids = running.map((a) => a.id ?? "?");
		return { additionalContext: `bro: ${running.length} worker(s) already running (${ids.join(", ")}) — claim a bead before editing, so two workers never touch one unit of work.` };
	});
	/**
	* Prewalk and Advisor do not expose separate omp extension events. Their
	* real shared seam is prompt submission: return a hidden context message
	* there rather than inventing model-handoff/advisor event names.
	*/
	pi.on("before_agent_start", async (_event, ctx) => {
		if (source.modeContext === void 0) return;
		let results;
		try {
			results = await Promise.all([source.modeContext("prewalk", ctx.cwd), source.modeContext("advisor", ctx.cwd)]);
		} catch {
			return;
		}
		const [routing, debt] = results;
		const parts = [routing, debt].filter((part) => part !== null && part.trim() !== "");
		if (parts.length === 0) return;
		return { message: {
			customType: "bro-mode-context",
			content: parts.join("\n\n"),
			display: false
		} };
	});
}

//#endregion
//#region packages/agent-plugins/omp/src/omp.ts
/** The published version of this adapter — the npx fallback pin. The
*  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = "@broject/bro@0.3.0";
/**
* The omp binding: the host's own shape, nothing else. Every
* behavioral decision lives in the shared driver, so this file is the
* whole of "what is different about omp". The API is captured in the
* closure — a module-level variable would leak one session's host into
* another's.
*/
function binding(pi) {
	return { ...sharedBinding({
		kind: "omp",
		npxPin: NPX_PIN,
		stop: "session_stop",
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
			return {
				decision: "block",
				reason
			};
		},
		stopAlreadyRefused(event) {
			return event.stop_hook_active === true;
		}
	}) };
}
/** The extension entry point — omp calls this with its API. */
function broExtension(pi) {
	const driver = createBroDriver(binding(pi), pi);
	/** The mode bridges — bro's durable state handed to omp's native Plan,
	*  Goal and Vibe modes. See omp-modes.ts for why bro adds state
	*  rather than a second implementation of each mode. */
	installModeBridges(pi, {
		board: () => driver.board,
		async modeContext(kind, cwd) {
			const args = kind === "prewalk" ? [
				"fleet",
				"status",
				"--json"
			] : [
				"debt",
				"next",
				"--json"
			];
			const result = await driver.run(args, cwd);
			if (result.code !== 0 || result.stdout.trim() === "") return null;
			return `bro ${kind === "prewalk" ? "provider routing" : "review debt"} (read-only):\n${result.stdout.trim()}`;
		}
	});
}
/**
* Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
* foreign file holding this slot; the marker survives generation into
* plugins/omp/bro/bro.ts.
*/
const adapter = {
	id: "bro",
	kind: "omp-extension"
};

//#endregion
export { adapter, broExtension as default };