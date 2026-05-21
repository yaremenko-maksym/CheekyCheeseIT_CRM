# task-fix-e2e-profile-pr28

## Агент: autotest
## Приоритет: high
## Ветка: claude/youthful-hermann-8df1d5 (PR #28 — уже открыт)

## КРИТИЧЕСКИ ВАЖНО

- **Это fix-задача в существующую ветку:**
  ```bash
  git fetch origin
  git checkout claude/youthful-hermann-8df1d5
  git pull origin claude/youthful-hermann-8df1d5
  ```
- repo: `yaremenko-maksym/CheekyCheeseIT_CRM`
- Push в эту же ветку → PR #28 обновится автоматически.

## Что сломалось

После UI revisions (commits `a209dca`, `01ac2e8`, `43513eb`, `a4520f6`, `e01b3de`) E2E specs для профиля устарели. Полный лог: `gh run view 26188071671 --repo yaremenko-maksym/CheekyCheeseIT_CRM --log-failed`.

CI job `Typecheck · Lint · Unit Tests` зелёный. Только E2E падает.

## Падающие тесты и причины

### apps/e2e/tests/admin-actions.spec.ts

Все падают на:
```
> 25 | await expect(page.getByText('Junior Dev')).toBeVisible()
> 26 | await expect(page.getByRole('button', { name: /Действия/ })).toBeVisible()
> 31 | await expect(page.getByText('Junior Dev')).toBeVisible()
> 34 | await expect(page.getByText('✏️ Редактировать данные')).toBeVisible()
> 48 | await expect(page.getByText('Junior Dev')).toBeVisible()
> 70 | await expect(page.getByText('Junior Dev')).toBeVisible()
> 92 | await expect(page.getByText('Junior Dev')).toBeVisible()
TimeoutError: page.waitForRequest: Timeout 5000ms exceeded
```

**Причины:**
1. **Эмодзи убраны из action menu** (commit `a209dca`/`01ac2e8`) — заменены на lucide-react icons (Pencil, Shield, DollarSign, Wallet, и т.д.). Тесты ищут текст вида `✏️ Редактировать данные`, но в DOM только текст `Редактировать данные` (или новый русский label).
2. **mockAuthAs/mock fixtures** — fixture `Junior Dev` не отображается. Скорее всего mock response shape устарел после изменений: response теперь `{user, permissions, data}` а ProfileShell ждёт нового формата (поле `avatarOverride`, `salaryCurrency`, etc). Полное расследование через MCP `mcp__playwright__browser_navigate` + получение текущего mock response shape.

### Другие spec'ы

Аналогичные проблемы вероятно в:
- `apps/e2e/tests/profile-self-edit.spec.ts`
- `apps/e2e/tests/rbac-hr-on-senior.spec.ts`
- `apps/e2e/tests/rbac-junior-on-other.spec.ts`
- `apps/e2e/tests/requisites-warning.spec.ts`
- `apps/e2e/tests/profile.spec.ts` (если ещё существует — это legacy spec, должен быть удалён или переписан под новый shell)

Запусти `pnpm --filter @crm/e2e test` локально (НЕ полностью, либо с `--reporter=list`) и собери актуальный список failures.

## Что обновить

### 1. Action menu selectors

Старый: `getByText('✏️ Редактировать данные')`
Новый: `getByText('Редактировать данные')` или через `getByRole('menuitem', { name: 'Редактировать данные' })`

Полный список actions (см. `apps/web/app/components/user-profile/admin-actions/AdminActionsMenu.tsx`):
- Редактировать данные (Pencil)
- Изменить роль (Shield)
- Изменить зарплату (DollarSign)
- Изменить реквизиты (Wallet)
- Управление командой (Users)
- Переназначить проект (FolderInput)
- Заметка админа (StickyNote)
- Удалить пользователя (Archive)

### 2. Mock response shape

Endpoint `/users/me` и `/users/:id` теперь возвращают:
```ts
{
  user: UserProfileDto,        // с avatarOverride, salaryCurrency, paymentMethod, ...
  permissions: { tabs, actions, fields },
  data: { overview?: {...}, ... }
}
```

Старый shape (если был просто `{ id, displayName, ... }`) → обновить mocks.

См. `apps/web/app/hooks/use-user-profile.ts` (useMe, useUser) для актуального ожидаемого формата.

### 3. Tab names

Если тесты ищут tab `Собеседования` для SENIOR-self — этой tab больше нет (перемещена в кнопку "Доска собеседований" в header).
Если ищут tab `Проекты` для JUNIOR — теперь `Проект` (single).

### 4. KPI cards

Старый: 4 карточки всегда (Зарплата, Доля, Способ выплат, Регистрация).
Новый: условный рендер по `permissions.fields`. Для ADMIN-self все скрыты, для SENIOR без "Зарплата", для JUNIOR/HR/ACC без "Доля".

### 5. Avatar

Старый: `<AvatarImage src={user.avatar}>`
Новый: `<AvatarImage src={user.avatarOverride ?? user.avatar}>`. В моках вернуть `avatarOverride: null` чтобы fallback на avatar работал.

## Acceptance

- `pnpm --filter @crm/e2e test --reporter=list` — все passed
- CI на PR #28: job `E2E Tests` — зелёный
- Никаких изменений в production code (`apps/web/app/`, `apps/api/src/`) — только specs (`apps/e2e/tests/`) и моки.
- Если найдёшь устаревшие spec'ы которые невозможно/невыгодно обновить (например `profile.spec.ts` если он pre-shell legacy) — удали с коротким комментарием почему в commit message.

## После завершения

Commit-сообщение: `test(e2e): update profile specs after UI revisions — remove emoji selectors, new mock shape, conditional KPIs`

Дай короткий summary (≤200 слов):
- SHA коммита
- Сколько spec файлов обновлено
- Сколько тестов починено
- CI status (E2E job conclusion)
- Blockers

Используй MCP:
- ast-grep для поиска emoji/Junior Dev/getByText паттернов в specs
- context7 для Playwright docs если нужно
- eslint MCP для pre-check
