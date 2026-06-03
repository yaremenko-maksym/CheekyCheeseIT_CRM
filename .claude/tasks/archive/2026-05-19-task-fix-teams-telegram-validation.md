# task-fix-teams-telegram-validation

## Агент: coder

## Приоритет: high

## Ветка: feature/teams-redesign

## Контекст

Поле Telegram в диалоге редактирования команды не валидирует что введённое значение
является корректной ссылкой на Telegram. Нужно добавить валидацию на обоих уровнях:
shared schema (backend + frontend) и в UI форме с отображением ошибки.

## Конкретные изменения

### 1. `packages/shared/src/schemas/teams.ts`

В `updateTeamSchema` заменить:

```typescript
telegram: z.string().max(500).nullable().optional(),
```

На:

```typescript
telegram: z
  .string()
  .max(500)
  .refine(
    (val) => !val || val.startsWith('https://t.me/'),
    'Ссылка должна начинаться с https://t.me/',
  )
  .nullable()
  .optional(),
```

### 2. `apps/web/app/routes/crm/team/$teamId.tsx`

В форме `editForm` (TanStack Form) для поля `telegram` — добавить отображение ошибки валидации под инпутом. Найти блок `<editForm.Field name="telegram">` и добавить после `<Input .../>`:

```typescript
{field.state.meta.errors[0] && (
  <p className="text-xs text-destructive">{String(field.state.meta.errors[0])}</p>
)}
```

Аналогично полю `name` которое уже показывает ошибку.

## Acceptance criteria

- [ ] Если в поле Telegram ввести произвольный текст (не `https://t.me/...`) — под полем появляется сообщение "Ссылка должна начинаться с https://t.me/"
- [ ] Если поле пустое — ошибки нет (поле опциональное)
- [ ] Если введено `https://t.me/team_chat` — ошибки нет, форма сохраняется
- [ ] Backend тоже отклоняет невалидный telegram через Zod parse в контроллере
- [ ] TypeCheck `pnpm --filter @crm/shared typecheck` и `pnpm --filter @crm/web typecheck` — 0 errors
- [ ] Unit-тесты в `packages/shared/src/schemas/teams.spec.ts` — добавить кейсы для telegram валидации
- [ ] Commit `fix(teams): add telegram URL validation in updateTeamSchema`

## Запрещено трогать

- Любые файлы кроме `packages/shared/src/schemas/teams.ts`, `packages/shared/src/schemas/teams.spec.ts`, `apps/web/app/routes/crm/team/$teamId.tsx`
