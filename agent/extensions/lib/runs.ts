/**
 * Run ledger, routes and batch validation for the orchestrator.
 *
 * Pure helpers are exported separately from the filesystem helpers so they can be unit tested.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AgentsConfig } from "./agents-config.ts";
import { isWriter } from "./agents-config.ts";

export type RouteName = "full" | "fast" | "express";

export interface RouteSpec {
	description: string;
	maxDelegations: number;
	/** Agents allowed on this route; "any" means every configured agent. */
	agents: "any" | readonly string[];
	steps: readonly string[];
	/** Whether worktree-isolated writer tasks are allowed on this route. */
	worktree: boolean;
}

export const ROUTES: Record<RouteName, RouteSpec> = {
	full: {
		description: "Полный цикл: разведка → план → реализация → ревью",
		maxDelegations: 10,
		agents: "any",
		worktree: true,
		steps: [
			"scout: разведка, сжатый контекст по затронутым файлам",
			"architect: план в .pi/plans/<run>.md",
			"coder(s): реализация + тесты (файлы не должны пересекаться)",
			"reviewer: ревью результата",
			"coder: фикс по замечаниям, не более 2 циклов",
		],
	},
	fast: {
		description: "Быстрый маршрут: план → реализация, без ревью",
		maxDelegations: 4,
		agents: ["scout", "architect", "coder"],
		worktree: false,
		steps: ["architect: короткий план", "coder(s): реализация + тесты"],
	},
	express: {
		description: "Экспресс: одна утилитарная задача (опечатки, тесты, коммит, мелкая утилита)",
		maxDelegations: 1,
		agents: ["handyman"],
		worktree: false,
		steps: ["handyman: одна задача, без плана и ревью"],
	},
};

export interface DelegateTask {
	agent: string;
	task: string;
	context?: string;
	files?: string[];
	timeoutSec?: number;
	/** 1-based plan step this task implements; the runtime enforces `depends` for it. */
	step?: number;
	/** Ownership scope in words, e.g. "surface weather only; do not touch materials or HUD". */
	scope?: string;
	/** Verification duty: check completed steps against the plan and acceptance criteria. */
	verify?: boolean;
	/** Run the task in an isolated git worktree (full route only). */
	worktree?: boolean | { base?: string };
	/** Merge worktree branches in the main workspace; runs alone, coder only. */
	merge?: { branches?: string[]; target?: string };
}

/** What the run already consumed, used for route limits. */
export interface RunUsage {
	delegations: number;
	worktrees: number;
}

export interface BatchValidation {
	ok: boolean;
	error?: string;
	/** Effective concurrency: 4 for read-only batches, 2 when writers are involved. */
	concurrency: number;
}

const MAX_CONCURRENCY = 4;
const MAX_WRITER_CONCURRENCY = 2;
export const MAX_WORKTREE_CONCURRENCY = 4;
export const MAX_WORKTREES_PER_RUN = 4;

function normalizeFile(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

export function filesOverlap(first: string, second: string): boolean {
	const a = normalizeFile(first);
	const b = normalizeFile(second);
	if (!a || !b) return false;
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Validate a delegation batch against the route rules and the run budget.
 *
 * - writers in the shared workspace may not run in parallel on overlapping files;
 * - worktree tasks are isolated, so they may overlap and run up to 4 at a time;
 * - a merge task runs alone, only for `coder`, only on routes that allow worktrees.
 */
export function validateBatch(
	route: RouteName,
	tasks: DelegateTask[],
	agents: AgentsConfig,
	usage: RunUsage,
): BatchValidation {
	const spec = ROUTES[route];
	if (!spec) return { ok: false, error: `Unknown route "${route}"`, concurrency: 1 };
	if (tasks.length === 0) return { ok: false, error: "No tasks to delegate", concurrency: 1 };

	const total = usage.delegations + tasks.length;
	if (total > spec.maxDelegations) {
		return {
			ok: false,
			error: `Route "${route}" allows ${spec.maxDelegations} delegations per run; ${usage.delegations} already used, ${tasks.length} requested`,
			concurrency: 1,
		};
	}

	for (const task of tasks) {
		if (!agents[task.agent]) {
			const available = Object.keys(agents).sort().join(", ") || "none";
			return { ok: false, error: `Unknown agent "${task.agent}". Configured: ${available}`, concurrency: 1 };
		}
		if (spec.agents !== "any" && !spec.agents.includes(task.agent)) {
			return {
				ok: false,
				error: `Route "${route}" does not allow agent "${task.agent}" (allowed: ${spec.agents.join(", ")})`,
				concurrency: 1,
			};
		}
		if (task.worktree && !isWriter(agents[task.agent])) {
			return { ok: false, error: `Worktrees are only for writer agents; "${task.agent}" is read-only`, concurrency: 1 };
		}
	}

	const mergeTasks = tasks.filter((task) => task.merge);
	if (mergeTasks.length > 0) {
		if (tasks.length > 1) {
			return { ok: false, error: "A merge task must run alone: delegate it in its own call", concurrency: 1 };
		}
		if (!spec.worktree) {
			return { ok: false, error: `Route "${route}" does not use worktrees, so it cannot merge worktree branches`, concurrency: 1 };
		}
		const mergeTask = mergeTasks[0];
		if (mergeTask.agent !== "coder") {
			return { ok: false, error: `Worktree branches must be merged by "coder", not "${mergeTask.agent}"`, concurrency: 1 };
		}
		if (mergeTask.worktree) {
			return { ok: false, error: "A merge task cannot itself run in a worktree", concurrency: 1 };
		}
		return { ok: true, concurrency: 1 };
	}

	const worktreeTasks = tasks.filter((task) => task.worktree);
	if (worktreeTasks.length > 0) {
		if (!spec.worktree) {
			return { ok: false, error: `Route "${route}" does not allow worktree tasks; use the full route`, concurrency: 1 };
		}
		const sharedWriters = tasks.filter((task) => isWriter(agents[task.agent]) && !task.worktree);
		if (sharedWriters.length > 0) {
			return {
				ok: false,
				error: "Do not mix worktree writers with shared-workspace writers in one batch",
				concurrency: 1,
			};
		}
		if (usage.worktrees + worktreeTasks.length > MAX_WORKTREES_PER_RUN) {
			return {
				ok: false,
				error: `At most ${MAX_WORKTREES_PER_RUN} worktrees per run; ${usage.worktrees} already created, ${worktreeTasks.length} requested`,
				concurrency: 1,
			};
		}
		return {
			ok: true,
			concurrency: Math.max(1, Math.min(MAX_WORKTREE_CONCURRENCY, tasks.length)),
		};
	}

	const writerTasks = tasks.filter((task) => isWriter(agents[task.agent]));
	if (writerTasks.length > 1) {
		for (const task of writerTasks) {
			if (!task.files || task.files.length === 0) {
				return {
					ok: false,
					error: `Parallel writers must declare files[]: task for "${task.agent}" has none. Split the work, run sequentially, or use worktree: true`,
					concurrency: 1,
				};
			}
		}
		for (let i = 0; i < writerTasks.length; i++) {
			for (let j = i + 1; j < writerTasks.length; j++) {
				const left = writerTasks[i];
				const right = writerTasks[j];
				for (const a of left.files ?? []) {
					for (const b of right.files ?? []) {
						if (filesOverlap(a, b)) {
							return {
								ok: false,
								error: `Parallel writers overlap on "${a}" and "${b}" (agents "${left.agent}" and "${right.agent}"). Use worktree: true or split the work`,
								concurrency: 1,
							};
						}
					}
				}
			}
		}
	}

	const limit = writerTasks.length > 0 ? MAX_WRITER_CONCURRENCY : MAX_CONCURRENCY;
	return { ok: true, concurrency: Math.max(1, Math.min(limit, tasks.length)) };
}

/** Branch created for a worktree task. */
export function branchNameFor(runId: string, taskId: string): string {
	return `agent/${runId}/${taskId}`;
}

/** Worktree directory, relative to the repository root. */
export function worktreePathFor(runId: string, taskId: string): string {
	return join(".pi", "worktrees", runId, taskId);
}

// ---------------------------------------------------------------------------
// Optional project config
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	/** Git-ignored directories symlinked into every new worktree. */
	worktreeLinks?: string[];
	/** Command executed inside a new worktree before the child starts, e.g. "npm ci". */
	worktreeSetup?: string;
}

const DEFAULT_WORKTREE_LINKS = ["node_modules", ".venv"];

/** Reads `.pi/orchestrator.json`; malformed or missing files fall back to defaults. */
export function loadOrchestratorConfig(cwd: string): Required<Pick<OrchestratorConfig, "worktreeLinks">> & OrchestratorConfig {
	const path = join(cwd, CONFIG_DIR_NAME, "orchestrator.json");
	if (!existsSync(path)) return { worktreeLinks: [...DEFAULT_WORKTREE_LINKS] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as OrchestratorConfig;
		const links = Array.isArray(parsed.worktreeLinks)
			? parsed.worktreeLinks.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			: [];
		return {
			worktreeLinks: links.length > 0 ? links : [...DEFAULT_WORKTREE_LINKS],
			worktreeSetup: typeof parsed.worktreeSetup === "string" && parsed.worktreeSetup.trim() ? parsed.worktreeSetup.trim() : undefined,
		};
	} catch (err) {
		console.error(`orchestrator: failed to parse ${path}: ${err}`);
		return { worktreeLinks: [...DEFAULT_WORKTREE_LINKS] };
	}
}

/** Filesystem- and shell-safe run id: `<UTC timestamp>-<slug>`. */
export function runIdFor(goal: string, now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
	return `${stamp}-${slugify(goal, 24)}`;
}

export function slugify(text: string, maxLength: number): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9а-яё]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/g, "");
	return slug || "run";
}

export function runDir(cwd: string, runId: string): string {
	return join(cwd, ".pi", "runs", runId);
}

const GITIGNORE_LINES = [".pi/runs/", ".pi/worktrees/"];

/** Add the run artifact directories to the project's .gitignore once. */
export function ensureGitignore(cwd: string): void {
	const path = join(cwd, ".gitignore");
	let content = "";
	if (existsSync(path)) {
		try {
			content = readFileSync(path, "utf-8");
		} catch {
			return;
		}
	}
	const lines = content.split(/\r?\n/);
	const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line));
	if (missing.length === 0) return;

	const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
	writeFileSync(path, `${content}${prefix}# pi agent runs\n${missing.join("\n")}\n`, "utf-8");
}

/** Newest run with status "open", if any. */
export function findOpenRunId(cwd: string): string | undefined {
	const dir = join(cwd, ".pi", "runs");
	if (!existsSync(dir)) return undefined;
	let names: string[];
	try {
		names = readdirSync(dir).sort().reverse();
	} catch {
		return undefined;
	}
	for (const name of names) {
		const path = join(dir, name, "run.json");
		if (!existsSync(path)) continue;
		try {
			const run = JSON.parse(readFileSync(path, "utf-8")) as { status?: string };
			if (run.status === "open") return name;
		} catch {
			// ignore malformed ledger, keep looking
		}
	}
	return undefined;
}
