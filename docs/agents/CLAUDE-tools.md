# Справочник инструментов

Полный перечень инструментов доступных агентам. **Читать перед работой.**

## Правило выбора

```
MCP-инструмент подходит? → использовать MCP
Нет MCP, есть нативный (Read/Edit/Write)? → нативный
Только через shell? → Bash
```

Никогда не используй Bash там где есть подходящий MCP.

---

## Нативные инструменты Claude Code

| Инструмент | Когда использовать | Когда НЕ использовать |
|-----------|-------------------|-----------------------|
| `Read` | Читать конкретный файл целиком или диапазон строк | Поиск — есть ast-grep |
| `Edit` | Точечные правки в существующем файле | Полная перезапись — используй Write |
| `Write` | Создать новый файл или полная перезапись | Без предварительного Read существующего файла |
| `Bash` | `git`, `gh`, `pnpm`, `find`, текстовый `grep` — всё без MCP-аналога | Там где есть MCP |
| `Agent` | Параллельная или изолированная задача (Coder, Reviewer, AutoTest, DevOps) | Простые однофайловые задачи |
| `Skill` | Вызов superpowers-скилов: `superpowers:writing-plans`, `systematic-debugging` и т.д. | — |
| `TaskCreate/Update/List` | Планировать и отслеживать шаги в текущей сессии | Долгосрочное хранение — для этого есть memory |

### Agent — параметры запуска

```python
Agent(
    subagent_type="claude",          # тип: claude (общий)
    isolation="worktree",            # изолированный git worktree
    run_in_background=True,          # параллельно
    prompt="..."                     # задача должна быть самодостаточной
)
```

`isolation="worktree"` создаёт временный git worktree — агент работает в изолированной копии репо. Если изменений нет, worktree очищается автоматически.

---

## MCP серверы

### ast-grep — структурный поиск по AST

Синтаксический поиск: находит `function foo()`, `class Bar`, импорты, паттерны использования. **Не текстовый grep** — не промахивается по вариантам синтаксиса.

| Tool | Когда использовать |
|------|-------------------|
| `mcp__ast-grep__find_code` | Найти паттерн: функцию, класс, импорт, вызов метода |
| `mcp__ast-grep__find_code_by_rule` | Найти все вхождения для рефакторинга / проверки нарушений правил |
| `mcp__ast-grep__dump_syntax_tree` | Отладить паттерн — посмотреть AST-структуру файла |
| `mcp__ast-grep__test_match_code_rule` | Проверить что паттерн матчит нужный код |

**Использовать перед написанием нового кода** — найти существующий паттерн как образец.
**Использовать вместо grep** для TypeScript/TSX/JS файлов.

Примеры паттернов:
```
"console.log($$$)"           — найти все console.log
"@UseGuards($$$)"            — найти все Guards
"useQuery({ queryKey: $$$"   — найти TanStack Query вызовы
"any"                        — найти использования any
```

---

### postgres — прямой доступ к БД

| Tool | Когда использовать |
|------|-------------------|
| `mcp__postgres__query` | Проверить схему, данные, constraints, seed |

**Использовать вместо чтения `schema.ts`** — реальная БД авторитетнее файла.

Полезные запросы:
```sql
-- Структура таблицы
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'projects';

-- Все таблицы
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public';

-- Enum значения
SELECT unnest(enum_range(NULL::interview_stage));
```

---

### eslint — линтинг в реальном времени

| Tool | Когда использовать |
|------|-------------------|
| `mcp__eslint__lint-files` | После каждого Edit/Write на `.ts/.tsx` файлах |

**Вместо `pnpm lint`** — быстрее, не требует полной сборки.
Файлы передавать списком: `{"filePaths": ["apps/api/src/file.ts", "apps/web/app/file.tsx"]}`.

- **severity: error** → обязательно исправить до коммита
- **severity: warning** → исправить если быстро, иначе задокументировать

---

### context7 — актуальная документация

| Tool | Когда использовать |
|------|-------------------|
| `mcp__context7__resolve-library-id` | Получить ID библиотеки (первый шаг) |
| `mcp__context7__query-docs` | Получить документацию: API, конфигурация, паттерны, migration guides |

**Вместо угадывания API по памяти** — особенно для TanStack Router `validateSearch`, Zod v4, NestJS 11, Drizzle.

Используй для:
- Синтаксиса который мог измениться между версиями
- Конфигурации GitHub Actions (`actions/checkout@v4`, правильные параметры)
- API методов которые не помнишь точно

---

### playwright — браузерная автоматизация

| Tool | Когда использовать |
|------|-------------------|
| `mcp__playwright__browser_navigate` | Перейти на URL (localhost:3000, localhost:3001/api) |
| `mcp__playwright__browser_snapshot` | Получить DOM-снимок — **перед написанием селекторов** |
| `mcp__playwright__browser_take_screenshot` | Визуальная проверка UI после изменений |
| `mcp__playwright__browser_click` | Кликнуть элемент |
| `mcp__playwright__browser_fill_form` | Заполнить форму |
| `mcp__playwright__browser_type` | Ввести текст в поле |
| `mcp__playwright__browser_select_option` | Выбрать опцию в select |
| `mcp__playwright__browser_press_key` | Нажать клавишу (Enter, Escape, Tab...) |
| `mcp__playwright__browser_wait_for` | Ждать условие (элемент, URL, состояние) |
| `mcp__playwright__browser_evaluate` | Выполнить JS в контексте страницы |
| `mcp__playwright__browser_network_requests` | Инспектировать сетевые запросы |
| `mcp__playwright__browser_console_messages` | Читать console.log из браузера |
| `mcp__playwright__browser_tabs` | Управление вкладками |
| `mcp__playwright__browser_close` | Закрыть браузер |

**Обязателен:**
- После любых UI-изменений — сделать скриншот
- Перед написанием E2E селекторов — `browser_snapshot` чтобы увидеть реальный DOM

---

### github — GitHub API

| Tool | Когда использовать |
|------|-------------------|
| `mcp__github__get_pull_request` | Прочитать описание, заголовок, статус PR |
| `mcp__github__get_pull_request_files` | Список изменённых файлов |
| `mcp__github__get_pull_request_reviews` | Review-комментарии (APPROVE/REQUEST_CHANGES) |
| `mcp__github__get_pull_request_comments` | Inline комментарии к коду |
| `mcp__github__get_pull_request_status` | Статус CI-проверок (passed/failed/pending) |
| `mcp__github__list_pull_requests` | Список open PR; найти PR по ветке |
| `mcp__github__list_commits` | История коммитов в репо или PR |
| `mcp__github__create_pull_request` | Создать новый PR |
| `mcp__github__create_pull_request_review` | Оставить APPROVE / REQUEST_CHANGES |
| `mcp__github__add_issue_comment` | Добавить комментарий к PR или issue |
| `mcp__github__create_issue` | Создать issue |
| `mcp__github__update_issue` | Обновить issue: labels, state (open/closed), title |
| `mcp__github__get_issue` | Прочитать issue |
| `mcp__github__list_issues` | Список issues с фильтрами |
| `mcp__github__search_issues` | Поиск issues и PR по query |
| `mcp__github__merge_pull_request` | Замержить PR (только CI или явный запрос пользователя) |
| `mcp__github__create_branch` | Создать ветку |
| `mcp__github__search_code` | Поиск кода по репозиторию |
| `mcp__github__get_file_contents` | Прочитать файл из GitHub (не локальный) |
| `mcp__github__push_files` | Запушить файлы напрямую через API |
| `mcp__github__update_pull_request_branch` | Обновить ветку PR (rebase/merge base) |

**Использовать вместо Bash `gh` CLI** для операций с PR, issues, commits.

Bash `gh` использовать для: `gh pr edit --add-label`, `gh pr view`, `gh run view` (CI логи), нестандартных API вызовов через `gh api`.

---

## Superpowers Skills

Вызывать через `Skill` tool.

| Skill | Когда вызывать |
|-------|---------------|
| `superpowers:writing-plans` | Перед сложной задачей — структурировать план |
| `superpowers:test-driven-development` | Перед написанием кода — TDD подход |
| `superpowers:systematic-debugging` | При любом неожиданном поведении / падении |
| `superpowers:verification-before-completion` | Перед созданием PR — финальная проверка |
| `superpowers:security-review` | PR трогает auth/finance/transactions/wallets |
| `superpowers:simplify` | После написания кода — упростить |
| `superpowers:requesting-code-review` | Reviewer: начало каждого review |
| `frontend-design:frontend-design` | Новые страницы или сложные UI компоненты |
