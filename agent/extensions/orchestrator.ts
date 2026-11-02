/**
 * Orchestrator tools: start_run / delegate / finish_run, plus the subagent heartbeat writer.
 *
 * The orchestrator agent is read-only. Everything that changes the repository happens in a child
 * `pi` process started with `--agent <name>`, so the child inherits its model, thinking level,
 * tools and read-only guard from `agents.json`.
 *
 * Run artifacts live in `<cwd>/.pi/runs/<runId>/`:
 *   run.json                       ledger (route, goal, tasks, usage)
 *   tasks/<taskId>/brief.md        what the child was asked to do
 *   tasks/<taskId>/plan.md         written by the child: numbered steps
 *   tasks/<taskId>/log.md          written by the child: progress lines
 *   tasks/<taskId>/alive.jsonl     heartbeat, written by this extension in the child every 60s
 *   tasks/<taskId>/state.json      parent-side state: pid, phase, exit code
 *   tasks/<taskId>/result.md       child's final report
 *   summary.md                     written by finish_run
 *
 * Recursion guard: children run with PI_AGENT_DEPTH>=1 and do not register these tools.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { StringEnum, Type, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AgentConfig, type ThinkingLevel, loadAgents, resolveThinking } from "./lib/agents-config.ts";
import { type ParsedPlan, parseDepends, parsePlan } from "./lib/plans.ts";
import { type BriefStep, buildTaskBrief } from "./lib/brief.ts";
import {
	type DelegateTask,
	ROUTES,
	type RouteName,
	ensureGitignore,
	findOpenRunId,
	loadOrchestratorConfig,
	runDir,
	runIdFor,
	validateBatch,
} from "./lib/runs.ts";
import {
	type CommandRunner,
	type WorktreeInfo,
	commitWorktree,
	conflictedFiles,
	createWorktree,
	isMergeInProgress,
	mergePreflight,
	removeWorktree,
	worktreePreflight,
	worktreeState,
} from "./lib/worktree.ts";

const DEPTH = Number.parseInt(process.env.PI_AGENT_DEPTH ?? "0", 10) || 0;
const HEARTBEAT_SEC = Number.parseInt(process.env.PI_HEARTBEAT_SEC ?? "60", 10) || 60;
const DEFAULT_TIMEOUT_SEC = 900;
const MAX_OUTPUT_BYTES = 8 * 1024;
const WATCHDOG_IDLE_MS = HEARTBEAT_SEC * 2500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskStatus = "pending" | "running" | "done" | "failed" | "timeout";

interface RunWorktree extends WorktreeInfo {
	headCommit?: string;
	autoCommitted?: boolean;
	commitError?: string;
}

interface RunMerge {
	branches: string[];
	target?: string;
	merged?: boolean;
	inProgress?: boolean;
	conflicted?: string[];
	error?: string;
}

interface RunTaskRecord {
	id: string;
	agent: string;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	usage: Usage;
	files?: string[];
	/** 1-based plan step this task implements. */
	step?: number;
	worktree?: RunWorktree;
	merge?: RunMerge;
}

interface RunStepRecord {
	index: number;
	title: string;
	agent?: string;
	files: string[];
	depends: number[];
	acceptance?: string;
	status: "pending" | "done";
}

interface RunLedger {
	id: string;
	route: RouteName;
	goal: string;
	steps?: string;
	/** Plan steps of this run, with dependency order and completion state. */
	planSteps?: RunStepRecord[];
	/** Absolute path of the plan this run executes, when handed off by the architect. */
	planPath?: string;
	planTitle?: string;
	root: string;
	startedAt: number;
	endedAt?: number;
	status: "open" | "done" | "failed" | "aborted";
	tasks: RunTaskRecord[];
}

interface TaskOutcome {
	id: string;
	agent: string;
	status: TaskStatus;
	output: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	usage: Usage;
	taskDir: string;
	idleMs: number;
	worktree?: RunWorktree;
	merge?: RunMerge;
}

interface DelegateDetails {
	runId: string;
	route: RouteName;
	results: TaskOutcome[];
}

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(target: Usage, delta: Usage | undefined): void {
	if (!delta) return;
	target.input += delta.input ?? 0;
	target.output += delta.output ?? 0;
	target.cacheRead += delta.cacheRead ?? 0;
	target.cacheWrite += delta.cacheWrite ?? 0;
	target.totalTokens = delta.totalTokens ?? target.totalTokens;
	target.cost.input += delta.cost?.input ?? 0;
	target.cost.output += delta.cost?.output ?? 0;
	target.cost.cacheRead += delta.cost?.cacheRead ?? 0;
	target.cost.cacheWrite += delta.cost?.cacheWrite ?? 0;
	target.cost.total += delta.cost?.total ?? 0;
}

function resolvePlanPath(cwd: string, input: string): string {
	const trimmed = input.trim().replace(/^@/, "");
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const expanded =
		trimmed === "~"
			? home
			: trimmed.startsWith("~/") || trimmed.startsWith("~\\")
				? join(home, trimmed.slice(2))
				: trimmed;
	return resolve(cwd, expanded);
}

function formatUsage(usage: Usage): string {
	return `↑${usage.input} ↓${usage.output} $${usage.cost.total.toFixed(4)}`;
}

function clip(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let clipped = text.slice(0, maxBytes);
	while (Buffer.byteLength(clipped, "utf8") > maxBytes) clipped = clipped.slice(0, -1);
	return `${clipped}\n\n[truncated: full text in result.md]`;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function readRun(cwd: string, runId: string): RunLedger | undefined {
	const path = join(runDir(cwd, runId), "run.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as RunLedger;
	} catch {
		return undefined;
	}
}

function writeRun(cwd: string, run: RunLedger): void {
	writeFileSync(join(runDir(cwd, run.id), "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf-8");
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** Age of the newest heartbeat line the child wrote, in milliseconds. */
function heartbeatAge(taskDir: string): number | undefined {
	const path = join(taskDir, "alive.jsonl");
	if (!existsSync(path)) return undefined;
	try {
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		const last = lines[lines.length - 1];
		if (!last) return undefined;
		const parsed = JSON.parse(last) as { ts?: number };
		return typeof parsed.ts === "number" ? Date.now() - parsed.ts : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Run an optional setup command inside a fresh worktree (shell needed: "npm ci" is a string). */
async function runSetupCommand(runner: CommandRunner, command: string, cwd: string, signal?: AbortSignal) {
	const shell =
		process.platform === "win32"
			? { command: "cmd", args: ["/c", command] }
			: { command: "sh", args: ["-c", command] };
	return runner(shell.command, shell.args, { cwd, signal, timeout: 300_000 });
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<unknown>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			await fn(items[index], index);
		}
	});
	await Promise.all(workers);
}

function buildBrief(params: {
	agent: string;
	task: DelegateTask;
	run: RunLedger;
	taskId: string;
	index: number;
	total: number;
	step?: number;
}): string {
	const { agent, task, run, taskId, index, total } = params;
	const runPath = runDir(run.root, run.id);
	const priorResults = run.tasks
		.filter((record) => record.status === "done" && record.id !== taskId)
		.map((record) => join(runPath, "tasks", record.id, "result.md"))
		.filter((file) => existsSync(file));
	const steps: BriefStep[] | undefined = run.planSteps?.map((item) => ({
		index: item.index,
		title: item.title,
		status: item.status,
		agent: item.agent,
		depends: item.depends,
		acceptance: item.acceptance,
	}));

	return buildTaskBrief({
		runId: run.id,
		route: run.route,
		goal: run.goal,
		root: run.root,
		agent,
		index,
		total,
		taskId,
		task: task.task,
		context: task.context,
		scope: task.scope,
		files: task.files,
		planPath: run.planPath,
		contextPath: run.planPath ? join(runPath, "context.md") : undefined,
		priorResults,
		steps,
		step: params.step,
		verify: task.verify,
		depth: DEPTH + 1,
	});
}

function buildMergeBrief(params: { run: RunLedger; task: DelegateTask; branches: string[]; target: string }): string {
	const { run, task, branches, target } = params;
	const summaries = run.tasks
		.filter((record) => record.worktree)
		.map((record) => {
			let excerpt = "(no result.md)";
			try {
				excerpt = readFileSync(join(runDir(run.root, run.id), "tasks", record.id, "result.md"), "utf-8")
					.trim()
					.slice(0, 800);
			} catch {
				// no result file: the branch summary is simply unknown
			}
			return `### ${record.agent} — ${record.worktree?.branch}\n\n${excerpt}`;
		})
		.join("\n\n");

	return [
		`# Integration task: merge ${branches.length} worktree branch(es)`,
		"",
		`Run: ${run.id} (route: ${run.route})`,
		`Working directory: ${run.root}`,
		`Target: ${target}`,
		"",
		"## Goal of the run",
		run.goal,
		"",
		"## Branches to merge, in order",
		...branches.map((branch, index) => `${index + 1}. ${branch}`),
		"",
		"## What each branch did",
		summaries || "(no worktree results)",
		"",
		"## Your task",
		task.task,
		task.context?.trim() ? `\n## Extra context\n${task.context.trim()}` : "",
		"",
		"## Merge policy (required)",
		"1. Merge one branch at a time in the order above: `git merge --no-ff <branch>`.",
		"2. Resolve conflicts by understanding both sides from the plan and summaries above; never drop work silently.",
		"3. If a conflict cannot be resolved without guessing, run `git merge --abort`, leave the workspace clean and report which files conflict.",
		"4. After the last merge run the project's test or typecheck command and report the command and result.",
		"5. Do not push. Do not delete branches or worktrees.",
	].join("\n");
}

function runChildAgent(params: {
	root: string;
	run: RunLedger;
	agentName: string;
	agent: AgentConfig;
	level: ThinkingLevel;
	task: DelegateTask;
	taskId: string;
	index: number;
	total: number;
	signal: AbortSignal | undefined;
	outcomes: TaskOutcome[];
	onUpdate: (() => void) | undefined;
	ledgerTask: RunTaskRecord;
	/** Command runner used for git plumbing (worktree/merge tasks). */
	runner: CommandRunner;
	/** Directory the child runs in: the repository root or its worktree. */
	cwd: string;
	worktree?: WorktreeInfo;
	merge?: { branches: string[]; target: string };
	/** Replaces the default task brief (used for merge tasks). */
	briefOverride?: string;
	/** 1-based plan step this task implements. */
	step?: number;
}): Promise<TaskOutcome> {
	const { root, run, agentName, agent, level, task, taskId, signal, outcomes, onUpdate, ledgerTask } = params;
	const { runner, cwd, worktree, merge } = params;
	const taskDir = join(runDir(root, run.id), "tasks", taskId);
	mkdirSync(taskDir, { recursive: true });

	const startedAt = Date.now();
	const usage = emptyUsage();
	let lastEventAt = startedAt;
	let lastText = "";
	let lastTool = "";
	let turns = 0;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let stderr = "";
	let pid = 0;
	let finished = false;

	const outcome: TaskOutcome = {
		id: taskId,
		agent: agentName,
		status: "running",
		output: "",
		stderr: "",
		exitCode: 0,
		durationMs: 0,
		usage,
		taskDir,
		idleMs: 0,
	};
	outcomes.push(outcome);

	const brief =
		params.briefOverride ??
		buildBrief({ agent: agentName, task, run, taskId, index: params.index, total: params.total, step: params.step });
	writeFileSync(join(taskDir, "brief.md"), `${brief}\n`, "utf-8");

	const statePath = join(taskDir, "state.json");
	const writeState = (extra: Record<string, unknown> = {}) => {
		writeJson(statePath, {
			taskId,
			agent: agentName,
			phase: outcome.status,
			pid,
			startedAt,
			lastEventAt,
			turns,
			idleMs: Date.now() - lastEventAt,
			heartbeatAgeMs: heartbeatAge(taskDir),
			exitCode: outcome.exitCode || undefined,
			...extra,
		});
	};
	writeState();

	const emit = () => {
		outcome.output = clip(lastText || (lastTool ? `…${lastTool}` : ""), MAX_OUTPUT_BYTES);
		outcome.idleMs = heartbeatAge(taskDir) ?? Date.now() - lastEventAt;
		onUpdate?.();
	};

	const invocation = getPiInvocation([
		"--agent",
		agentName,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--thinking",
		level,
		`Task: ${brief}`,
	]);
	const child = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_RUN_DIR: runDir(root, run.id),
			PI_RUN_TASK: taskDir,
			PI_AGENT_NAME: agentName,
			PI_AGENT_DEPTH: String(DEPTH + 1),
			PI_HEARTBEAT_SEC: String(HEARTBEAT_SEC),
		},
	});
	pid = child.pid ?? 0;
	writeState();

	const killChild = () => {
		try {
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 5000).unref?.();
		} catch {
			// already gone
		}
	};

	const timeoutHandle = setTimeout(() => {
		if (finished) return;
		outcome.status = "timeout";
		killChild();
	}, (task.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000);
	const watchdogHandle = setInterval(() => {
		if (finished) return;
		emit();
		writeState();
	}, 30_000);
	watchdogHandle.unref?.();

	const onAbort = () => {
		if (finished) return;
		outcome.status = "failed";
		errorMessage ??= "aborted by the user";
		killChild();
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	let buffer = "";
	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		lastEventAt = Date.now();
		if (event.type !== "message_end" || !event.message) return;

		const message = event.message;
		if (message.role === "assistant") {
			turns++;
			addUsage(usage, message.usage as Usage | undefined);
			if (message.stopReason) stopReason = message.stopReason;
			if (message.errorMessage) errorMessage = message.errorMessage;
			const text = Array.isArray(message.content)
				? message.content
						.filter((part: any) => part?.type === "text")
						.map((part: any) => part.text)
						.join("\n")
						.trim()
				: "";
			if (text) lastText = text;
			emit();
			return;
		}
		if (message.role === "toolResult" && message.toolName) {
			lastTool = message.toolName;
			emit();
		}
	};

	child.stdout?.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	});
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});

	const finish = async () => {
		if (finished) return;
		finished = true;
		clearTimeout(timeoutHandle);
		clearInterval(watchdogHandle);
		signal?.removeEventListener("abort", onAbort);
		if (buffer.trim()) processLine(buffer);

		outcome.exitCode = child.exitCode ?? 1;
		outcome.durationMs = Date.now() - startedAt;
		outcome.stderr = stderr.trim();
		if (outcome.status === "running") {
			outcome.status =
				outcome.exitCode === 0 && stopReason !== "error" && stopReason !== "aborted" ? "done" : "failed";
		}

		// Worktree task: make the branch usable for merging, even if the child forgot to commit.
		if (worktree && outcome.status === "done") {
			const before = await worktreeState(runner, cwd, signal);
			const message = `agent(${agentName}): ${task.task.split("\n")[0].slice(0, 72)}`;
			const commit = before.dirty ? await commitWorktree(runner, cwd, message, signal) : { committed: false };
			const after = await worktreeState(runner, cwd, signal);
			outcome.worktree = {
				...worktree,
				headCommit: after.head,
				autoCommitted: commit.committed,
				commitError: commit.error,
			};
			ledgerTask.worktree = outcome.worktree;
		}

		// Merge task: record whether the merge finished or stopped on conflicts.
		if (merge) {
			const inProgress = await isMergeInProgress(runner, root, signal);
			const conflicted = inProgress ? await conflictedFiles(runner, root, signal) : [];
			if (inProgress) outcome.status = "failed";
			outcome.merge = {
				branches: merge.branches,
				target: merge.target,
				merged: !inProgress && outcome.status === "done",
				inProgress,
				conflicted,
			};
			ledgerTask.merge = outcome.merge;
		}

		const finalText = (lastText || outcome.stderr || "(no output)").trim();
		outcome.output = clip(finalText, MAX_OUTPUT_BYTES);
		writeFileSync(join(taskDir, "result.md"), `${finalText}\n`, "utf-8");
		ledgerTask.status = outcome.status;
		ledgerTask.endedAt = Date.now();
		ledgerTask.exitCode = outcome.exitCode;
		ledgerTask.usage = usage;
		writeState({ finishedAt: Date.now(), error: errorMessage, worktree: outcome.worktree, merge: outcome.merge });
		emit();
	};

	return new Promise<TaskOutcome>((resolve) => {
		child.on("close", async () => {
			await finish();
			resolve(outcome);
		});
		child.on("error", async (error) => {
			stderr += String(error);
			await finish();
			resolve(outcome);
		});
	});
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const startRunParams = Type.Object({
	route: Type.Optional(
		StringEnum(["full", "fast", "express"] as const, {
			description: "Execution route; omit to take it from the plan's ## Route section",
		}),
	),
	goal: Type.Optional(Type.String({ description: "What the user wants; omit to take it from the plan" })),
	plan: Type.Optional(
		Type.String({ description: "Path to a plan file (e.g. handed off by the architect); its route, goal and steps are used" }),
	),
	steps: Type.Optional(Type.String({ description: "Free-text plan when there is no plan file" })),
});

const delegateParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run id from start_run. Defaults to the open run" })),
	tasks: Type.Array(
		Type.Object({
			agent: Type.String({ description: "Agent name from agents.json (scout, architect, coder, reviewer, handyman)" }),
			task: Type.String({ description: "Concrete task for the subagent" }),
			context: Type.Optional(Type.String({ description: "Facts the subagent needs: plan excerpt, constraints, file list" })),
			files: Type.Optional(Type.Array(Type.String(), { description: "Files this task will touch; required for parallel writers" })),
			timeoutSec: Type.Optional(Type.Number({ description: "Per-task timeout in seconds, default 900" })),
			step: Type.Optional(
				Type.Number({ description: "1-based plan step this task implements; the plan's depends[] is enforced" }),
			),
			scope: Type.Optional(
				Type.String({ description: "Ownership scope in words; anything outside it must not be touched" }),
			),
			verify: Type.Optional(
				Type.Boolean({ description: "Verification duty: check completed steps against the plan and acceptance" }),
			),
			worktree: Type.Optional(
				Type.Union([Type.Boolean(), Type.Object({ base: Type.Optional(Type.String({ description: "Commit or branch to create the worktree from, default HEAD" })) })], {
					description: "Run this task in an isolated git worktree (full route, writer agents only)",
				}),
			),
			merge: Type.Optional(
				Type.Object(
					{
						branches: Type.Optional(
							Type.Array(Type.String(), { description: "Branches to merge; default: every worktree branch of this run" }),
						),
						target: Type.Optional(Type.String({ description: "Target ref, default HEAD" })),
					},
					{ description: "Merge worktree branches into the main workspace; must run alone, coder only" },
				),
			),
		}),
		{ description: "One task runs synchronously; several run in parallel within the route limits" },
	),
	concurrency: Type.Optional(Type.Number({ description: "Max parallel tasks (bounded by route rules)" })),
});

const finishRunParams = Type.Object({
	runId: Type.String({ description: "Run id from start_run" }),
	status: StringEnum(["done", "failed", "aborted"] as const, { description: "Final run status" }),
	summary: Type.String({ description: "Markdown summary for the user: what was done, files, tests, open questions" }),
	cleanupWorktrees: Type.Optional(
		Type.Boolean({ description: "Remove this run's worktrees and branches after a successful merge" }),
	),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function orchestratorExtension(pi: ExtensionAPI) {
	const heartbeatDir = process.env.PI_RUN_TASK;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	const alive = (extra: Record<string, unknown>) => {
		if (!heartbeatDir) return;
		try {
			appendFileSync(
				join(heartbeatDir, "alive.jsonl"),
				`${JSON.stringify({ ts: Date.now(), agent: process.env.PI_AGENT_NAME, pid: process.pid, ...extra })}\n`,
				"utf-8",
			);
		} catch {
			// a heartbeat must never break the run
		}
	};

	pi.on("session_start", async () => {
		if (!heartbeatDir || heartbeatTimer) return;
		alive({ event: "start" });
		heartbeatTimer = setInterval(() => alive({ event: "heartbeat" }), HEARTBEAT_SEC * 1000);
		heartbeatTimer.unref?.();
	});
	pi.on("session_shutdown", async () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		alive({ event: "shutdown" });
	});
	pi.on("tool_execution_start", (event) => alive({ event: "tool_start", tool: event.toolName }));
	pi.on("tool_execution_end", (event) => alive({ event: "tool_end", tool: event.toolName, isError: event.isError }));

	// Children never get the orchestration tools: depth guard plus `--tools` from their agent config.
	if (DEPTH > 0) return;

	const activeRuns = new Map<string, RunLedger>();

	function loadRun(cwd: string, runId?: string): RunLedger | undefined {
		const id = runId ?? findOpenRunId(cwd);
		if (!id) return undefined;
		const cached = activeRuns.get(id);
		if (cached) return cached;
		const run = readRun(cwd, id);
		if (run) activeRuns.set(id, run);
		return run;
	}

	pi.registerTool({
		name: "start_run",
		label: "Start run",
		description:
			"Open an orchestration run: pick the route, store the goal, ask the user once for confirmation and return the checklist. delegate() only works inside an open run.",
		promptSnippet: "Open an orchestration run (route + goal) with a single user confirmation",
		promptGuidelines: [
			"Call start_run once per user request, before any delegate call; never open a second run while one is open",
			"Pick the route: full for unfamiliar work, fast for a known local change, express for typos/extra tests/commits/small utilities",
		],
		parameters: startRunParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const openRun = findOpenRunId(ctx.cwd);
			if (openRun) {
				return {
					content: [{ type: "text", text: `Run ${openRun} is still open. Close it with finish_run before starting another one.` }],
					details: { openRun },
					isError: true,
				};
			}

			let parsed: ParsedPlan | undefined;
			let planPath: string | undefined;
			let planText: string | undefined;
			const requestedPlan = params.plan?.trim();
			if (requestedPlan) {
				planPath = resolvePlanPath(ctx.cwd, requestedPlan);
				if (!existsSync(planPath)) {
					return {
						content: [{ type: "text", text: `Plan file not found: ${requestedPlan}` }],
						details: undefined,
						isError: true,
					};
				}
				try {
					planText = readFileSync(planPath, "utf-8");
					parsed = parsePlan(planText);
				} catch (err) {
					return {
						content: [{ type: "text", text: `Cannot read plan ${requestedPlan}: ${err}` }],
						details: undefined,
						isError: true,
					};
				}
			}

			const route = (params.route as RouteName | undefined) ?? parsed?.route;
			if (!route) {
				return {
					content: [{ type: "text", text: "start_run needs a route, or a plan file with a `## Route` section." }],
					details: undefined,
					isError: true,
				};
			}

			const spec = ROUTES[route];
			const goal = params.goal?.trim() || parsed?.goal || parsed?.title || `Run ${route}`;
			const runId = runIdFor(goal);
			const run: RunLedger = {
				id: runId,
				route,
				goal,
				steps: params.steps,
				planSteps: parsed?.steps.length
					? parsed.steps.map((item, index) => ({
							index: index + 1,
							title: item.title,
							agent: item.agent,
							files: item.files,
							depends: parseDepends(item.depends),
							acceptance: item.acceptance,
							status: "pending" as const,
						}))
					: undefined,
				planPath,
				planTitle: parsed?.title,
				root: ctx.cwd,
				startedAt: Date.now(),
				status: "open",
				tasks: [],
			};
			const runPath = runDir(ctx.cwd, runId);
			mkdirSync(join(runPath, "tasks"), { recursive: true });
			ensureGitignore(ctx.cwd);
			if (planText) writeFileSync(join(runPath, "plan.md"), planText, "utf-8");
			if (planPath) {
				const contextText =
					parsed?.context?.trim() ||
					"(no `## Context` section in the plan; rely on plan.md and the project rules)";
				writeFileSync(join(runPath, "context.md"), `${contextText}\n`, "utf-8");
			}
			writeFileSync(join(runPath, "results.md"), "# Results\n\n", "utf-8");
			writeRun(ctx.cwd, run);
			activeRuns.set(runId, run);

			const planSteps = parsed?.steps ?? [];
			const checklist =
				planSteps.length > 0
					? planSteps
							.map((step, index) => {
								const agent = step.agent ? ` (${step.agent})` : "";
								const files = step.files.length > 0 ? ` — ${step.files.join(", ")}` : "";
								return `${index + 1}. ${step.title}${agent}${files}`;
							})
							.join("\n")
					: spec.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
			const planned = params.steps?.trim() ? `\n\nPlanned steps:\n${params.steps.trim()}` : "";
			const agents = spec.agents === "any" ? "any configured agent" : spec.agents.join(", ");

			if (ctx.hasUI) {
				const approved = await ctx.ui.confirm(
					`Run ${route}: ${goal.slice(0, 80)}`,
					`${planPath ? `Plan: ${planPath}\n` : ""}Route: ${route} — ${spec.description}\nMax delegations: ${spec.maxDelegations}\nAgents: ${agents}\n\n${checklist}${planned}`,
				);
				if (!approved) {
					run.status = "aborted";
					run.endedAt = Date.now();
					writeRun(ctx.cwd, run);
					activeRuns.delete(runId);
					return {
						content: [{ type: "text", text: "Run cancelled by the user. Nothing was delegated." }],
						details: { runId, cancelled: true },
					};
				}
			}

			return {
				content: [
					{
						type: "text",
						text: [
							`Run ${runId} is open (route ${route}, max ${spec.maxDelegations} delegations).`,
							`Agents allowed: ${agents}.`,
							"",
							"Route checklist:",
							checklist,
							"",
							`Next: delegate({ runId: "${runId}", tasks: [...] }). Close with finish_run.`,
						].join("\n"),
					},
				],
				details: { runId, route, planPath, maxDelegations: spec.maxDelegations },
			};
		},
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Run one or more tasks in isolated subagent processes and return their summaries. Subagents do not see this conversation, so pass everything they need in `context`.",
		promptSnippet: "Delegate tasks to specialized subagents in isolated contexts (single or parallel)",
		promptGuidelines: [
			"Write the brief yourself: goal, constraints, affected files, acceptance criteria, output format",
			"Parallel writers (coder/handyman) must declare non-overlapping files[]; otherwise run them one at a time",
			"When you delegate to architect or scout, say explicitly that they return their result and must not start orchestration",
		],
		parameters: delegateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const run = loadRun(ctx.cwd, params.runId);
			if (!run) {
				return {
					content: [{ type: "text", text: "No open run. Call start_run first — delegate is only allowed inside a run." }],
					details: undefined,
					isError: true,
				};
			}
			if (run.status !== "open") {
				return {
					content: [{ type: "text", text: `Run ${run.id} is ${run.status}; start a new run.` }],
					details: { runId: run.id },
					isError: true,
				};
			}

			const agents = loadAgents(ctx.cwd);
			const tasks = params.tasks as DelegateTask[];
			const config = loadOrchestratorConfig(ctx.cwd);
			const runner: CommandRunner = (command, args, options) => pi.exec(command, args, options);
			const validation = validateBatch(run.route, tasks, agents, {
				delegations: run.tasks.length,
				worktrees: run.tasks.filter((record) => record.worktree).length,
			});
			if (!validation.ok) {
				return {
					content: [{ type: "text", text: `delegate rejected: ${validation.error}` }],
					details: { runId: run.id, validation },
					isError: true,
				};
			}

			const parentLevel = pi.getThinkingLevel() as ThinkingLevel;
			const concurrency = Math.max(1, Math.min(params.concurrency ?? validation.concurrency, validation.concurrency));
			const outcomes: TaskOutcome[] = [];
			const base = run.tasks.length;

			interface Job {
				task: DelegateTask;
				index: number;
				taskId: string;
				ledgerTask: RunTaskRecord;
				worktree?: WorktreeInfo;
			}

			const jobs: Job[] = tasks.map((task, index) => {
				const taskId = `${String(base + index + 1).padStart(2, "0")}-${task.agent}`;
				return {
					task,
					index,
					taskId,
					ledgerTask: {
						id: taskId,
						agent: task.agent,
						status: "pending",
						startedAt: Date.now(),
						usage: emptyUsage(),
						files: task.files,
					},
				};
			});

			const emitUpdate = () =>
				onUpdate?.({
					content: [{ type: "text", text: renderOutcomes(outcomes) }],
					details: { runId: run.id, route: run.route, results: [...outcomes] } satisfies DelegateDetails,
				});

			const reject = (message: string) => ({
				content: [{ type: "text", text: `delegate rejected: ${message}` }],
				details: { runId: run.id },
				isError: true,
			});

			const stepIssues: string[] = [];
			for (const task of tasks) {
				if (task.step === undefined) continue;
				const record = run.planSteps?.find((item) => item.index === task.step);
				if (!record) {
					stepIssues.push(`agent "${task.agent}" references step ${task.step}, but the run has no such plan step`);
					continue;
				}
				for (const dep of record.depends) {
					const dependency = run.planSteps?.find((item) => item.index === dep);
					if (dependency?.status === "done") continue;
					const depTask = run.tasks.find((item) => item.step === dep);
					const resultPath = depTask ? join(runDir(ctx.cwd, run.id), "tasks", depTask.id, "result.md") : undefined;
					stepIssues.push(
						`step ${task.step} depends on step ${dep}, which is not done${resultPath ? `; read ${resultPath} first` : ""}`,
					);
				}
			}
			if (stepIssues.length > 0) return reject(stepIssues.join("; "));

			// Worktrees created before a failure must stay visible so they can be cleaned up later.
			const rejectAfterCreate = (message: string) => {
				const created = jobs.filter((job) => job.worktree);
				for (const job of created) {
					job.ledgerTask.status = "failed";
					job.ledgerTask.endedAt = Date.now();
					run.tasks.push(job.ledgerTask);
				}
				if (created.length > 0) writeRun(ctx.cwd, run);
				return reject(
					`${message}${created.length > 0 ? " (created worktrees recorded; finish_run with cleanupWorktrees removes them)" : ""}`,
				);
			};

			const mergeJob = jobs.find((job) => job.task.merge);
			if (mergeJob) {
				const requested = mergeJob.task.merge?.branches?.map((branch) => branch.trim()).filter(Boolean);
				const branches =
					requested && requested.length > 0
						? requested
						: run.tasks.filter((record) => record.worktree?.branch).map((record) => record.worktree!.branch);
				if (branches.length === 0) return reject("the run has no worktree branches to merge");

				const stillRunning = run.tasks.filter((record) => record.worktree && record.status === "running");
				if (stillRunning.length > 0) {
					return reject(`${stillRunning.length} worktree task(s) are still running; merge after they finish`);
				}

				const pre = await mergePreflight(runner, ctx.cwd, branches, signal);
				if (!pre.ok) return reject(`merge preflight failed: ${pre.error}`);

				const target = mergeJob.task.merge?.target?.trim() || "HEAD";
				mergeJob.ledgerTask.status = "running";
				run.tasks.push(mergeJob.ledgerTask);
				writeRun(ctx.cwd, run);
				await runChildAgent({
					root: ctx.cwd,
					run,
					agentName: mergeJob.task.agent,
					agent: agents[mergeJob.task.agent],
					level: resolveThinking(agents[mergeJob.task.agent], parentLevel),
					task: mergeJob.task,
					taskId: mergeJob.taskId,
					index: mergeJob.index,
					total: jobs.length,
					signal,
					outcomes,
					onUpdate: emitUpdate,
					ledgerTask: mergeJob.ledgerTask,
					runner,
					cwd: ctx.cwd,
					merge: { branches, target },
					briefOverride: buildMergeBrief({ run, task: mergeJob.task, branches, target }),
				});
				writeRun(ctx.cwd, run);
			} else {
				const worktreeJobs = jobs.filter((job) => job.task.worktree);
				if (worktreeJobs.length > 0) {
					const pre = await worktreePreflight(runner, ctx.cwd, signal);
					if (!pre.ok) return reject(`worktree preflight failed: ${pre.error}`);

					for (const job of worktreeJobs) {
						const requestedBase = typeof job.task.worktree === "object" ? job.task.worktree?.base?.trim() : undefined;
						const created = await createWorktree(runner, ctx.cwd, {
							runId: run.id,
							taskId: job.taskId,
							base: requestedBase || pre.base,
							links: config.worktreeLinks,
							signal,
						});
						if (!created.ok) return rejectAfterCreate(`worktree creation failed: ${created.error}`);

						job.worktree = created.worktree;
						job.ledgerTask.worktree = created.worktree;

						if (config.worktreeSetup) {
							const setup = await runSetupCommand(runner, config.worktreeSetup, created.worktree.path, signal);
							writeJson(join(runDir(ctx.cwd, run.id), "tasks", job.taskId, "setup.json"), {
								command: config.worktreeSetup,
								code: setup.code,
								stdout: setup.stdout.slice(-4_000),
								stderr: setup.stderr.slice(-4_000),
							});
							if (setup.code !== 0) {
								return rejectAfterCreate(
									`worktree setup failed for ${job.taskId}: ${setup.stderr.trim() || `exit ${setup.code}`}`,
								);
							}
						}
					}
					writeRun(ctx.cwd, run);
				}

				for (const job of jobs) {
					job.ledgerTask.status = "running";
					run.tasks.push(job.ledgerTask);
				}
				writeRun(ctx.cwd, run);

				await mapWithConcurrency(jobs, concurrency, async (job) => {
					await runChildAgent({
						root: ctx.cwd,
						run,
						agentName: job.task.agent,
						agent: agents[job.task.agent],
						level: resolveThinking(agents[job.task.agent], parentLevel),
						task: job.task,
						taskId: job.taskId,
						index: job.index,
						total: jobs.length,
						signal,
						outcomes,
						onUpdate: emitUpdate,
						ledgerTask: job.ledgerTask,
						runner,
						cwd: job.worktree?.path ?? ctx.cwd,
						worktree: job.worktree,
						step: job.task.step,
					});
					if (job.task.step && job.ledgerTask.status === "done") {
						const record = run.planSteps?.find((item) => item.index === job.task.step);
						if (record) record.status = "done";
						appendFileSync(
							join(runDir(ctx.cwd, run.id), "results.md"),
							`- step ${job.task.step} · ${job.task.agent} · done · tasks/${job.taskId}/result.md\n`,
						);
					}
					writeRun(ctx.cwd, run);
				});
			}

			const usage = emptyUsage();
			for (const outcome of outcomes) addUsage(usage, outcome.usage);
			const failed = outcomes.filter((outcome) => outcome.status !== "done");

			return {
				content: [{ type: "text", text: renderOutcomes(outcomes) || "(no output)" }],
				details: { runId: run.id, route: run.route, results: outcomes } satisfies DelegateDetails,
				usage,
				isError: failed.length > 0 && outcomes.length === 1,
			};
		},
		renderCall(args, theme) {
			const agents = (args.tasks ?? []).map((task: DelegateTask) => task.agent).join(", ");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("accent", `${args.tasks?.length ?? 0} task(s)`)} ${theme.fg("muted", agents)}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as DelegateDetails | undefined;
			if (!details) return new Text("", 0, 0);
			const lines = details.results.map((item) => {
				const icon = item.status === "done" ? "✓" : item.status === "running" ? "…" : "✗";
				const idle =
					item.status === "running" && item.idleMs > WATCHDOG_IDLE_MS
						? theme.fg("warning", ` idle ${Math.round(item.idleMs / 1000)}s`)
						: "";
				const text = expanded ? item.output : (item.output.split("\n")[0] ?? "");
				return `${icon} ${theme.fg("accent", item.agent)} ${theme.fg("muted", `${Math.round(item.durationMs / 1000)}s`)}${idle} ${theme.fg("dim", text.slice(0, 100))}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "finish_run",
		label: "Finish run",
		description: "Close the orchestration run, write summary.md and return the final report for the user.",
		promptSnippet: "Close the run and write its summary",
		promptGuidelines: ["Call finish_run exactly once at the end, with a user-facing summary"],
		parameters: finishRunParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const run = loadRun(ctx.cwd, params.runId);
			if (!run) {
				return {
					content: [{ type: "text", text: `Unknown run "${params.runId}".` }],
					details: undefined,
					isError: true,
				};
			}

			const usage = emptyUsage();
			for (const task of run.tasks) addUsage(usage, task.usage);

			const unfinished = run.tasks.filter((task) => task.status === "running" || task.status === "pending");
			if (unfinished.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Run ${run.id} still has ${unfinished.length} unfinished task(s): ${unfinished.map((task) => task.id).join(", ")}`,
						},
					],
					details: { runId: run.id, unfinished },
					isError: true,
				};
			}

			const runner: CommandRunner = (command, args, options) => pi.exec(command, args, options);
			const cleanupErrors: string[] = [];
			if (params.cleanupWorktrees) {
				for (const task of run.tasks) {
					if (!task.worktree) continue;
					cleanupErrors.push(...(await removeWorktree(runner, ctx.cwd, task.worktree, signal)));
				}
			}

			run.status = params.status;
			run.endedAt = Date.now();
			writeRun(ctx.cwd, run);

			const worktrees = run.tasks.filter((task) => task.worktree);
			writeFileSync(
				join(runDir(ctx.cwd, run.id), "summary.md"),
				[
					`# ${run.goal}`,
					"",
					`Route: ${run.route}`,
					`Started: ${new Date(run.startedAt).toISOString()}`,
					`Finished: ${new Date(run.endedAt).toISOString()}`,
					"",
					"## Tasks",
					"",
					...run.tasks.map((task) => {
						const parts = [`- ${task.agent} (${task.status}) — ${task.id}`];
						if (task.worktree) parts.push(`branch \`${task.worktree.branch}\`, commit \`${task.worktree.headCommit ?? "?"}\``);
						if (task.merge) {
							parts.push(
								`merge ${task.merge.merged ? "ok" : "failed"}${task.merge.inProgress ? " (in progress)" : ""}${task.merge.conflicted?.length ? `, conflicts: ${task.merge.conflicted.join(", ")}` : ""}`,
							);
						}
						return parts.join(" | ");
					}),
					"",
					...(worktrees.length > 0
						? [
								"## Worktrees",
								"",
								...worktrees.map(
									(task) =>
										`- ${task.agent}: \`${task.worktree!.branch}\` at \`${task.worktree!.path}\`${task.worktree!.autoCommitted ? " (auto-committed)" : ""}`,
								),
								"",
							]
						: []),
					...(run.planSteps?.length
						? [
								"## Plan steps",
								"",
								...run.planSteps.map(
									(item) =>
										`- ${item.index}. ${item.title} — ${item.status}${item.depends.length > 0 ? ` (after ${item.depends.join(",")})` : ""}`,
								),
								"",
							]
						: []),
					...(cleanupErrors.length > 0 ? ["## Cleanup errors", "", ...cleanupErrors.map((error) => `- ${error}`), ""] : []),
					...(params.cleanupWorktrees && cleanupErrors.length === 0 && worktrees.length > 0
						? ["## Cleanup", "", "Worktrees and branches removed by this run.", ""]
						: []),
					"## Summary",
					"",
					params.summary,
					"",
				].join("\n"),
				"utf-8",
			);
			activeRuns.delete(run.id);

			const perTask = run.tasks.map((task) => `${task.agent}: ${task.status} (${formatUsage(task.usage)})`).join("\n");
			const cleanup = params.cleanupWorktrees
				? cleanupErrors.length === 0
					? "Worktrees: removed"
					: `Worktrees: cleanup errors: ${cleanupErrors.join("; ")}`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Run ${run.id} finished (${params.status}).\n\n${perTask}\n\nTotal: ↑${usage.input} ↓${usage.output} $${usage.cost.total.toFixed(4)}\n\n${params.summary}${cleanup ? `\n\n${cleanup}` : ""}`,
					},
				],
				details: { runId: run.id, status: params.status, tasks: run.tasks, cleanupErrors },
				usage,
			};
		},
	});

	pi.registerCommand("runs", {
		description: "List orchestration runs, branches and worktrees",
		handler: async (_args, ctx) => {
			const dir = join(ctx.cwd, ".pi", "runs");
			if (!existsSync(dir)) {
				ctx.ui.notify("No runs yet", "info");
				return;
			}

			const lines: string[] = [];
			for (const name of readdirSync(dir).sort().reverse()) {
				const run = readRun(ctx.cwd, name);
				if (!run) continue;
				lines.push(`${run.status === "open" ? "●" : "○"} ${run.id} [${run.route}] ${run.status} — ${run.goal.slice(0, 70)}`);
				for (const task of run.tasks.filter((record) => record.worktree)) {
					lines.push(`    ${task.agent}: ${task.worktree!.branch} @ ${task.worktree!.path}`);
				}
				if (run.tasks.some((task) => task.merge?.inProgress)) lines.push("    merge in progress — resolve or abort it");
			}
			if (lines.length === 0) lines.push("No runs found");
			pi.sendMessage({ customType: "runs", content: lines.join("\n"), display: true });
		},
	});
}

function renderOutcomes(outcomes: TaskOutcome[]): string {
	return outcomes
		.map((outcome) => `## ${outcome.agent} — ${outcome.status} (${Math.round(outcome.durationMs / 1000)}s)\n\n${outcome.output}`)
		.join("\n\n---\n\n");
}
