---
name: security-review
description: 'Project-local security-review для CRM: рецидивирующие классы утечек, которые generic OWASP-чеклист не ловит — NO-OP RolesGuard, RBAC в теле сервиса, denylist-маскировка, mocked-E2E поверх global guards, prod-DDL без SSH, токены в CI. DELTA поверх OWASP/secrets/npm-audit в security-reviewer.md — не дублирует их. Каждый паттерн подтверждён реальным инцидентом с номером PR.'
when_to_use: "Use when a PR touches auth / RBAC / finance / wallets / transactions / company-account, or when a Coder is about to write an endpoint or DTO on those paths. Examples: 'PR трогает finance — что проверить', 'добавляю поле в профиль, кто его увидит', 'новый junior-facing экран переиспользует DTO', 'endpoint за global guard', 'нужно применить DDL на проде', 'ревью CI/workflow с токенами'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__ast-grep__find_code
  - mcp__postgres__query
  - mcp__github__get_pull_request_files
---

# Security review — проектная дельта (CRM)

**Это НЕ замена** OWASP Top 10 / secrets-detection / npm audit — они уже расписаны
по шагам в `.claude/agents/security-reviewer.md` (Шаги 2-4). Здесь — только те
классы, на которых проект **реально горел**, и которые generic-чеклист пропускает.
У каждого паттерна указан инцидент: если сомневаешься, что это важно — открой его.

## When to invoke

- security-reviewer: на КАЖДОМ dispatch (PR трогает auth / finance / RBAC / wallets / transactions / company-account).
- Coder: ДО того как писать endpoint / DTO / маскировку на этих путях — дешевле, чем round-trip ревью.
- code-reviewer: только чтобы понять, нужен ли отдельный security-reviewer. Findings по этим классам — его зона, не твоя.

---

## Patterns

### 1. `RolesGuard` — NO-OP без `@Roles()`

`JwtAuthGuard` **глобальный** (`APP_GUARD` в `app.module.ts`) — каждый роут
аутентифицирован, если нет `@Public()`. А `RolesGuard` — opt-in и **ничего не
защищает сам по себе**: `@UseGuards(RolesGuard)` без `@Roles(...)` = пустышка.

Видишь `@UseGuards(RolesGuard)` — ищи рядом `@Roles(...)`. Нет его → роут открыт
всем аутентифицированным, независимо от того, как убедительно выглядит декоратор.

**Инцидент:** RBAC-sweep 21 контроллера (2026-06-10) — 3 кластера утечек: #159
(HR cross-team write-IDOR на projects create/update/addMember), #160 (HR видит
все зарплаты компании + IDOR в payout-request getById), #161 (over-projection в
`buildProfileView`).

### 2. RBAC живёт в теле сервиса — контроллер не показывает правду

Значительная часть авторизации в этом проекте — внутри методов сервиса
(`svc.method(user)`), а не в декораторах. **Судить об утечке по контроллеру
нельзя.** Открывай тело сервиса и смотри, что реально делает фильтрация по
`viewer`.

Практика ревью: для каждого затронутого эндпоинта — «кто смотрит → чьи данные
видит», явной строкой. Матрица ролей слишком сложна, чтобы держать её в голове:
пять ролей (`ADMIN`, `SENIOR`, `JUNIOR`, `HR`, `ACCOUNTANT`) плюс `DROP`-роутинг
поверх них.

### 3. Проекция — только allow-list, никогда denylist

Маскировка «перечислим, что скрыть» — игра в whack-a-mole, которая всегда
проигрывает при следующем добавлении поля.

**Инцидент:** junior-маскировка проектов (#164). Первый заход был denylist:
финансы скрыли, а **личность синьора и дропа — нет**. Поймали только
field-by-field аудитом + manual-qa. Итог: `mapProject(viewerRole==='JUNIOR')`
занулил `seniorId/seniorName/dropId/dropName/dropSharePercent/rate/currency/
seniorSharePercent*/paymentType/salaryReview/notesGeneral`, `members → []`,
`effectiveTeam → undefined` — последнее особенно: оно несло идентичности
senior/drop/HR/accountant **вместе с email**.

Правила, которые из этого следуют:

- `buildProfileView` (`apps/api/src/users/users.service.ts`) — explicit allow-list
  проекция. **Никогда не регрессировать в `{ ...target }`.**
- Новая чувствительная колонка в `User` гейтится в ДВУХ местах: в проекции
  **и** флагом в `getViewPermissions` (`realContacts` / `fopPii` / `adminNote` /
  `legalName`).
- Любая новая surface, переиспользующая management-DTO для менее привилегированного
  зрителя, маскируется allow-list'ом — и на пути списка (`findAll`), и на пути
  детали (`findOne`). Забыть один путь — типовая ошибка.

### 4. Mocked E2E ничего не знает про global guards

Mocked Playwright-спека возвращает то, что **ожидал разработчик**, а не то, что
отдаёт backend. Поэтому она структурно слепа к взаимодействию с глобальными
guard'ами.

**Инцидент (рецидив ×3, первый — PR #110, 2026-06-04):** `preview-rendered`
403'ился за глобальным `OnboardingGuard` (не был в bypass-list). Mocked E2E
замокала его как 200 и прошла **зелёной**. Оба ревьюера — code и security —
поставили APPROVE, потому что смотрели authz на уровне контроллера, а не
взаимодействие с глобальным guard'ом. Поймал только Manual QA на живом стеке.

Что требовать в ревью: для эндпоинта за global guard — **integration-спека против
реального guard-chain** (`*.integration.spec.ts`, реальная БД), проверяющая 200/403
без моков. Зелёная mocked-E2E — не доказательство.

Диагностический ход, если «в тестах работает, в браузере нет»: проверь `APP_GUARD`
в `app.module.ts` и bypass-list соответствующего guard'а.

### 5. Проверка = real-DB integration-тест на каждое чувствительное поле

Для любой маскировки/RBAC-правки требуй спеку, которая на реальной БД ассертит
**null у каждого** чувствительного поля для непривилегированного зрителя
(образец: `projects-junior-masking.rbac.integration.spec.ts`, кейсы MASK-1..10,
включая regression-guard на `effectiveTeam`).

Отсутствие такой спеки на PR с маскировкой — самостоятельная находка, а не
придирка: без неё следующее добавленное поле утечёт молча.

### 6. Прод-БД: DDL только через `deploy.yml`, SSH нет

У оркестратора **нет SSH к VPS** (ключ первого деплоя одноразовый). Единственный
путь к прод-БД — шаги manual-SQL в `deploy.yml`
(`psql -v ON_ERROR_STOP=1 < file`).

Отсюда два требования к ревью:

- Появился файл `apps/api/drizzle/manual/*.sql` — проверь, что он **завайрен** в
  `deploy.yml`. Дрейф этих двух зон уже ронял прод в 500
  (vacancy-i18n DDL, 2026-07-25); теперь есть CI-гард
  `scripts/devops/check-prod-ddl-wiring.py`, но гард проверяет факт ссылки, а не смысл.
- Разовый data-fix — идемпотентный и fail-loud (`RAISE` при verify ≠ ожидаемому),
  применяется один раз, потом шаг **снимается** из `deploy.yml` (де-вайринг).

### 7. CI / workflow — отдельная поверхность атаки

Проверять на PR, трогающих `.github/workflows/**`:

- **Недоверенный ввод в `run:`** — commit subject / PR title / branch name.
  Только через `env:` и `"$VAR"`, никогда прямой интерполяцией `${{ }}`.
- **Скоуп токена.** Дефолт репо — `read`, а job-level `permissions:` его
  **заменяет**, а не дополняет. `contents: write` в workflow с триггером
  `pull_request` = вектор self-merge: для веток этого репо исполняется версия
  workflow из merge-ref, то есть ветка может переписать собственное условие
  (инцидент 2026-06-21, #271; job `auto_merge` удалён по этой причине, #446).
- **Оживление триггера будит подписчиков.** Прежде чем чинить неработающий
  триггер — посмотри, кто ещё слушает это событие (`workflow_run`, `push`) и что
  он делает с правами (#446: post-merge CI разбудил watchdog, пушивший в main
  под owner-PAT).
- **Секрет: проверять валидность, а не наличие.** Протухший PAT — непустая
  строка; `[ -n "$PAT" ]` его примет, `gh` вернёт 401, `set -e` уронит скрипт —
  и алерт исчезнет в тишину.

---

## Anti-patterns

- **«Контроллер выглядит правильно» как основание для APPROVE.** См. паттерн 2 — читай сервис.
- **Ставить APPROVE, потому что mocked E2E зелёная** на PR с guard-поверхностью. См. паттерн 4: ровно так и прошёл #110.
- **Дублировать сюда OWASP-чеклист.** Он в `security-reviewer.md` Шаг 2. Этот файл — только про то, на чём горел ЭТОТ проект.
- **Трогать метку `merge-approved`.** Её ставит только PM/владелец по явному «мерджим» — независимо от вердикта (инцидент #271).

## References

- `.claude/agents/security-reviewer.md` — OWASP Top 10, secrets, npm audit, USDT-паттерны, формат вердикта.
- `.claude/rules/common/skills-invocation.md` — таблица триггеров (эта строка).
- `.claude/skills/code-review-discipline/SKILL.md` — как формулировать и постить вердикт.
- `.claude/agents/project-state.md` — актуальная RBAC-матрица и модель энфорсмента.
