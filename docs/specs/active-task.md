# Рефактор страницы Команды — Team Page Refactor

## Что делать

Реализовать полный рефактор страниц `/crm/team` (список) и `/crm/team/:id` (детальная).  
Полный план с кодом по каждому шагу: **`docs/superpowers/plans/2026-05-17-team-page-refactor.md`**  
Дизайн-спека: **`docs/superpowers/specs/2026-05-17-team-page-refactor-design.md`**

Следуй плану task-by-task. Не пропускай тесты.

---

## Branch

```
feat/team-page-refactor
```

---

## Acceptance Criteria (обязательно проверить перед PR)

- [ ] `pnpm typecheck` — 0 ошибок
- [ ] `pnpm lint` — 0 ошибок (предупреждения допустимы)
- [ ] `pnpm test` — все тесты проходят
- [ ] SENIOR/JUNIOR при открытии `/crm/team` → редирект на `/crm/team/:id`
- [ ] JUNIOR на detail-странице не видит других JUNIOR
- [ ] JUNIOR не видит дату создания и Telegram-ссылку
- [ ] Кнопка "+ Добавить участника" на detail-странице открывает диалог и добавляет
- [ ] Кнопка [✕] на участнике открывает подтверждение и удаляет
- [ ] "Редактировать" открывает диалог с полями Название + Telegram URL
- [ ] PATCH /api/teams/:id сохраняет `telegramGroupUrl`
- [ ] Карточки на list-странице кликабельны, нет inline-кнопок Edit/AddMember
- [ ] ADMIN видит кнопку Delete на list-карточке
- [ ] Дублирование ROLE_LABELS/ROLE_VARIANT/getInitials устранено (один файл)
- [ ] index.tsx < 250 строк, $teamId.tsx < 200 строк

---

## Файлы которые затронет задача

### Новые файлы
```
apps/web/app/lib/team-constants.ts
apps/web/app/routes/crm/team/components/TeamCard.tsx
apps/web/app/routes/crm/team/components/MemberRow.tsx
apps/web/app/routes/crm/team/components/CreateSeniorDialog.tsx
apps/web/app/routes/crm/team/components/AddMemberDialog.tsx
apps/web/app/routes/crm/team/components/EditTeamDialog.tsx
apps/web/app/routes/crm/team/components/DeleteTeamDialog.tsx
apps/api/drizzle/migrations/0012_*.sql
```

### Изменённые файлы
```
apps/web/app/routes/crm/team/index.tsx
apps/web/app/routes/crm/team/$teamId.tsx
packages/shared/src/schemas/teams.ts
packages/shared/src/schemas/teams.spec.ts
apps/api/src/database/schema.ts
apps/api/src/teams/teams.service.ts
apps/api/src/teams/teams.service.spec.ts
apps/api/src/teams/teams.controller.ts
```

---

## Важные технические детали

- **Миграция**: `pnpm --filter @crm/api drizzle-kit generate` после правки schema.ts, потом `drizzle-kit migrate`
- **JUNIOR**: фильтрация на фронте (`user.role === 'JUNIOR'`). Серверная фильтрация других JUNIOR уже реализована в `mapTeam()`
- **canRemoveMember**: нельзя удалять SENIOR (только через удаление команды), последнего HR, последнего ACCOUNTANT, любого JUNIOR
- **EditTeamDialog**: синхронизировать поля через `useEffect([team?.id])`, НЕ в render-функции
- **CreateSeniorDialog**: не использовать Avatar/AvatarFallback/AvatarImage/getInitials (их там нет)
- **index.tsx**: файл `apps/web/app/routes/crm/team/index.tsx` уже существует (новый, пустой) — это он, не удалять
- **Удалить**: `apps/web/app/routes/crm/team.tsx` (перемещён в `team/index.tsx` в PR #11 — проверь git status)

---

## После реализации

1. `pnpm typecheck && pnpm lint && pnpm test` — всё зелёное
2. Создай PR с label `ai-review-ready`
