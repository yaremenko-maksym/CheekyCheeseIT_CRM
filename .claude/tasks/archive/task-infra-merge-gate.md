# task-infra-merge-gate

## Агент: devops

## Приоритет: critical

## Ветка: infra/merge-gate

## Контекст

Текущий `.github/workflows/ci.yml` → job `auto_merge` мерджит PR на любом не-failure состоянии quality+e2e:

```yaml
if: github.event_name == 'pull_request' && needs.quality.result != 'failure' && needs.e2e.result != 'failure'
```

Это пропускает обязательный User Testing шаг (Mode 4 в pm.md) — что и произошло с PR #22. Нарушает правило «NEVER merge без явного подтверждения пользователя» из памяти PM.

Нужен явный лейбл-гейт.

## Конкретные изменения

### 1. Создать лейбл `merge-approved` в репо

```bash
gh label create "merge-approved" --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --color "0e8a16" \
  --description "PM получил явный апрув пользователя — CI может мерджить"
```

### 2. Изменить условие job `auto_merge` в `.github/workflows/ci.yml`

Заменить блок:

```yaml
auto_merge:
  name: Auto-Merge PR
  runs-on: ubuntu-latest
  needs: [quality, e2e]
  if: github.event_name == 'pull_request' && needs.quality.result != 'failure' && needs.e2e.result != 'failure'
```

На:

```yaml
auto_merge:
  name: Auto-Merge PR
  runs-on: ubuntu-latest
  needs: [quality, e2e]
  if: |
    github.event_name == 'pull_request' &&
    needs.quality.result == 'success' &&
    needs.e2e.result == 'success' &&
    contains(github.event.pull_request.labels.*.name, 'merge-approved') &&
    !contains(github.event.pull_request.labels.*.name, 'awaiting-pm-review')
```

Изменения:

- `!= 'failure'` → `== 'success'` — `skipped` теперь блокирует мердж
- Требуется лейбл `merge-approved`
- Запрещён лейбл `awaiting-pm-review` (страховка — если ещё ждёт PM, не мердж)

### 3. Обновить `docs/agents/pm.md` Mode 4 шаг "АПРУВ"

В блоке после подтверждения пользователя «мерджи» добавить:

```bash
gh pr edit <N> --repo yaremenko-maksym/CheekyCheeseIT_CRM \
  --add-label "merge-approved" \
  --remove-label "awaiting-pm-review"
```

Текст уведомления пользователя изменить с «CI запущен — после прохождения всех проверок PR будет смерджен автоматически» на:

```
✅ Метка merge-approved выставлена. CI выполнит typecheck + lint + tests + E2E.
Если все зелёные — squash-мердж. Иначе CI остановится и сообщит.
```

### 4. (Опционально, если время) — обновить branch protection

Через GitHub API/Settings: добавить `merge-approved` как required label для merge to main (если поддерживается). Это страховка на случай если кто-то попробует merge напрямую через UI.

## Acceptance criteria

- [ ] Лейбл `merge-approved` создан в репо
- [ ] `ci.yml` auto_merge job требует лейбл `merge-approved` И отсутствие `awaiting-pm-review`
- [ ] `ci.yml` auto_merge требует `success` обоих jobs (не просто `!= failure`)
- [ ] pm.md Mode 4 «АПРУВ» инструктирует добавлять лейбл `merge-approved`
- [ ] Тестовый прогон: PR без лейбла НЕ мерджится автоматически (можно проверить на drafte PR)

## Запрещено трогать

- Логика jobs `quality`, `e2e`, `notify_e2e` — только `auto_merge` и pm.md
- `docs/specs/pm-state.json` — не PM-задача
