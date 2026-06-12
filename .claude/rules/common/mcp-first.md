# Rule: MCP-first tool priority

**Status:** Always-on
**Applies to:** All agents (PM, BA, Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus ECC-imported agents)
**Source:** Project hard requirement (CLAUDE.md "MCP серверы — ИСПОЛЬЗОВАТЬ В ПЕРВУЮ ОЧЕРЕДЬ") + Phase 2.5 activation of `eslint` MCP

---

## The rule

```
MCP-инструмент подходит? → использовать MCP
Нет MCP, есть нативный (Read/Edit/Write)? → нативный
Только через shell? → Bash
```

Никогда не используй Bash там, где есть подходящий MCP.

## MCP catalog (когда что)

| Задача                                                             | MCP / Tool                                                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Найти функцию / класс / импорт / паттерн в коде (AST)              | `mcp__ast-grep__find_code`, `find_code_by_rule`                                                                                                                         |
| «Как устроено X» / архитектура / blast-radius / call-sites символа | `mcp__codegraph__codegraph_explore` (PRIMARY, спрашивай ПЕРЕД правкой), `codegraph_callers`, `codegraph_search`, `codegraph_node` — pre-indexed граф, дешевле grep/Read |
| Проверить реальную схему БД / данные                               | `mcp__postgres__query` — вместо чтения `schema.ts`                                                                                                                      |
| Документация NestJS / TanStack / Zod / React / Drizzle             | `mcp__context7__resolve-library-id` → `query-docs`                                                                                                                      |
| Lint проверка на изменённых файлах                                 | `mcp__eslint__lint-files` — вместо ожидания pre-commit                                                                                                                  |
| UI проверка после изменений                                        | `mcp__playwright__browser_navigate` + `browser_snapshot` + `browser_take_screenshot`                                                                                    |
| Список изменённых файлов PR                                        | `mcp__github__get_pull_request_files`                                                                                                                                   |
| Описание / статус / labels PR                                      | `mcp__github__get_pull_request`, `get_pull_request_status`                                                                                                              |
| Reviews / inline-comments                                          | `mcp__github__get_pull_request_reviews`, `get_pull_request_comments`                                                                                                    |
| Создать review (APPROVE / COMMENT)                                 | `mcp__github__create_pull_request_review`                                                                                                                               |
| Labels на PR                                                       | Bash: `gh pr edit --add-label / --remove-label`                                                                                                                         |
| Cross-session wake-up (> 30 мин)                                   | `mcp__scheduled-tasks__create_scheduled_task`                                                                                                                           |

## Native tools (когда MCP не подходит)

| Tool    | Когда                                             | Когда НЕ                              |
| ------- | ------------------------------------------------- | ------------------------------------- |
| `Read`  | Конкретный файл целиком / диапазон строк          | Поиск (есть ast-grep)                 |
| `Edit`  | Точечные правки в существующем файле              | Полная перезапись (используй `Write`) |
| `Write` | Создать новый файл / полная перезапись            | Без `Read` существующего файла        |
| `Bash`  | `git`, `gh`, `pnpm`, операции без MCP             | Там где есть MCP                      |
| `Agent` | Параллельная / изолированная задача (PM → агенты) | Простые однофайловые задачи           |
| `Skill` | Вызов superpowers (см. `skills-invocation.md`)    | —                                     |

## Конкретные правила (mandatory)

- Перед написанием любого сервиса / хука / компонента → `ast-grep find_code` чтобы найти существующий аналог.
- Перед изменением существующего экспортируемого символа → `codegraph_callers <symbol>` / `codegraph_explore` для blast-radius (резолвит cross-file ссылки точнее grep). Архитектурный вопрос «как работает X» → `codegraph_explore` ПЕРЕД чтением файлов.
- Перед `pnpm --filter @crm/api db:generate` → `postgres query` для проверки текущей схемы.
- После каждого Edit / Write на `.ts` / `.tsx` → `eslint lint-files` вместо ожидания pre-commit хука. Подробности — `.claude/rules/common/eslint-mcp-first.md`.
- Для любого API NestJS / TanStack / Zod / Drizzle — сначала `context7`, не угадывать.
- Перед написанием `getByRole` / `getByText` (E2E) → `playwright browser_snapshot` чтобы увидеть реальный DOM.
- Для seed-данных в тестах (id, email, суммы) → `postgres query`, не хардкод.

## Связанные правила

- `.claude/rules/common/eslint-mcp-first.md` — детали ESLint MCP замены post-edit hook'а.
- Superpowers skills invocation — `.claude/rules/common/skills-invocation.md`.

## Источники

- CLAUDE.md "MCP серверы — ИСПОЛЬЗОВАТЬ В ПЕРВУЮ ОЧЕРЕДЬ"
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md`
- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` §2.7 (MCP configs)
