/**
 * Agents Extension - named "agents" (personas/modes) switchable by hotkey.
 *
 * An agent is a bundle of:
 *   - model (provider + model id)
 *   - thinking level
 *   - active tools
 *   - instructions appended to the system prompt as an `<agent>` section
 *   - optional read-only guard (see below)
 *
 * Config files (merged, project takes precedence):
 *   - ~/.pi/agent/agents.json          (global)
 *   - <cwd>/.pi/agents.json            (project-local)
 *
 * agents.json:
 * {
 *   "architect": {
 *     "description": "Read-only planning",
 *     "provider": "anthropic",
 *     "model": "claude-sonnet-4-5",
 *     "thinkingLevel": "high",
 *     "tools": ["read", "grep", "find", "ls", "edit", "write"],
 *     "readOnly": true,
 *     "planDir": ".pi/plans",
 *     "allowCommands": ["npx tsc --noEmit"],
 *     "inputColor": "accent",
 *     "statusColor": "accent",
 *     "instructions": "You are in PLANNING MODE. ..."
 *   }
 * }
 *
 * Read-only guard (`readOnly`, `planDir`):
 *   - `readOnly: true` blocks `edit`/`write` everywhere and blocks `bash`/`powershell`
 *     commands that are not clearly read-only (allowlist + destructive checks).
 *   - `planDir` (relative to cwd, `~` allowed) implies `readOnly` and additionally
 *     allows `edit`/`write` inside that directory only. The directory is created on
 *     activation. Writes are blocked by the runtime, not by instructions, so the model
 *     cannot talk itself out of the restriction.
 *   - The shell filter is a heuristic, not a sandbox: it rejects redirections, command
 *     substitution, interpreters, package managers that can mutate, `find -exec/-delete`,
 *     `sed -i`, mutating git subcommands, and every command outside the allowlist.
 *     `allowCommands` adds literal command prefixes (e.g. project-specific type checks).
 *
 * Usage:
 *   /agent                 - open a picker
 *   /agent architect       - switch directly
 *   alt+1..alt+9           - switch to agent N (alphabetical order)
 *   ctrl+alt+1..9          - same, for terminals that swallow alt+digit
 *   ctrl+alt+a             - open the picker
 *   pi --agent architect   - start with an agent
 */

import { mkdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, Theme } from "@earendil-works/pi-coding-agent";
import { Key, Text, colorToHex, type Color } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { findOpenRunId } from "./lib/runs.ts";
import { parsePlan } from "./lib/plans.ts";
import { buildAgentSection } from "./lib/prompt.ts";
import { handoffRefusal } from "./lib/handoff.ts";
import {
	type AgentConfig,
	type AgentsConfig,
	type ThinkingLevel,
	loadAgents,
	resolveThinking,
	sortAgentNames,
} from "./lib/agents-config.ts";

interface Guard {
	planDir?: string;
	allowCommands: string[];
}

interface OriginalState {
	model: ExtensionContext["model"];
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

/** Depth 0 = user-facing session; >0 = delegated subagent (must not orchestrate). */
const DEPTH = Number.parseInt(process.env.PI_AGENT_DEPTH ?? "0", 10) || 0;

/** Key combos used for slots 1..9 (index order matches alphabetical agent order). */
const SLOT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** The editor input border is drawn with the thinking-level token of the current level. */
const THINKING_TOKENS = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
] as const;

// ---------------------------------------------------------------------------
// Read-only shell filter
// ---------------------------------------------------------------------------

const READ_ONLY_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"fd",
	"ls",
	"pwd",
	"echo",
	"printf",
	"wc",
	"sort",
	"uniq",
	"diff",
	"cmp",
	"comm",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"which",
	"whereis",
	"type",
	"printenv",
	"uname",
	"whoami",
	"id",
	"date",
	"cal",
	"uptime",
	"ps",
	"top",
	"htop",
	"free",
	"jq",
	"bat",
	"eza",
	"nl",
	"cut",
	"tr",
	"column",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"xxd",
	"od",
	"strings",
	"tac",
	"seq",
	"expr",
	"test",
	"true",
	"false",
	"cd",
	"diff3",
	"fold",
	"fmt",
	"paste",
	"join",
	"findstr",
]);

const GIT_READ_ONLY = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"shortlog",
	"describe",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"cat-file",
	"grep",
	"show-ref",
	"name-rev",
	"merge-base",
	"for-each-ref",
	"config",
	"branch",
	"remote",
	"reflog",
	"whatchanged",
	"diff-tree",
	"diff-files",
	"diff-index",
	"range-diff",
	"count-objects",
	"fsck",
	"verify-commit",
	"verify-tag",
	"help",
	"version",
]);

const GIT_BRANCH_WRITE_FLAGS = /^-(d|D|m|M|c|C|f|u|delete|move|copy|force|set-upstream-to|unset-upstream)$/i;
const GIT_CONFIG_READ_FLAGS = ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"];
const GIT_REMOTE_READ = ["-v", "--verbose", "show", "get-url"];
const PACKAGE_READ_SUBCOMMANDS = ["list", "ls", "view", "info", "search", "outdated", "audit", "why", "explain", "help", "--version", "-v"];
const PIP_READ_SUBCOMMANDS = ["list", "show", "freeze", "--version", "-v"];
const INTERPRETERS = new Set([
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
	"powershell",
	"pwsh",
	"cmd",
	"node",
	"nodejs",
	"python",
	"python3",
	"deno",
	"bun",
	"ruby",
	"perl",
	"php",
	"osascript",
	"wsl",
]);
const CURL_WRITE_FLAGS = /^(-o|-O|--output|--remote-name|-d|--data.*|-F|--form.*|-T|--upload-file|-X|--request)$/i;
const FIND_MUTATING_FLAGS = /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/i;
const POWERSHELL_READ_ONLY =
	/^(get-[a-z]+|select-string|select-object|measure-object|sort-object|compare-object|resolve-path|test-path|join-path|split-path|convertto-[a-z]+|convertfrom-[a-z]+|write-output|write-host|out-string|format-[a-z]+|where|where-object|foreach|foreach-object|dir|ls|cat|type|gc|pwd|echo|sls|cls|more|findstr)$/i;

type ShellVerdict = { ok: true } | { ok: false; reason: string };

function commandName(token: string): string {
	return token.replace(/^.*[\\/]/, "").toLowerCase();
}

/** Strip quoted text so separators inside strings do not create fake segments. */
function splitSegments(command: string): string[] {
	return command
		.replace(/"[^"]*"|'[^']*'/g, " ")
		.split(/&&|\|\||[;|\n\r]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function checkBashSegment(segment: string, allowCommands: string[]): string | undefined {
	const lowerSegment = segment.toLowerCase();
	if (allowCommands.some((prefix) => prefix.trim() && lowerSegment.startsWith(prefix.trim().toLowerCase()))) {
		return undefined;
	}

	const tokens = segment.split(/\s+/).filter(Boolean);
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;

	const token = tokens[index];
	if (!token) return undefined;
	const cmd = commandName(token);
	const args = tokens.slice(index + 1);

	if (cmd === "git") {
		// Skip global git flags so `git --no-pager log` and `git -C dir status` work.
		let cursor = 0;
		while (cursor < args.length && args[cursor].startsWith("-")) {
			const flag = args[cursor].toLowerCase();
			cursor += flag === "-c" || flag === "-C" || flag === "--git-dir" || flag === "--work-tree" ? 2 : 1;
		}
		const sub = commandName(args[cursor] ?? "");
		if (!GIT_READ_ONLY.has(sub)) return `\`git ${sub || "<none>"}\` is not a read-only git command`;
		const rest = args.slice(cursor + 1);
		if (sub === "branch" && rest.some((arg) => GIT_BRANCH_WRITE_FLAGS.test(arg))) {
			return "`git branch` with delete/move/copy/upstream flags writes to the repository";
		}
		if (sub === "remote" && rest.length > 0 && !GIT_REMOTE_READ.includes(rest[0].toLowerCase())) {
			return "only `git remote -v`, `git remote show` and `git remote get-url` are read-only";
		}
		if (sub === "config" && !rest.some((arg) => GIT_CONFIG_READ_FLAGS.includes(arg.toLowerCase()))) {
			return "only reading `git config` is allowed (--get/--list)";
		}
		return undefined;
	}

	if (cmd === "find") {
		if (args.some((arg) => FIND_MUTATING_FLAGS.test(arg))) {
			return "`find` with -delete/-exec can modify files";
		}
		return undefined;
	}

	if (cmd === "sed") {
		if (args.some((arg) => /^(-i|--in-place)/i.test(arg))) return "`sed -i` modifies files in place";
		return undefined;
	}

	if (cmd === "awk" || cmd === "gawk") return undefined;

	if (cmd === "curl") {
		if (args.some((arg) => CURL_WRITE_FLAGS.test(arg))) {
			return "`curl` with upload/output flags is not read-only";
		}
		return undefined;
	}

	if (cmd === "wget") {
		return "`wget` writes files; use `curl` without output flags instead";
	}

	if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
		const sub = (args[0] ?? "").toLowerCase();
		if (!PACKAGE_READ_SUBCOMMANDS.includes(sub)) return `\`${cmd} ${sub || "<none>"}\` can change the project or run scripts`;
		return undefined;
	}

	if (cmd === "pip" || cmd === "pip3") {
		const sub = (args[0] ?? "").toLowerCase();
		if (!PIP_READ_SUBCOMMANDS.includes(sub)) return `\`${cmd} ${sub || "<none>"}\` can change the environment`;
		return undefined;
	}

	if (INTERPRETERS.has(cmd)) {
		if (!args.some((arg) => /^(--version|-v|-V)$/i.test(arg))) {
			return `\`${cmd}\` can execute arbitrary code; only --version is allowed`;
		}
		return undefined;
	}

	if (cmd === "xargs") return "`xargs` can execute arbitrary commands";

	if (READ_ONLY_COMMANDS.has(cmd)) return undefined;
	return `\`${cmd}\` is not in the read-only command allowlist`;
}

function checkPowerShellSegment(segment: string, allowCommands: string[]): string | undefined {
	if (segment.includes("{") || segment.includes("}")) return "script blocks are not allowed in a read-only agent";
	const lowerSegment = segment.toLowerCase();
	if (allowCommands.some((prefix) => prefix.trim() && lowerSegment.startsWith(prefix.trim().toLowerCase()))) {
		return undefined;
	}
	const tokens = segment.split(/\s+/).filter(Boolean);
	const token = tokens[0];
	if (!token) return undefined;
	const cmd = commandName(token);
	if (POWERSHELL_READ_ONLY.test(cmd)) return undefined;
	if (INTERPRETERS.has(cmd)) return `\`${cmd}\` can execute arbitrary code`;
	return `\`${cmd}\` is not a read-only PowerShell cmdlet`;
}

function isReadOnlyShell(command: string, shell: "bash" | "powershell", allowCommands: string[]): ShellVerdict {
	const raw = command.trim();
	if (!raw) return { ok: false, reason: "empty command" };

	if (raw.includes("`") || raw.includes("$(") || raw.includes("<(") || raw.includes(">(")) {
		return { ok: false, reason: "command substitution is not allowed in a read-only agent" };
	}

	// Ignore harmless descriptor plumbing and /dev/null redirects before rejecting ">".
	const withoutNullRedirects = raw
		.replace(/\d?>&\d/g, "")
		.replace(/&>>?\s*\/dev\/null/g, "")
		.replace(/[12]?>>?\s*\/dev\/null/g, "");
	if (withoutNullRedirects.includes(">")) {
		return { ok: false, reason: "output redirection is not allowed in a read-only agent" };
	}

	// awk can call system() from inside a quoted program, so check the raw command.
	if (/\bawk\b[^\n;|]*\bsystem\s*\(/i.test(raw)) {
		return { ok: false, reason: "`awk system()` can execute arbitrary commands" };
	}

	for (const segment of splitSegments(raw)) {
		const reason =
			shell === "powershell"
				? checkPowerShellSegment(segment, allowCommands)
				: checkBashSegment(segment, allowCommands);
		if (reason) return { ok: false, reason };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveUserPath(input: string, cwd: string): string {
	let path = input.trim().replace(/^@/, "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || path.startsWith("~\\")) path = join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

function canonical(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		try {
			return join(realpathSync.native(dirname(path)), basename(path));
		} catch {
			return path;
		}
	}
}

function isInside(dir: string, target: string): boolean {
	const rel = relative(canonical(dir), canonical(target));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function buildGuard(agent: AgentConfig): Guard | undefined {
	if (agent.readOnly !== true && !agent.planDir) return undefined;
	return { planDir: agent.planDir?.trim() || undefined, allowCommands: agent.allowCommands ?? [] };
}

// ---------------------------------------------------------------------------
// Theme colors
// ---------------------------------------------------------------------------

function readThemeSetting(cwd: string): string | undefined {
	const paths = [join(cwd, CONFIG_DIR_NAME, "settings.json"), join(getAgentDir(), "settings.json")];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const value = (JSON.parse(readFileSync(path, "utf-8")) as { theme?: unknown }).theme;
			if (typeof value === "string" && value) return value;
		} catch {
			// Malformed settings: fall back to the captured theme instance.
		}
	}
	return undefined;
}

function themeColorValue(color: Color): string | number {
	return color.kind === "indexed" ? color.index : colorToHex(color);
}

/** Copy of `base` where every target token takes the color of the named source token. */
function deriveTheme(base: Theme, tokenMap: Record<string, string>, onUnknown: (name: string) => void): Theme {
	const baseColors = base.colors as Record<string, Color>;
	const values: Record<string, string | number> = {};
	for (const [token, color] of Object.entries(baseColors)) values[token] = themeColorValue(color);

	const colors = { ...values };
	for (const [target, source] of Object.entries(tokenMap)) {
		// Targets are our own thinking tokens, which are valid even when a sparse base theme omits them.
		const knownTarget = target in values || (THINKING_TOKENS as readonly string[]).includes(target);
		if (!knownTarget) {
			onUnknown(target);
			continue;
		}
		if (!(source in values)) {
			onUnknown(source);
			continue;
		}
		colors[target] = values[source];
	}

	// Do not copy `dimTokens`: `base.colors` are already mixed toward the background for those tokens,
	// and passing them again as faint would dim them twice.
	return new Theme(colors, {}, base.getColorMode(), {
		name: base.name,
		appearance: base.appearance,
	});
}

export default function agentsExtension(pi: ExtensionAPI) {
	let agents: AgentsConfig = {};
	let activeName: string | undefined;
	let activeAgent: AgentConfig | undefined;
	let activeGuard: Guard | undefined;
	let originalState: OriginalState | undefined;
	let originalTheme: Theme | undefined;
	let inputColorToken: string | undefined;
	let statusColorToken = "accent";
	let pendingHandoff: { plan: string; route: string; notes?: string } | undefined;

	const agentNames = () => sortAgentNames(agents);

	function updateStatus(ctx: ExtensionContext) {
		if (!activeName) {
			ctx.ui.setStatus("agent", undefined);
			return;
		}
		const suffix = activeGuard ? " (ro)" : "";
		ctx.ui.setStatus("agent", ctx.ui.theme.fg(statusColorToken, `agent:${activeName}${suffix}`));
	}

	function clearActive() {
		activeName = undefined;
		activeAgent = undefined;
		activeGuard = undefined;
		inputColorToken = undefined;
		statusColorToken = "accent";
	}

	function resolveColorToken(ctx: ExtensionContext, value: unknown, fallback: string, field: string): string {
		const name = typeof value === "string" ? value.trim() : "";
		if (!name) return fallback;
		if (name in (ctx.ui.theme.colors as Record<string, unknown>)) return name;
		ctx.ui.notify(`agents: unknown theme color "${name}" in ${field}; using ${fallback}`, "warning");
		return fallback;
	}

	function restoreBaseTheme(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !originalTheme) return;
		const setting = readThemeSetting(ctx.cwd);
		// A plain theme name restores the controller's auto-sync (system theme / light-dark pairs)
		// without writing settings: pi only persists when the stored setting differs.
		if (setting && !setting.includes("/")) ctx.ui.setTheme(setting);
		else ctx.ui.setTheme(originalTheme);
	}

	function applyInputColor(ctx: ExtensionContext, token: string | undefined) {
		if (ctx.mode !== "tui") return;
		if (!originalTheme) originalTheme = ctx.ui.theme;
		if (!token) {
			restoreBaseTheme(ctx);
			return;
		}

		const tokenMap = Object.fromEntries(THINKING_TOKENS.map((thinkingToken) => [thinkingToken, token]));
		const derived = deriveTheme(originalTheme, tokenMap, (name) =>
			ctx.ui.notify(`agents: unknown theme color "${name}"`, "warning"),
		);
		const result = ctx.ui.setTheme(derived);
		if (!result.success) ctx.ui.notify(`agents: cannot apply theme: ${result.error ?? "unknown error"}`, "warning");
	}

	/** Applies the agent's configured tool set (unknown names dropped, planDir write tools added). */
	function applyAgentTools(agent: AgentConfig, guard: Guard | undefined, ctx: ExtensionContext): string[] {
		if (!agent.tools || agent.tools.length === 0) return pi.getActiveTools();
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		let valid = agent.tools.filter((tool) => known.has(tool));
		if (DEPTH > 0) valid = valid.filter((tool) => tool !== "orchestrator_execution");
		const unknown = agent.tools.filter((tool) => !known.has(tool));
		if (unknown.length > 0) ctx.ui.notify(`agents: unknown tools: ${unknown.join(", ")}`, "warning");

		// A plan dir is useless without the write tools, so add them when available.
		if (guard?.planDir) {
			for (const tool of ["write", "edit"]) if (known.has(tool) && !valid.includes(tool)) valid.push(tool);
		}

		if (valid.length > 0) pi.setActiveTools(valid);
		return valid;
	}

	async function activate(name: string, ctx: ExtensionContext): Promise<boolean> {
		const agent = agents[name];
		if (!agent) {
			const available = agentNames().join(", ") || "(none defined)";
			ctx.ui.notify(`agents: unknown agent "${name}". Available: ${available}`, "error");
			return false;
		}

		// Snapshot the pre-agent state once so "(none)" can restore it.
		if (!activeName) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}

		if (agent.provider && agent.model) {
			const model = ctx.modelRegistry.find(agent.provider, agent.model);
			if (!model) {
				ctx.ui.notify(`agents: model ${agent.provider}/${agent.model} not found`, "warning");
			} else if (!(await pi.setModel(model))) {
				ctx.ui.notify(`agents: no API key for ${agent.provider}/${agent.model}`, "warning");
			}
		}

		if (agent.thinkingLevel) pi.setThinkingLevel(resolveThinking(agent, pi.getThinkingLevel()));

		const guard = buildGuard(agent);
		if (guard?.planDir) {
			try {
				mkdirSync(resolveUserPath(guard.planDir, ctx.cwd), { recursive: true });
			} catch (err) {
				ctx.ui.notify(`agents: cannot create plan dir "${guard.planDir}": ${err}`, "warning");
			}
		}

		applyAgentTools(agent, guard, ctx);

		inputColorToken = agent.inputColor
			? resolveColorToken(ctx, agent.inputColor, "borderMuted", "inputColor")
			: undefined;
		statusColorToken = resolveColorToken(ctx, agent.statusColor, "accent", "statusColor");
		applyInputColor(ctx, inputColorToken);

		activeName = name;
		activeAgent = agent;
		activeGuard = guard;

		ctx.ui.notify(`agent: ${name}${guard ? " (read-only)" : ""}`, "info");
		updateStatus(ctx);
		return true;
	}

	async function deactivate(ctx: ExtensionContext) {
		clearActive();
		if (originalState) {
			if (originalState.model) await pi.setModel(originalState.model);
			pi.setThinkingLevel(originalState.thinkingLevel);
			pi.setActiveTools(originalState.tools);
		}
		restoreBaseTheme(ctx);
		ctx.ui.notify("agent: (none)", "info");
		updateStatus(ctx);
	}

	async function pick(ctx: ExtensionContext) {
		const names = agentNames();
		if (names.length === 0) {
			ctx.ui.notify(
				`agents: no agents defined. Add them to ${join(getAgentDir(), "agents.json")} or ${join(ctx.cwd, CONFIG_DIR_NAME, "agents.json")}`,
				"warning",
			);
			return;
		}

		const labels = names.map((name) => {
			const agent = agents[name];
			const details = [
				agent.description,
				agent.planDir ? `plans in ${agent.planDir}` : undefined,
				agent.model && `${agent.provider}/${agent.model}`,
			]
				.filter(Boolean)
				.join(" - ");
			const marker = name === activeName ? " (active)" : "";
			const slot = agent.slot ? `[${agent.slot}] ` : "";
			return details ? `${slot}${name}${marker}  -  ${details}` : `${slot}${name}${marker}`;
		});
		labels.push("(none)");

		const choice = await ctx.ui.select("Select agent", labels);
		if (!choice) return;

		const index = labels.indexOf(choice);
		if (index === names.length) {
			await deactivate(ctx);
			return;
		}
		await activate(names[index], ctx);
	}

	// CLI flag: pi --agent architect
	pi.registerFlag("agent", { description: "Agent configuration to start with", type: "string" });

	// Hotkeys: one slot per agent, alphabetical order.
	SLOT_KEYS.forEach((digit, index) => {
		const handler = async (ctx: ExtensionContext) => {
			const name = agentNames()[index];
			if (!name) {
				ctx.ui.notify(`agents: no agent in slot ${index + 1}`, "warning");
				return;
			}
			if (name === activeName) return;
			await activate(name, ctx);
		};
		pi.registerShortcut(Key.alt(digit), { description: `Switch to agent ${index + 1}`, handler });
		pi.registerShortcut(Key.ctrlAlt(digit), { description: `Switch to agent ${index + 1}`, handler });
	});

	pi.registerShortcut(Key.ctrlAlt("a"), { description: "Select agent", handler: pick });

	// Hand a finished plan to the orchestrator. Subagents never get to run it.
	pi.registerTool({
		name: "orchestrator_execution",
		label: "Hand off the plan",
		description:
			"Start implementation of an agreed plan. Hands the plan file to the orchestrator agent, which opens a run, splits the plan into steps, delegates them to coder/reviewer/handyman subagents, tracks progress and reports back; it does not edit code itself. Use it when the plan is written and the user confirmed they want to implement it. Only for the primary planning session - a delegated subagent must return its result instead.",
		promptSnippet: "Start implementation of an agreed plan via the orchestrator agent",
		promptGuidelines: [
			"Call it once, after the plan file is written and the user explicitly agreed to start implementation",
			"It covers implementation, review and test runs of the plan; it is not for further design discussion",
			"The plan must live inside the plan directory and contain a route (## Route) or pass route explicitly",
			"After the handoff you are inactive until the run ends: do not try to implement anything yourself",
		],
		parameters: Type.Object({
			plan: Type.String({ description: "Path to the plan file inside the plan directory, e.g. .pi/plans/session-cache.md" }),
			route: Type.Optional(
				StringEnum(["full", "fast", "express"] as const, {
					description: "Execution route; omit to use the plan's ## Route section",
				}),
			),
			notes: Type.Optional(Type.String({ description: "Anything the orchestrator should know before starting" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const refuse = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { refused: true },
				isError: true,
			});

			if (DEPTH > 0 || !activeAgent?.planDir?.trim() || activeName === "orchestrator") {
				return refuse(
					handoffRefusal({ depth: DEPTH, agentName: activeName, planDir: activeAgent?.planDir }) ??
						"orchestrator_execution refused.",
				);
			}

			const planDir = activeAgent?.planDir?.trim();
			if (!planDir) return refuse("orchestrator_execution refused: no plan directory configured.");

			const planDirAbs = resolveUserPath(planDir, ctx.cwd);
			const planAbs = resolveUserPath(params.plan, ctx.cwd);
			if (!isInside(planDirAbs, planAbs)) {
				return refuse(`orchestrator_execution refused: the plan must live inside ${planDirAbs}.`);
			}
			if (!existsSync(planAbs)) {
				return refuse(`orchestrator_execution refused: plan file not found: ${params.plan}`);
			}

			let text = "";
			try {
				text = readFileSync(planAbs, "utf-8");
			} catch (err) {
				return refuse(`orchestrator_execution refused: cannot read ${params.plan}: ${err}`);
			}
			if (!text.trim()) return refuse(`orchestrator_execution refused: plan file is empty: ${params.plan}`);

			const parsed = parsePlan(text);
			const route = params.route ?? parsed.route;
			if (!route) {
				return refuse(
					"orchestrator_execution refused: no route given and the plan has no `## Route` section (full | fast | express).",
				);
			}

			const openRun = findOpenRunId(ctx.cwd);
			if (openRun) {
				return refuse(`orchestrator_execution refused: run ${openRun} is still open; finish it before starting another one.`);
			}

			if (ctx.hasUI) {
				const steps = parsed.steps.slice(0, 6).map((step, index) => {
					const agent = step.agent ? ` (${step.agent})` : "";
					const files = step.files.length > 0 ? ` — ${step.files.slice(0, 3).join(", ")}` : "";
					return `${index + 1}. ${step.title}${agent}${files}`;
				});
				const approved = await ctx.ui.confirm(
					`Execute plan: ${parsed.title ?? basename(planAbs)}`,
					[`Route: ${route}`, `Steps: ${parsed.steps.length}`, ...steps].join("\n"),
				);
				if (!approved) {
					return {
						content: [{ type: "text" as const, text: "Execution declined. The plan file is kept; keep discussing or edit it." }],
						details: { declined: true },
					};
				}
			}

			pendingHandoff = { plan: planAbs, route, notes: params.notes?.trim() || undefined };
			return {
				content: [
					{
						type: "text" as const,
						text: `Handing ${basename(planAbs)} to the orchestrator after this turn (route ${route}, ${parsed.steps.length} step(s)).`,
					},
				],
				details: { plan: planAbs, route, steps: parsed.steps.length },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("orchestrator_execution"))} ${theme.fg("accent", args.plan ?? "")}`,
				0,
				0,
			);
		},
	});

	// Switching agents mid-run breaks the queued message and the status line, so hand off once the turn settled.
	pi.on("agent_settled", async (_event, ctx) => {
		const pending = pendingHandoff;
		if (!pending) return;
		pendingHandoff = undefined;

		const switched = await activate("orchestrator", ctx);
		if (!switched) {
			ctx.ui.notify("agents: cannot hand off, orchestrator is not configured", "error");
			return;
		}
		pi.sendUserMessage(
			`Execute the plan at ${pending.plan} (route: ${pending.route}). ` +
				`Start by calling start_run({ route: "${pending.route}", plan: "${pending.plan}" }); do not probe for tools from a previous mode. ` +
				`Read the plan first and do not re-plan unless it is incomplete.${pending.notes ? `\n\nNotes: ${pending.notes}` : ""}`,
		);
	});

	pi.registerCommand("agent", {
		description: "Switch agent (persona/mode)",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				await pick(ctx);
				return;
			}
			if (name === "none" || name === "off") {
				await deactivate(ctx);
				return;
			}
			await activate(name, ctx);
		},
	});

	// Enforce the read-only guard on real tool calls.
	pi.on("tool_call", (event, ctx) => {
		const guard = activeGuard;
		if (!guard) return;

		const agentName = activeName ?? "agent";
		if (event.toolName === "edit" || event.toolName === "write") {
			const target = (event.input as { path?: string }).path;
			if (!target) {
				return { block: true, reason: `${agentName} is read-only: no file path was provided` };
			}
			const absolute = resolveUserPath(target, ctx.cwd);
			if (guard.planDir && isInside(resolveUserPath(guard.planDir, ctx.cwd), absolute)) return;
			// Read-only subagents still own their run artifacts: plan.md, log.md, result.md.
			const runDir = process.env.PI_RUN_DIR;
			if (runDir && isInside(resolveUserPath(runDir, ctx.cwd), absolute)) return;

			const allowed = [guard.planDir, runDir].filter(Boolean) as string[];
			const where = allowed.length
				? `Writes are only allowed inside ${allowed.join(" or ")}.`
				: "Writes are not allowed for this agent.";
			return { block: true, reason: `${agentName} is read-only: ${where} Blocked path: ${target}` };
		}

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = (event.input as { command?: string }).command ?? "";
			const verdict = isReadOnlyShell(command, event.toolName === "powershell" ? "powershell" : "bash", guard.allowCommands);
			if (!verdict.ok) {
				return {
					block: true,
					reason: `${agentName} is read-only: ${verdict.reason}. Use read/grep/find/ls for inspection, or ask the user to switch agents.`,
				};
			}
		}
	});

	// Inject the agent instructions as a structured prompt section (cache-friendly).
	pi.on("before_agent_start", (event, ctx) => {
		const sections = event.systemPromptOptions.sections;
		if (!activeName) {
			delete sections.agent;
			return;
		}

		sections.agent = buildAgentSection({
			name: activeName,
			readOnly: Boolean(activeGuard),
			tools: pi.getActiveTools(),
			planDirAbs: activeGuard?.planDir ? resolveUserPath(activeGuard.planDir, ctx.cwd) : undefined,
			runDirAbs: process.env.PI_RUN_DIR ? resolveUserPath(process.env.PI_RUN_DIR, ctx.cwd) : undefined,
			allowCommands: activeGuard?.allowCommands,
			instructions: activeAgent?.instructions,
		});
	});

	// Track the agent in the branch so rewinds/resumes restore it.
	pi.on("turn_start", async () => {
		if (activeName) pi.appendEntry("agent-state", { name: activeName });
	});

	pi.on("session_start", async (_event, ctx) => {
		agents = loadAgents(ctx.cwd);
		clearActive();
		originalState = undefined;
		pendingHandoff = undefined;
		restoreBaseTheme(ctx);

		const flag = pi.getFlag("agent");
		if (typeof flag === "string" && flag && flag !== "none") {
			await activate(flag, ctx);
			return;
		}

		const entries = ctx.sessionManager.getEntries() as Array<{
			type: string;
			customType?: string;
			data?: { name?: string };
		}>;
		const saved = entries
			.filter((entry) => entry.type === "custom" && entry.customType === "agent-state")
			.pop()?.data?.name;

		if (saved && agents[saved]) {
			// Do not re-apply model/thinking on restore: the session already carries them. Tools are
			// re-applied because the transcript may carry leftovers from the previous mode.
			activeName = saved;
			activeAgent = agents[saved];
			activeGuard = buildGuard(agents[saved]);
			applyAgentTools(agents[saved], activeGuard, ctx);
			inputColorToken = agents[saved].inputColor
				? resolveColorToken(ctx, agents[saved].inputColor, "borderMuted", "inputColor")
				: undefined;
			statusColorToken = resolveColorToken(ctx, agents[saved].statusColor, "accent", "statusColor");
			applyInputColor(ctx, inputColorToken);
			ctx.ui.notify(`agent: ${saved} (restored)`, "info");
		}

		updateStatus(ctx);
	});
}
