# Docs — Multi-Agent Development System

Эта папка — операционная база для всех AI-агентов и людей, работающих над CRM.

## Структура

```
docs/
├── business/           # Бизнес-логика, user flows, user stories
│   ├── overview.md     # Бизнес-модель и роли
│   ├── user-flows.md   # Диаграммы пользовательских потоков
│   ├── user-stories.md # User stories по всем модулям
│   └── modules/        # Детальная документация каждого модуля
├── specs/
│   ├── active-task.md  # ТЕКУЩАЯ задача для Coder-агента (1 файл в один момент)
│   └── archive/        # Выполненные задачи (перемещаются после merge)
├── test-cases/
│   └── e2e-scenarios.md # Сценарии E2E тестов (AutoTest-агент пишет тесты отсюда)
├── escalations/        # Баги/несостыковки, найденные QA после merge в main
└── agents/             # Системные промпты каждого агента
    ├── ../business/roles/ba.md  # Business Analyst (human role, moved out in Phase 6)
    ├── coder.md        # Coder
    ├── reviewer.md     # Code Reviewer
    ├── qa.md           # QA Manual Tester
    ├── devops.md       # DevOps
    └── autotest.md     # AutoTest
```

## Workflow агентов

```
Пользователь описывает фичу
        ↓
   BA-агент (локально)
   - задаёт вопросы
   - пишет docs/business/
   - создаёт .claude/briefs/active-task.md
        ↓
 ┌──────────────────────────────┐
 │ Coder-агент  │ AutoTest-агент│
 │ (ветка PR)   │ (тесты)       │
 └──────────────────────────────┘
        ↓ (PR открыт + label: ai-review-ready)
 ┌──────────────────────────────────┐
 │ Reviewer (GitHub Actions)        │
 │ QA Manual (GitHub Actions + app) │
 └──────────────────────────────────┘
        ↓ (оба APPROVE + status checks green)
   Auto-merge в main
```

## Как создать задачу для Coder-агента

1. Запустить BA-агента локально в Claude Code
2. BA пишет `.claude/briefs/active-task.md` по шаблону
3. Coder читает файл, создаёт ветку `feature/<slug>`, делает PR
4. Добавить label `ai-review-ready` → запустятся Reviewer + QA

## Как читать agent prompts

Каждый `.claude/agents/*.md` — это системный промпт для соответствующего агента.
Агент ВСЕГДА читает его первым перед любой работой.
