# task-fix-pr34-user-testing-round6

## Агент: coder

## Приоритет: high

## Зависит от: PR 34 round 5 (commit 6f167a3)

## Ветка: feature/archive-views-teams-projects — push (не force)

## Fixes: User Testing PR 34 round 6 — 3 правки (ut-38, ut-39, ut-40)

## Контекст

После round 5 юзер тестирует и нашёл 3 правки:

### ut-38: Убрать «Восстановить» с archived project card

**Файл:** `apps/web/app/routes/crm/projects/index.tsx` (где рендерится archived ProjectCard, или отдельный `ArchivedProjectCard` если есть)

- Сейчас на каждой archived project card в списке отображается кнопка «Восстановить» (с иконкой). User screenshot (фото 1) показывает `[В архиве] Design Platform [Восстановить →]`
- Должно: убрать кнопку «Восстановить» из карточки в списке. Unarchive доступно **только на detail page** (clicking карточку → detail → header → «Восстановить» кнопка).
- **Consistent с ut-27** где trash был убран с project card.

### ut-39: Team page — apply same pattern as projects (ut-27 + ut-28)

**Files:**

- `apps/web/app/routes/crm/team/index.tsx` (list)
- `apps/web/app/routes/crm/team/$teamId.tsx` (detail)

#### Часть A (analog ut-27 для teams): убрать edit/delete с team card в списке

- Сейчас на team card в списке: `1 уч., 0 проекта, Pencil edit icon, Действия dropdown` (см. фото 3)
- Должно: убрать **Pencil** (edit icon) и любые destructive buttons из карточки
- Карточка должна быть просто clickable → ведёт на detail page

#### Часть B (analog ut-28 для teams): detail page header → explicit Archive/Unarchive

- Сейчас на team detail page header: `Добавить, Редактировать, Действия dropdown` (см. фото 4)
- «Действия» dropdown содержит archive/unarchive
- Должно: заменить «Действия» dropdown на **explicit button**:
  - Если team active → кнопка «**Архивировать**» (Archive icon, destructive variant)
  - Если team archived → кнопка «**Восстановить**» (ArchiveRestore icon, primary)
- «Редактировать» button оставить (это edit team metadata)
- «Добавить» (member) button оставить
- Никаких dropdown menus в header — все actions visible как кнопки

### ut-40: SENIOR не появляется в dropdown при создании проекта

**Bug:** user создал SENIOR "asd asd" через /crm/users. При создании нового проекта (ProjectDialog или ProjectCreateForm) — этот синьер не появляется в senior dropdown.

**Investigation steps:**

1. Найди код где рендерится senior dropdown в project create flow:
   - Likely в `apps/web/app/routes/crm/projects/...` (если есть Create form)
   - Или в `ProjectDialog` компонент
   - Или в /crm/users → "Создать проект" action если такой есть

2. Find query/filter: какой endpoint используется (`/api/users?role=SENIOR`?)

3. Backend: проверь `apps/api/src/users/users.service.ts` — какие фильтры по role=SENIOR

4. **Гипотезы:**
   - Frontend cache stale (TanStack Query не invalidate'нул `['users']` after senior create)
   - Backend filter: `archivedAt IS NULL` — corrent? OR filter уже только seniors с командой? OR filter excludes seniors без active project?
   - Может быть `team_members` join filter — newly-created SENIOR не в team_members yet (team_members записываются только для HR/ACC, не для самого SENIOR — see CLAUDE.md note about pair invariant)

5. **Fix depends на root cause:**
   - Если frontend cache → invalidate `['users']` query в useMutation onSuccess
   - Если backend filter — relax filter to include archivedAt IS NULL SENIORS regardless of team membership
   - Если frontend dropdown filter — fix the predicate

6. **Verify:** создай ещё одного SENIOR через UserDialog → открой ProjectDialog (create) → senior dropdown должен содержать нового

## Шаги

1. checkout feature/archive-views-teams-projects + git pull
2. ut-38: убрать Restore button с card
3. ut-39a: убрать Pencil с team card в списке
4. ut-39b: detail page header — explicit Archive/Unarchive button
5. ut-40: investigate + fix (root cause + verify)
6. Typecheck + unit tests
7. **Local E2E 1-worker** (правило юзера)
8. Commit + push (обычный, не force)
9. Отчёт PM-у

## Запреты

- НЕ ломай data-testid (E2E selectors)
- НЕ откатывай round 1-5 changes
- НЕ open new PR

## Commit

```
fix(archive-ui): User Testing PR 34 round 6 (ut-38, ut-39, ut-40)

- ut-38: remove «Восстановить» button from archived project cards in
         list. Unarchive accessible only via detail page header
         (consistent with ut-27 trash removal).
- ut-39a: remove Pencil edit icon from team cards in list (consistent
          with ut-27).
- ut-39b: team detail page header — «Действия» dropdown replaced
          with explicit «Архивировать» (active) or «Восстановить»
          (archived) button. «Редактировать» + «Добавить» buttons
          retained.
- ut-40: [root cause + fix description, e.g. invalidate ['users']
         query in adminCreateUser onSuccess so newly created SENIORs
         appear in project-create dropdown].

ac_verified: 1,2,3,4
addresses: User Testing PR 34 round 6
```

## Acceptance criteria

- [ ] ut-38: Восстановить button удалена с archived project card в списке
- [ ] ut-39a: Pencil edit icon удалён с team card
- [ ] ut-39b: team detail header — explicit Archive/Unarchive button (no dropdown)
- [ ] ut-40: newly created SENIOR появляется в project create dropdown immediately
- [ ] Typecheck + unit + local E2E зелёные
- [ ] CI зелёный после push
