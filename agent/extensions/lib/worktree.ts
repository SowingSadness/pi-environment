/**
 * Git worktree plumbing for the orchestrator.
 *
 * Everything here is infrastructure: the extension creates and removes worktrees, never a model.
 * The command runner is injected so the whole module can be unit tested with a real or fake git.
 */

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { branchNameFor, worktreePathFor } from "./runs.ts";

export interface ExecOutcome {
	stdout: string;
	stderr: string;
	code: number;
	/** True when pi.exec cut the output at `maxBuffer` (pi >= 1.5). */
	truncated?: boolean;
}

export type CommandRunner = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number; maxBuffer?: number },
) => Promise<ExecOutcome>;

export interface WorktreeInfo {
	/** Absolute path of the worktree. */
	path: string;
	/** Branch created for this task. */
	branch: string;
	/** Commit the worktree was created from. */
	base: string;
}

export type Verdict = { ok: true } | { ok: false; error: string };

export function isDirtyPorcelain(porcelain: string): boolean {
	return porcelain.trim().length > 0;
}

async function git(run: CommandRunner, cwd: string, args: string[], signal?: AbortSignal): Promise<ExecOutcome> {
	return run("git", args, { cwd, signal });
}

function failure(outcome: ExecOutcome): string {
	return (outcome.stderr || outcome.stdout).trim() || `exit ${outcome.code}`;
}

/** Repository checks required before creating a worktree. */
export async function worktreePreflight(
	run: CommandRunner,
	root: string,
	signal?: AbortSignal,
): Promise<{ ok: true; base: string } | { ok: false; error: string }> {
	const inside = await git(run, root, ["rev-parse", "--is-inside-work-tree"], signal);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") {
		return { ok: false, error: "worktree requires a git repository (git rev-parse --is-inside-work-tree failed)" };
	}

	const top = await git(run, root, ["rev-parse", "--show-toplevel"], signal);
	if (top.code !== 0) return { ok: false, error: `cannot resolve repository root: ${failure(top)}` };

	const head = await git(run, root, ["rev-parse", "--verify", "HEAD"], signal);
	if (head.code !== 0) return { ok: false, error: "worktree needs at least one commit (HEAD is unborn)" };

	// Only tracked changes make the workspace unsafe to branch from: untracked files (including the
	// .gitignore that start_run creates) stay in the main tree and do not affect `git worktree add`.
	const status = await git(run, root, ["status", "--porcelain", "--untracked-files=no"], signal);
	if (status.code !== 0) return { ok: false, error: `cannot read git status: ${failure(status)}` };
	if (isDirtyPorcelain(status.stdout)) {
		return { ok: false, error: "the workspace has uncommitted changes to tracked files; commit or stash them before using worktrees" };
	}

	return { ok: true, base: head.stdout.trim() };
}

/** Mirror heavy, git-ignored directories into the worktree so tests and builds work there. */
export function linkWorktreeDirs(root: string, worktreePath: string, links: readonly string[]): string[] {
	const created: string[] = [];
	for (const name of links) {
		const source = join(root, name);
		const target = join(worktreePath, name);
		if (!existsSync(source) || existsSync(target)) continue;
		try {
			symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
			created.push(name);
		} catch {
			// best effort: a missing link only means the child may need to install dependencies
		}
	}
	return created;
}

export async function createWorktree(
	run: CommandRunner,
	root: string,
	params: { runId: string; taskId: string; base: string; links?: readonly string[]; signal?: AbortSignal },
): Promise<{ ok: true; worktree: WorktreeInfo; linked: string[] } | { ok: false; error: string }> {
	const branch = branchNameFor(params.runId, params.taskId);
	const relativePath = worktreePathFor(params.runId, params.taskId);
	const path = join(root, relativePath);

	if (existsSync(path)) {
		return { ok: false, error: `worktree path already exists: ${relativePath}` };
	}

	mkdirSync(dirname(path), { recursive: true });
	const add = await git(run, root, ["worktree", "add", path, "-b", branch, params.base], params.signal);
	if (add.code !== 0) {
		return { ok: false, error: `git worktree add failed: ${failure(add)}` };
	}

	const linked = linkWorktreeDirs(root, path, params.links ?? []);
	return { ok: true, worktree: { path, branch, base: params.base }, linked };
}

export async function worktreeState(
	run: CommandRunner,
	worktreePath: string,
	signal?: AbortSignal,
): Promise<{ head?: string; dirty: boolean }> {
	const head = await git(run, worktreePath, ["rev-parse", "HEAD"], signal);
	const status = await git(run, worktreePath, ["status", "--porcelain"], signal);
	return {
		head: head.code === 0 ? head.stdout.trim() : undefined,
		dirty: status.code === 0 ? isDirtyPorcelain(status.stdout) : true,
	};
}

/** Commit whatever the child left uncommitted, so the branch is usable for merging. */
export async function commitWorktree(
	run: CommandRunner,
	worktreePath: string,
	message: string,
	signal?: AbortSignal,
): Promise<{ committed: boolean; error?: string }> {
	const status = await git(run, worktreePath, ["status", "--porcelain"], signal);
	if (status.code !== 0) return { committed: false, error: failure(status) };
	if (!isDirtyPorcelain(status.stdout)) return { committed: false };

	const add = await git(run, worktreePath, ["add", "-A"], signal);
	if (add.code !== 0) return { committed: false, error: failure(add) };

	let commit = await git(run, worktreePath, ["commit", "-m", message], signal);
	if (commit.code !== 0) {
		// Fresh clones may have no identity configured; use a throwaway one for the agent branch.
		commit = await git(
			run,
			worktreePath,
			["-c", "user.name=pi-agent", "-c", "user.email=agent@localhost", "commit", "-m", message],
			signal,
		);
	}
	if (commit.code !== 0) return { committed: false, error: failure(commit) };
	return { committed: true };
}

export async function mergePreflight(
	run: CommandRunner,
	root: string,
	branches: readonly string[],
	signal?: AbortSignal,
): Promise<Verdict> {
	if (branches.length === 0) return { ok: false, error: "no branches to merge" };

	const status = await git(run, root, ["status", "--porcelain", "--untracked-files=no"], signal);
	if (status.code !== 0) return { ok: false, error: `cannot read git status: ${failure(status)}` };
	if (isDirtyPorcelain(status.stdout)) {
		return { ok: false, error: "the workspace has uncommitted changes to tracked files; commit or stash them before merging worktree branches" };
	}
	if (await isMergeInProgress(run, root, signal)) {
		return { ok: false, error: "a merge is already in progress; finish or abort it first" };
	}

	for (const branch of branches) {
		const verify = await git(run, root, ["rev-parse", "--verify", branch], signal);
		if (verify.code !== 0) return { ok: false, error: `branch not found: ${branch}` };
	}
	return { ok: true };
}

export async function isMergeInProgress(run: CommandRunner, root: string, signal?: AbortSignal): Promise<boolean> {
	const gitDir = await git(run, root, ["rev-parse", "--git-dir"], signal);
	if (gitDir.code !== 0) return false;
	const dir = gitDir.stdout.trim();
	const absolute = dir.startsWith("/") || /^[A-Za-z]:/.test(dir) ? dir : join(root, dir);
	return existsSync(join(absolute, "MERGE_HEAD"));
}

/** Files with conflict markers, from `git diff --name-only --diff-filter=U`. */
export async function conflictedFiles(run: CommandRunner, root: string, signal?: AbortSignal): Promise<string[]> {
	const result = await git(run, root, ["diff", "--name-only", "--diff-filter=U"], signal);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export async function removeWorktree(
	run: CommandRunner,
	root: string,
	worktree: { path: string; branch: string },
	signal?: AbortSignal,
): Promise<string[]> {
	const errors: string[] = [];
	const remove = await git(run, root, ["worktree", "remove", "--force", worktree.path], signal);
	if (remove.code !== 0) errors.push(`worktree remove: ${failure(remove)}`);
	const prune = await git(run, root, ["worktree", "prune"], signal);
	if (prune.code !== 0) errors.push(`worktree prune: ${failure(prune)}`);
	const branch = await git(run, root, ["branch", "-D", worktree.branch], signal);
	if (branch.code !== 0) errors.push(`branch -D ${worktree.branch}: ${failure(branch)}`);
	return errors;
}
