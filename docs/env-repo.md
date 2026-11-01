# Публикация окружения в `pi-environment` + установка одной командой

## Route
fast

## Goal
Собрать в `~/pi-environment` репозиторий из созданных агентов и расширений (без секретов), с
идемпотентным `install.mjs` (линки + merge `agents.json`), README и `.gitignore`; закоммитить и запушить
в `git@github.com:SowingSadness/pi-environment.git` по SSH.

## Steps

### 1. Скелет репозитория и скрипты
- agent: coder
- files: [~/pi-environment/agent/agents.json, ~/pi-environment/agent/extensions/, ~/pi-environment/scripts/, ~/pi-environment/README.md, ~/pi-environment/.gitignore, ~/pi-environment/docs/]
- depends: —
- acceptance: файлы из §2 на месте; в `agent/` нет auth.json/sessions/install/; `.gitignore` закрывает секреты

### 2. Проверка install.mjs на временном агентском каталоге
- agent: coder
- files: []
- depends: 1
- acceptance: запуск с `PI_CODING_AGENT_DIR` на временный каталог создаёт линки и мержит agents.json, повторный запуск идемпотентен; живой `~/.pi/agent` не изменён

### 3. Коммит и push по SSH
- agent: coder
- files: []
- depends: 1, 2
- acceptance: `git remote -v` = git@github.com:…, `git push -u origin main` прошёл, `git ls-remote origin` показывает main

## Constraints (обязательные)

- **Push идёт по SSH** (проверено: `git ls-remote git@github.com:SowingSadness/pi-environment.git` с ключом
  `~/.ssh/github_rsa` вернул exit 0 и пустой список refs — репозиторий пуст, ключ авторизован, пароля нет).
  HTTPS-remote не использовать: `https://github.com/...` требует интерактивного логина.
- **Не трогать живой `~/.pi/agent`**: `install.mjs` проверяется только с `PI_CODING_AGENT_DIR` на
  временный каталог (например `$TMPDIR/pi-agent-test`); прогон против настоящего агентского каталога
  в рамках этого run'а запрещён.
- **Секреты не коммитить**: `auth.json`, `sessions/`, `install/`, `bin/`, `npm/`, `kendex/`,
  `models-store.json`, `trust.json`, `settings.json` — вне репозитория (`.gitignore`).
- **Push — по SSH, ожидается успешным**: если он всё же упадёт, остановиться, оставить локальный коммит
  и вернуть отчёт с текстом ошибки. Никаких интерактивных `gh auth login` из подагента.

## Push over SSH (точные команды)

```bash
mkdir -p ~/pi-environment && cd ~/pi-environment
git init -b main
git config core.sshCommand "ssh -i $HOME/.ssh/github_rsa -o IdentitiesOnly=yes"
# ... разложить файлы, git add -A, git commit ...
git remote add origin git@github.com:SowingSadness/pi-environment.git
git push -u origin main
```

`core.sshCommand` обязателен: дефолтный `~/.ssh/id_rsa` не авторизован на GitHub, рабочий ключ — `github_rsa`.
Репозиторий пустой, поэтому force/rebase не нужны.
- Не менять `~/.pi/agent/agents.json` при проверке install: merge тестируется на копии.

Задача: из `https://github.com/SowingSadness/pi-environment.git` развернуть это же окружение на новой
машине, а на существующей — добрать/обновить, ничего не затерев.

## 1. Что публикуем (и что нет)

| В репозиторий | Источник | Почему |
|---|---|---|
| `agent/agents.json` | `~/.pi/agent/agents.json` | 6 агентов, слоты, цвета, guard, инструкции |
| `agent/extensions/agents.ts` | там же | режимы, guard, цвета, handoff-тул |
| `agent/extensions/orchestrator.ts` | там же | `start_run`/`delegate`/`finish_run`, heartbeat |
| `agent/extensions/lib/*.ts` | там же | `agents-config`, `runs`, `worktree`, `plans`, `prompt`, `handoff` |
| `agent/settings.example.json` | из `settings.json`, без личного | тема/дефолтная модель как пример |
| `docs/*.md` | `.pi/plans/orchestrator*.md`, `agent-colors.md`, `readonly-context.md` | проектная документация |

**Не публикуем:** `auth.json` (ключи), `sessions/` (история), `install/` (200 МБ бинаря pi), `bin/`,
`npm/`, `kendex/`, `models-store.json`, `trust.json` (локальные решения о доверии),
`extensions/subagent/` (копия примера из pi, не наше — ставится отдельно при желании),
`*.bak.*`, `settings.json` (у каждого свой: тема, модель, packages).

`.gitignore` закрывает это на случай `git add -A`.

## 2. Layout репозитория

```
pi-environment/
├── README.md
├── .gitignore
├── agent/
│   ├── agents.json
│   ├── settings.example.json
│   └── extensions/
│       ├── agents.ts
│       ├── orchestrator.ts
│       └── lib/{agents-config,runs,worktree,plans,prompt,handoff}.ts
├── scripts/
│   ├── install.mjs      # вся логика: линки/копии + merge agents.json
│   ├── install.sh       # обёртка для POSIX: exec node scripts/install.mjs "$@"
│   └── install.ps1      # обёртка для Windows: node $PSScriptRoot\scripts\install.mjs @args
└── docs/
    ├── orchestrator.md
    ├── orchestrator-handoff.md
    ├── readonly-context.md
    └── agent-colors.md
```

Репозиторий **не** является самой `~/.pi/agent` (там бинарь, сессии и ключи). Он кладётся в
`~/pi-environment`, а `install` связывает нужные файлы с агенским каталогом.

## 3. Семантика установки (идемпотентная, «добрать, не затереть»)

Каталог назначения: `$PI_CODING_AGENT_DIR` или `~/.pi/agent`.

- **Режим по умолчанию — симлинки/джанкшены.** `agent/extensions/agents.ts` → `~/.pi/agent/extensions/agents.ts`,
  `orchestrator.ts` так же, `lib/` — один junction на весь каталог. Тогда после `git pull` изменения
  подхватываются без повторного запуска install.
- **`--copy`** — копирование (для файловых систем без симлинков/джанкшенов без прав).
- **`agents.json` — merge, не перезапись:** берём локальный JSON, накладываем агентов из репозитория
  (repo win по совпадающим именам), локальные уникальные агенты сохраняются. Перед записью —
  `agents.json.bak.<timestamp>`. Если файла нет — просто копируется.
- **`extensions/`**: обрабатываются только элементы из репозитория (`agents.ts`, `orchestrator.ts`, `lib`).
  Чужие расширения в `~/.pi/agent/extensions` не удаляются и не трогаются. Если файл есть и отличается —
  бэкап `<file>.bak.<ts>` и замена.
- **`settings.json` не трогаем** (там модель/тема/packages). `--with-settings` — только если файла нет,
  копирует `settings.example.json`.
- Флаги: `--dry-run` (только печатать), `--copy`, `--force` (перезаписать даже одинаковые), `--with-settings`.
- Код выхода ≠0 при ошибке, чтобы годилось для CI/one-liner.

## 4. Скрипты

**`scripts/install.mjs`**

```js
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
	if (!copy) {
		// symlink: снимаем, чтобы не потерять оригинал
		try { rmSync(path, { recursive: false, force: true }); } catch {}
	}
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
	if (!existsSync(localFile)) { linkFile(repoFile, localFile); return; }
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
```

**`scripts/install.sh`**

```sh
#!/usr/bin/env sh
set -eu
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/install.mjs" "$@"
```

**`scripts/install.ps1`**

```powershell
$ErrorActionPreference = "Stop"
node "$PSScriptRoot/install.mjs" @args
```

> Требуется Node (он есть у pi, если pi поставлен через npm). Если pi — самостоятельный бинарь без node,
> `--copy` всё равно требует node; в этом случае fallback: скопировать `agent/*` вручную, `install.mjs`
> нужен только для merge `agents.json`.

## 5. Как это разворачивается

**Новая машина:**
```bash
git clone https://github.com/SowingSadness/pi-environment.git ~/pi-environment
node ~/pi-environment/scripts/install.mjs        # Windows: powershell -File ~/pi-environment/scripts/install.ps1
pi --help                                        # проверка загрузки расширений
```

**Обновление (окружение уже есть):**
```bash
cd ~/pi-environment && git pull && node scripts/install.mjs
```
Так как файлы — симлинки, изменения `agents.ts`/`orchestrator.ts`/`lib` подхватываются сразу; повторный
install нужен только когда в репозитории появились **новые агенты** (merge `agents.json`).

**Почему не `git pull` прямо в `~`:** репозиторий-как-home (`git --work-tree=$HOME`) при `pull` может
перезаписать любые файлы в домашнем каталоге и делает `git status` в `~` многотысячным. Вариант
`~/pi-environment` + install предсказуем и обратим (все замены — с `.bak`).

## 6. Пуш (SSH, ключ `github_rsa` — уже проверен)

Актуальные команды — в разделе «Push over SSH» выше. HTTPS-remote не использовать; `gh auth login` не нужен.

Remote ответил `could not read Username for 'https://github.com'` → репозиторий приватный (или требует
авторизации). Перед пушем:

```bash
gh auth status          # или: git config --global credential.helper
gh auth login           # если не залогинен; либо PAT/SSH-ключ
```

Далее:
```bash
mkdir -p ~/pi-environment && cd ~/pi-environment
git init -b main
# скопировать agent/, scripts/, docs/, README.md, .gitignore (см. §2)
git add -A
git commit -m "pi harness: agents, orchestrator, worktree/handoff extensions"
git remote add origin https://github.com/SowingSadness/pi-environment.git
git push -u origin main
```

Если в remote уже есть коммиты (например, создан README при создании репозитория):
```bash
git clone https://github.com/SowingSadness/pi-environment.git ~/pi-environment
# скопировать файлы, git add/commit, git push
```

## 7. README репозитория (коротко)

- что внутри (6 агентов, оркестратор, guard, worktree);
- требования (pi ≥ 1.4, node);
- установка (2 команды) и обновление;
- как добавить своего агента (agents.json + `slot`);
- дисклеймер: секретов в репозитории нет, `auth.json`/`sessions/` не коммитятся.

## 8. Проверка после установки

1. `pi --help` — без «extension error»/«failed to load».
2. `/agent` или `alt+1..6` — архитектор, кодер, оркестратор, ревьюер, скаут, хендимен; слоты 1–6.
3. `pi --agent architect -p "reply OK"` — в системном промпте секция `## Runtime constraints` с абсолютным `.pi/plans`.
4. `pi --agent orchestrator -p "reply OK"` — инструменты `start_run/delegate/finish_run` в списке.
5. `git -C ~/pi-environment status` — чисто; `git pull` повторяемо ничего не ломает.

## 9. Риски и как закрыты

| Риск | Мера |
|---|---|
| Утечка ключей/сессий | `.gitignore` + явный список того, что копируем; `auth.json` не читается скриптом |
| Затереть локальные настройки | `agents.json` — merge; `settings.json` не трогается; замены только с `.bak.<ts>` |
| Сломать чужие расширения | install трогает только `agents.ts`, `orchestrator.ts`, `lib`; остальное не удаляет |
| Windows без прав на symlink | junction для каталогов, `--copy` как fallback |
| Репозиторий приватный | пуш и clone требуют `gh auth login` / PAT — делает пользователь |
| Разные версии pi | README фиксирует «≥1.4»; `pi --help` как smoke-тест |
