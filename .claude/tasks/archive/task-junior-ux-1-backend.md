# task-junior-ux-1-backend — junior UX рефактор, фаза 1: довершение бэкенда

## Агент: coder

## branch: feature/junior-ux-backend (новая, от main)

## Контекст (выжимка одобренной спеки docs/architecture/2026-06-10-junior-ux-refactor-design.md, едет в PR #167)

Проекто-центричный реврейм UX джуна. Сквозные правила: джун видит ТОЛЬКО персону легенды
(никогда реального синьора/дропа, их контакты/профили); за персоной может стоять senior ИЛИ drop —
джуну ВСЕГДА показывается «синьор», слово «дроп» в junior-данных отсутствует; финансовая граница —
только свои SALARY-приходы.

УЖЕ СДЕЛАНО в #164 (НЕ переделывать): legends per-project (ключ projectId, ОДНА на проект,
субъект = project.dropId ?? seniorId), поля персоны + presented_role/presented_stack/backstory,
журнал legend_entries (append-only), эндпоинты GET/PUT /api/projects/:projectId/legend +
POST .../entries, RBAC легенды (ADMIN / HR-команды синьора / активный JUNIOR-член = view+edit;
субъект исключён), junior allowlist-маскировка mapProject (null на seniorId/seniorName/drop*/rate/
currency/share*/paymentType/salaryReview/notesGeneral; members→[]; effectiveTeam→undefined;
список И деталь), real-DB тесты MASK-1..10 + legend RBAC.

## Конкретные изменения (фаза 1 остаток)

1. **Персона-замена в junior-facing project DTO** (mapProject, список и деталь):
   для JUNIOR вместо голого null — подставить персону легенды проекта, если легенда существует:
   `seniorName = legend.fullName`, `seniorPresentedRole = legend.presentedRole` (поле/имена выбери
   консистентно c shared-схемой; типы из @crm/shared через Zod). Реальные seniorId / drop\* / контакты /
   фото ОСТАЮТСЯ null (НЕ реверсить allowlist #164 — обогащаем, а не открываем). Легенды нет → null как сейчас.
2. **Невидимость синьор↔синьор (backend side-fix из спеки §6):** `getViewPermissions` — сейчас
   `isSeniorViewingOwnProjectMember` пускает SENIOR смотреть НЕ-JUNIOR участников (других синьоров/дропов).
   Закрыть: senior видит только JUNIOR-участников своих проектов (и себя). ВНИМАНИЕ: buildProfileView
   allow-list не реверсить.
3. **Real-DB тесты** (рядом с существующими legend/masking тестами): junior получает в project DTO
   легенда-персону (имя+роль) и НЕ получает реальные идентичности; senior → профиль другого senior/drop
   своего проекта = 403; регрессия MASK-1..10 и legend RBAC зелёные.

## AC

1. JUNIOR в списке проектов и детали видит персону легенды (fullName + presentedRole) при её наличии; без легенды — null; реальные identity-поля null всегда. Real-DB тест.
2. SENIOR не может открыть профиль другого SENIOR/DROP своего проекта (403) — real-DB тест; ADMIN/HR поведение не изменилось (регрессия).
3. Все существующие MASK-1..10 + legend RBAC тесты зелёные без правок ослабления.
4. typecheck + unit + `pnpm --filter @crm/e2e test` локально зелёные перед push; финальный коммит `ac_verified: 1,2,3,4`.

## Зона

apps/api/\*\* (+ packages/shared при изменении DTO-схем). apps/web НЕ трогать (фазы 2-3 отдельно).
Если правишь shared-схему — проверь обратную совместимость не-junior клиентов (ADMIN/HR видят как раньше).

## Координация

Параллельно в ветке chore/pending-live-fixes (PR #167) другой Coder добавляет integration-тест
JUNIOR/findAll (transactions) — НЕ трогай transactions-спеки, чтобы не конфликтовать.
