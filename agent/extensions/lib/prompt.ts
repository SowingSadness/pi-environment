/**
 * System-prompt section for the active agent.
 *
 * The runtime constraints are generated from the agent configuration so the model knows exactly
 * what it may write and which shell commands are refused, instead of spending turns on blocked calls.
 */

export interface AgentSectionParams {
	name: string;
	readOnly: boolean;
	planDirAbs?: string;
	runDirAbs?: string;
	allowCommands?: string[];
	tools?: string[];
	instructions?: string;
}

const READ_ONLY_SHELL =
	"`ls`, `cat`, `rg`/`find` (without -delete/-exec), `sed -n`, `git status/log/diff/show/rev-parse`, `npm ls`, `<command> --version`";

/**
 * One-line role reminder that is delivered as a message at the start of every run.
 *
 * The `<agent>` system section already describes the mode, but pi adds it as a separate delta for
 * every switch, and the model can anchor on an older one. A short message placed after the history
 * of the current run keeps the role in view without paying for the full section again.
 *
 * Must stay a single line of at most 200 characters (about 30 tokens).
 */
export function buildRoleReminder(name: string, readOnly: boolean, planDir?: string): string {
	const reminders: Record<string, string> = {
		architect:
			"planning only: write plan files only, shell is read-only; when the plan is agreed and the user says yes, call orchestrator_execution; never edit code",
		coder: "implementation: edit/write allowed; read before editing; run tests after changes; do not start orchestration",
		orchestrator: "coordination only: start_run -> delegate -> finish_run; you are read-only; never probe write/edit",
		scout: "reconnaissance only: read-only; return a compact product map, do not edit code",
		reviewer: "review only: read-only; report file:line findings against the plan and acceptance criteria",
		handyman: "small utility work only: do exactly what the brief says, commit only when asked",
	};

	const known = reminders[name.trim().toLowerCase()];
	const body = known ?? [readOnly ? "read-only mode" : "write mode", planDir ? `plans in ${planDir}` : undefined]
		.filter(Boolean)
		.join(", ");
	return `[agent mode] ${name}: ${body}`;
}

export function buildAgentSection(params: AgentSectionParams): string {
	const parts: string[] = [`Active agent: ${params.name}`];

	if (params.readOnly) {
		const lines = ["## Runtime constraints (enforced by the runtime, not by these instructions)"];
		lines.push(
			"- The repository is READ-ONLY for you: `edit` and `write` are refused outside the writable locations below.",
		);
		if (params.tools && params.tools.length > 0)
			lines.push(`- Active tools for this mode: ${params.tools.join(", ")}. Tools from a previous mode are not available; do not try them.`);
		if (params.planDirAbs) lines.push(`- Writable plan files: ${params.planDirAbs}`);
		else if (!params.runDirAbs) lines.push("- File writes (including plan files) are refused.");
		else lines.push("- File writes are refused except for the task artifacts below.");
		if (params.runDirAbs) lines.push(`- Writable task artifacts: ${params.runDirAbs}`);
		lines.push(
			"- Plan changes: use `edit` with exact oldText/newText for a small change, and `write` only for a new plan or a full rewrite that is actually needed. Never rewrite a whole file to change a few lines.",
		);
		lines.push(`- Shell allowlist: ${READ_ONLY_SHELL}.`);
		lines.push(
			"- Refused before execution: any other program (python, node, bash -c, sh, perl, ruby, powershell, ...), output redirection `>` `>>`/`tee`, command substitution `$(...)` or backticks, `sed -i`, git write commands, package installs. A script cannot be used to edit files - use `write` or `edit`.",
		);
		lines.push(
			"- A refused call fails immediately. Do not retry it and do not try to bypass it: use the tools listed above or ask the user.",
		);
		parts.push(lines.join("\n"));
	} else {
		const lines = ["## Runtime constraints", "- Writes: anywhere in the workspace. Shell: unrestricted."];
		if (params.tools && params.tools.length > 0)
			lines.push(`- Active tools for this mode: ${params.tools.join(", ")}. Tools from a previous mode are not available; do not try them.`);
		parts.push(lines.join("\n"));
	}

	const instructions = params.instructions?.trim();
	if (instructions) parts.push(instructions);

	return parts.join("\n\n");
}
