/**
 * Task brief for a delegated subagent.
 *
 * The brief is the only context a child process gets, so it carries pointers to the shared run
 * workspace: the plan, the product context (`context.md`) and the results of earlier tasks.
 * Kept free of pi imports so it can be unit tested.
 */

export interface BriefStep {
	index: number;
	title: string;
	status: string;
	agent?: string;
	depends?: number[];
	acceptance?: string;
	files?: string[];
}

export interface TaskBriefParams {
	runId: string;
	route: string;
	goal: string;
	root: string;
	agent: string;
	index: number;
	total: number;
	taskId: string;
	task: string;
	context?: string;
	scope?: string;
	files?: string[];
	planPath?: string;
	contextPath?: string;
	priorResults?: string[];
	steps?: BriefStep[];
	/** 1-based plan step this task implements. */
	step?: number;
	/** Reviewer/verification duty: check completed steps against the plan. */
	verify?: boolean;
	/** This read-only task must produce the shared product context (no `## Context` in the plan). */
	contextDuty?: boolean;
	depth: number;
}

export function buildTaskBrief(params: TaskBriefParams): string {
	const {
		runId,
		route,
		goal,
		root,
		agent,
		index,
		total,
		taskId,
		task,
		context,
		scope,
		files,
		planPath,
		contextPath,
		priorResults,
		steps,
		step,
		verify,
		contextDuty,
		depth,
	} = params;

	const taskDir = `.pi/runs/${runId}/tasks/${taskId}`;
	const plannedStep = step && steps ? steps.find((item) => item.index === step) : undefined;
	const stepFiles = plannedStep?.files ?? [];
	const stepAcceptance = plannedStep
		? (plannedStep.acceptance ??
			(stepFiles.length > 0 ? `files ${stepFiles.join(", ")}` : "as described in the plan"))
		: undefined;
	const fileList = files?.length
		? files.map((file) => `  - ${file}`).join("\n")
		: stepFiles.length > 0
			? stepFiles.map((file) => `  - ${file}`).join("\n")
			: "  - (not specified)";
	const stepList = steps?.length
		? steps
				.map((item) => {
					const owner = item.agent ? ` (${item.agent})` : "";
					const depends = item.depends?.length ? ` after ${item.depends.join(",")}` : "";
					return `  ${item.index}. ${item.title}${owner} — ${item.status}${depends}`;
				})
				.join("\n")
		: "";

	const readFirst = [
		planPath ? `- Plan: ${planPath}` : undefined,
		plannedStep ? `- Your step: #${plannedStep.index} «${plannedStep.title}» of ${steps?.length ?? "?"}` : undefined,
		contextPath ? `- Product context: ${contextPath}  (architecture, invariants, do-not-break list)` : undefined,
		priorResults?.length ? `- Prior results:\n${priorResults.map((item) => `  - ${item}`).join("\n")}` : undefined,
		"- Project rules: AGENTS.md / CLAUDE.md in the repository root, if present (you inherit them)",
	]
		.filter(Boolean)
		.join("\n");

	const contextSection = contextDuty
		? [
				"",
				"## Shared context duty (required)",
				"The plan has no `## Context` section, so you produce the shared product context for all later tasks.",
				"Put it in `result.md` under these headings and keep it under ~40 lines:",
				"- Layers: the modules/layers that matter for this run and what each owns.",
				"- Invariants / do-not-break: public APIs, state shape, conventions, tests that must stay green.",
				"- Boundaries: which paths each layer owns, so parallel tasks do not collide.",
				"- Risks: what is easy to break in this area.",
			]
			.join("\n")
		: "";

	const finished = (steps ?? []).filter((item) => item.status === "done");
	const verification =
		verify || agent === "reviewer"
			? [
					"",
					"## Verification duty (required)",
					"- Judge the work against the plan and the acceptance criteria, not against style preferences.",
					"- Report regressions and missing coverage with `path:line` evidence, ordered by severity.",
					finished.length > 0
						? `- Already completed steps to verify against:\n${finished.map((item) => `  ${item.index}. ${item.title}${item.acceptance ? ` — acceptance: ${item.acceptance}` : ""}`).join("\n")}`
						: "- No completed steps are recorded yet.",
				].join("\n")
			: "";

	return [
		`# Task ${index + 1}/${total}: ${agent}`,
		"",
		`Run: ${runId} (route: ${route})`,
		`Working directory: ${root}`,
		"",
		"## Read before you start",
		readFirst,
		stepList ? `\n## Plan steps\n${stepList}` : "",
		"",
		"## Goal of the run",
		goal,
		plannedStep
			? [
					"",
					"## Your step",
					`#${plannedStep.index} «${plannedStep.title}»`,
					`- depends: ${plannedStep.depends?.length ? plannedStep.depends.join(", ") : "none"}`,
					`- acceptance: ${stepAcceptance}`,
				].join("\n")
			: "",
		"",
		"## Your task",
		task,
		"",
		"## Context from the orchestrator",
		context?.trim() || "(none)",
		"",
		"## Your boundary",
		`- files:\n${fileList}`,
		`- scope: ${scope?.trim() || "derive it from the files above; do not touch anything else"}`,
		"- Do not change public APIs or behaviour outside this boundary. If the task seems to require it, stop and report.",
		"",
		"## Work contract (required)",
		`1. Before starting, write your work plan to \`${taskDir}/plan.md\`: numbered steps with checkboxes.`,
		`2. Keep \`${taskDir}/log.md\` updated: one short line per meaningful step - what you did, which files, what is next.`,
		"3. A 60-second heartbeat is written for you automatically; do not spend turns on it.",
		`4. Finish by writing \`${taskDir}/result.md\` with: status (done | blocked | failed), summary (max 10 lines), files changed, tests run, open questions.`,
		"5. Your final chat message must repeat that summary; the orchestrator only reads the summary.",
		"6. Do not touch files outside the list above. Do not commit unless this task explicitly asks for a commit.",
		`7. You are a delegated subagent (depth ${depth}): do not call orchestrator_execution, start_run or delegate. Return your result to the caller that delegated this task.`,
		"8. No user is present in this session: never ask questions, state your assumptions explicitly instead.",
		contextSection,
		verification,
		"",
		"## Return format",
		"status (done | blocked | failed) · summary (max 10 lines) · files changed · tests run (command + result) · do-not-break checks · open questions",
	]
		.filter((part) => part !== "")
		.join("\n");
}
