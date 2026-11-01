# Orchestrator agent

Роль: диспетчер. Сам read-only, код меняет только через подагентов, контекст держит на summary.

Решения зафиксированы по ответам пользователя: 1 read-only · 2 три маршрута · 3 одно подтверждение на поток ·
4 два coder'а только без пересечения файлов / в отдельных worktree · 5 план работы + alive каждые 60 с ·
6 tiers моделей · 7 подпроекты только по запросу · 8 слот 3, reviewer на 4.

## 1. Агенты и слоты

Слот задаётся явно (`slot`), потому что алфавитный порядок не совпадает с желаемым.

| slot | agent | роль | thinking | tools | guard |
|---|---|---|---|---|---|
| 1 | `architect` | план, read-only | `high` | read, bash, grep, find, ls, edit, write | `readOnly` + `planDir: .pi/plans` |
| 2 | `coder` | реализация | `dispatcher` (= уровень оркестратора) | read, bash, edit, write, find, grep, ls | — |
| 3 | `orchestrator` | координатор | `high` | read, bash, grep, find, ls, **start_run, delegate, finish_run** | `readOnly` (без `planDir`) |
| 4 | `reviewer` | ревью | `medium` | read, bash, grep, find, ls | `readOnly` |
| 5 | `scout` | разведка, сжатый контекст | `low` | read, grep, find, ls, bash | `readOnly` |
| 6 | `handyman` | утилитарные правки, тесты, коммиты | `low` | read, bash, edit, write, find, grep, ls | — |

- `thinkingLevel: "dispatcher"` — новый режим: при делегировании `delegate` передаёт `--thinking <уровень родителя>`;
  при ручной активации (alt+2) это текущий уровень сессии.
- Оркестратор без `planDir` — писать он не может вообще; план создаёт `architect` в `.pi/plans/`.
- Hotkeys: `alt+<slot>` / `ctrl+alt+<slot>`; агенты без `slot` идут после, по алфавиту. Пикер показывает `[3] orchestrator`.

## 2. Инструменты (регистрируются в `agents.ts`)

```ts
start_run({ route: "full" | "fast" | "express", goal: string, plan?: string })
// 1) создаёт run-dir, 2) один раз спрашивает ctx.ui.confirm (маршрут + цель + шаги + файлы),
// 3) возвращает { runId, route, steps, rules } — чек-лист, которому агент обязан следовать.
// Повторный start_run без finish_run отклоняется.

delegate({
  runId: string,
  tasks: [{ agent, task, context?, files?: string[], worktree?: boolean, timeoutSec?: number }],
  concurrency?: number,           // default 2
})
// 1 задача — синхронно, >1 — параллельно. Возвращает:
// content: markdown-сводки (≤ 8 КБ каждая)
// details: { results: [{ agent, status, summary, files, tests, usage, durationMs, worktreePath? }] }
// usage: агрегированный Usage детей (чтобы счётчик сессии был честным)

finish_run({ runId, summary: string, status: "done" | "aborted" | "failed" })
// пишет summary.md, закрывает run, возвращает итоговую сводку для отчёта пользователю.
```

`delegate` вне активного run отклоняется — так «одно подтверждение на поток» нельзя обойти.

## 3. Маршруты

| route | шаги | лимит делегирований | когда |
|---|---|---|---|
| `full` | scout → architect(план) → coder(s) → reviewer → цикл fix→review ≤ 2 | 10 | фичи, рефакторинг, всё незнакомое |
| `fast` | architect(короткий план) → coder(s) | 4 | понятное локальное изменение |
| `express` | handyman (один шаг) | 1 | опечатки, доп. тесты, коммит, мелкие утилиты |

- Тесты запускает `coder` в рамках своей задачи (это уже в его инструкциях); `reviewer` проверяет их результат.
- `express` не пишет план: handyman получает бриф и сразу делает. Коммит — только если цель явно это просит
  (в брифе: «commit with message …»), иначе handyman коммитить не должен.
- Оркестратор вправе понизить маршрут (`full` → `fast`), но не повысить после подтверждения: смена маршрута
  требует нового `start_run` (и нового подтверждения).

## 4. Контракт подагента: план, лог, alive

Каталог запуска: `.pi/runs/<runId>/`

```
run.json                         # route, goal, startedAt, status
tasks/<taskId>/brief.md          # пишет delegate: цель, ограничения, файлы, критерии приёмки, формат отчёта
tasks/<taskId>/plan.md           # пишет САМ подагент: шаги с чекбоксами
tasks/<taskId>/log.md            # пишет САМ подагент: одна строка на значимый шаг (файл, результат, следующий шаг)
tasks/<taskId>/alive.jsonl       # пишет расширение в процессе ребёнка, раз в 60 с
tasks/<taskId>/state.json        # пишет delegate: pid, старт, фаза, usage, exitCode
tasks/<taskId>/result.md         # финальный отчёт ребёнка
summary.md                       # пишет finish_run
```

**alive (механический, не зависит от модели).** Ребёнок запускается с env
`PI_RUN_DIR`, `PI_RUN_TASK`, `PI_AGENT_DEPTH=1`. Расширение в `session_start` (только если env задан) поднимает
интервал `heartbeatSec` (по умолчанию 60), в `session_shutdown` его снимает. Каждая запись:

```json
{ "ts": 1730000000000, "agent": "coder", "pid": 1234, "tool": "bash", "idleMs": 1200, "turn": 7 }
```

Дополнительно `alive.jsonl` дописывается на `tool_execution_start` / `tool_execution_end` (быстрый прогресс),
а таймер держит 60-секундный «пульс» в простое.

**Watchdog в родителе.** `delegate` считает задачу зависшей, если heartbeat старше `2.5 × heartbeatSec` (150 с),
и показывает в рендере `⚠ no heartbeat 2m10s`; процесс при этом не убивается автоматически — решение за
оркестратором (он может отменить run). Exit кода ребёнка и `state.json` — источник истины для статуса.

**Инструкции ребёнку (добавляет `delegate` в бриф):** вести `plan.md` (шаги + отметки) и `log.md`
(1–3 строки на шаг: что сделал / что дальше), не удалять чужие файлы, закончить `result.md` по формату:
`status`, `summary`, `files`, `tests`, `open questions`.

**Guard и артефакты.** Read-only подагент (`architect`, `scout`, `reviewer`) не может писать в репозиторий, но
обязан вести свои `plan.md`/`log.md`/`result.md`. Поэтому `agents.ts` разрешает записи внутри `PI_RUN_DIR`
(каталог run'а), даже когда агент read-only: это единственное исключение помимо `planDir`.

## 5. Параллельность и worktree

Два режима параллельной работы, выбираются оркестратором осознанно.

**A. Общий workspace (по умолчанию).** Писатели (`coder`, `handyman`) — не более 2 одновременно, и только
если у каждой задачи в `files[]` перечислены файлы и множества **не пересекаются**. Пересечение `delegate`
отклоняет с ошибкой «раздели задачи или запусти в worktree». Read-only роли (`scout`, `reviewer`, `architect`)
— до 4 параллельно без ограничений по файлам.

**B. Изолированные worktree (для крупной самостоятельной работы).** Используется, когда параллельно идёт
несколько больших задач полного цикла, которые потом надо интегрировать отдельным шагом:

- `worktree: true` → `git worktree add .pi/worktrees/<taskId> -b agent/<runId>/<taskId> <base>`; ребёнок
  получает `cwd` этого worktree, `files[]` могут пересекаться с другими worktree, но не с общим workspace;
- результат содержит `worktreePath` и `branch`;
- **интеграция — отдельная задача**, не авто-мерж: после параллельной фазы оркестратор делает `delegate`
  к `coder` с брифом «слить ветки A и B в <base>, разрешить конфликты, прогнать тесты». Пока идёт
  интеграция, других писателей быть не должно (проверка в `delegate`);
- worktree создаётся только от чистого HEAD; грязное дерево → отказ с подсказкой закоммитить/спрятать;
- если интеграция не удалась, worktree не удаляются: пользователь решает, добивать вручную или выбросить.

Смешивать оба режима в одной пачке нельзя. `.pi/worktrees/` и `.pi/runs/` — в `.gitignore`.

## 6. Подпроекты и cwd

- `delegate` принимает `cwd`; разрешены: текущий cwd, его подкаталоги, `.pi/worktrees/*`.
- Соседний проект (на одном уровне с основным) или каталог вне разрешённых корней — **только по явному
  запросу пользователя**: `delegate` требует `approvedByUser: true` в такой задаче и всё равно спрашивает
  `ctx.ui.confirm` (отдельное подтверждение, потому что это выход за пределы run-root).
- Создание структуры нового проекта — задача для `handyman`/`coder` (оркестратор сам не пишет): express-route
  «создай проект X в ../X по шаблону Y».

## 7. Лимиты и лимиты стоимости

| Параметр | Значение |
|---|---|
| делегирований на run | full 10 · fast 4 · express 1 |
| параллельно | read-only 4 · писатели 2 · всего 8 |
| таймаут задачи | 15 мин (per-task override) |
| heartbeat / watchdog | 60 с / 150 с |
| цикл fix→review | ≤ 2 |
| глубина | 1 (`PI_AGENT_DEPTH`; при > 0 `delegate` не регистрируется) |
| вывод в родителя | summary ≤ 8 КБ на задачу (`result.md` целиком лежит на диске) |

Usage детей агрегируется в результат `delegate`, поэтому футер показывает реальную стоимость run.

## 8. Безопасность

- Оркестратор: `readOnly` без `planDir` — ни файлов, ни мутирующего shell.
- Подагенты запускаются как `pi --agent <name> --mode json -p --no-session --tools <из конфига>`:
  guard, инструкции и tools берутся из `agents.json`, обойти их брифом нельзя.
- `delegate` не пробрасывает `delegate` в `--tools` ребёнка → рекурсия невозможна даже без depth-переменной.
- Worktree создаётся только от чистого HEAD; при грязном дереве — отказ с подсказкой закоммитить/спрятать.
- Всё, что пишется вне `.pi/runs`, `.pi/worktrees` и `.pi/plans`, делает только `coder`/`handyman` после
  подтверждения run'а.

## 9. Этапы реализации

1. **Слоты и tiers** — `slot` в `agents.json`, сортировка хоткеев по слоту, `thinkingLevel: "dispatcher"`,
   новые агенты `scout` и `handyman`. Проверка: `alt+1..6`, `/hotkeys`, `pi --help`.
2. **Каркас run + delegate (single)** — `start_run`/`delegate`/`finish_run`, subprocess через `--agent`,
   парсинг JSON-потока, `state.json`, агрегированный usage, рендер. Проверка: express-route на scratch-репе.
3. **Heartbeat** — `alive.jsonl` в ребёнке (60 с + события тулов), watchdog в родителе, индикация в рендере.
4. **Маршруты** — валидация route/лимитов, чек-лист шагов в `start_run`, запрет `delegate` вне run.
5. **Параллельность и worktree** — проверка пересечения `files[]`, `git worktree`, отказ при грязном дереве.
6. **Подпроекты** — `cwd`-allowlist, отдельное подтверждение, express-сценарий «новый проект».
7. **Тесты** — юнит: парсер маршрутов, лимиты, пересечение файлов, heartbeat-писатель, watchdog-порог;
   e2e: express на scratch-репе, fast на 2 файлах, full с заглушечным агентом (без реальных трат).

## 10. Решения по вопросам

| Вопрос | Решение |
|---|---|
| Слоты и имена | `scout` = 5, `handyman` = 6, имена оставляем |
| Дешёвый tier | Отдельных моделей нет: у всех агентов наследуется текущая модель, дешевизна — только через `thinking` (`low`/`medium`); у `coder` — `dispatcher`, у оркестратора `high` |
| Артефакты run | `.pi/runs/` в проекте; `.pi/runs/`, `.pi/worktrees/` добавить в `.gitignore` |
| Параллельная запись | По умолчанию — только непересекающиеся `files[]`; worktree — для крупной работы полного цикла с последующей отдельной задачей интеграции |
| `bash` у оркестратора | Оставляем read-only: `git status/log/diff`, `rg`, наблюдение за подагентами |

## 11. Черновик конфигурации `agents.json`

Слоты явные, моделей нет (наследуется текущая), дешёвый tier — только thinking.

```json
"architect":    { "slot": 1, "thinkingLevel": "high",       "readOnly": true, "planDir": ".pi/plans" },
"coder":        { "slot": 2, "thinkingLevel": "dispatcher" },
"orchestrator": { "slot": 3, "thinkingLevel": "high",       "readOnly": true,
                  "tools": ["read", "bash", "grep", "find", "ls", "start_run", "delegate", "finish_run"] },
"reviewer":     { "slot": 4, "thinkingLevel": "medium",     "readOnly": true },
"scout":        { "slot": 5, "thinkingLevel": "low",        "readOnly": true },
"handyman":     { "slot": 6, "thinkingLevel": "low" }
```

Что нужно добавить в код расширения помимо самих агентов:

- `slot?: number` в `AgentConfig`; `agentNames()` сортирует по `slot`, затем по имени; хоткеи и пикер берут слот;
- `thinkingLevel: "dispatcher"` в типе: `delegate` передаёт `--thinking` от родителя, ручная активация — текущий уровень;
- `.gitignore`: блок `.pi/runs/` + `.pi/worktrees/` (создаётся/дополняется при первом `start_run`,
  чтобы не перезаписать существующий файл).

## 12. Этап 5: worktree + интеграция (реализовано)

### API

```ts
delegate({ runId, tasks: [{ agent: "coder", task, context?, files?, worktree: true | { base?: string } }] })
delegate({ runId, tasks: [{ agent: "coder", task, merge: { branches?: string[], target?: string } }] })
finish_run({ runId, status, summary, cleanupWorktrees?: boolean })
```

`merge.branches` по умолчанию — все worktree-ветки этого run'а, задавать их модели не обязательно.

### Правила (валидация в `lib/runs.ts`)

| Правило | Причина |
|---|---|
| `worktree` только на маршруте `full` | worktree — для крупной параллельной работы полного цикла |
| `worktree` только для писателей (`coder`, `handyman`) | read-only агенту ветка не нужна |
| нельзя смешивать worktree-писателей и общих писателей в одной пачке | разные модели изоляции |
| ≤ 4 worktree на run, конкурентность 4 (в общем workspace остаётся 2) | изоляция снимает гонку за файлы |
| `merge` — только `coder`, только один в вызове, не в worktree | мерж меняет общее дерево |
| `finish_run` отклоняется, пока есть `pending`/`running` задачи | иначе в ledger остаются призраки |

### Механика

1. **Preflight** (`lib/worktree.ts`): git-репозиторий, `HEAD` существует, нет изменений **отслеживаемых**
   файлов (`git status --porcelain --untracked-files=no`). Untracked-файлы не блокируют: `start_run` сам
   создаёт untracked `.gitignore`, а коллизии с untracked при мерже git отвергает и ребёнок это сообщает.
2. **Создание**: `git worktree add .pi/worktrees/<runId>/<taskId> -b agent/<runId>/<taskId> <base>`;
   затем junction/symlink тяжёлых каталогов из `worktreeLinks` и опциональная `worktreeSetup`-команда
   (`.pi/orchestrator.json`). Все worktree создаются до запуска детей, по одному, чтобы не было гонки.
3. **Запуск**: ребёнок получает `cwd` = worktree, артефакты run'а — в основном дереве (абсолютные пути).
4. **После выхода**: если дерево worktree грязное — авто-коммит `agent(<agent>): <первая строка задачи>`
   (с фолбэком на служебную identity); в `run.json`/`state.json` пишутся `branch`, `path`, `headCommit`,
   `autoCommitted`.
5. **Мерж**: preflight (чистое отслеживаемое дерево, нет `MERGE_HEAD`, ветки существуют) → бриф с порядком
   веток, выдержками из `result.md` и политикой (`git merge --no-ff`, не угадывать в конфликтах) → `coder`.
   После выхода проверяются `MERGE_HEAD` и `git diff --diff-filter=U`; при незавершённом мерже
   `merge.inProgress = true`, `merge.conflicted = [...]`, задача `failed`, run остаётся `open`.
6. **Уборка**: только `finish_run({ cleanupWorktrees: true })` → `git worktree remove --force`, `prune`,
   `branch -D`. При конфликте worktree и ветки сохраняются — их разбирает пользователь.

### Артефакты

`run.json.tasks[].worktree` / `.merge`, `tasks/<id>/state.json` (pid, turns, heartbeat, worktree, merge),
`summary.md` — секции `Worktrees` и `Cleanup`, команда `/runs` — список run'ов, веток и путей.

### Проверено

- Юнит-тесты `lib/runs.ts` (включая новые правила worktree/merge и `loadOrchestratorConfig`) — зелёные;
- Юнит-тесты `lib/worktree.ts` на реальном git: preflight (tracked/untracked), создание, авто-коммит,
  линковка `node_modules`, merge preflight, `MERGE_HEAD`, удаление — зелёные;
- E2E #1: две worktree-задачи параллельно → мерж → оба файла в `master`, ветки и worktree удалены,
  `summary.md` с `Worktrees`/`Cleanup`, usage агрегирован;
- E2E #2 (конфликт): две ветки правят одну строку → мерж оставил `MERGE_HEAD`, `conflicted: ["src/a.txt"]`,
  run `failed`, worktree и ветки сохранены — восстановление возможно.

### Известные ограничения

- `git worktree` требует минимум один коммит в репозитории;
- в worktree нет тяжёлых каталогов, если они не в `worktreeLinks` и нет `worktreeSetup`;
- конфликт разрешает модель-`coder`; если она не уверена — по политике делает `git merge --abort`,
  тогда `merge.inProgress = false`, а конфликт остаётся описан в `result.md` и `summary.md`;
- `cleanupWorktrees` не удаляет ветки, если мерж не был выполнен (мы не удаляем невлитую работу).

## 13. Handoff `architect → orchestrator` и контракт read-only в промпте (реализовано)

### Тул `orchestrator_execution` (в `agents.ts`, доступен только агенту с `planDir`)

```ts
orchestrator_execution({ plan: string, route?: "full"|"fast"|"express", notes?: string })
```

Проверки по порядку (первые три вынесены в `lib/handoff.ts` и покрыты юнит-тестами):

1. `PI_AGENT_DEPTH > 0` → отказ «you are a delegated subagent (depth N)… return your plan/result to the caller»;
2. агент не выбран / это `orchestrator` / нет `planDir` → отказ;
3. путь вне `planDir` → отказ с абсолютным разрешённым каталогом;
4. файла нет / он пустой / в плане нет `## Route` и не передан `route` → отказ;
5. уже открыт run → отказ (сначала `finish_run`);
6. `ctx.ui.confirm` в TUI (в headless — пропуск);
7. «Да» → handoff в очередь, «Нет» → план остаётся.

Переключение — только на `agent_settled` (не посреди run'а): `activate("orchestrator")` затем
`pi.sendUserMessage("Execute the plan at <abs path> (route: …)…")`.

Подагентам тул недоступен дважды: `activate()` вырезает его при `DEPTH > 0`, а бриф `delegate` содержит
пункт 7 «you are a delegated subagent: do not call orchestrator_execution, start_run or delegate; return your
result to the caller».

### `start_run({ route?, goal?, plan?, steps? })`

`plan` читается и парсится `lib/plans.ts` (`# title`, `## Route`, `## Goal`, `## Steps` + `### шаг` с
`- agent/- files/- depends/- acceptance`, фолбэк на нумерованный список и `route:` в любом месте).
В `run.json` пишутся `planPath` и `planTitle`, чек-лист строится из шагов плана; `route`/`goal`
берутся из плана, если не переданы параметрами.

### Контракт read-only в системном промпте

`lib/prompt.ts#buildAgentSection` собирает секцию `<agent>` из конфига, а не из текста инструкций:

```
Active agent: architect

## Runtime constraints (enforced before execution, not by these instructions)
- You are READ-ONLY: …
- Writable plan files: C:\…\.pi\plans
- Writable task artifacts: C:\…\.pi\runs\<run>\tasks\<task>   (только у подагента)
- Shell: read-only only — ls, cat, rg/find (без -delete/-exec), sed -n, git status/log/diff/show, npm ls.
- A blocked call fails immediately. Do not retry it and do not bypass it with redirects, tee or -o…
```

Пути абсолютные; для не-read-only агентов блок — одна строка «Writes: anywhere…».

### Проверено

- юнит: `parsePlan` (полный план, нумерованный фолбэк, `route:` в тексте, мусор, CRLF);
  `handoffRefusal` (depth приоритетнее всего, orchestrator, нет planDir, разрешённый случай);
  `buildAgentSection` (READ-ONLY, абсолютные пути, run-каталог, allowCommands, размер, не-readonly вариант);
- e2e #1: `architect` в json-режиме пишет `.pi/plans/ctx-check.md` и получает отказ тула для пути вне
  `.pi/plans`; каталог `.pi/runs` не создаётся;
- e2e #2: архитектор пишет план → `orchestrator_execution` → переключение на `orchestrator` → `start_run({plan})`
  → `delegate(handyman)` → `finish_run`; `run.json.planPath`/`planTitle` заполнены, `NOTES.md` создан;
- `pi --help` — без ошибок загрузки и конфликтов хоткеев.

### Известные ограничения

- один открытый run за раз; план читается один раз на старте;
- в headless-режимах подтверждение handoff'а пропускается (нужно для e2e);
- после handoff архитектор недоступен до `finish_run` или ручного возврата на `alt+1`.
