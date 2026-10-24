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
* Strip terminal control sequences from untrusted board text — bead
* titles, worktree names, agent steps and drill titles are task-store
* data, and a title carrying ANSI/OSC bytes would drive the user's
* terminal (erase rows, forge content, OSC-52 clipboard writes) instead
* of being displayed. Applied at both sinks: the widget's `boardLines`
* and the interactive panel's render, before clipping so control bytes
* cannot spend the width budget either.
*/
/** Control-byte codes, spelled numerically so this source carries no
*  control character and no regex at all — Sonar flags ESC in both
*  literal and constructor form, and a sanitizer must not look like
*  the payload it strips. */
const ESC_CODE = 27;
const BEL_CODE = 7;
const TAB_CODE = 9;
const DEL_CODE = 127;
/** True for `c` in `[lo, hi]` — three call sites keep the bounds. */
function inRange(c, lo, hi) {
	return c >= lo && c <= hi;
}
/** Index just past the escape sequence starting at `i` (an ESC byte):
*  CSI = ESC [ params… final; OSC = ESC ] … BEL | ESC \; anything else
*  is ESC + one byte; a dangling ESC consumes itself. */
function afterEscape(text, i) {
	const lead = text[i + 1];
	if (lead === "[") {
		let j = i + 2;
		while (j < text.length && inRange(text.charCodeAt(j), 32, 63)) j++;
		if (j < text.length && inRange(text.charCodeAt(j), 64, 126)) j++;
		return j;
	}
	if (lead === "]") {
		let j = i + 2;
		while (j < text.length) {
			const c = text.charCodeAt(j);
			if (c === BEL_CODE) return j + 1;
			if (c === ESC_CODE && text[j + 1] === "\\") return j + 2;
			j++;
		}
		return j;
	}
	return lead === void 0 ? i + 1 : i + 2;
}
/**
* Strip terminal control sequences from untrusted board text — bead
* titles, worktree names, agent steps and drill titles are task-store
* data, and a title carrying ANSI/OSC bytes would drive the user's
* terminal (erase rows, forge content, OSC-52 clipboard writes) instead
* of being displayed. Applied at both sinks: the widget's `boardLines`
* and the interactive panel's render, before clipping so control bytes
* cannot spend the width budget either.
*/
function sanitizeTerminalText(text) {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === TAB_CODE) {
			out += " ";
			i++;
			continue;
		}
		if (code === ESC_CODE) {
			i = afterEscape(text, i);
			continue;
		}
		if (code < 32 || code === DEL_CODE) {
			i++;
			continue;
		}
		out += text[i];
		i++;
	}
	return out;
}
/**
* The widget board — one compact summary line, then the top in-progress
* beads and running fleet agents. A string array is the simplest board
* any host can render. Lines pass the sanitizer: board fields are
* untrusted task-store text.
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
	return lines.map((line) => sanitizeTerminalText(line));
}
/** The footer crumb — the one-glance form of the same board. */
function statusCrumb(s) {
	return `bro ◐${s.beads?.inProgress?.length ?? 0} ⬢${(s.fleet?.agents ?? []).filter((a) => a.state === "running").length}`;
}

//#endregion
//#region packages/cli/src/adapter/board-panel.ts
/** Rows that keep their color without the cursor; the cursor always
* highlights. */
const HIGHLIGHTED = {
	header: true,
	footer: true,
	section: false,
	item: false
};
const READY_SHOWN = 8;
const SILENT_MS = 6e4;
/** One in-progress bead's row. */
function beadRow(b) {
	const assignee = b.assignee ? `  [${b.assignee}]` : "";
	return `◐ ${b.id ?? "?"}  ${clip(b.title ?? "", 96)}${assignee}`;
}
/** One ready bead's row. */
function readyRow(b) {
	return `✓ ${b.id ?? "?"}  ${clip(b.title ?? "", 96)}`;
}
/** One fleet agent's row: id, backend, state, then what it is doing. */
function fleetRow(a) {
	const parts = [`▶ ${a.id ?? "?"}  ${a.backend ?? ""}  ${a.state ?? "?"}`];
	if (a.state === "running" && a.step) parts.push(a.step);
	if (a.state !== "running" && a.cause) parts.push(`(${a.cause})`);
	if (a.worktree) parts.push(a.worktree);
	return parts.join("  ");
}
/** One loop run's row: bead, state, pid, silence, worktree. */
function loopRow(r) {
	const parts = [`${r.state === "running" ? "▶" : "·"} ${r.beadId ?? r.slug ?? "?"}`];
	parts.push(r.state ?? "?");
	if (typeof r.pid === "number") parts.push(`pid ${r.pid}`);
	const silent = r.silentMs ?? 0;
	if (silent > SILENT_MS) parts.push(`silent ${Math.round(silent / 6e4)}m`);
	if (r.worktree) parts.push(r.worktree);
	return parts.join("  ");
}
/** One worktree's row: name, branch, state, main marker. */
function worktreeRow(w) {
	const parts = [`⎇ ${w.name ?? w.path ?? "?"}  ${w.branch ?? "?"}`];
	if (w.state) parts.push(w.state);
	if (w.main) parts.push("(main)");
	return parts.join("  ");
}
/** Build the panel's sections from a snapshot. Absent data hides its
*  section; present-but-empty data shows it with a placeholder — the
*  difference between "no loop configured" and "loop with 0 runs" is
*  worth one row. */
function buildSections(s) {
	if (s === null) return [{
		id: "board",
		title: "board",
		rows: ["no board yet — press r to load"]
	}];
	return [
		...workSections(s),
		...agentSections(s),
		...checkoutSections(s)
	];
}
/** beads + ready — what is claimed and what is queued. */
function workSections(s) {
	const inProgress = s.beads?.inProgress ?? [];
	const beadRows = inProgress.length === 0 ? ["— none in progress —"] : inProgress.map(beadRow);
	const ready = s.beads?.ready ?? [];
	const readyTotal = s.beads?.readyTotal ?? ready.length;
	const shown = ready.slice(0, READY_SHOWN);
	const readyRows = shown.map(readyRow);
	if (readyTotal - shown.length > 0) readyRows.push(`… ${readyTotal - shown.length} more ready`);
	return [{
		id: "beads",
		title: `beads (${inProgress.length})`,
		rows: beadRows
	}, {
		id: "ready",
		title: `ready (${readyTotal})`,
		rows: readyRows
	}];
}
/** fleet + loop — the agent plane: who runs, who exited, who is loud. */
function agentSections(s) {
	const sections = [];
	const agents = s.fleet?.agents ?? [];
	const running = agents.filter((a) => a.state === "running").length;
	const max = s.fleet?.maxConcurrent ?? 0;
	const cap = max > 0 ? `/${max}` : "";
	sections.push({
		id: "fleet",
		title: `fleet (${running}${cap})`,
		rows: agents.length === 0 ? ["— no agents —"] : agents.map(fleetRow)
	});
	if (s.loop !== void 0) {
		const runs = s.loop.runs ?? [];
		sections.push({
			id: "loop",
			title: `loop (${runs.filter((r) => r.state === "running").length})`,
			rows: runs.length === 0 ? ["— no runs —"] : runs.map(loopRow)
		});
	}
	return sections;
}
/** worktrees + drill + repo — the checkout around the session. */
function checkoutSections(s) {
	const sections = [];
	if (s.worktrees !== void 0) {
		const trees = s.worktrees;
		sections.push({
			id: "worktrees",
			title: `worktrees (${trees.length})`,
			rows: trees.length === 0 ? ["— none —"] : trees.map(worktreeRow)
		});
	}
	const frame = s.drill?.frame;
	if (frame) {
		const title = frame.title ? `  — ${clip(frame.title, 96)}` : "";
		const depth = typeof frame.depth === "number" ? `  (depth ${frame.depth})` : "";
		sections.push({
			id: "drill",
			title: "drill",
			rows: [`⌄ ${frame.id ?? "?"}${title}${depth}`]
		});
	}
	const repoRows = [`branch  ${s.branch ?? "?"}`];
	if ((s.dirty ?? 0) > 0) repoRows.push(`dirty   ${s.dirty} file(s)`);
	sections.push({
		id: "repo",
		title: "repo",
		rows: repoRows
	});
	return sections;
}
const FOOTER = " ↑↓/jk move · ←→/enter collapse · r refresh · q close";
/** Bytes that continue an escape sequence after its ESC. */
const SEQUENCE_LEADS = {
	"[": true,
	O: true
};
/** End index of the escape sequence starting at `data[i]` (an ESC): a
*  CSI/SS3 sequence runs to its final byte, an alt+<char> pair eats two
*  bytes, a lone ESC is one. A run that never reaches a final byte
*  falls back to the two-byte form. */
function escapeEnd(data, i) {
	const next = data[i + 1];
	if (next in SEQUENCE_LEADS) {
		let j = i + 2;
		while (data[j] >= " " && data[j] <= "?") j++;
		if (j < data.length) return j + 1;
	}
	return next === void 0 ? i + 1 : i + 2;
}
/**
* Split a raw input chunk into key tokens. pi-tui hands the focused
* component whatever bytes arrived together — one key during typing, a
* whole run during paste/autorepeat — and the action map must see every
* key in it. CSI/SS3 escape sequences stay intact as one token; a bare
* ESC followed by a non-sequence char is alt+<char> (unknown, ignored);
* an ESC alone is the escape key.
*/
function splitKeys(data) {
	const keys = [];
	let i = 0;
	while (i < data.length) {
		if (data[i] === "\x1B") {
			const end = escapeEnd(data, i);
			keys.push(data.slice(i, end));
			i = end;
			continue;
		}
		keys.push(data[i]);
		i++;
	}
	return keys;
}
var BoardPanelImpl = class {
	collapsed = /* @__PURE__ */ new Set();
	cursor = 0;
	pending = false;
	closed = false;
	dirty = true;
	lastWidth = -1;
	cached = [];
	/** Key → action, as a Map: the lookup key is raw terminal input, and
	*  a Map lookup never reads a prototype chain (a Record index on
	*  external data reads as object injection to static analysis). */
	actions;
	constructor(options) {
		this.options = options;
		const moveUp = () => this.move(-1);
		const moveDown = () => this.move(1);
		const collapse = () => this.collapseUnderCursor();
		const expand = () => this.expandUnderCursor();
		const toggle = () => this.toggleUnderCursor();
		const refresh = () => this.refresh();
		const close = () => this.close();
		this.actions = new Map([
			["\x1B[A", moveUp],
			["k", moveUp],
			["\x1B[B", moveDown],
			["j", moveDown],
			["\x1B[D", collapse],
			["h", collapse],
			["\x1B[C", expand],
			["l", expand],
			["\r", toggle],
			["\n", toggle],
			[" ", toggle],
			["r", refresh],
			["q", close],
			["\x1B", close]
		]);
	}
	/** The always-visible summary — the widget's own words (boardLines),
	*  so panel header and widget line never drift apart; the refresh
	*  state is the panel's own. */
	summaryOf(s) {
		if (s === null) return "bro · no board";
		const attention = s.watch?.attention ?? 0;
		return `${boardLines(s)[0]}${attention > 0 ? ` · ⚠ ${attention} attention` : ""}${this.pending ? " · refreshing…" : ""}`;
	}
	/** Flatten visible sections into cursor rows; the footer is never a
	*  cursor target. */
	rows(sections) {
		const rows = [{ kind: "header" }];
		for (const sec of sections) {
			rows.push({
				kind: "section",
				section: sec.id
			});
			if (!this.collapsed.has(sec.id)) for (const _ of sec.rows) rows.push({
				kind: "item",
				section: sec.id
			});
		}
		rows.push({ kind: "footer" });
		return rows;
	}
	render(width) {
		if (!this.dirty && width === this.lastWidth) return this.cached;
		const board = this.options.host.snapshot();
		const sections = buildSections(board);
		const rows = this.rows(sections);
		const footerIndex = rows.length - 1;
		this.cursor = Math.min(this.cursor, Math.max(0, footerIndex - 1));
		const lines = [];
		/** Which row of its section each item line shows — items are
		*  emitted in section order, so a per-section counter suffices. */
		const itemCounts = /* @__PURE__ */ new Map();
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const current = i === this.cursor && row.kind !== "footer";
			const mark = current ? "›" : " ";
			let text;
			if (row.kind === "header") text = `${mark} ${this.summaryOf(board)}`;
			else if (row.kind === "footer") text = FOOTER;
			else text = `${mark} ${this.rowBody(row, sections, itemCounts)}`;
			lines.push(this.renderLine(row, text, width, current));
		}
		this.cached = lines;
		this.lastWidth = width;
		this.dirty = false;
		return this.cached;
	}
	/** Clip, sanitize, and color one line: header/footer keep their
	*  color, the cursor highlights, everything else stays plain. */
	renderLine(row, text, width, current) {
		const line = clip(sanitizeTerminalText(text), width);
		const role = row.kind === "footer" ? "muted" : HIGHLIGHTED[row.kind] || current ? "accent" : "";
		const theme = this.options.theme;
		return role === "" || theme === void 0 ? line : theme.fg(role, line);
	}
	/** The section-arrow or item-body payload — the cursor mark and its
	*  space are the caller's prefix; extracted so render's loop stays
	*  inside the cognitive-complexity ceiling. */
	rowBody(row, sections, itemCounts) {
		const sec = sections.find((x) => x.id === row.section);
		if (row.kind === "section") return `${sec !== void 0 && this.collapsed.has(sec.id) ? "▸" : "▾"} ${sec?.title ?? ""}`;
		const id = row.section ?? "";
		const n = itemCounts.get(id) ?? 0;
		itemCounts.set(id, n + 1);
		return `  ${sec?.rows[n] ?? ""}`;
	}
	handleInput(data) {
		for (const key of splitKeys(data)) {
			if (this.closed) return;
			if (this.options.keybindings?.matches(key, "app.interrupt")) {
				this.close();
				return;
			}
			this.actions.get(key)?.();
		}
	}
	move(delta) {
		const rows = this.rows(buildSections(this.options.host.snapshot()));
		const last = Math.max(0, rows.length - 2);
		this.cursor = Math.min(Math.max(this.cursor + delta, 0), last);
		this.dirty = true;
	}
	currentSection() {
		const rows = this.rows(buildSections(this.options.host.snapshot()));
		this.cursor = Math.min(this.cursor, Math.max(0, rows.length - 2));
		return rows[this.cursor]?.section;
	}
	setCollapsed(sectionId, collapsed) {
		if (sectionId === void 0) return;
		if (collapsed) this.collapsed.add(sectionId);
		else this.collapsed.delete(sectionId);
		this.dirty = true;
	}
	/** ←/h — collapse the section under the cursor. */
	collapseUnderCursor() {
		this.setCollapsed(this.currentSection(), true);
	}
	/** →/l — expand the section under the cursor. */
	expandUnderCursor() {
		this.setCollapsed(this.currentSection(), false);
	}
	toggleUnderCursor() {
		const id = this.currentSection();
		if (id !== void 0) this.setCollapsed(id, !this.collapsed.has(id));
	}
	refresh() {
		if (this.pending || this.closed) return;
		this.pending = true;
		this.dirty = true;
		this.options.tui?.requestRender?.();
		const settle = () => {
			this.pending = false;
			this.dirty = true;
			this.options.tui?.requestRender?.();
		};
		this.options.host.refresh().then(settle, settle);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.options.done(void 0);
	}
	invalidate() {
		this.dirty = true;
	}
	dispose() {
		this.closed = true;
	}
};
/** Build the board panel for `ui.custom(..., { overlay: true })`. */
function createBoardPanel(options) {
	return new BoardPanelImpl(options);
}

//#endregion
//#region packages/cli/src/adapter/completions.ts
/** Group blurbs — GROUP_META in plugins.ts, mirrored for the bundle. */
const GROUPS = [
	{
		name: "review",
		description: "PR review loop — gates, threads, debt"
	},
	{
		name: "flow",
		description: "scheduling & work chains — claims, loops, stacks"
	},
	{
		name: "fleet",
		description: "agent plane — workers, serve, the board"
	},
	{
		name: "comms",
		description: "events & session mailbox"
	},
	{
		name: "work",
		description: "worktree & session mechanics"
	},
	{
		name: "self",
		description: "self-correction — retro, lessons, judgment, guards"
	},
	{
		name: "spec",
		description: "spec-driven development"
	},
	{
		name: "plan",
		description: "versioned plans"
	},
	{
		name: "mesh",
		description: "inter-rig federation"
	}
];
/** Flat verbs — every visible plugin, flat spelling. Aliases carry
*  their expansion; hidden plugins (docs, hooks, acp-worker, contract)
*  are internal and stay out of the dropdown. */
const VERBS = [
	{
		name: "debt",
		description: "Review-debt pipeline: collect|status|prs|list|mark|sync|set"
	},
	{
		name: "act",
		description: "Open-PR loop: status|threads|resolve|reply|merge"
	},
	{
		name: "watch",
		description: "Orchestrator heartbeat — mols × act gates × fleet snapshot"
	},
	{
		name: "drive",
		description: "Post-PR review driver — poll act gates, spawn fixers, merge on green"
	},
	{
		name: "cleanup",
		description: "Delete local branches whose PR merged"
	},
	{
		name: "convoy",
		description: "Molecule DAG execution: status|next|done|pour|list|run"
	},
	{
		name: "next",
		description: "Claim + emit the top ready bead — the autonomous backlog loop"
	},
	{
		name: "loop",
		description: "Autonomous backlog runner — claim → agent → gate → close → repeat"
	},
	{
		name: "stack",
		description: "Stacked bead→worktree→PR chains: push|list|sync|publish|merge"
	},
	{
		name: "fleet",
		description: "Fleet view — mols × steps × agents × worktrees × PRs"
	},
	{
		name: "agents",
		description: "Agent supervisor: status|up|down over the orchestrator connectors"
	},
	{
		name: "status",
		description: "The compact live board — beads + fleet + drill + git"
	},
	{
		name: "daemon",
		description: "Project-scoped supervisor: up|status|down|run --every N"
	},
	{
		name: "resume",
		description: "Post-restart recovery — rearm watches, revive the daemon"
	},
	{
		name: "serve",
		description: "Facade host for thin clients — HTTP/JSON on 127.0.0.1"
	},
	{
		name: "provider",
		description: "Claude-facing Messages-API plane — listener + url|token|env wiring"
	},
	{
		name: "mcp",
		description: "Stdio MCP server over the read planes"
	},
	{
		name: "pulse",
		description: "Session-owned metronome — tick + mailbox beat every S seconds"
	},
	{
		name: "telemetry",
		description: "→ hooks perf"
	},
	{
		name: "trace",
		description: "OTLP export of the session trace journals"
	},
	{
		name: "rig",
		description: "Rig freshness: sync|status|watch|install"
	},
	{
		name: "notify",
		description: "Drop an event into the session mailbox"
	},
	{
		name: "sinks",
		description: "Outbound event sinks: list|test"
	},
	{
		name: "bus",
		description: "Local event bus — serve/publish/subscribe agent events"
	},
	{
		name: "drill",
		description: "Scoped descent over beads: down|up|current|tree|list|report|distill"
	},
	{
		name: "unwind",
		description: "→ drill up"
	},
	{
		name: "queue",
		description: "Frame-scoped intake queue: ls|drill|bump|rm"
	},
	{
		name: "goal",
		description: "Session-scoped completion goal: set|status|pause|resume|clear"
	},
	{
		name: "work",
		description: "Parallel-friendly worktrees: enter|leave|list|prune"
	},
	{
		name: "stamp",
		description: "Attribute shared-output writes — record/read the last build stamp"
	},
	{
		name: "sync",
		description: "Push/pull artifact dirs on refs/bro/data"
	},
	{
		name: "sweep",
		description: "Gated disposal for closed beads: status|distill|run"
	},
	{
		name: "retrospect",
		description: "Self-correction: capture|record|status|list|schema"
	},
	{
		name: "wtf",
		description: "→ retrospect capture"
	},
	{
		name: "learn",
		description: "Lessons: add|list|show|forget|capture|probe"
	},
	{
		name: "judge",
		description: "Calibrated decision judge"
	},
	{
		name: "dogfood",
		description: "Scenario-driven e2e self-test"
	},
	{
		name: "guard",
		description: "Declarative prompt guards — list resolved declarations"
	},
	{
		name: "providers",
		description: "Provider registry — models catalog as <provider>/<model>"
	},
	{
		name: "spec",
		description: "Spec-driven development policy: check|new"
	},
	{
		name: "query",
		description: "Cross-provider GraphQL plan"
	},
	{
		name: "run",
		description: "Execute a plan file — `kind` routes to the owning plugin"
	},
	{
		name: "plan",
		description: "Plan contract: list kinds + schema versions, validate a file"
	},
	{
		name: "mesh",
		description: "Inter-rig work federation: me|peers|pull|inbox|request|claim|done|accept|reject|wait"
	},
	{
		name: "request",
		description: "Post a request to a repo or peer"
	},
	{
		name: "check",
		description: "Run the repo sverka workflow — per-step stats + findings"
	},
	{
		name: "setup",
		description: "Wire bro into the current repo"
	},
	{
		name: "doctor",
		description: "Environment diagnostics: node, git, gh auth, bd, hooks, config"
	},
	{
		name: "wait",
		description: "Dep-plane watcher — verdict = exit code"
	},
	{
		name: "plugins",
		description: "Plugin registry + client adapters: install|uninstall|list"
	}
];
/** Position-2 members per group — registry group membership, aliases
*  included (they are valid spellings of the same dispatch). */
const GROUP_MEMBERS = {
	review: [
		{
			name: "debt",
			description: "review-debt pipeline"
		},
		{
			name: "act",
			description: "open-PR review loop"
		},
		{
			name: "watch",
			description: "orchestrator heartbeat"
		},
		{
			name: "drive",
			description: "post-PR review driver"
		},
		{
			name: "cleanup",
			description: "delete merged branches"
		}
	],
	flow: [
		{
			name: "convoy",
			description: "molecule DAG execution"
		},
		{
			name: "next",
			description: "claim the top ready bead"
		},
		{
			name: "loop",
			description: "autonomous backlog runner"
		},
		{
			name: "stack",
			description: "stacked bead→PR chains"
		}
	],
	fleet: [
		{
			name: "fleet",
			description: "fleet view"
		},
		{
			name: "agents",
			description: "agent supervisor"
		},
		{
			name: "status",
			description: "the compact live board"
		},
		{
			name: "daemon",
			description: "project-scoped supervisor"
		},
		{
			name: "resume",
			description: "post-restart recovery"
		},
		{
			name: "serve",
			description: "thin-client facade host"
		},
		{
			name: "provider",
			description: "Messages-API plane"
		},
		{
			name: "mcp",
			description: "stdio MCP server"
		},
		{
			name: "pulse",
			description: "session metronome"
		},
		{
			name: "telemetry",
			description: "→ hooks perf"
		},
		{
			name: "trace",
			description: "OTLP trace export"
		},
		{
			name: "rig",
			description: "rig freshness"
		}
	],
	comms: [
		{
			name: "notify",
			description: "drop a mailbox event"
		},
		{
			name: "sinks",
			description: "outbound event sinks"
		},
		{
			name: "bus",
			description: "local event bus"
		}
	],
	work: [
		{
			name: "drill",
			description: "scoped descent over beads"
		},
		{
			name: "unwind",
			description: "→ drill up"
		},
		{
			name: "queue",
			description: "frame-scoped intake queue"
		},
		{
			name: "goal",
			description: "session completion goal"
		},
		{
			name: "work",
			description: "parallel worktrees"
		},
		{
			name: "stamp",
			description: "build stamp attribution"
		},
		{
			name: "sync",
			description: "artifact dirs on refs/bro/data"
		},
		{
			name: "sweep",
			description: "gated disposal for closed beads"
		}
	],
	self: [
		{
			name: "retrospect",
			description: "self-correction"
		},
		{
			name: "wtf",
			description: "→ retrospect capture"
		},
		{
			name: "learn",
			description: "lesson store"
		},
		{
			name: "judge",
			description: "calibrated decision judge"
		},
		{
			name: "dogfood",
			description: "e2e self-test"
		},
		{
			name: "guard",
			description: "declarative prompt guards"
		},
		{
			name: "providers",
			description: "provider registry"
		}
	],
	spec: [{
		name: "spec",
		description: "spec policy: check|new"
	}],
	plan: [
		{
			name: "query",
			description: "cross-provider GraphQL plan"
		},
		{
			name: "run",
			description: "execute a plan file"
		},
		{
			name: "plan",
			description: "plan contract"
		}
	],
	mesh: [{
		name: "mesh",
		description: "inter-rig federation"
	}, {
		name: "request",
		description: "post a request to a repo or peer"
	}]
};
/** Position-2 subcommands per flat verb — the pipe-lists the plugin
*  summaries themselves advertise; completions.test.ts pins every
*  entry to its verb's summary so the table cannot rot. */
const VERB_SUBS = {
	debt: [
		"collect",
		"status",
		"prs",
		"list",
		"mark",
		"sync",
		"set"
	],
	act: [
		"status",
		"threads",
		"resolve",
		"reply",
		"merge"
	],
	convoy: [
		"status",
		"next",
		"done",
		"pour",
		"list",
		"run"
	],
	agents: [
		"status",
		"up",
		"down"
	],
	daemon: [
		"up",
		"status",
		"down",
		"run"
	],
	rig: [
		"sync",
		"status",
		"watch",
		"install"
	],
	sinks: ["list", "test"],
	watch: ["install", "uninstall"],
	drill: [
		"down",
		"up",
		"current",
		"tree",
		"list",
		"report",
		"distill"
	],
	queue: [
		"ls",
		"drill",
		"bump",
		"rm"
	],
	retrospect: [
		"capture",
		"record",
		"status",
		"list",
		"schema"
	],
	learn: [
		"add",
		"list",
		"show",
		"forget",
		"capture",
		"probe"
	],
	goal: [
		"set",
		"status",
		"pause",
		"resume",
		"clear"
	],
	work: [
		"enter",
		"leave",
		"list",
		"prune"
	],
	stack: [
		"push",
		"list",
		"sync",
		"publish",
		"merge"
	],
	spec: ["check", "new"],
	sweep: [
		"status",
		"distill",
		"run"
	],
	mesh: [
		"me",
		"peers",
		"pull",
		"inbox",
		"request",
		"claim",
		"done",
		"accept",
		"reject",
		"wait"
	],
	plugins: [
		"install",
		"uninstall",
		"list"
	]
};
/** Items for one vocabulary filtered by the typed token. `value` is
*  the full replacement of the argument prefix, so position-2 items
*  carry the head word. */
function pick(entries, token, head) {
	const out = [];
	for (const e of entries) {
		if (!e.name.startsWith(token)) continue;
		out.push({
			value: head ? `${head} ${e.name}` : e.name,
			label: e.name,
			description: e.description
		});
	}
	return out;
}
/** Position 1 — groups and flat verbs. An empty token stays null so
*  bare `/bro ` keeps submitting the command (the board panel). */
function firstPosition(token) {
	if (token.length === 0) return null;
	return [...pick(GROUPS, token, void 0), ...pick(VERBS, token, void 0)];
}
/** Position 2 — the head's group members, else the verb's
*  subcommands; an unknown head offers nothing. */
function secondPosition(head, token) {
	const members = GROUP_MEMBERS[head];
	if (members !== void 0) return pick(members, token, head);
	const subs = VERB_SUBS[head];
	if (subs === void 0) return null;
	return subs.filter((s) => s.startsWith(token)).map((s) => ({
		value: `${head} ${s}`,
		label: s
	}));
}
/**
* `/bro` argument completion. Returns the items for the current
* argument prefix, or null when there is nothing honest to offer:
* an empty first token (bare submit stays the command), a quoted
* token (never shred quotes), a flag (flags are not guessed), an
* unknown head, or anything past position 2.
*/
function broArgumentCompletions(argumentPrefix) {
	const tokens = argumentPrefix.split(" ");
	const token = tokens[tokens.length - 1] ?? "";
	if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("-")) return null;
	if (tokens.length < 2) return firstPosition(token);
	if (tokens.length > 2) return null;
	return secondPosition(tokens[tokens.length - 2] ?? "", token);
}

//#endregion
//#region packages/cli/src/adapter/host.ts
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
		async mountPanel(ctx, factory) {
			const custom = ctx.ui.custom;
			if (!ctx.hasUI || ctx.mode !== "tui" || typeof custom !== "function") return false;
			try {
				await custom.call(ctx.ui, factory, { overlay: true });
				return true;
			} catch {
				return false;
			}
		},
		paint: host.paint,
		clear(ctx) {
			try {
				ctx.ui.setWidget(BOARD_KEY, void 0);
				ctx.ui.setStatus(BOARD_KEY, void 0);
			} catch {}
		},
		notify: host.notify,
		refuseStop: host.refuseStop,
		stopAlreadyRefused: host.stopAlreadyRefused,
		stopAborted: host.stopAborted,
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
	/** Pre-compaction carry — kept apart from the hydration probe so a
	*  post-compaction re-probe cannot overwrite what must survive the
	*  summary. Consumed (cleared) by the next hydrate() that runs. */
	let carry;
	/** Set when the stop gate already refused this session — gates, not
	*  loops: the blocker goes back once per session, a later stop is
	*  let through, and a NEW session starts with a fresh gate (the
	*  flag dies with its session instead of leaking into the next). */
	let gatedSession;
	/** Resolve the CLI once. Probing costs a spawn even where bro is
	*  inert, so it stays lazy. A *failed* resolution is not permanent:
	*  PATH, a local install or npx can appear mid-session, so a null
	*  answer expires after RESOLVE_RETRY_MS instead of poisoning the
	*  whole extension instance. */
	let resolved;
	let resolvedFailedAt;
	const command = () => {
		if (resolved !== void 0 && (resolvedFailedAt === void 0 || Date.now() - resolvedFailedAt < RESOLVE_RETRY_MS)) return resolved;
		resolvedFailedAt = void 0;
		resolved = resolveCommand({ npxPin: host.npxPin }).then((cmd) => {
			if (cmd === null) resolvedFailedAt = Date.now();
			return cmd;
		});
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
	/** Re-probe the board and repaint. Fail-open: an unavailable bro
	*  leaves the last snapshot in place; resolves whatever is current. */
	const refreshBoard = async (ctx) => {
		const cwd = host.cwd(ctx);
		const seq = ++refreshSeq;
		if (!broEnabled(cwd)) {
			board = null;
			paint(ctx);
			return board;
		}
		const cmd = await command();
		if (cmd === null || seq !== refreshSeq) return board;
		const next = await statusJson(cmd, cwd);
		if (seq !== refreshSeq) return board;
		if (next !== null) board = next;
		paint(ctx);
		return board;
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
		const started = probe(event, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS).then(contextOf).then((text) => priorCarry === "" ? text : text === "" ? priorCarry : `${priorCarry}\n\n${text}`);
		hydration = {
			sessionId,
			promise: started
		};
		if (hydrated === sessionId) hydrated = void 0;
		started.then((text) => {
			if (hydration?.promise === started && text === "") hydration = void 0;
		}).catch(() => {});
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
		const nudge = probe("prompt-submit", {
			session_id: sessionId,
			prompt: host.promptOf(event)
		}, cwd).then(contextOf);
		const parts = [];
		const pending = hydration;
		if (pending !== void 0 && hydrated !== sessionId && pending.sessionId === sessionId) {
			hydrated = sessionId;
			const text = (await pending.promise).trim();
			if (text !== "") parts.push(text);
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
	const stopGate = async (event, ctx, sessionId) => {
		if (host.stopAborted?.(event) === true) return;
		const control = await probe("stop", {
			session_id: sessionId,
			stop_hook_active: gatedSession === sessionId || host.stopAlreadyRefused(event)
		}, host.cwd(ctx));
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
	/** Bare `/bro`: mount the interactive board panel where the host can
	*  give a component keyboard focus — an overlay over the transcript,
	*  editor untouched (docs/tui.md). Headless, non-TUI modes and hosts
	*  without `custom` fall back to the plain refresh. */
	const openBoardPanel = async (ctx) => host.mountPanel(ctx, async (tui, theme, keybindings, done) => {
		if (board === null) await refreshBoard(ctx).catch(() => {});
		return createBoardPanel({
			host: {
				snapshot: () => board,
				refresh: () => refreshBoard(ctx)
			},
			done,
			theme,
			keybindings,
			tui
		});
	});
	/** The shared surfaces. Bare `/bro` mounts the interactive board
	*  panel (a plain refresh where no UI can mount); `bro act|next|
	*  fleet|drill` is a thin passthrough reachable without leaving the
	*  editor, and `bro_status` hands the model the same board JSON the
	*  widget renders. Both are the same on every host, so both live
	*  here. */
	api.registerCommand("bro", {
		description: "bro — interactive board (panel), or run `bro <args>` (act|next|fleet|drill|…)",
		getArgumentCompletions: broArgumentCompletions,
		async handler(args, ctx) {
			const trimmed = args.trim();
			if (trimmed === "") {
				if (await openBoardPanel(ctx)) return;
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
			await refreshBoard(ctx).catch(() => {});
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
//#region packages/cli/src/adapter/pi.ts
/** The published version of this adapter — the npx fallback pin. The
*  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = "@broject/bro@0.2.5";
/** pi hands the submitted prompt to its `input` event rather than to
*  the turn event — cached so the shared prompt-submit probe still
*  carries prompt-specific nudges. Absent event → '' → same behavior
*  as before the cache existed (fail-open). */
let inputPrompt = "";
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
			paint(ctx, lines, crumb) {
				try {
					ctx.ui.setWidget(BOARD_KEY, lines, { placement: "aboveEditor" });
					ctx.ui.setStatus(BOARD_KEY, crumb);
				} catch {}
			}
		}),
		promptOf(event) {
			const own = event.prompt;
			return typeof own === "string" && own !== "" ? own : inputPrompt;
		},
		npxPin: NPX_PIN
	};
}
/** The extension entry point — pi calls this with its API. */
function broExtension(pi) {
	const driver = createBroDriver(binding(pi), pi);
	pi.on("input", (event) => {
		const payload = event;
		if (typeof payload.prompt === "string") inputPrompt = payload.prompt;
	});
	pi.on("agent_settled", (_e, ctx) => {
		driver.refresh(ctx).catch(() => {});
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