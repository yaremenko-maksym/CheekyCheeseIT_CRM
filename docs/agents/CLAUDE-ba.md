# BA — Agent Notes

## Бизнес-модель

**Cheeky Cheese IT** — компания обратного рекрутинга:
1. HR находит вакансии
2. SENIOR проходит интервью от имени компании
3. JUNIOR работает вместо SENIOR'а на проекте
4. SENIOR получает зарплату → платит 74% в смарт-контракт
5. JUNIOR получает фиксированную сумму, остаток 50/50 ADMIN + партнёр

## Роли и доступ

| Роль | Что может |
|------|-----------|
| ADMIN | Всё. Видит всех пользователей |
| SENIOR | Свои проекты, своя доска интервью, свои транзакции |
| JUNIOR | Проекты где активный member |
| HR | Свои команды, проекты своих синьоров, доски синьоров |
| ACCOUNTANT | Финансы всех синьоров, валидация транзакций |

## Структура документации

```
docs/
  business/
    overview.md          # бизнес-модель
    user-flows.md        # пользовательские потоки
    user-stories.md      # user stories
    modules/
      teams.md
      projects.md
      interviews.md
      finance.md
      profile.md
  specs/
    active-task.md       # текущее задание для Coder
    active-devops-task.md # текущее задание для DevOps
  test-cases/
    e2e-scenarios.md     # сценарии для AutoTest
  escalations/
    YYYY-MM-DD-*.md      # эскалации от QA
  agents/
    *.md                 # системные промпты агентов
    CLAUDE-*.md          # заметки агентов (этот файл)
```

## Текущий статус фаз

- ✅ PHASE 1: Layout (Sidebar + Header)
- ✅ PHASE 2: Команды (включая страницу детали команды с реальным счётчиком проектов)
- ✅ PHASE 3: Проекты
- ✅ PHASE 4: Интервью (Kanban)
- ✅ PHASE 5: Финансы (мониторинг)
- ✅ PHASE 7 (partial): Профили
- ⬜ PHASE 6: База знаний + Документы ← **СЛЕДУЮЩАЯ**
- ⬜ PHASE 7 (full): Профиль
- ⬜ PHASE 8: Смарт-контракти (USDT ERC-20)
- ⬜ PHASE 9: Дашборд

## CI/CD Pipeline (актуальный)

```
BA пишет docs/specs/active-task.md
  → gh workflow run coder.yml          # Coder реализует, открывает PR
  → gh workflow run ai-review.yml \
      -f pr_number=N                   # AutoTest → Reviewer → Merge
  → BA проверяет результат → обновляет CLAUDE.md
```

Workflows: `coder.yml` | `devops.yml` | `ai-review.yml` | `autotest.yml` | `ba-escalation.yml`

## Ключевые бизнес-ограничения

- Команды: макс 10, ACCOUNTANT добавляется автоматически
- JUNIOR в команде — производное от project_members, НЕ хранится в team_members
- ADMIN исключён из всех команд
- Один JUNIOR максимум на активный проект
- Finance флоу: `PENDING → VALIDATED → PENDING_PAYMENT → PAID / REJECTED`
- Файлы (документы, фото) — AWS S3 со сжатием (sharp для img, pdf-lib для PDF)
- Выплаты только через USDT ERC-20 (Ethereum mainnet)

## Триггер запуска AgentOps

После изменения `docs/business/**`:
```bash
gh workflow run autotest.yml --repo yaremenko-maksym/CheekyCheeseIT_CRM
```

После создания `docs/specs/active-task.md`:
```bash
gh workflow run coder.yml --repo yaremenko-maksym/CheekyCheeseIT_CRM
```

После создания `docs/specs/active-devops-task.md`:
```bash
gh workflow run devops.yml --repo yaremenko-maksym/CheekyCheeseIT_CRM
```
