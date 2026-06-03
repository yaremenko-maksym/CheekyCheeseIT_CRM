# task-fix-drop-archive-and-409

## Агент: coder

## Приоритет: critical

## Ветка: feat/drop-role-phase1 (PR #63)

## Зависит от: PR #63 (включая все предыдущие коммиты включая bugfix round 1)

## Контекст

Второй раунд Playwright user-testing выявил блокеры в логике архива drop-team и обработке 409 (duplicate email) на UI. Все фиксы — в ту же ветку.

## Acceptance Criteria

### 🚨 B1. Backend: DELETE /api/teams/:id поддержка drop-team

**Сейчас**: `DELETE /api/teams/:id` для team.type='DROP' возвращает 400 «Team has no active SENIOR — cannot archive via pair flow». Backend проверяет SENIOR без ветки для DROP.

- [ ] В `TeamsController.remove` (или соотв. endpoint в `apps/api/src/teams/teams.controller.ts`) добавить **диспатч по `team.type`**:
  - `team.type === 'DROP'` → вызвать существующий `TeamsService.archiveDropTeam(teamId, tx?)` (он уже написан, делает: cascade drop-проекты → CLOSED+archivedAt, синьор → leftAt **без архивации user**, HR/accountant → leftAt, team → archivedAt).
  - `team.type === 'SENIOR'` → текущая логика без изменений.
- [ ] Метод `archiveDropTeam` уже существует и протестирован (`teams.drop.spec.ts`) — нужно только вызвать из контроллера. **Не дублируй** логику.
- [ ] RBAC: ADMIN only (как и для senior-team archive — текущее поведение).

### 🚨 B2. Backend: getArchiveImpact для drop-team корректные поля

**Сейчас**: `GET /api/teams/:id/archive-impact` для drop-team возвращает `seniorName` (имя синьора), а должно отражать что paired сущность — это **дроп**.

- [ ] В методе `getArchiveImpact` (вероятно `TeamsService.getArchiveImpact` или контроллере) для `team.type === 'DROP'`:
  - Добавить поле `dropName: drop.displayName` (имя дропа, paired user).
  - Добавить поле `seniorWillBeDetached: boolean` (true если активный синьор есть).
  - Добавить поле `teamType: 'DROP' | 'SENIOR'`.
  - **Оставить** `seniorName` поле как **deprecated/legacy** (но для drop-team либо `null` либо имя отцепляющегося синьора с пометкой — на твоё усмотрение, главное чтобы frontend мог отличить).
- [ ] Для `team.type === 'SENIOR'` — оставить текущий response 1:1.
- [ ] Shared schema `archiveImpactSchema` (если есть) — расширить новыми полями optional, чтобы клиент сам обрабатывал.

### 🚨 B3. Frontend: текст диалога архива drop-team

**Сейчас**: текст диалога **скопирован из senior-team flow** — говорит «связанная пара: команда + синьор», «будут архивированы: профиль синьора», требует ввести имя синьора. Это семантически неправильно для drop-team.

- [ ] В `ArchiveConfirmDialog` (вероятно `apps/web/app/components/archive/ArchiveConfirmDialog.tsx` или соотв. компонент drop-team) реализовать ветку по `teamType`:
  - **Если `teamType === 'DROP'`**:
    - Заголовок: «Архивировать команду дропа»
    - Описание: «Команда **{teamName}** и её дроп **{dropName}** — связанная пара. При архивации будут архивированы: профиль **дропа**, команда (HR/бухгалтер будут отвязаны — N), и все его drop-проекты (M шт.). Активный синьор {seniorName ?? 'если есть'} **отцепится** от команды без архивации.»
    - Поле подтверждения: «Для подтверждения введите имя дропа: **{dropName}**» (вместо имени синьора).
  - **Если `teamType === 'SENIOR'`** (default) — текущая логика и тексты без изменений.
- [ ] Альтернатива (если ArchiveConfirmDialog универсальный для team+user): добавить пропс `pairedType: 'SENIOR' | 'DROP'` и переключаться по нему.

### ⚠️ B4. Frontend: обработка 409 (duplicate email) → toast

**Сейчас**: после submit drop creation с уже существующим email backend возвращает 409, но UI silent — dialog остаётся открытым, никакого error/toast.

- [ ] В success/error handler create-drop mutation (вероятно в `useCreateDrop` или внутри `UserDialog`):
  - При HTTP 409 показать `toast.error('Пользователь с таким email уже существует')`.
  - Dialog остаётся открытым (юзер может поправить email и сабмитнуть снова).
- [ ] Аналогично — для **create-senior** и **create-user** через тот же диалог. Используй единый обработчик ошибок.
- [ ] Для других HTTP кодов (400 → validation error, 500 → fallback) тоже показать дефолтный toast.error если нет специфичного.

### B5. UT покрытие

- [ ] Добавь UT на `TeamsController` или соотв. ветку: `DELETE /api/teams/:dropTeamId` для type='DROP' → 200 (через `archiveDropTeam`).
- [ ] Добавь UT на `getArchiveImpact` для type='DROP' → возвращает `teamType: 'DROP'`, `dropName`, `seniorWillBeDetached`.
- [ ] Текущие UT для senior-team archive — должны проходить без правок (regression).

### B6. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные.

### B7. Playwright проверка (через MCP)

Скриншоты до/после в `/tmp/drop-fix2-*.png`:

- [ ] Логин ADMIN → drop-team detail → клик «Архивировать» → диалог показывает **«дроп»** в тексте (не «синьор»), требует ввести имя дропа, submit → 200, drop-team archivedAt, drop archivedAt, синьор леftAt но не archivedAt.
- [ ] Попытка создать drop с дублирующим email → toast «Пользователь с таким email уже существует».

### B8. Push

- [ ] `git push origin feat/drop-role-phase1` (тот же PR #63).
- [ ] `gh pr comment 63` со списком фиксов и скриншотами.

## Что НЕ нужно

- Не менять архив SENIOR team flow (уже работает).
- Не менять архив DROP user через DELETE /api/users/:id (уже работает корректно).
- Не трогать другие фичи.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
