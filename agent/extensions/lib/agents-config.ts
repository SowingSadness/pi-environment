/**
 * Shared agent configuration: loading, slot ordering, thinking resolution.
 *
 * Lives in a subdirectory without an `index.ts`, so pi does not load it as an extension;
 * `agents.ts` and `orchestrator.ts` import it directly.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** `"dispatcher"` means: use the thinking level of whoever dispatches the task. */
export type ThinkingSetting = ThinkingLevel | "dispatcher";

export interface AgentConfig {
	/** Hotkey slot 1..9 and sort order. Agents without a slot come after, alphabetically. */
	slot?: number;
	/** Shown in the picker and status line. */
	description?: string;
	/** Model provider, e.g. "anthropic". Requires `model`. */
	provider?: string;
	/** Model id, e.g. "claude-sonnet-4-5". */
	model?: string;
	/** Thinking level for this agent, or `"dispatcher"` to inherit the dispatching level. */
	thinkingLevel?: ThinkingSetting;
	/** Active tool names. Omit to keep the current set. */
	tools?: string[];
	/** Block file writes and mutating shell commands. Implied by `planDir`. */
	readOnly?: boolean;
	/** Directory the agent may write to while read-only. Relative to cwd, `~` allowed. */
	planDir?: string;
	/** Extra literal command prefixes allowed while read-only, e.g. "npx tsc --noEmit". */
	allowCommands?: string[];
	/** Theme token name used as the editor input border color, e.g. "accent". */
	inputColor?: string;
	/** Theme token name used for the `agent:<name>` badge in the status line. */
	statusColor?: string;
	/** Text appended to the system prompt while this agent is active. */
	instructions?: string;
}

export interface AgentsConfig {
	[name: string]: AgentConfig;
}

const AGENTS_FILE = "agents.json";

export function loadAgents(cwd: string): AgentsConfig {
	const paths = [join(getAgentDir(), AGENTS_FILE), join(cwd, CONFIG_DIR_NAME, AGENTS_FILE)];
	let merged: AgentsConfig = {};

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as AgentsConfig;
			if (parsed && typeof parsed === "object") merged = { ...merged, ...parsed };
		} catch (err) {
			console.error(`agents: failed to parse ${path}: ${err}`);
		}
	}

	return merged;
}

export function slotOf(agents: AgentsConfig, name: string): number {
	const slot = agents[name]?.slot;
	return typeof slot === "number" && Number.isFinite(slot) && slot > 0 ? slot : Number.MAX_SAFE_INTEGER;
}

/** Agents ordered by explicit slot, then by name. Hotkey number = position in this list. */
export function sortAgentNames(agents: AgentsConfig): string[] {
	return Object.keys(agents).sort(
		(a, b) => slotOf(agents, a) - slotOf(agents, b) || a.localeCompare(b),
	);
}

/** Agents that can change the workspace: not read-only and able to call edit/write. */
export function isWriter(agent: AgentConfig | undefined): boolean {
	if (!agent || agent.readOnly) return false;
	const tools = agent.tools;
	if (!tools || tools.length === 0) return true;
	return tools.includes("edit") || tools.includes("write");
}

/** Resolve a configured thinking setting against the dispatching level. */
export function resolveThinking(agent: AgentConfig | undefined, dispatcherLevel: ThinkingLevel): ThinkingLevel {
	const setting = agent?.thinkingLevel;
	if (!setting || setting === "dispatcher") return dispatcherLevel;
	return setting;
}
