# Read-only контракт в контексте агента

Проблема: read-only агенты (architect, reviewer, scout) узнают о запрете записи из общих инструкций, а
точный список разрешённых мест — из одной строки в секции `<agent>`. Модель периодически всё равно
пробует `write`/`edit`/`bash` за пределами разрешённого и тратит на это ходы. Нужен явный, машинно
сгенерированный блок ограничений с абсолютными путями, чтобы попыток было меньше.

## Принцип

Блок ограничений **генерируется из конфига** (`planDir`, `readOnly`, `PI_RUN_DIR`, `allowCommands`), а не
пишется руками в `instructions` каждого агента — иначе конфиг и текст разъезжаются. Один источник истины.

## Шаблон текста (внутри секции `<agent>`, до инструкций)

```
## Runtime constraints (enforced before execution, not by these instructions)
- You are READ-ONLY: `edit`, `write` and mutating shell commands are refused by the runtime.
- Writable plans: /abs/path/.pi/plans            # только если planDir задан
- Writable task artifacts: /abs/path/.pi/runs/<run>/tasks/<task>/   # только у подагента (PI_RUN_DIR)
- Shell: read-only only — ls, cat, rg/find (без -delete/-exec), sed -n, git status/log/diff/show,
  npm ls; everything else is refused.
- A blocked call returns an error immediately. Do not retry it, do not try redirects/`tee`/`-o` to work
  around it: adapt or ask the user to switch agents.
```

Варианты:
- `planDir` не задан → вместо строки «Writable plans» пишется `File writes (including plan files) are refused.`
- агент не read-only → блок всё равно полезен, но короткий: `Writable: anywhere in the workspace. Shell: unrestricted.` (одна строка, чтобы не тратить токены).
- `allowCommands` задан → добавить `Extra allowed commands: <list>.`

Ограничение размера: блок ≤ 12 строк / ~700 символов.

## Реализация

1. **`extensions/lib/prompt.ts`** (новый): чистая функция
   ```ts
   buildAgentSection(params: {
     name: string; readOnly: boolean; planDirAbs?: string; runDirAbs?: string;
     allowCommands?: string[]; instructions?: string;
   }): string
   ```
   Возвращает готовое содержимое секции `<agent>`: `Active agent: …`, блок ограничений, инструкции.
   Пути — абсолютные (резолвятся в вызывающем коде через `resolveUserPath`), относительные пути
   бесполезны: модель не знает cwd из секции.

2. **`extensions/agents.ts`**, `pi.on("before_agent_start")`:
   ```ts
   sections.agent = buildAgentSection({
     name: activeName,
     readOnly: Boolean(activeGuard),
     planDirAbs: activeGuard?.planDir ? resolveUserPath(activeGuard.planDir, ctx.cwd) : undefined,
     runDirAbs: process.env.PI_RUN_DIR ? resolveUserPath(process.env.PI_RUN_DIR, ctx.cwd) : undefined,
     allowCommands: activeGuard?.allowCommands,
     instructions: activeAgent?.instructions,
   });
   ```
   Никаких изменений в guard'е — только текст.

3. **`agents.json`**: убрать дублирование из `instructions` (строка «every other write is blocked…»
   остаётся только в блоке ограничений). У `architect` оставить план-каталог упоминанием «the plan
   directory from Runtime constraints».

## Зачем это экономит токены

- попытка `write` вне плана = 1 tool call + error result + ещё один ход на адаптацию (≈300–800 токенов);
- явный блок с абсолютным путём снимает и «попробую на всякий случай», и «а вдруг `.pi/plans` — это
  относительно чего-то другого»;
- цена блока — ~150–200 токенов системного промпта, один раз на запрос.

## Тесты

- юнит `buildAgentSection` (функция чистая, тестируется без pi):
  - read-only + planDir → есть строка с абсолютным путём плана, есть «READ-ONLY»;
  - read-only без planDir → «File writes (including plan files) are refused»;
  - подагент (`runDirAbs`) → строка про артефакты задачи;
  - не read-only → короткий блок, нет слова REFUSED;
  - `allowCommands` → они перечислены;
  - размер блока ≤ 700 символов.
- e2e: `pi --agent architect --mode json -p "…"` → в `<agent>` есть «READ-ONLY» и абсолютный `.pi/plans`;
  `pi --agent reviewer …` → «File writes (including plan files) are refused»;
  `PI_AGENT_DEPTH=1 pi --agent architect …` → есть строка про каталог run'а.
- регресс: e2e architect по-прежнему пишет план в `.pi/plans`, а `hacked.md` блокируется.

## Порядок применения

Вместе с handoff-тулом (`orchestrator-handoff.md`), т.к. оба правят `agents.ts` и `agents.json`:
1. `lib/plans.ts` + `lib/prompt.ts` (оба чистые, с юнит-тестами);
2. `agents.ts`: `orchestrator_execution` + guard + `agent_settled` + новый `before_agent_start`;
3. `orchestrator.ts`: `start_run({plan})`, пункт 7 в брифе;
4. `agents.json`: инструменты и инструкции;
5. юнит-тесты, e2e (handoff-позитив, depth-отказ, path-отказ, read-only контекст);
6. раздел 13 в `.pi/plans/orchestrator.md` с фактическим API.
