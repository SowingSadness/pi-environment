#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const copy = args.has("--copy");
const force = args.has("--force");
const withSettings = args.has("--with-settings");

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const log = (msg) => console.log(`${dryRun ? "[dry-run] " : ""}${msg}`);

function backup(path) {
	if (!existsSync(path) || dryRun) return;
	const target = `${path}.bak.${stamp}`;
	// сначала копия, только потом замена — иначе оригинал теряется (ENOENT на copyFileSync)
	copyFileSync(path, target);
	log(`backup: ${relative(homedir(), target)}`);
}

function sameFile(a, b) {
	try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

function linkFile(source, target) {
	mkdirSync(dirname(target), { recursive: true });
	if (existsSync(target) || isLink(target)) {
		if (!force && sameFile(source, target)) { log(`ok: ${target}`); return; }
		backup(target);
		if (!copy) rmSync(target, { force: true });
	}
	if (dryRun) { log(`link: ${source} -> ${target}`); return; }
	if (copy) copyFileSync(source, target);
	else symlinkSync(source, target, process.platform === "win32" ? "file" : undefined);
	log(`linked: ${target}`);
}

function isLink(path) {
	try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function linkDir(source, target) {
	mkdirSync(dirname(target), { recursive: true });
	if (existsSync(target) || isLink(target)) {
		if (isLink(target) && resolve(realpathSync(target)) === resolve(source)) { log(`ok: ${target}`); return; }
		log(`exists (left as is): ${target} — rerun with --force to replace`);
		return;
	}
	if (dryRun) { log(`link dir: ${source} -> ${target}`); return; }
	symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
	log(`linked dir: ${target}`);
}

function mergeAgents(repoFile, localFile) {
	if (!existsSync(localFile) && !isLink(localFile)) {
		// agents.json всегда остаётся локальной копией: merge пишет в файл,
		// симлинк в репозиторий означал бы правку рабочего дерева repo
		mkdirSync(dirname(localFile), { recursive: true });
		if (dryRun) { log(`copy: ${repoFile} -> ${localFile}`); return; }
		copyFileSync(repoFile, localFile);
		log(`copied: ${localFile}`);
		return;
	}
	const repo = JSON.parse(readFileSync(repoFile, "utf-8"));
	const local = JSON.parse(readFileSync(localFile, "utf-8"));
	const merged = { ...local, ...repo };
	const changed = JSON.stringify(merged) !== JSON.stringify(local);
	if (!changed) { log(`agents.json ok (${Object.keys(merged).length} agents)`); return; }
	if (dryRun) { log(`agents.json merge: ${Object.keys(repo).length} from repo`); return; }
	backup(localFile);
	writeFileSync(localFile, `${JSON.stringify(merged, null, 2)}\n`);
	log(`agents.json merged: ${Object.keys(merged).length} agents`);
}

log(`agent dir: ${agentDir}`);
mkdirSync(join(agentDir, "extensions"), { recursive: true });

mergeAgents(join(repoRoot, "agent", "agents.json"), join(agentDir, "agents.json"));
linkFile(join(repoRoot, "agent", "extensions", "agents.ts"), join(agentDir, "extensions", "agents.ts"));
linkFile(join(repoRoot, "agent", "extensions", "orchestrator.ts"), join(agentDir, "extensions", "orchestrator.ts"));
linkDir(join(repoRoot, "agent", "extensions", "lib"), join(agentDir, "extensions", "lib"));

if (withSettings && !existsSync(join(agentDir, "settings.json"))) {
	linkFile(join(repoRoot, "agent", "settings.example.json"), join(agentDir, "settings.json"));
}

log("done. run `pi` (or /reload in a running session)");
