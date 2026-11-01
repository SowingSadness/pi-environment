# pi-environment

Набор агентов и расширений для [pi](https://github.com/earendil-works/pi-coding-agent) — harness уровня
«оркестратор + подагенты + git worktrees», разворачиваемый в `~/.pi/agent` одной командой.

## Что внутри

**6 агентов** (`agent/agents.json`, слоты 1–6, переключение `alt+1..6` или `/agent`):

| # | Агент | Роль |
|---|---|---|
| 1 | `architect` | read-only: планирование и дизайн, пишет план в `.pi/plans` |
| 2 | `coder` | полный доступ к тулам, реализация по плану |
| 3 | `orchestrator` | координирует подагентов, сам репозиторий не правит |
| 4 | `reviewer` | read-only ревью текущего диффа |
| 5 | `scout` | read-only разведка, возвращает сжатый контекст |
| 6 | `handyman` | мелкая рутина: опечатки, тесты, коммиты, хелперы |

**Расширения** (`agent/extensions/`):

- `agents.ts` — режимы агентов, guard (запрет на запись/деструктивные команды там, где роль read-only),
  цвета/слоты, handoff-тул (передача контекста между агентами).
- `orchestrator.ts` — тулы оркестрации `start_run` / `delegate` / `finish_run`, heartbeat и учёт
  запусков подагентов.
- `lib/` — общие модули: `agents-config`, `runs`, `worktree`, `plans`, `prompt`, `handoff`.
  `worktree` даёт подагентам изолированные git worktrees, `plans` — чтение `.pi/plans/*.md`,
  `runs` — состояние run'ов в `.pi/runs/`.

**Документация** — `docs/`: устройство оркестратора, handoff между агентами, readonly-контекст,
цвета и слоты агентов, план публикации окружения (`docs/env-repo.md`).

## Требования

- pi ≥ 1.4 (`pi --version`)
- Node.js (нужен для `scripts/install.mjs`; идёт вместе с pi, если pi поставлен через npm)

## Установка

```bash
git clone git@github.com:SowingSadness/pi-environment.git ~/pi-environment
node ~/pi-environment/scripts/install.mjs
```

Windows (PowerShell):

```powershell
git clone git@github.com:SowingSadness/pi-environment.git "$HOME\pi-environment"
powershell -File "$HOME\pi-environment\scripts\install.ps1"
```

POSIX-обёртка: `~/pi-environment/scripts/install.sh`.

Что делает install:

- `agent/extensions/agents.ts`, `orchestrator.ts` и каталог `lib/` — **симлинки/джанкшены** в
  `~/.pi/agent/extensions/` (изменения из `git pull` подхватываются без повторного запуска);
- `agent/agents.json` — **merge** с локальным: агенты из репозитория побеждают по совпадающим именам,
  локальные уникальные агенты сохраняются, перед записью делается `agents.json.bak.<timestamp>`;
  если локального файла нет — он **копируется** (не симлинк: merge пишет в него);
- `extensions/subagent/` и прочие ваши расширения **не трогаются**;
- `settings.json` **не перезаписывается** (там ваша тема/модель/packages).

Флаги: `--dry-run` (только показать), `--copy` (копирование вместо симлинков), `--force` (перезаписать
даже идентичные файлы), `--with-settings` (скопировать `settings.example.json`, только если
`settings.json` ещё нет). Каталог назначения: `$PI_CODING_AGENT_DIR` или `~/.pi/agent`.

## Обновление

```bash
cd ~/pi-environment && git pull
node scripts/install.mjs   # нужен только если в репозитории появились новые агенты/файлы
```

Так как расширения — симлинки, правки кода подхватываются сразу (достаточно `/reload` в сессии pi).

## Как добавить своего агента

1. Добавить запись в `agent/agents.json`:

   ```json
   {
     "my-agent": {
       "slot": 7,
       "description": "что делает",
       "thinkingLevel": "medium",
       "tools": ["read", "bash", "grep", "find", "ls"],
       "readOnly": true,
       "instructions": "You are in MY-AGENT MODE. ..."
     }
   }
   ```

   `slot` — номер горячей клавиши (`alt+<slot>`) и порядок в `/agent`; он должен быть уникальным.
   `readOnly: true` включает guard на запись и деструктивные bash-команды; `planDir` (например
   `.pi/plans`) добавляет секцию `## Runtime constraints` с абсолютным путём к планам;
   `inputColor`/`statusColor` задают цвета в TUI.
2. `node scripts/install.mjs` — merge перетащит нового агента в локальный `~/.pi/agent/agents.json`,
   не затерев ваших.
3. `/reload` (или перезапуск `pi`) и проверить `pi --agent my-agent -p "reply OK"`.

## Безопасность

В репозитории **нет секретов**: `auth.json` (ключи провайдеров), `sessions/` (история чатов),
`install/` (бинарь pi), `bin/`, `npm/`, `kendex/`, `models-store.json`, `trust.json` (локальные решения
о доверии) и `settings.json` (личные тема/модель/packages) не публикуются и закрыты `.gitignore`.
`agents.json` содержит только конфигурацию агентов; резервные копии `*.bak.*` тоже игнорируются.
