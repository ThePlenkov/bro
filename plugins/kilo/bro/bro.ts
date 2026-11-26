// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
import { tool } from "@kilocode/plugin/tool";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

//#region packages/agent-plugins/adapter-core/src/core.ts
/** How long a normal hook probe may take. */
const HOOK_TIMEOUT_MS = 15e3;
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
//#region packages/agent-plugins/kilo/src/kilo.ts
/** Last-resort npx fallback specs, pinned first then latest — gen-plugins
*  lists this file in VERSIONED_SOURCES, so the pin is rewritten to
*  plugin.json's version on every gen/release run. */
const NPX_SPECS = ["@broject/bro@0.3.0", "@broject/bro"];
/** Env stamped on every `bro hooks` spawn so the CLI's adapter emit
*  path journals this session into the hook spool — the in-process
*  adapters bypass run.sh, which owns the shell-side writer
*  (specs/bro-izpyk.9.md). A CLI that predates the marker ignores
*  the env, so old↔new mixes degrade to the pre-emit status quo. */
const HOOK_ENV = hookEmitEnv("kilo", { npxPin: NPX_SPECS[0] });
const GATE_DIAG_INTERVAL_MS = 6e4;
/** Auto-approve only a plain bro/bd/npx-bro invocation — no shell
*  metacharacters in args (a metachar just means the ask goes to the
*  user; auto-approve fails closed, never wrong). */
const SHELL_META_CHARACTERS = new Set([
	";",
	"&",
	"|",
	"`",
	"<",
	">",
	"$",
	"(",
	")",
	"\\",
	"\n",
	"\r"
]);
function isSafeCommand(command) {
	const trimmed = command.trim();
	if (trimmed === "" || [...trimmed].some((character) => SHELL_META_CHARACTERS.has(character))) return false;
	const words = trimmed.split(/\s+/);
	if (words[0] === "bro" || words[0] === "bd") return true;
	if (words[0] !== "npx") return false;
	return words[words[1] === "-y" ? 2 : 1] === "@broject/bro";
}
function asRecord(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}
function hookOutcome(result) {
	if (result.error !== null) return {
		control: null,
		failure: result.error
	};
	if (result.code !== 0) return {
		control: null,
		failure: `the hook exited ${result.code ?? "with no exit code"}`
	};
	const control = firstControl(result.stdout);
	if (control === null) return {
		control: null,
		failure: result.stdout === "" ? null : "the hook answered with no control object"
	};
	return {
		control,
		failure: null
	};
}
/** First JSON object on the hook's stdout; non-JSON lines are
*  diagnostic chatter. null when nothing parses. */
function firstControl(stdout) {
	for (const line of stdout.split("\n")) {
		const text = line.trim();
		if (text === "") continue;
		try {
			const parsed = asRecord(JSON.parse(text));
			if (parsed !== null) return parsed;
		} catch {}
	}
	return null;
}
const BroPlugin = async (input) => {
	const { directory, client } = input;
	const broArgv = input.broArgv;
	const getCommand = createCommandResolver({ npxSpecs: NPX_SPECS });
	/** Run one bro hook event; null on every failure mode (fail-open).
	*  `bro hooks` itself no-ops in a repo that never opted in. */
	const runBroHook = async (event, input$1) => {
		if (broArgv !== void 0) return callHookDetailed({
			cmd: broArgv[0] ?? "",
			args: broArgv.slice(1)
		}, {
			event,
			payload: input$1,
			cwd: directory,
			timeoutMs: HOOK_TIMEOUT_MS,
			extraEnv: HOOK_ENV
		});
		const resolved = await getCommand();
		return resolved === null ? {
			control: null,
			failure: { kind: "no-cli" }
		} : callHookDetailed(resolved, {
			event,
			payload: input$1,
			cwd: directory,
			timeoutMs: HOOK_TIMEOUT_MS,
			extraEnv: HOOK_ENV
		});
	};
	const run = async (sub, args) => {
		const resolved = await getCommand();
		if (resolved === null) return "error: no bro command resolved";
		const result = await runCommand(resolved.cmd, [
			...resolved.args,
			sub,
			...args
		], {
			cwd: directory,
			timeoutMs: RUN_TIMEOUT_MS
		});
		if (result.error !== null && result.code === null) return `error: ${result.error}`;
		return result.stdout + result.stderr;
	};
	const liveSessions = /* @__PURE__ */ new Set();
	const hydratedContexts = /* @__PURE__ */ new Map();
	let hydrationToken = 0;
	let stopGateDiagAt = 0;
	const hydrate = async (sessionKey) => {
		const token = ++hydrationToken;
		hydratedContexts.set(sessionKey, {
			token,
			context: null
		});
		const { control } = await runBroHook("session-start", { session_id: sessionKey });
		if (Object.is(hydratedContexts.get(sessionKey)?.token, token)) hydratedContexts.set(sessionKey, {
			token,
			context: contextOf(control) || null
		});
	};
	const contextForSession = (sessionKey) => {
		if (sessionKey) return hydratedContexts.get(sessionKey)?.context ?? null;
		const contexts = [];
		for (const liveSession of liveSessions) {
			const candidate = hydratedContexts.get(liveSession)?.context;
			if (candidate === null || candidate === void 0) continue;
			contexts.push(candidate);
		}
		return contexts.length === 1 ? contexts[0] ?? null : null;
	};
	const sessionIdOf = (event) => {
		const props = asRecord(event.properties) ?? {};
		const info = asRecord(props.info);
		return typeof props.sessionID === "string" ? props.sessionID : typeof info?.id === "string" ? info.id : null;
	};
	const onSessionCreated = async (sid) => {
		if (sid === null) return;
		liveSessions.add(sid);
		if (!hydratedContexts.has(sid)) await hydrate(sid);
	};
	const contextVisibleFor = (sessionKey) => sessionKey === "" || liveSessions.has(sessionKey);
	const onSessionDeleted = (sid) => {
		liveSessions.delete(sid ?? "");
		if (sid === null) hydratedContexts.clear();
		else hydratedContexts.delete(sid);
	};
	const reportStopGateDiag = async (failure) => {
		const now = Date.now();
		if (now - stopGateDiagAt < GATE_DIAG_INTERVAL_MS) return;
		stopGateDiagAt = now;
		try {
			await client.app.log({ body: {
				service: "bro",
				level: "warn",
				message: `bro stop gate did not run (${hookFailureText(failure)}) — the stop is unguarded`
			} }).catch(() => {});
		} catch {}
	};
	const runStopGate = async (event) => {
		const { control, failure } = await runBroHook("stop", { session_id: asRecord(event.properties)?.sessionID });
		if (failure !== null) {
			await reportStopGateDiag(failure);
			return;
		}
		if (control?.decision === "block") await client.app.log({ body: {
			service: "bro",
			level: "warn",
			message: `bro stop gate blocked: ${control.reason ?? "unfinished work"}`
		} });
	};
	return {
		tool: { bro: tool({
			description: "Run a bro subcommand (act, debt, drill, convoy, work, stack, spec, fleet, agents, watch, serve, sync, setup, doctor, cleanup, next, loop, plan, plugins). Args after the subcommand are passed through verbatim.",
			args: {
				sub: tool.schema.string().describe("bro subcommand (e.g. act, debt, drill)"),
				args: tool.schema.array(tool.schema.string()).optional().describe("arguments to the subcommand")
			},
			async execute(args, _context) {
				return run(args.sub, args.args ?? []);
			}
		}) },
		"experimental.chat.system.transform": async (input$1, output) => {
			const sessionKey = input$1.sessionID ?? "";
			if (sessionKey && !hydratedContexts.has(sessionKey)) {
				liveSessions.add(sessionKey);
				await hydrate(sessionKey);
			}
			const context = contextForSession(sessionKey);
			if (context !== null && contextVisibleFor(sessionKey)) output.system.push(`bro state — resume from here:\n${context}`);
		},
		event: async ({ event }) => {
			const sid = sessionIdOf(event);
			if (event.type === "session.created") await onSessionCreated(sid);
			else if (event.type === "session.deleted") onSessionDeleted(sid);
			if (event.type !== "session.idle") return;
			await runStopGate(event);
		},
		"permission.ask": async (input$1, output) => {
			const pats = input$1.patterns ?? input$1.pattern;
			const cmds = pats === void 0 ? [] : Array.isArray(pats) ? pats : [pats];
			if (cmds.length > 0 && cmds.every(isSafeCommand)) output.status = "allow";
		}
	};
};
var kilo_default = {
	id: "bro",
	server: BroPlugin
};

//#endregion
export { kilo_default as default, hookOutcome };