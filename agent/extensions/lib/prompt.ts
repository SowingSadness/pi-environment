/**
 * System-prompt section for the active agent.
 *
 * The runtime constraints are generated from the agent configuration so the model knows exactly
 * where it may write, instead of spending turns on refused `write`/`edit`/`bash` calls.
 */

export interface AgentSectionParams {
	name: string;
	/** True when the agent runs with a read-only guard. */
	readOnly: boolean;
	/** Absolute directory where plan files may be written (only for read-only agents with planDir). */
	planDirAbs?: string;
	/** Absolute run directory of the delegating orchestrator (only in a subagent process). */
	runDirAbs?: string;
	/** Extra literal command prefixes allowed by the guard (e.g. "npx tsc --noEmit"). */
	allowCommands?: string[];
	instructions?: string;
}

const READ_ONLY_SHELL =
	"`ls`, `cat`, `rg`/`find` (without -delete/-exec), `sed -n`, `git status/log/diff/show`, `npm ls`";

export function buildAgentSection(params: AgentSectionParams): string {
	const parts: string[] = [`Active agent: ${params.name}`];

	if (params.readOnly) {
		const lines = ["## Runtime constraints (enforced before execution, not by these instructions)"];
		lines.push("- You are READ-ONLY: `edit`, `write` and mutating shell commands are refused by the runtime.");
		if (params.planDirAbs) lines.push(`- Writable plan files: ${params.planDirAbs}`);
		else lines.push("- File writes (including plan files) are refused.");
		if (params.runDirAbs) lines.push(`- Writable task artifacts: ${params.runDirAbs}`);
		lines.push(`- Shell: read-only only — ${READ_ONLY_SHELL}.`);
		if (params.allowCommands && params.allowCommands.length > 0) {
			lines.push(`- Extra allowed commands: ${params.allowCommands.join("; ")}.`);
		}
		lines.push(
			"- A blocked call fails immediately. Do not retry it and do not bypass it with redirects, `tee` or `-o`: adapt or ask the user to switch agents.",
		);
		parts.push(lines.join("\n"));
	} else {
		parts.push("## Runtime constraints\n- Writes: anywhere in the workspace. Shell: unrestricted.");
	}

	const instructions = params.instructions?.trim();
	if (instructions) parts.push(instructions);

	return parts.join("\n\n");
}
