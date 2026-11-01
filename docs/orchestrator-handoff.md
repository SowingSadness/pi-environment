# Handoff-тул `orchestrator_execution` (вариант C)

Цель: архитектор обсуждает задачу, пишет план и **сам** передаёт его оркестратору. Пользователь
не думает об оркестраторе и не передаёт файл вручную. Оркестратор остаётся полностью read-only:
план принадлежит архитектору, оркестратор его только читает.

## 1. Тул `orchestrator_execution` (регистрируется в `agents.ts`)

```ts
orchestrator_execution({
  plan: string,                                   // путь к файлу плана, внутри planDir
  route?: "full" | "fast" | "express",            // иначе берётся из плана
  notes?: string,                                 // что оркестратору знать до старта
})
```

Доступен только агенту с `planDir` (в конфиге — у `architect` в `tools`).

### Проверки в `execute()` (по порядку)

1. **Depth-guard (главное требование).** Если `PI_AGENT_DEPTH > 0` — это подагент, делегированный
   оркестратором (или кем-то ещё). Отказ, без переключения агента:
   ```
   orchestrator_execution refused: you are a delegated subagent (depth N).
   Do not start orchestration. Return your plan/result to the caller that delegated this task.
   ```
   `isError: true`. Так архитектор, вызванный оркестратором, не может запустить второй оркестратор.
2. **Не оркестратор.** Если активный агент — `orchestrator`, отказ: «call start_run/delegate instead».
3. **Путь.** `resolveUserPath(plan)` обязан быть внутри `<planDir>` (по умолчанию `.pi/plans`), иначе
   отказ: план нельзя писать/читать за пределами каталога планов.
4. **Файл существует и не пуст.**
5. **Нет открытого run'а** (`findOpenRunId`) — иначе отказ: сначала `finish_run`.
6. **Подтверждение** (`ctx.ui.confirm`) с заголовком плана, маршрутом, числом шагов и первыми шагами.
   В headless-режимах (`ctx.hasUI === false`) подтверждение пропускается — нужно для e2e/автоматизации.
7. «Нет» → план остаётся, агент не переключается. «Да» → handoff в очередь.

### Переключение — на `agent_settled`, не внутри тула

Менять агента посреди его run'а нельзя (очередь сообщений, статус). Поэтому:

```ts
pi.on("agent_settled", async (_event, ctx) => {
  const pending = takePendingHandoff();
  if (!pending) return;
  if (!(await activate("orchestrator", ctx))) {
    ctx.ui.notify("agents: cannot switch to orchestrator (not configured?)", "error");
    return;
  }
  pi.sendUserMessage(
    `Execute the plan at ${pending.plan}${pending.route ? ` (route: ${pending.route})` : ""}. ` +
    `Read it first and do not re-plan unless it is incomplete.${pending.notes ? `\n\nNotes: ${pending.notes}` : ""}`,
  );
});
```

Пользователь видит только смену бейджа `agent:architect` → `agent:orchestrator` и старт работы.

## 2. Подагенты не видят тул

Помимо runtime-guard'а — фильтр в `activate()`:

```ts
const DEPTH = Number.parseInt(process.env.PI_AGENT_DEPTH ?? "0", 10) || 0;
// ...
let valid = agent.tools.filter((tool) => known.has(tool));
if (DEPTH > 0) valid = valid.filter((tool) => tool !== "orchestrator_execution");
```

## 3. Оркестратор явно запрещает вызов тула в брифе

`orchestrator.ts`, `buildBrief()` — добавить пункт контракта (действует для **всех** подагентов):

```
7. You are a delegated subagent (depth N): do not call orchestrator_execution, start_run or delegate.
   Return your result to the caller that delegated this task; the orchestrator decides what happens next.
```

Плюс в `delegate`'s `promptGuidelines` — строка: «Bриф must state that the subagent returns results and
must not start orchestration».

## 4. `start_run` принимает план

```ts
start_run({ route, goal?, plan?: string })
```

- `plan` читается, парсится `lib/plans.ts` → `{ title, route?, goal?, steps: [{ title, agent, files, acceptance, depends }] }`;
- в `run.json` пишутся `planPath` и `planTitle`;
- чек-лист в ответе — шаги из плана (fallback: шаги маршрута);
- `goal` берётся из параметра, иначе из `## Goal` плана, иначе из заголовка;
- `route` — из параметра, иначе из `## Route`, иначе ошибка «plan has no route».

`lib/plans.ts` — новый модуль: `parsePlan(text)`, `toRoute`, `parseFiles` (см. формат в шапке модуля:
`# title`, `## Route`, `## Goal`, `## Steps` + `### шаг` с `- agent/files/depends/acceptance`,
плюс фолбэк на нумерованный список и `route:` в любом месте).

## 5. Инструкции агентов

**`architect`** (добавить):
> Стандартный процесс двухфазный: обсуждаем задачу → ты пишешь исполняемый план в `.pi/plans/<slug>.md`
> → вызываешь `orchestrator_execution` один раз. Реализацией занимается оркестратор, ты не пишешь код.
> Шаблон плана: `# План: …`, `## Route` (full|fast|express), `## Goal`, `## Steps` — для каждого шага
> `### N. заголовок` и поля `- agent`, `- files`, `- depends`, `- acceptance`, затем `## Risks`.
> `files[]` обязательны: по ним оркестратор проверяет, что параллельные `coder` не пересекаются.
> Если тебя вызвал оркестратор как подагента — не вызывай `orchestrator_execution`, верни план в ответе.

**`orchestrator`** (добавить):
> Если пришло указание исполнить план по пути X — прочитай X, не перепланируй, вызови
> `start_run({ route, goal, plan: X })`, и дальше каждый `delegate` соответствует шагу плана
> (`files[]` и `acceptance` из шага). Права на запись у тебя нет.

## 6. Тесты

- юнит `parsePlan`: полный план, без `###` (нумерованный список), без Route (фолбэк `route:`), мусор,
  `files: [a, b]` и `files: a, b`, `agent: coder` с комментарием;
- юнит: проверка «путь внутри planDir» (внутри/`..`/абсолютный снаружи);
- e2e-негатив: `pi --agent architect` c `PI_AGENT_DEPTH=1` и промптом «вызови orchestrator_execution» →
  ошибка с текстом «delegated subagent», агент не переключился;
- e2e-позитив: `pi --agent architect` (json-режим, без диалога) → пишет план → `orchestrator_execution`
  → `agent_settled` → `orchestrator` читает план → `start_run` с `plan` → `delegate` → `finish_run`;
  проверить `run.json.planPath`, выполненные шаги, отчёт;
- e2e-негатив: план вне `.pi/plans` и несуществующий путь → отказ, агент не меняется.

## 7. Ограничения

- один открытый run за раз;
- план читается один раз на старте; правки файла во время исполнения не подхватываются;
- после handoff архитектор недоступен до `finish_run` (или ручного возврата на alt+1);
- в headless-режимах подтверждение пропускается (нужно для автоматизации).

## 8. Файлы к изменению

| Файл | Что |
|---|---|
| `extensions/lib/plans.ts` | новый: парсер плана |
| `extensions/agents.ts` | `orchestrator_execution`, pending handoff, `agent_settled`, фильтр тула у подагентов, инструкции-агностик |
| `extensions/orchestrator.ts` | `start_run({plan})`, пункт 7 в брифе, `promptGuidelines` |
| `agents.json` | `architect.tools += orchestrator_execution`, тексты инструкций |
| `.pi/plans/orchestrator.md` | раздел 13 с реализованным API |
