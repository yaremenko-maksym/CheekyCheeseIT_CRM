# task-fix-drop-bugs-after-testing

## Агент: coder

## Приоритет: critical

## Ветка: feat/drop-role-phase1 (продолжение PR #63)

## Зависит от: PR #63 (включая все предыдущие коммиты)

## Контекст

Playwright user-testing на PR #63 выявил **критичные security баги и UX баги**. Все фиксы в эту же ветку.

## Acceptance Criteria

### 🚨 КРИТИЧНЫЕ (security / data leak)

#### AC1. Backend: DROP видит ТОЛЬКО свои транзакции

**Сейчас**: `GET /api/transactions` для DROP возвращает все транзакции (admin приходы, синьор приходы, расходы). Это data leak.

- [ ] В `apps/api/src/finance/transactions.service.ts` (или `transactions.controller.ts`) в `findAll`/visibility логике добавить ветку для роли DROP:
  - DROP видит только транзакции с `seniorId = caller.id` (т.е. где он сам является «инициатором прихода»). По спеку в Phase 1 у дропа ещё нет своих транзакций — список ДОЛЖЕН быть пустой. Phase 2 добавит распределение, тогда transactions будут привязываться к dropId/seniorId.
  - Не показывать чужие admin/senior транзакции, расходы, payouts, junior payments.
- [ ] Аналогично для `expenses`, `payouts`, `junior_payments`, `invoices` — DROP **не видит** их в Phase 1 (пустые списки или 403).
- [ ] **НЕ менять** visibility для ADMIN/ACCOUNTANT/SENIOR/HR/JUNIOR — текущая логика 1:1.

#### AC2. Backend: DROP не имеет доступа к /api/interviews

**Сейчас**: DROP может GET `/api/interviews` и получить полный список.

- [ ] В `InterviewsController` (или соответствующем guard'е) добавить отказ для роли DROP — 403 для всех методов.
- [ ] Аналогично для всех `/api/interviews/*` endpoint'ов.

#### AC3. Backend: DROP не имеет доступа к /api/users (список других)

**Сейчас**: DROP может GET `/api/users` (возможно фильтрованный, но UI рендерит). По спеку DROP не имеет «Пользователи» в sidebar — backend должен 403.

- [ ] `UsersController.findAll` (`/api/users`) — для DROP вернуть 403.
- [ ] Существующие endpoint'ы вроде `/api/auth/me`, `/api/users/me/*`, `/api/users/:id` (просмотр чужого профиля) — оставить как было.

#### AC4. Frontend: route-guard для /crm/interviews, /crm/users, /crm/projects (для /projects уже работает но проверь), /crm/documents, /crm/stats, /crm/dashboard

**Сейчас**: DROP может пройти на `/crm/interviews` и `/crm/users` через прямой URL.

- [ ] Проверить через ast-grep: `useRoleGuard` на всех роутах `/crm/*` (кроме profile/team/finance/team/$id).
  - `/crm/interviews/*` — guard должен НЕ включать DROP.
  - `/crm/users` — guard должен НЕ включать DROP.
  - `/crm/documents` — guard должен НЕ включать DROP.
  - `/crm/stats` — guard должен НЕ включать DROP.
  - `/crm/dashboard` — guard должен НЕ включать DROP, плюс отдельная логика «redirect DROP → /crm/profile».
  - `/crm/projects/*` — уже работает (редирект), но подтверди.
- [ ] **Не менять** guard'ы для других ролей — только DROP добавляется/убирается из массивов.

#### AC5. Frontend: `/crm` (root) для DROP → redirect на /crm/profile

**Сейчас**: открыв `/crm` DROP видит Dashboard placeholder.

- [ ] В `apps/web/app/routes/crm/index.tsx` (или соотв. root route) для роли DROP — redirect на `/crm/profile`.
- [ ] Для остальных ролей — текущий редирект (видимо на `/crm/dashboard` или показ dashboard) — без изменений.

### ⚠️ ВАЖНЫЕ UX

#### AC6. Слайдер «Доля дропа» — корректные тексты

**Сейчас**: слайдер использует тексты из формы синьора: «95% компания», «5% синьор», `aria-label="Доля синьора"`.

- [ ] В компоненте share-slider (вероятно `apps/web/app/components/users/share-slider.tsx` или вызов в `UserDialog`) — при `role==='DROP'`:
  - Левая метка: «X% компания» (X = 100 - value)
  - Правая метка: **«Y% дропу»** (Y = value)
  - `aria-label="Доля дропа в процентах"` или аналогичный для DROP
  - Подсказка/hint: оставить «Сколько дроп оставляет себе с каждой выплаты» (как сейчас, ОК)
- [ ] При `role==='SENIOR'` — оставить текущие тексты без изменений.

#### AC7. Submit без HR — явная обратная связь

**Сейчас**: при submit без HR диалог тихо остаётся открытым, никакого toast или inline error.

- [ ] В `UserDialog` при роли DROP и empty `hrIds` (или общая Zod-валидация формы):
  - Показать **inline error** под секцией «HR\*»: «Выберите минимум одного HR».
  - Дополнительно — короткий toast «Заполните обязательные поля» (если submit не прошёл по любой причине).
- [ ] Аналогичная inline валидация для всех `*` обязательных полей (email/имя/реквизиты/HR) — если они уже работают, не трогать; если молча — добавить.

#### AC8. Toast «Дроп создан» отображается после успеха

**Сейчас**: после успешного submit drop'а toast не виден (вероятно очень короткий timeout или удалён).

- [ ] В success-handler create-drop mutation вызвать `toast.success('Дроп создан')` с дефолтным timeout (4-5 сек).
- [ ] Аналогично для senior с teamMode=JOIN_DROP_TEAM: «Синьор добавлен в команду дропа».
- [ ] Existing toast «Пользователь создан» для других ролей — без изменений.

### AC9. Локальная проверка

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные. **Особое внимание к финансовым unit-тестам** — добавь UT на «DROP transactions visibility = empty / own only».

### AC10. Playwright проверка (через playwright MCP)

Скриншоты до/после в `/tmp/drop-bugs-fix-*.png`:

- [ ] Логин как DROP → /crm — редирект на /profile.
- [ ] DROP → /crm/finance → пустой список (или только свои).
- [ ] DROP → /crm/interviews → редирект на /profile.
- [ ] DROP → /crm/users → редирект на /profile.
- [ ] DROP → /crm/team → видит свою команду (работает как раньше).
- [ ] Создание дропа в форме: slider показывает «X% компания / Y% дропу», `aria-label` корректный.
- [ ] Submit DROP без HR → inline error «Выберите минимум одного HR».
- [ ] Submit DROP с HR → toast «Дроп создан» виден.

### AC11. Push

- [ ] `git push origin feat/drop-role-phase1` (тот же PR #63).
- [ ] `gh pr comment 63` со списком фиксов и скриншотами.
- [ ] Возвращайся с подтверждением что все 11 AC закрыты.

## Что НЕ нужно

- Любые изменения вне backend RBAC, route guards, slider текстов, toast, validation.
- Не трогать существующие финансы для других ролей.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
