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
	const pinned = opts.command;
	if (typeof pinned === "string" && pinned.trim() !== "") {
		const [cmd, ...args] = pinned.split(/\s+/).filter((p) => p !== "");
		if (cmd !== void 0 && await exitsZero(cmd, [...args, "hooks"])) return {
			cmd,
			args
		};
	} else if (pinned !== void 0 && typeof pinned === "object" && pinned !== null) {
		const cmd = typeof pinned.cmd === "string" ? pinned.cmd : "";
		const args = Array.isArray(pinned.args) ? pinned.args.filter((a) => typeof a === "string") : [];
		if (cmd !== "" && await exitsZero(cmd, [...args, "hooks"])) return {
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
	const specs = opts.npxSpecs ?? (opts.npxPin !== void 0 ? [opts.npxPin] : []);
	if (specs.length > 0 && await exitsZero("npx", ["--version"])) {
		for (const spec of specs) if (await exitsZero("npx", [
			"-y",
			"--prefer-offline",
			spec,
			"hooks"
		])) return {
			cmd: "npx",
			args: [
				"-y",
				"--prefer-offline",
				spec
			]
		};
	}
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
/**
* Run one `bro hooks <event>` with the payload on stdin; resolve null on
* every failure mode — spawn error, timeout, nonzero exit, garbage out.
* `extraEnv` rides on the spawn env (the adapter's `hookEmitEnv` block).
*/
async function callHook(command, event, payload, cwd, timeoutMs, extraEnv) {
	const { promise, resolve } = Promise.withResolvers();
	let child;
	try {
		child = spawn(command.cmd, [
			...command.args,
			"hooks",
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
		let settled = false;
		const settle = (result) => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};
		const cap = (buf, chunk) => buf.length < MAX_OUTPUT ? buf + chunk.slice(0, MAX_OUTPUT - buf.length) : buf;
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
			stdout = cap(stdout, chunk);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderr = cap(stderr, chunk);
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
	});
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
	return () => {
		if (resolved !== void 0 && (failedAt === void 0 || Date.now() - failedAt < RESOLVE_RETRY_MS)) return resolved;
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
/** Auto-approve only a plain bro/bd/npx-bro invocation — no shell
*  metacharacters in args (a metachar just means the ask goes to the
*  user; auto-approve fails closed, never wrong). */
const SAFE_CMD = [/^\s*(?:bro|bd)(?:\s+[^;&|`<>$()\\\n]*)?\s*$/, /^\s*npx\s+(?:-y\s+)?@broject\/bro(?:\s+[^;&|`<>$()\\\n]*)?\s*$/];
const BroPlugin = async ({ directory, client }) => {
	const getCommand = createCommandResolver({ npxSpecs: NPX_SPECS });
	/** Run one bro hook event; null on every failure mode (fail-open).
	*  `bro hooks` itself no-ops in a repo that never opted in. */
	const runBroHook = async (event, input) => {
		const resolved = await getCommand();
		return resolved === null ? null : callHook(resolved, event, input, directory, HOOK_TIMEOUT_MS, HOOK_ENV);
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
	const hydrate = async (sessionKey) => {
		const token = ++hydrationToken;
		hydratedContexts.set(sessionKey, {
			token,
			context: null
		});
		const control = await runBroHook("session-start", { session_id: sessionKey });
		if (Object.is(hydratedContexts.get(sessionKey)?.token, token)) hydratedContexts.set(sessionKey, {
			token,
			context: contextOf(control) || null
		});
	};
	const contextForSession = (sessionKey) => {
		if (sessionKey) return hydratedContexts.get(sessionKey)?.context ?? null;
		let context = null;
		for (const liveSession of liveSessions) {
			const candidate = hydratedContexts.get(liveSession)?.context;
			if (candidate === null || candidate === void 0) continue;
			if (context !== null) return null;
			context = candidate;
		}
		return context;
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
		"experimental.chat.system.transform": async (input, output) => {
			const sessionKey = input.sessionID ?? "";
			if (sessionKey && !hydratedContexts.has(sessionKey)) {
				liveSessions.add(sessionKey);
				await hydrate(sessionKey);
			}
			const context = contextForSession(sessionKey);
			if (context && (!sessionKey || liveSessions.has(sessionKey))) output.system.push(`bro state — resume from here:\n${context}`);
		},
		event: async ({ event }) => {
			const props = event.properties ?? {};
			const sid = typeof props.sessionID === "string" ? props.sessionID : typeof props.info?.id === "string" ? props.info.id : null;
			if (event.type === "session.created" && sid !== null) {
				liveSessions.add(sid);
				if (!hydratedContexts.has(sid)) await hydrate(sid);
			} else if (event.type === "session.deleted") {
				liveSessions.delete(sid ?? "");
				if (sid === null) hydratedContexts.clear();
				else hydratedContexts.delete(sid);
			}
			if (event.type !== "session.idle") return;
			const control = await runBroHook("stop", { session_id: event.properties.sessionID });
			if (control?.decision === "block") await client.app.log({ body: {
				service: "bro",
				level: "warn",
				message: `bro stop gate blocked: ${control.reason ?? "unfinished work"}`
			} });
		},
		"permission.ask": async (input, output) => {
			const pats = input.patterns ?? input.pattern;
			const cmds = pats === void 0 ? [] : Array.isArray(pats) ? pats : [pats];
			if (cmds.length > 0 && cmds.every((c) => SAFE_CMD.some((re) => re.test(c)))) output.status = "allow";
		}
	};
};
var kilo_default = {
	id: "bro",
	server: BroPlugin
};

//#endregion
export { kilo_default as default };