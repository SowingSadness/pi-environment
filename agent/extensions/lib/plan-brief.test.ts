import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePlan } from "./plans.ts";
import { buildTaskBrief, type BriefStep, type TaskBriefParams } from "./brief.ts";

const baseBrief = (overrides: Partial<TaskBriefParams>): TaskBriefParams => ({
	runId: "test-run",
	route: "fast",
	goal: "goal",
	root: "D:/work",
	agent: "coder",
	index: 0,
	total: 1,
	taskId: "01-coder",
	task: "do it",
	depth: 1,
	...overrides,
});

test("(a) ### in ## Design is not a step, only ## Steps counts", () => {
	const doc = [
		"# План",
		"",
		"## Route",
		"fast",
		"",
		"## Design",
		"### 1. Layer one",
		"text",
		"### 2. Layer two",
		"### 3. Layer three",
		"### 4. Layer four",
		"### 5. Layer five",
		"### 6. Layer six",
		"### 7. Layer seven",
		"",
		"## Steps",
		"### 1. Первый",
		"- agent: coder",
		"### 2. Второй",
		"- agent: reviewer",
	].join("\n");

	const plan = parsePlan(doc);
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(
		plan.steps.map((item) => item.title),
		["Первый", "Второй"],
	);
});

test("(b) brief without task.files and without step files does not throw", () => {
	const steps: BriefStep[] = [
		{ index: 1, title: "Первый", status: "pending" },
		{ index: 2, title: "Второй", status: "pending" },
	];
	const brief = buildTaskBrief(baseBrief({ steps, step: 1 }));
	assert.match(brief, /\n## Your boundary\n/);
	assert.ok(brief.includes("  - (not specified)"), "expected (not specified) in boundary");
});

test("(c) brief falls back to the planned step files", () => {
	const steps: BriefStep[] = [
		{ index: 1, title: "Первый", status: "pending", files: ["src/a.ts", "src/b.ts"] },
		{ index: 2, title: "Второй", status: "pending" },
	];
	const brief = buildTaskBrief(baseBrief({ steps, step: 1 }));
	const boundary = brief.slice(brief.indexOf("## Your boundary"), brief.indexOf("## Work contract"));
	assert.ok(boundary.includes("  - src/a.ts"), "expected src/a.ts in boundary");
	assert.ok(boundary.includes("  - src/b.ts"), "expected src/b.ts in boundary");
});

test("(d) numbered fallback list under ## Steps still parses", () => {
	const doc = ["# План", "", "## Steps", "1. Alpha", "2. Beta"].join("\n");
	const plan = parsePlan(doc);
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(
		plan.steps.map((item) => item.title),
		["Alpha", "Beta"],
	);
});

test("(e1) acceptance of the step lands in the brief", () => {
	const steps: BriefStep[] = [
		{ index: 1, title: "Первый", status: "pending", acceptance: "pytest -q → 0" },
	];
	const brief = buildTaskBrief(baseBrief({ steps, step: 1 }));
	assert.ok(brief.includes("pytest -q → 0"), "expected step acceptance in brief");
});

test("(e2) no acceptance but step files produce 'files ...' line", () => {
	const steps: BriefStep[] = [
		{ index: 1, title: "Первый", status: "pending", files: ["src/a.ts", "src/b.ts"] },
	];
	const brief = buildTaskBrief(baseBrief({ steps, step: 1 }));
	assert.ok(brief.includes("files src/a.ts, src/b.ts"), "expected files listing as acceptance");
});

test("(e3) neither acceptance nor files fall back to 'as described in the plan'", () => {
	const steps: BriefStep[] = [{ index: 1, title: "Первый", status: "pending" }];
	const brief = buildTaskBrief(baseBrief({ steps, step: 1 }));
	assert.ok(brief.includes("as described in the plan"), "expected generic acceptance fallback");
});

test("(f) ## Context and ## Route land in ParsedPlan", () => {
	const doc = [
		"# План",
		"",
		"## Route",
		"full",
		"",
		"## Context",
		"Line one of context.",
		"Line two of context.",
		"",
		"## Steps",
		"### 1. Шаг",
		"- agent: coder",
	].join("\n");
	const plan = parsePlan(doc);
	assert.equal(plan.route, "full");
	assert.ok(plan.context?.includes("Line one of context."));
	assert.ok(plan.context?.includes("Line two of context."));
	assert.equal(plan.steps.length, 1);
});

test("(ж) plan without ## Steps keeps 1.5.0 behaviour: every ### is a step", () => {
	const doc = ["# План", "", "## Goal", "goal text", "", "### 1. Alpha", "### 2. Beta"].join("\n");
	const plan = parsePlan(doc);
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(
		plan.steps.map((item) => item.title),
		["Alpha", "Beta"],
	);
});

test("(з) ## Шаги (russian) is a steps section; ### in ## Проектирование is ignored", () => {
	const doc = [
		"# План",
		"",
		"## Проектирование",
		"### 1. Слой один",
		"### 2. Слой два",
		"### 3. Слой три",
		"",
		"## Шаги",
		"### 1. Первый",
		"- agent: coder",
		"### 2. Второй",
		"- agent: reviewer",
	].join("\n");

	const plan = parsePlan(doc);
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(
		plan.steps.map((item) => item.title),
		["Первый", "Второй"],
	);
});

test("(и) '## Steps:' with colon and lowercase '## steps' both parse steps", () => {
	const colonDoc = ["# План", "", "## Steps:", "### 1. One", "### 2. Two"].join("\n");
	const colonPlan = parsePlan(colonDoc);
	assert.equal(colonPlan.steps.length, 2);
	assert.deepEqual(
		colonPlan.steps.map((item) => item.title),
		["One", "Two"],
	);

	const lowerDoc = ["# План", "", "## steps", "### 1. One", "### 2. Two"].join("\n");
	const lowerPlan = parsePlan(lowerDoc);
	assert.equal(lowerPlan.steps.length, 2);

	// Numbered fallback also accepts both heading forms (case/spacing/colon insensitive).
	const fallbackDoc = ["# План", "", "##  ШАГИ : ", "1. Alpha", "2. Beta"].join("\n");
	const fallbackPlan = parsePlan(fallbackDoc);
	assert.equal(fallbackPlan.steps.length, 2);
	assert.deepEqual(
		fallbackPlan.steps.map((item) => item.title),
		["Alpha", "Beta"],
	);
});

test("(к) with a steps section, ### under ## Notes is not a step", () => {
	const doc = [
		"# План",
		"",
		"## Steps",
		"### 1. Первый",
		"- agent: coder",
		"### 2. Второй",
		"- agent: reviewer",
		"",
		"## Notes",
		"### 1. Not a step",
		"### 2. Still not a step",
	].join("\n");

	const plan = parsePlan(doc);
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(
		plan.steps.map((item) => item.title),
		["Первый", "Второй"],
	);
});
