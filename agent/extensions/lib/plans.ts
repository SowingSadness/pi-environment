/**
 * Plan file parsing.
 *
 * A plan written by the architect is the contract the orchestrator executes, so the format is
 * deliberately simple and forgiving:
 *
 *   # Plan: <title>
 *   ## Route
 *   fast
 *   ## Goal
 *   one paragraph
 *   ## Steps
 *   ### 1. <step title>
 *   - agent: coder
 *   - files: [src/a.ts, src/b.ts]
 *   - depends: —
 *   - acceptance: tests pass
 */

export type PlanRoute = "full" | "fast" | "express";

export interface PlanStep {
	title: string;
	agent?: string;
	files: string[];
	acceptance?: string;
	depends?: string;
}

export interface ParsedPlan {
	title?: string;
	route?: PlanRoute;
	goal?: string;
	/** Raw text of the `## Context` section: architecture, invariants, do-not-break list. */
	context?: string;
	steps: PlanStep[];
}

const ROUTES = new Set<string>(["full", "fast", "express"]);

/** Section names that hold the step list: `## Steps`, `## steps:`, `## Шаги`, `## ШАГИ `. */
const STEP_SECTIONS = new Set<string>(["steps", "шаги"]);

function parseFiles(value: string): string[] {
	return value
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((item) => item.trim().replace(/^["'`]|["'`]$/g, ""))
		.filter(Boolean);
}

function normalizeSection(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[:：]+$/, "")
		.trim();
}

function isStepSection(value: string | undefined): boolean {
	return value !== undefined && STEP_SECTIONS.has(normalizeSection(value));
}

/**
 * Pre-pass: does the document have an explicit steps section at all?
 *
 * With one, only `###` inside it counts as a step (`###` in `## Design`, `## Notes`, … is prose).
 * Without one we keep the 1.5.0 behaviour: any `###` is a step, so old plans still parse.
 */
function hasStepSection(text: string): boolean {
	for (const rawLine of text.split(/\r?\n/)) {
		const h2 = /^##\s+(.+)$/.exec(rawLine.trim());
		if (h2 && isStepSection(h2[1])) return true;
	}
	return false;
}

function toRoute(value: string | undefined): PlanRoute | undefined {
	const candidate = value?.trim().toLowerCase().replace(/[:.]$/, "");
	return candidate && ROUTES.has(candidate) ? (candidate as PlanRoute) : undefined;
}

export function parsePlan(text: string): ParsedPlan {
	const result: ParsedPlan = { steps: [] };
	const explicitSteps = hasStepSection(text);
	const goalLines: string[] = [];
	const contextLines: string[] = [];
	let section: string | undefined;
	let step: PlanStep | undefined;

	const flushStep = () => {
		if (step) {
			result.steps.push(step);
			step = undefined;
		}
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();

		const h1 = /^#\s+(.+)$/.exec(line);
		if (h1) {
			result.title ??= h1[1].trim();
			section = undefined;
			flushStep();
			continue;
		}

		const h3 = /^###\s+(.+)$/.exec(line);
		if (h3) {
			// With an explicit steps section only `###` inside it starts a step: `###` in `## Design`,
			// `## Context`, `## Risks` etc. is prose/structuring and must not create steps.
			if (explicitSteps && !isStepSection(section)) continue;
			flushStep();
			step = { title: h3[1].replace(/^\d+[.)]\s*/, "").trim(), files: [] };
			// No steps section: 1.5.0 treated the heading itself as the start of the steps section.
			if (!explicitSteps) section = "steps";
			continue;
		}

		const h2 = /^##\s+(.+)$/.exec(line);
		if (h2) {
			flushStep();
			section = normalizeSection(h2[1]);
			continue;
		}

		if (!line) continue;

		if (section === "goal" && !step) {
			goalLines.push(line);
			continue;
		}

		if (section === "context" && !step) {
			contextLines.push(line);
			continue;
		}

		if (section === "route" && !result.route) {
			result.route = toRoute(line);
			continue;
		}

		const field = /^[-*]?\s*(agent|files|depends|acceptance)\s*:\s*(.+)$/i.exec(line);
		if (field && step) {
			const key = field[1].toLowerCase();
			const value = field[2].trim();
			if (key === "agent") step.agent = value.replace(/["'`]/g, "").split(/\s+/)[0];
			else if (key === "files") step.files = parseFiles(value);
			else if (key === "acceptance") step.acceptance = value;
			else if (key === "depends") step.depends = value;
			continue;
		}
	}

	flushStep();

	// Fallback: numbered list under "## Steps"/"## Шаги" instead of "###" headings.
	if (result.steps.length === 0) {
		let inSteps = false;
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			const h2 = /^##\s+(.+)$/.exec(line);
			if (h2) {
				inSteps = isStepSection(h2[1]);
				continue;
			}
			if (!inSteps) continue;
			const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
			if (numbered) result.steps.push({ title: numbered[1].trim(), files: [] });
		}
	}

	// Route fallback: `route: fast` anywhere in the file.
	if (!result.route) {
		const match = /^\s*[-*]?\s*route\s*:\s*([A-Za-z]+)/im.exec(text);
		result.route = toRoute(match?.[1]);
	}

	const goal = goalLines.join(" ").trim();
	if (goal) result.goal = goal;

	const context = contextLines.join("\n").trim();
	if (context) result.context = context;

	return result;
}

/** Parse a step's `depends` field ("1, 2", "1 2", "—") into step numbers. */
export function parseDepends(value: string | undefined): number[] {
	if (!value) return [];
	const matches = value.match(/\d+/g);
	if (!matches) return [];
	return [...new Set(matches.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isFinite(item) && item > 0))];
}
