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
		else lines.push("- File writes (including plan files) are refused.");
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
