# Обновить direct_prompt во всех воркфлоу — читать агентские CLAUDE файлы

## Контекст

Каждый агент теперь имеет собственный файл с техническими заметками в `docs/agents/CLAUDE-<agent>.md`.
Это заменяет чтение монолитного `/CLAUDE.md` (~500 строк) — агенты читают только релевантное им.
Главный эффект: Code Review будет занимать ~3-4 мин вместо ~8 мин.

## Задача

Обновить `direct_prompt` в каждом воркфлоу — заменить инструкцию читать `CLAUDE.md` на чтение агентского файла.

### Что нужно изменить

**`.github/workflows/ai-review.yml`** — шаг `Claude Code Review` (reviewer job):
```
# Было:
Также прочитай .clauderules и CLAUDE.md (раздел "Ключевые технические заметки").

# Стало:
Також прочитай docs/agents/CLAUDE-reviewer.md — архитектурные решения и ограничения.
```

**`.github/workflows/ai-review.yml`** — шаг `Claude QA Manual Test` (qa job):
```
# Добавить в начало direct_prompt (после "Прочитай docs/agents/qa.md"):
Прочитай docs/agents/CLAUDE-qa.md — seed пользователи, порты, RBAC матрица.
```

**`.github/workflows/ai-review.yml`** — шаг `Claude AutoTest` (autotest job):
```
# Добавить в direct_prompt (после "Прочитай docs/agents/autotest.md"):
Прочитай docs/agents/CLAUDE-autotest.md — структура тестов, паттерны.
```

**`.github/workflows/coder.yml`** — шаг `Claude Coder Agent`:
```
# Добавить строку после "Прочитай docs/agents/coder.md":
Прочитай docs/agents/CLAUDE-coder.md — команды, структура, статус, gotchas.
```

**`.github/workflows/devops.yml`** — шаг `Claude DevOps Agent`:
```
# Добавить строку после "Прочитай docs/agents/devops.md":
Прочитай docs/agents/CLAUDE-devops.md — архитектура пайплайна, concurrency, secrets.
```

**`.github/workflows/autotest.yml`** — шаг `Claude AutoTest Agent`:
```
# Добавить строку после "Прочитай docs/agents/autotest.md":
Прочитай docs/agents/CLAUDE-autotest.md — структура тестов, паттерны, seed.
```

### Acceptance Criteria

- [ ] В `ai-review.yml` reviewer больше НЕ читает `/CLAUDE.md`
- [ ] В `ai-review.yml` все три Claude шага имеют ссылку на свой CLAUDE-*.md
- [ ] В `coder.yml` добавлена ссылка на `CLAUDE-coder.md`
- [ ] В `devops.yml` добавлена ссылка на `CLAUDE-devops.md`
- [ ] В `autotest.yml` добавлена ссылка на `CLAUDE-autotest.md`

## Файлы для изменения

- `.github/workflows/ai-review.yml`
- `.github/workflows/coder.yml`
- `.github/workflows/devops.yml`
- `.github/workflows/autotest.yml`
