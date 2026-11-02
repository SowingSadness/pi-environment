/**
 * Whether `start_run` still has to ask the user for confirmation.
 *
 * The planning agent already asks once in `orchestrator_execution` and announces the approved
 * plan+route on `orchestrator:handoff-confirmed`. `start_run` reuses that approval instead of
 * asking a second time, but only for a fresh, exact match: same plan file, same route, within the
 * TTL. Anything else (no approval, expired, other plan/route, no plan at all) must ask again.
 */

/** How long a handoff approval stays valid, in milliseconds (10 minutes). */
export const PRE_CONFIRM_TTL_MS = 10 * 60 * 1000;

export interface PreConfirmed {
	/** Plan path that the user approved. */
	plan: string;
	/** Route that the user approved. */
	route: string;
	/** Timestamp of the approval, `Date.now()`. */
	at: number;
}

function normalizePlanPath(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

export function shouldConfirmStartRun(
	pre: PreConfirmed | undefined,
	planPath: string | undefined,
	route: string,
	now: number = Date.now(),
	ttlMs: number = PRE_CONFIRM_TTL_MS,
): boolean {
	if (!pre) return true;
	if (now - pre.at > ttlMs) return true;
	if (!planPath) return true;
	if (normalizePlanPath(pre.plan) !== normalizePlanPath(planPath)) return true;
	if (pre.route !== route) return true;
	return false;
}
