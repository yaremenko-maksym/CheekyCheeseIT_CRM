---
name: pm-dispatching
description: Use when PM needs to dispatch an agent (Coder/AutoTest/Reviewer/DevOps) or run PR/CI/User-Testing commands. Loads on-demand snippets from .claude/agents/pm-snippets.md instead of keeping them in PM system prompt.
when_to_use: "Use when PM dispatches any agent (Coder, AutoTest, code-reviewer, security-reviewer, DevOps) or runs PR / CI / User-Testing operations and needs the ready Agent() / gh / E2E snippets. Examples: 'диспетчу Coder', 'запусти AutoTest', 'нужен сниппет для PR review', 'старт User Testing', 'pm-state schema'."
allowed-tools:
  - Read
  - Bash(gh:*)
  - Bash(git:*)
---

# PM Dispatching — Loading Snippets

Этот skill вызывается PM-агентом когда нужен готовый сниппет для:

- Диспетча агента (Coder / AutoTest / Reviewer / DevOps)
- Проверки PR / CI / лейблов
- Подготовки окружения User Testing
- Запуска E2E GHA workflow

## Использование

Прочитай файл `.claude/agents/pm-snippets.md` целиком и используй секцию которая подходит к текущей задаче:

| Задача PM                                               | Секция snippets                           |
| ------------------------------------------------------- | ----------------------------------------- |
| Запустить нового Coder на task                          | "Coder — новая фича"                      |
| Запустить Coder на fix в существующую ветку             | "Coder — фикс в существующую ветку"       |
| Запустить Reviewer после Coder                          | "Reviewer — code review"                  |
| Запустить AutoTest для post-approval тестов             | "AutoTest — post-approval тесты"          |
| Параллельный запуск нескольких агентов                  | "Параллельный запуск"                     |
| Найти PR по ветке                                       | "PR и CI команды"                         |
| Проверить статус CI                                     | "PR и CI команды" → "Статус CI на PR"     |
| Управлять лейблами (merge-approved, awaiting-pm-review) | "PR и CI команды" → "Управление лейблами" |
| User Testing подготовка                                 | "User Testing подготовка окружения"       |
| Запустить E2E через GHA                                 | "E2E запуск"                              |
| Проверить что AutoTest не no-op                         | "Workflow lookups"                        |

## Принцип

Снippets не лежат в системном промпте PM постоянно — это экономит контекст. PM вызывает этот skill когда уже знает что хочет диспетчить, и получает точный шаблон.

После использования сниппета — подставь конкретные значения (`<slug>`, `<N>`, `<pr_branch>`) и выполни.
