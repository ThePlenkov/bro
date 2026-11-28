// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";

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
const NPX_COMMAND = "npx";
const NPX_YES_FLAG = "-y";
const NPX_OFFLINE_FLAG = "--prefer-offline";
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
	const [cmd, ...args] = splitCommand(pinned);
	return cmd !== void 0 && await exitsZero(cmd, [...args, "hooks"]) ? {
		cmd,
		args
	} : null;
}
function splitCommand(command) {
	return command.trim().split(/\s+/).filter(Boolean);
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
	const timer = killAfter(child, timeoutMs, () => {
		settle({
			control: null,
			failure: {
				kind: "timeout",
				timeoutMs
			}
		});
	});
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
/** Spawn `command args`, capture stdout+stderr, kill the process group
*  on timeout. Never rejects — every failure mode lands in `error` or
*  a null `code`, because a read-verb caller's only question is what
*  printed. The nonzero exit IS the answer for gate verbs like
*  `act status`, so the code travels in the result. */
function runCommand(command, args, options) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				],
				windowsHide: true,
				detached: process.platform !== "win32"
			});
		} catch (error) {
			resolve({
				code: null,
				stdout: "",
				stderr: "",
				error: error instanceof Error ? error.message : String(error)
			});
			return;
		}
		runCollect(child, options, resolve);
	});
}
function runCollect(child, options, resolve) {
	const settle = once(resolve);
	let stdout = "";
	let stderr = "";
	const timer = killAfter(child, options.timeoutMs, () => settle({
		code: null,
		stdout,
		stderr,
		error: `timed out after ${options.timeoutMs}ms`
	}));
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout = appendOutput(stdout, chunk);
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		stderr = appendOutput(stderr, chunk);
	});
	child.on("error", (error) => {
		clearTimeout(timer);
		settle({
			code: null,
			stdout,
			stderr,
			error: error.message
		});
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		settle({
			code,
			stdout,
			stderr,
			error: null
		});
	});
	child.stdin?.on("error", () => {});
	child.stdin?.end(options.input ?? "");
}
function once(resolve) {
	let settled = false;
	return (result) => {
		if (settled) return;
		settled = true;
		resolve(result);
	};
}
function appendOutput(buffer, chunk) {
	const remaining = MAX_OUTPUT - buffer.length;
	return remaining > 0 ? buffer + chunk.slice(0, remaining) : buffer;
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
//#region packages/agent-plugins/opencode/src/rpc.ts
const bead = {
	type: "object",
	properties: {
		id: { type: "string" },
		title: { type: "string" },
		assignee: { type: "string" }
	},
	required: ["id", "title"],
	additionalProperties: false
};
const boardOutput = {
	type: "object",
	properties: {
		dirty: { type: "number" },
		dir: { type: "string" },
		branch: { type: "string" },
		inWork: {
			type: "array",
			items: bead
		},
		ready: {
			type: "array",
			items: bead
		},
		readyTotal: { type: "number" },
		agents: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					state: { type: "string" },
					provider: { type: "string" },
					model: { type: "string" },
					worktree: { type: "string" },
					pid: { type: "number" },
					step: { type: "string" }
				},
				required: ["id", "state"],
				additionalProperties: false
			}
		},
		fleetMax: { type: "number" },
		runs: {
			type: "array",
			items: {
				type: "object",
				properties: {
					slug: { type: "string" },
					state: { type: "string" },
					startedAt: { type: "number" }
				},
				required: ["slug", "state"],
				additionalProperties: false
			}
		},
		watch: {
			type: "object",
			properties: {
				ageMs: { type: "number" },
				attention: { type: "number" }
			},
			required: ["ageMs", "attention"],
			additionalProperties: false
		},
		act: {
			type: "object",
			properties: {
				pr: { type: "number" },
				url: { type: "string" }
			},
			required: ["pr", "url"],
			additionalProperties: false
		},
		worktrees: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					branch: { type: "string" },
					path: { type: "string" }
				},
				required: ["name"],
				additionalProperties: false
			}
		},
		attention: { type: "number" }
	},
	required: [
		"dirty",
		"inWork",
		"ready",
		"readyTotal",
		"agents",
		"fleetMax",
		"runs",
		"worktrees",
		"attention"
	],
	additionalProperties: false
};
const Bro = Rpc.define({
	id: "bro",
	methods: {
		board: {
			input: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			output: boardOutput
		},
		notify: {
			input: {
				type: "object",
				properties: {
					sessionID: { type: "string" },
					text: { type: "string" },
					title: { type: "string" },
					variant: {
						type: "string",
						enum: [
							"info",
							"success",
							"warning",
							"error"
						]
					}
				},
				required: ["text"],
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: { delivered: { type: "boolean" } },
				required: ["delivered"],
				additionalProperties: false
			},
			errors: { no_session: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				required: ["sessionID"],
				additionalProperties: false
			} }
		},
		prompt: {
			input: {
				type: "object",
				properties: {
					sessionID: { type: "string" },
					text: { type: "string" },
					agent: { type: "string" }
				},
				required: ["sessionID", "text"],
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: { accepted: { type: "boolean" } },
				required: ["accepted"],
				additionalProperties: false
			},
			errors: { no_session: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				required: ["sessionID"],
				additionalProperties: false
			} }
		}
	},
	events: {
		changed: { schema: {
			type: "object",
			properties: {
				inWork: { type: "number" },
				ready: { type: "number" },
				agents: { type: "number" }
			},
			required: [
				"inWork",
				"ready",
				"agents"
			],
			additionalProperties: false
		} },
		attention: { schema: {
			type: "object",
			properties: {
				title: { type: "string" },
				message: { type: "string" },
				severity: {
					type: "string",
					enum: [
						"info",
						"warning",
						"error"
					]
				}
			},
			required: [
				"title",
				"message",
				"severity"
			],
			additionalProperties: false
		} }
	}
});
/** The RPC id as it appears in the HTTP route (`/api/rpc/bro/board`). */
const BRO_RPC_ID = Bro.id;
/** `bro status --json` is the raw wire format; this turns it into the
*  board the contract publishes and the TUI renders. It lives in ONE
*  place on purpose: the server part serves the parsed board over RPC
*  and the TUI part reads THAT — so the sidebar and the RPC can never
*  disagree about what the board is.
*
*  Every field is defensive: JSON arrives unverified, and one malformed
*  row must drop that row, never the whole board. */
/** JSON numbers arrive unverified — counts, pids and epoch stamps are
*  integers by contract; a float (or non-number coerced by Number())
*  means the payload is not what `bro status` emits. */
const asInt = (value) => typeof value === "number" && Number.isInteger(value) ? value : void 0;
/** JSON array elements may be null or primitives — read fields only off
*  real objects or the cast crashes the whole board parse. */
const asObj = (value) => typeof value === "object" && value !== null ? value : null;
function parseBeads(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((row) => {
		const o = asObj(row);
		if (o === null) return [];
		if (typeof o.id !== "string" || typeof o.title !== "string") return [];
		const bead$1 = {
			id: o.id,
			title: o.title
		};
		if (typeof o.assignee === "string") bead$1.assignee = o.assignee;
		return [bead$1];
	});
}
function parseAgents(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((row) => {
		const o = asObj(row);
		if (o === null) return [];
		if (typeof o.id !== "string" || typeof o.state !== "string") return [];
		const agent = {
			id: o.id,
			state: o.state
		};
		if (typeof o.provider === "string") agent.provider = o.provider;
		if (typeof o.model === "string") agent.model = o.model;
		if (typeof o.worktree === "string") agent.worktree = o.worktree;
		const pid = asInt(o.pid);
		if (pid !== void 0) agent.pid = pid;
		if (typeof o.step === "string") agent.step = o.step;
		return [agent];
	});
}
function parseRuns(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((row) => {
		const o = asObj(row);
		if (o === null) return [];
		if (typeof o.slug !== "string" || typeof o.state !== "string") return [];
		const run = {
			slug: o.slug,
			state: o.state
		};
		const startedAt = asInt(o.startedAt);
		if (startedAt !== void 0) run.startedAt = startedAt;
		return [run];
	});
}
function parseWorktrees(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((row) => {
		const o = asObj(row);
		if (o === null) return [];
		if (typeof o.name !== "string") return [];
		const wt = { name: o.name };
		if (typeof o.branch === "string") wt.branch = o.branch;
		if (typeof o.path === "string") wt.path = o.path;
		return [wt];
	});
}
/** The empty board — a rig with no bro, a failed read, a parse error.
*  The widget hides on an empty board; the RPC still answers. */
function emptyBoard() {
	return {
		dirty: 0,
		inWork: [],
		ready: [],
		readyTotal: 0,
		agents: [],
		fleetMax: 0,
		runs: [],
		worktrees: [],
		attention: 0
	};
}
function addBoardMetadata(board, value) {
	if (typeof value.dir === "string") board.dir = value.dir;
	if (typeof value.branch === "string") board.branch = value.branch;
	const watch = asObj(value.watch);
	if (watch !== null) board.watch = {
		ageMs: asInt(watch.ageMs) ?? 0,
		attention: asInt(watch.attention) ?? 0
	};
	const act = asObj(value.act);
	if (act !== null && typeof act.pr === "number" && typeof act.url === "string") board.act = {
		pr: act.pr,
		url: act.url
	};
}
/** Parse `bro status --json` output into the board. Unparseable output
*  yields the EMPTY board — never a throw, never a partial lie. */
function parseBoard(out) {
	let parsed;
	try {
		parsed = JSON.parse(out);
	} catch {
		return emptyBoard();
	}
	const o = asObj(parsed);
	if (o === null) return emptyBoard();
	const beads = asObj(o.beads) ?? {};
	const fleet = asObj(o.fleet) ?? {};
	const loop = asObj(o.loop) ?? {};
	const board = {
		dirty: asInt(o.dirty) ?? 0,
		inWork: parseBeads(beads.inProgress),
		ready: parseBeads(beads.ready),
		readyTotal: asInt(beads.readyTotal) ?? 0,
		agents: parseAgents(fleet.agents),
		fleetMax: asInt(fleet.maxConcurrent) ?? 0,
		runs: parseRuns(loop.runs),
		worktrees: parseWorktrees(o.worktrees),
		attention: asInt(o.attention) ?? 0
	};
	addBoardMetadata(board, o);
	return board;
}

//#endregion
//#region packages/agent-plugins/opencode/src/opencode.ts
const DEFAULT_STOP_REASON = "unfinished bro work";
const BLOCKED_TOOL_REASON = "blocked by bro";
const DEFAULT_COMMAND_OUTPUT = "(no output)";
function makePersistence(storage) {
	if (!storage?.get || !storage.set) return void 0;
	return {
		load: () => storage.get?.("stop-gated") ?? Promise.resolve(void 0),
		save: (ids) => Promise.resolve(storage.set?.("stop-gated", [...ids])).then(() => void 0)
	};
}
/** Last-resort npx fallback specs, pinned first then latest — gen-plugins
*  lists this file in VERSIONED_SOURCES, so the pin is rewritten to
*  plugin.json's version on every gen/release run. */
const NPX_SPECS = ["@broject/bro@0.3.0", "@broject/bro"];
/** Env stamped on every `bro hooks` spawn so the CLI's adapter emit
*  path journals this session into the hook spool — the in-process
*  adapters bypass run.sh, which owns the shell-side writer
*  (specs/bro-izpyk.9.md). A CLI that predates the marker ignores
*  the env, so old↔new mixes degrade to the pre-emit status quo. */
const HOOK_ENV = hookEmitEnv("opencode", { npxPin: NPX_SPECS[0] });
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function errorText(err) {
	return err instanceof Error ? err.message : String(err);
}
function isCleanSession(sessionID, clean) {
	return typeof sessionID === "string" && clean.delete(sessionID);
}
async function logControlHint(control, log) {
	const hint = contextOf(control);
	if (hint) await log("info", hint);
}
async function logAlreadyGated(reason, log) {
	await log("info", `stop gate: already gated — not re-prompting (${reason || DEFAULT_STOP_REASON})`);
}
function stopReason(control) {
	return typeof control?.reason === "string" ? control.reason.trim() : "";
}
function pushSystem(system, text) {
	if (system) system.push({
		type: "text",
		text
	});
}
function mergedToolInput(control, input) {
	const override = asRecord(asRecord(control.hookSpecificOutput)?.tool_input);
	return override ? {
		...asRecord(input),
		...override
	} : null;
}
function assertToolAllowed(control) {
	if (control.decision !== "block" && control.decision !== "deny") return;
	throw new Error(stopReason(control) || BLOCKED_TOOL_REASON);
}
function permissionEffect(control) {
	if (control?.decision === "approve") return "allow";
	if (control?.decision === "deny" || control?.decision === "block") return "deny";
}
async function finishStopGate(options) {
	const { control, sessionID, stillAlive, gated, persistGated, log, reprompt } = options;
	const reason = stopReason(control);
	if (gated.has(sessionID)) {
		await logAlreadyGated(reason, log);
		return;
	}
	gated.add(sessionID);
	persistGated();
	const message = reason || DEFAULT_STOP_REASON;
	await log("warn", `stop gate: ${message}`);
	if (!stillAlive()) return;
	try {
		await reprompt(sessionID, message);
	} catch (err) {
		await log("error", `stop gate could not re-prompt: ${errorText(err)}`);
	}
}
/** Did the tool succeed? bro arms its gates and cites skills only on success,
* so a false positive here is worse than a false negative.
*
*  opencode's bash metadata is `{ output, exit, truncated }` — there is no
*  `error` field on a nonzero exit, so keying on `error` alone reads every
*  failure as a success. Honour `exit` when the tool reports it and fall back
*  to the error key for tools that only set that. */
function toolSucceeded(metadata) {
	if (metadata?.error !== void 0) return false;
	return typeof metadata?.exit === "number" ? metadata.exit === 0 : true;
}
function makeCore(input) {
	const directory = input.directory;
	const options = input.options;
	const log = input.log;
	const getCommand = createCommandResolver({
		command: options?.command,
		npxSpecs: NPX_SPECS
	});
	const notify = (level, message) => {
		log(level, message).catch(() => {});
	};
	let lastStopWarning = 0;
	const probe = async (event, payload, timeoutMs = HOOK_TIMEOUT_MS) => {
		const resolved = await getCommand();
		if (!resolved) {
			notify("debug", `bro probe skipped (no cli) for event=${event}`);
			return null;
		}
		const result = await callHookDetailed(resolved, {
			event,
			payload,
			cwd: directory,
			timeoutMs,
			extraEnv: HOOK_ENV
		});
		if (result.failure !== null) {
			const message = hookFailureText(result.failure);
			if (event === "stop" && Date.now() - lastStopWarning >= 15 * 6e4) {
				lastStopWarning = Date.now();
				notify("warn", `stop gate did not run (${message})`);
			} else notify("debug", `probe failed (${message})`);
		} else if (result.control === null) notify("debug", `bro probe returned null for event=${event}`);
		return result.control;
	};
	/** Spawn `<bro> args` and capture stdout — the read-verb path tool
	* executions and commands share. Never rejects: no resolved CLI,
	* a spawn error, or a timeout resolves with what printed. The code
	* travels in the result because a nonzero exit IS the answer for
	* gate verbs like `act status`. */
	const exec = (args) => getCommand().then(async (resolved) => {
		if (resolved === null) return {
			code: 127,
			out: "",
			err: "no bro command resolved"
		};
		const result = await runCommand(resolved.cmd, [...resolved.args, ...args], {
			cwd: directory,
			timeoutMs: RUN_TIMEOUT_MS
		});
		return {
			code: result.code ?? (result.error !== null && result.error.startsWith("timed out") ? 124 : 127),
			out: result.stdout.trim(),
			err: (result.stderr !== "" ? result.stderr : result.error ?? "").trim()
		};
	});
	/** Rehydration is per session, not per turn: the context hook runs on every
	* request, so the probe runs once and the answer is re-pushed each turn —
	* which is also what carries it across compaction. The cache holds the
	* in-flight promise, not its result, so a `session.created` prime and a
	* first turn racing each other share one probe instead of two. A FAILED
	* probe is evicted rather than cached — timing out once is not the
	* session's verdict, and the next turn deserves a retry; only a real
	* answer (including an empty one) is sticky. */
	const rehydration = /* @__PURE__ */ new Map();
	const hydrate = (sessionID, event) => {
		const pending = rehydration.get(sessionID);
		if (pending) return pending;
		notify("debug", `bro hydrate starting for session=${sessionID} event=${event}`);
		const started = probe(event, { session_id: sessionID }, REHYDRATION_TIMEOUT_MS).then((control) => {
			if (control === null && rehydration.get(sessionID) === started) rehydration.delete(sessionID);
			const ctx = contextOf(control);
			if (ctx) notify("debug", `bro hydrate injected context for session=${sessionID} len=${ctx.length}`);
			return ctx;
		});
		rehydration.set(sessionID, started);
		return started;
	};
	/** Sessions that already got their one re-prompt. */
	const gated = /* @__PURE__ */ new Set();
	const persistGated = () => {
		input.persist?.save([...gated]).catch(() => {});
	};
	/** Ids deleted while the persisted snapshot is still in flight — the
	* merge would otherwise resurrect the gate onto a session reusing the
	* id and its first block would be swallowed as a repeat. */
	const retiredDuringLoad = /* @__PURE__ */ new Set();
	let persistLoaded = input.persist === void 0;
	if (input.persist) input.persist.load().then((stored) => {
		if (Array.isArray(stored)) {
			for (const id of stored) if (typeof id === "string" && !retiredDuringLoad.has(id)) gated.add(id);
		}
	}).catch(() => {}).finally(() => {
		persistLoaded = true;
		retiredDuringLoad.clear();
	});
	/** Sessions whose last assistant turn finished cleanly. */
	const clean = /* @__PURE__ */ new Set();
	/** Sessions observed alive. `session.deleted` is the only retirement, and
	* the idle gate suspends on real I/O — liveness is re-checked after each
	* suspending await before the re-prompt goes out, never assumed. The
	* value is an instance token minted per observing event, not membership:
	* a delete followed by an id-reusing create leaves the map occupied by a
	* *different* session, and a bare `has` would wave a stale gate through
	* to it. */
	const live = /* @__PURE__ */ new Map();
	let liveSeq = 0;
	/** `session.deleted` retires the per-session structures — they live as
	* long as the plugin process, not the session, so without this a
	* long-lived server accumulates dead entries. */
	const onSessionDeleted = (props) => {
		const sessionID = asRecord(props.info)?.id ?? props.sessionID;
		if (typeof sessionID !== "string") return;
		rehydration.delete(sessionID);
		if (!persistLoaded) retiredDuringLoad.add(sessionID);
		if (gated.delete(sessionID)) persistGated();
		clean.delete(sessionID);
		live.delete(sessionID);
	};
	/** `session.compacted` re-primes the cache so the next turn pushes
	* post-compaction state instead of the pre-compaction snapshot. */
	const onSessionCompacted = (props) => {
		const sessionID = props.sessionID;
		if (typeof sessionID !== "string") return;
		rehydration.delete(sessionID);
		hydrate(sessionID, "post-compaction");
	};
	/** Turn completion is the stop gate — `session.idle` on v1 hosts,
	*  `session.execution.succeeded` on v2. Gated sessions pass
	*  `stop_hook_active`, so bro skips its own re-evaluation — the
	*  one-shot guard is bro's, not duplicated here. */
	const onSessionIdle = async (props) => {
		const sessionID = props.sessionID;
		if (!isCleanSession(sessionID, clean)) return;
		const instance = live.get(sessionID);
		const stillAlive = () => instance !== void 0 && live.get(sessionID) === instance;
		const control = await probe("stop", {
			session_id: sessionID,
			stop_hook_active: gated.has(sessionID)
		});
		if (control?.decision !== "block") {
			await logControlHint(control, log);
			return;
		}
		if (!stillAlive()) return;
		await finishStopGate({
			control,
			sessionID,
			stillAlive,
			gated,
			persistGated,
			log,
			reprompt: input.reprompt
		});
	};
	/** Dispatches the v2 event stream into core handlers.
	*
	*  opencode ≥2.x never emits the v1 names — `session.idle` is declared
	*  in the schema but nothing publishes it (opencode#55358), and
	*  `session.created`/`message.updated`/`session.compacted` are absent
	*  from the public stream (verified live on 2.2.7). The v2 lifecycle
	*  is `session.execution.{started,succeeded,failed,interrupted}` plus
	*  `session.compaction.*` and `session.deleted` (that name survived).
	*  A succeeded execution is simultaneously the clean-turn verdict and
	*  the idle moment, so it feeds both the `clean` set and the stop
	*  gate in one step. */
	const onEvent = async (type, props) => {
		const sessionID = typeof props.sessionID === "string" ? props.sessionID : void 0;
		if (sessionID !== void 0 && !live.has(sessionID)) live.set(sessionID, ++liveSeq);
		switch (type) {
			case "session.execution.started":
				if (sessionID !== void 0) hydrate(sessionID, "session-start");
				return;
			case "session.execution.succeeded":
				if (sessionID === void 0) return;
				clean.add(sessionID);
				await onSessionIdle({ sessionID });
				return;
			case "session.execution.failed":
			case "session.execution.interrupted":
				if (sessionID !== void 0) clean.delete(sessionID);
				return;
			case "session.compaction.succeeded":
			case "session.compaction.ended":
				onSessionCompacted(props);
				return;
			case "session.deleted":
				onSessionDeleted(props);
				return;
		}
	};
	return {
		probe,
		hydrate,
		onEvent,
		exec
	};
}
/**
* Mint a declared RPC error, tolerating a host that hands us no context.
*
* The contract's `errors` map is the promise to the caller: `no_session`
* comes back as `no_session`, not as a 500 and not as a crash. The host
* provides `context.error`; when it is missing we still have to answer
* with SOMETHING shaped like the declared error, so we build it by hand.
*/
function declaredError(context, type, message, data) {
	if (typeof context?.error === "function") try {
		return context.error(type, message, data);
	} catch {}
	return {
		type,
		message,
		data
	};
}
/** Permission evaluation carries `resources` — for a bash ask, the command
* segments. The classifier wants the whole ask joined. */
function evalCommand(event) {
	const resources = Array.isArray(event.resources) ? event.resources.filter((r) => typeof r === "string") : [];
	if (resources.length > 0) return resources.join(" && ");
	for (const key of [
		"command",
		"cmd",
		"pattern"
	]) {
		const value = event.metadata?.[key];
		if (typeof value === "string") return value;
	}
	return "";
}
/** bro read-verbs exposed as `bro_<name>` model tools — args pinned so
* the model gets reads, never arbitrary bro. */
const BRO_TOOLS = [
	{
		name: "status",
		description: "bro live board — beads in-progress/ready, fleet agents, drill frame, branch (--json)",
		args: ["status", "--json"]
	},
	{
		name: "convoy_status",
		description: "bro molecule DAG — done/ready/blocked steps for the open convoy",
		args: ["convoy", "status"]
	},
	{
		name: "act_status",
		description: "PR review exit gate — nonzero while blocked; the exit code IS the verdict (--json)",
		args: [
			"act",
			"status",
			"--json"
		]
	},
	{
		name: "fleet",
		description: "fleet snapshot — mols × steps × agents × worktrees × PRs",
		args: ["fleet"]
	},
	{
		name: "next",
		description: "bro next actionable work — pick the next ready bead respecting constraints",
		args: ["next", "--list"]
	},
	{
		name: "drill_status",
		description: "current drill frame status — scoped investigation context",
		args: [
			"work",
			"drill",
			"status"
		]
	},
	{
		name: "review_threads",
		description: "unresolved PR review threads for current branch/PR",
		args: [
			"review",
			"act",
			"threads"
		]
	},
	{
		name: "worktree_status",
		description: "worktree and branch hygiene — dirty/uncommitted changes",
		args: ["status", "--json"]
	}
];
/** Tool registration options — `codemode: false` keeps the reads as
* direct `bro_*` function tools; the plugin SDK's `Info.options` type
* predates the field, so the literal is widened once here. */
const BRO_TOOL_OPTIONS = {
	namespace: "bro",
	codemode: false
};
/** `/bro` arguments — whitespace-split with "…"/'…' holding a multiword
* value together (`/bro learn capture "a note"` must not shred the
* note into four argv entries). Unmatched quotes degrade to the plain
* token — a mangled command still runs. */
function splitArgs(input) {
	const args = [];
	for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) args.push(m[1] ?? m[2] ?? m[3] ?? m[0]);
	return args;
}
function cleanCommandOutput(body) {
	return body.split("\n").filter((line) => {
		if (!line.trim()) return true;
		const words = line.trim().toLowerCase().split(/\s+/);
		return !(words[0] === "bro" && words[1] === "learn");
	}).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function tryPrompt(prompt, sessionID, text) {
	if (!prompt) return false;
	try {
		await prompt({
			sessionID,
			text
		});
		return true;
	} catch {
		return false;
	}
}
function readNotification(input) {
	const { sessionID, text, title, variant } = asRecord(input) ?? {};
	if (typeof text !== "string" || text.trim() === "") return null;
	return {
		sessionID: validSessionID(sessionID),
		title: validTitle(title),
		message: warningMessage(text, variant),
		severity: notificationSeverity(variant)
	};
}
function validSessionID(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function validTitle(value) {
	return typeof value === "string" && value.trim() !== "" ? value : "bro";
}
function warningMessage(text, variant) {
	return variant === "error" || variant === "warning" ? `⚠ ${text}` : text;
}
function notificationSeverity(variant) {
	if (variant === "error") return "error";
	if (variant === "warning") return "warning";
	return "info";
}
async function submitPrompt(options) {
	const { switchAgent, prompt, sessionID, text, agent } = options;
	if (agent) await switchAgent?.({
		sessionID,
		agent
	});
	await prompt?.({
		sessionID,
		text
	});
	return true;
}
/** Where the nudge lands on a tool result — `output`/`content` take text
* directly; anything else rides metadata as `broContext`. */
function appendToolResult(result, text) {
	if (result === null) return { metadata: { broContext: text } };
	if (typeof result.output === "string") return {
		...result,
		output: `${result.output}\n\n${text}`
	};
	if (typeof result.content === "string") return {
		...result,
		content: `${result.content}\n\n${text}`
	};
	return {
		...result,
		metadata: {
			...asRecord(result.metadata),
			broContext: text
		}
	};
}
function readSkillFile(reader, root, entry) {
	const path = join(root, entry, "SKILL.md");
	try {
		if (!reader.stat(path).isFile()) return null;
		const content = reader.read(path, "utf8");
		const parsed = parseSkill(content);
		if (!parsed) return null;
		return {
			id: entry,
			name: parsed.name ?? entry,
			description: parsed.description ?? "",
			path,
			content
		};
	} catch {
		return null;
	}
}
/** Parse a `SKILL.md` frontmatter block — `name`, `description`, and the
* optional `autoinvoke` flag. A file without frontmatter is not a skill;
* it is skipped rather than half-registered. */
function parseSkill(markdown) {
	const front = frontmatter(markdown);
	if (front === null) return null;
	const name = readFrontmatterValue(front, "name");
	const description = readFrontmatterValue(front, "description");
	if (!name || !description) return null;
	return {
		name: name.replace(/^["']|["']$/g, ""),
		description: description.replace(/^["']|["']$/g, "")
	};
}
function frontmatter(markdown) {
	if (!markdown.startsWith("---")) return null;
	const end = markdown.indexOf("\n---", 3);
	return end < 0 ? null : markdown.slice(3, end);
}
function readFrontmatterValue(front, key) {
	return (key === "name" ? /^\s*name:\s*(\S[^\r\n]*)/m : /^\s*description:\s*(\S[^\r\n]*)/m).exec(front)?.[1]?.trim();
}
/** Auto-discovered skills roots must look like BRO's tree before they
*  are registered — the ancestor walk-up can land on a foreign `skills/`
*  dir (e.g. opencode's own `~/.config/opencode/skills`), and registering
*  somebody else's skills under bro's name is worse than registering
*  none. `sdd` is bro's canonical skill — every shipped tree carries it.
*  An explicit `skillsDir` is the operator's choice and skips the check. */
const BRO_SKILLS_SENTINEL = "sdd";
function isBroSkillsRoot(root) {
	try {
		return statSync(join(root, BRO_SKILLS_SENTINEL, "SKILL.md")).isFile();
	} catch {
		return false;
	}
}
/** The directories that may hold bro's skills, most specific first:
*  an explicit option, the materialized sibling `skills/`, the npm
*  package's `skills/`, then the checkout's `skills/`.
*
*  An explicit `skillsDir` is AUTHORITATIVE: it is the only root tried.
*  Falling back to the checkout when it points nowhere would register a
*  different skill set than the operator asked for — a silent mismatch
*  between what was configured and what opencode learned. */
function skillRoots(options) {
	if (typeof options?.skillsDir === "string" && options.skillsDir.trim() !== "") return [options.skillsDir];
	const roots = [];
	roots.push(fileURLToPath(new URL("./skills", import.meta.url)));
	roots.push(fileURLToPath(new URL("../skills", import.meta.url)));
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		roots.push(join(dir, "skills"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return roots;
}
async function BroSetup(ctx) {
	const log = (level, message) => {
		try {
			console.error(`[bro] ${level}: ${message}`);
		} catch {}
		return Promise.resolve(void 0);
	};
	const core = makeCore({
		directory: ctx.location?.directory ?? process.cwd(),
		options: ctx.options,
		log,
		reprompt: (sessionID, text) => {
			const session = ctx.session;
			const fn = session?.prompt?.bind(session) ?? session?.synthetic?.bind(session);
			return fn ? fn({
				sessionID,
				text
			}) : Promise.resolve(void 0);
		},
		persist: makePersistence(ctx.storage)
	});
	const pendingPromptContext = /* @__PURE__ */ new Map();
	const registrations = [];
	const register = (r) => {
		if (r) registrations.push(r.catch(() => void 0));
	};
	register(ctx.session?.hook?.("context", async (event) => {
		const sessionID = event.sessionID;
		if (!sessionID || event.system === void 0) return;
		const text = await core.hydrate(sessionID, "session-start");
		if (text) pushSystem(event.system, text);
		const pending = pendingPromptContext.get(sessionID);
		if (pending) {
			pushSystem(event.system, pending);
			pendingPromptContext.delete(sessionID);
		}
	}));
	register(ctx.session?.hook?.("compaction", async (event) => {
		try {
			const text = contextOf(await core.probe("pre-compact", { session_id: event.sessionID }, REHYDRATION_TIMEOUT_MS));
			if (text && event.system !== void 0) event.system.push({
				type: "text",
				text
			});
		} catch {}
	}));
	register(ctx.session?.hook?.("prompt", async (event) => {
		const prompt = event.prompt;
		if (prompt === void 0) return;
		const text = contextOf(await core.probe("prompt-submit", {
			session_id: event.sessionID,
			prompt: prompt.text ?? ""
		}));
		if (text && event.sessionID) pendingPromptContext.set(event.sessionID, text);
	}));
	register(ctx.tool?.hook?.("execute.before", async (event) => {
		const control = await core.probe("pre-tool", {
			session_id: event.sessionID,
			tool_name: event.tool,
			tool_input: asRecord(event.input) ?? {}
		});
		if (control === null) return;
		const merged = mergedToolInput(control, event.input);
		if (merged) event.input = merged;
		assertToolAllowed(control);
	}));
	register(ctx.tool?.hook?.("execute.after", async (event) => {
		const result = asRecord(event.result);
		const text = contextOf(await core.probe("post-tool", {
			session_id: event.sessionID,
			tool_name: event.tool,
			tool_input: asRecord(event.input) ?? asRecord(event.args) ?? {},
			tool_response: { success: event.status !== "error" && toolSucceeded(asRecord(result?.metadata)) }
		}));
		if (text) event.result = appendToolResult(result, text);
	}));
	register(ctx.permission?.hook?.("evaluate", async (event) => {
		const command = evalCommand(event);
		if (!command) return;
		const control = await core.probe("permission", {
			tool_input: { command },
			session_id: event.sessionID
		});
		const effect = permissionEffect(control);
		if (!effect) return;
		event.effect = effect;
		const reason = stopReason(control);
		if (reason) event.message = reason;
	}));
	register(ctx.shell?.hook?.("create.before", (event) => {
		if (event.env === void 0) return;
		event.env.BRO_AGENT_ID ??= "opencode";
	}));
	register(ctx.tool?.transform?.((editor) => {
		editor.namespace?.({
			name: "bro",
			description: "bro orchestration reads"
		});
		for (const tool of BRO_TOOLS) editor.add?.({
			name: tool.name,
			description: tool.description,
			input: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			options: BRO_TOOL_OPTIONS,
			execute: async () => {
				const { code, out, err } = await core.exec(tool.args);
				const body = out || err || DEFAULT_COMMAND_OUTPUT;
				return { content: code === 0 ? body : `exit ${code}: ${body}` };
			}
		});
	}));
	register(ctx.command?.transform?.((editor) => {
		const run = async (sessionID, argv, label) => {
			if (!sessionID || !ctx.session?.prompt) return;
			const { code, out, err } = await core.exec(argv);
			const body = cleanCommandOutput(out || err || DEFAULT_COMMAND_OUTPUT);
			const suffix = code === 0 ? "" : ` (exit ${code})`;
			await ctx.session.prompt({
				sessionID,
				text: `${label}${suffix}:\n${body}`
			});
		};
		editor.add?.({
			name: "bro",
			description: "bro orchestration — `/bro [args]` runs the CLI and submits the output",
			execute: async ({ sessionID, prompt }) => {
				const args = splitArgs(prompt?.text ?? "");
				const verb = args.length > 0 ? args : ["status"];
				await run(sessionID, verb, `bro ${verb.join(" ")}`);
			}
		});
		const natives = new Set(["goal"]);
		for (const c of BRO_COMMANDS) {
			const name = natives.has(c.name) ? `bro:${c.name}` : c.name;
			editor.add?.({
				name,
				description: c.description,
				execute: async ({ sessionID, prompt }) => {
					const args = splitArgs(prompt?.text ?? "");
					const verb = [c.verb, ...args];
					await run(sessionID, verb, `bro ${verb.join(" ")}`);
				}
			});
		}
	}));
	if (typeof ctx.options?.mcpPort === "number") {
		const mcpPort = ctx.options.mcpPort;
		register(ctx.mcp?.transform?.((editor) => {
			editor.set?.("bro", {
				type: "remote",
				url: `http://127.0.0.1:${mcpPort}`
			});
		}));
	}
	const boardSnapshot = async () => {
		const { code, out } = await core.exec(["status", "--json"]);
		if (code !== 0 || out === "") return emptyBoard();
		return parseBoard(out);
	};
	const rpcRegistration = ctx.rpc?.register?.(Bro, {
		board: async () => boardSnapshot(),
		notify: async (input, _context) => {
			const notification = readNotification(input);
			if (!notification) return { delivered: false };
			const { sessionID, title, message, severity } = notification;
			if (sessionID && await tryPrompt(ctx.session?.prompt, sessionID, `${title}: ${message}`)) return { delivered: true };
			await emitRpc("attention", {
				title,
				message,
				severity
			});
			return { delivered: true };
		},
		prompt: async (input, context) => {
			const { sessionID, text, agent } = asRecord(input) ?? {};
			if (typeof sessionID !== "string" || sessionID === "") return declaredError(context, "no_session", "sessionID is required", { sessionID: "" });
			if (typeof text !== "string" || text.trim() === "") return { accepted: false };
			try {
				await submitPrompt({
					switchAgent: ctx.session?.switchAgent,
					prompt: ctx.session?.prompt,
					sessionID,
					text,
					agent: typeof agent === "string" && agent !== "" ? agent : void 0
				});
				return { accepted: true };
			} catch {
				return declaredError(context, "no_session", "session not available", { sessionID });
			}
		}
	});
	let emitRpc = async () => void 0;
	register((rpcRegistration ?? Promise.resolve(void 0))?.then((reg) => {
		if (reg !== void 0) emitRpc = async (name, data) => {
			try {
				await reg.events.emit(name, data);
			} catch {}
		};
		return reg;
	}));
	const skills = await collectBroSkills(ctx.options);
	if (skills.length > 0) register(ctx.skill?.transform?.((editor) => {
		for (const skill of skills) editor.add?.({
			id: skill.id,
			name: skill.name,
			description: skill.description,
			path: skill.path,
			content: skill.content
		});
	}));
	const controller = new AbortController();
	const stream = ctx.event?.subscribe?.({ signal: controller.signal });
	if (stream) (async () => {
		for await (const raw of stream) {
			const e = asRecord(raw);
			const type = typeof e?.type === "string" ? e.type : "";
			if (type) core.onEvent(type, asRecord(e?.properties) ?? asRecord(e?.data) ?? {}).catch(() => {});
		}
	})().catch(() => {});
	await log("info", `plugin ready — ${skills.length} bro skill(s), RPC 'bro' registered`);
	return async () => {
		controller.abort();
		for (const pending of registrations) try {
			const registration = await pending;
			if (registration?.dispose) await registration.dispose();
		} catch {}
	};
}
/** Read bro's skills off disk and shape them for opencode's registry.
*  Every failure mode — a missing tree, an unreadable file, a file
*  without frontmatter — drops that one skill, never the whole set. */
async function collectBroSkills(options) {
	const { readdirSync, readFileSync, statSync: statSync$1 } = await import("node:fs");
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const explicit = typeof options?.skillsDir === "string" && options.skillsDir.trim() !== "";
	for (const root of skillRoots(options)) {
		if (!explicit && !isBroSkillsRoot(root)) continue;
		let entries;
		try {
			if (!existsSync(root)) continue;
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const skill = readSkillFile({
				stat: statSync$1,
				read: readFileSync
			}, root, entry);
			if (!skill) continue;
			const id = entry;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(skill);
		}
		if (out.length > 0) break;
	}
	return out;
}
/** `Plugin.define` at runtime — opencode's own loader is what reads the
*  default export, and the published contract asks for this exact shape.
*  The cast below narrows the SDK's stricter signature back to the
*  structural one the implementation actually honours. */
const defined = Plugin.define({
	id: "bro",
	setup: BroSetup
});
var opencode_default = defined;

//#endregion
export { BroSetup, collectBroSkills, opencode_default as default, isBroSkillsRoot, skillRoots, toolSucceeded };