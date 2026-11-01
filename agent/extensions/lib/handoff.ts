/**
 * Why the `orchestrator_execution` handoff tool must refuse the call.
 *
 * Kept separate from the extension so the rules are unit-testable: a delegated subagent (depth > 0)
 * must never start orchestration, the orchestrator must not hand off to itself, and only planning
 * agents with a plan directory may hand work over.
 */

export interface HandoffContext {
	/** PI_AGENT_DEPTH: 0 for a user-facing session, >0 for a delegated subagent. */
	depth: number;
	/** Name of the active agent, if any. */
	agentName?: string;
	/** The agent's planDir, the only place it may write a plan. */
	planDir?: string;
}

export function handoffRefusal(context: HandoffContext): string | undefined {
	if (context.depth > 0) {
		return (
			`orchestrator_execution refused: you are a delegated subagent (depth ${context.depth}). ` +
			"Do not start orchestration. Return your plan/result to the caller that delegated this task."
		);
	}
	if (!context.agentName) {
		return "orchestrator_execution refused: no active agent.";
	}
	if (context.agentName === "orchestrator") {
		return "orchestrator_execution refused: you are the orchestrator; use start_run and delegate instead.";
	}
	if (!context.planDir?.trim()) {
		return `orchestrator_execution refused: agent "${context.agentName}" has no planDir configured.`;
	}
	return undefined;
}
