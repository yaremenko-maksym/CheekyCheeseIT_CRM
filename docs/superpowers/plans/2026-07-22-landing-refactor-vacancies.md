# Landing Refactor + Vacancies — Implementation Plan

> **For agentic workers:** этот план исполняется через проектную агент-фабрику
> (Master диспатчит Coder/AutoTest/DevOps per task, `Agent(isolation=worktree)`,
> волны ≤ 3–4). Каждая задача ниже станет task-файлом `.claude/tasks/<slug>.md`
> при диспатче. Чекбоксы — для трекинга.

**Goal:** редизайн `apps/landing` до уровня топовых IT-студий + модуль вакансий
в CRM (ADMIN/HR) + публичный приём резюме (PDF → R2) с ретеншном.

**Spec:** `docs/superpowers/specs/2026-07-22-landing-refactor-design.md` (APPROVED).

**Architecture:** новый NestJS-модуль `vacancies` (2 таблицы, admin CRUD +
public read/apply), Zod-контракты в `@crm/shared`, лендинг читает same-origin
`/api` через Router-loader'ы, CRM-экраны для ADMIN/HR, cron-ретеншн, Turnstile
на публичной форме.

**Tech Stack:** NestJS 11 + Fastify + Drizzle · Zod v4 · React + Vite SPA +
TanStack Router · Tailwind v4 + shadcn/ui + Framer Motion · Playwright/Vitest.

## Global Constraints (из спеки и правил — действуют на КАЖДУЮ задачу)

- Version pins: `rules/common/version-pins.md` (Vite ^6.4, TanStack pair EXACT, Zod v4, Node 20).
- Лендинг — только английский; CRM-UI — консистентно с текущим языком сайдбара.
- Зарплатных полей НЕТ нигде (схема/DTO/UI).
- Отклики НЕ связаны с interviews-канбаном.
- Все API DTO через Zod `.parse()`, типы из `@crm/shared`.
- git-policy: explicit `git add`, `ac_verified:` в финальном коммите, `DATABASE_URL= git push`, никаких `--no-verify`.
- E2E локально перед push кода; eslint MCP + typecheck перед commit.
- Design-gate Tier 1: UI-задачи (C, D) НЕ стартуют без `docs/design/<slug>.md` + assets.
- Responsive hard-гейт: 320/375/768/1024/1280/1440/1920; тач-таргеты ≥ 44px.
- security-reviewer ОБЯЗАТЕЛЕН на PR задач A, B, C (public surface / RBAC / file upload).
- Прод-DDL — только через миграционный шаг deploy.yml (SSH нет).

---

## Файловая карта (кто что создаёт — zone-of-write, задачи не пересекаются по файлам)

| Задача         | Создаёт / правит                                                                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------- |
| A (api-core)   | `packages/shared/src/schemas/vacancies.ts` (+`index.ts` экспорт), `apps/api/src/database/schema.ts` (+2 таблицы, 5 enum'ов), `apps/api/drizzle/migrations/00XX_vacancies.sql` (db:generate), `apps/api/src/vacancies/vacancies.module.ts                                                                                               | service.ts | controller.ts`, spec-файлы модуля |
| B (api-public) | `apps/api/src/vacancies/public-vacancies.controller.ts`, `apps/api/src/vacancies/turnstile.service.ts`, `apps/api/src/vacancies/applications.service.ts`, `apps/api/src/vacancies/vacancies-retention.cron.ts`, `packages/shared/src/schemas/notifications.ts` (+1 enum-значение), env-схема api (+`TURNSTILE_SECRET_KEY`), spec-файлы |
| C (landing)    | `apps/landing/app/routes/index.tsx` (редизайн), `apps/landing/app/routes/careers/index.tsx`, `apps/landing/app/routes/careers/$slug.tsx`, `apps/landing/app/components/**` (секции, форма), `apps/landing/app/lib/api.ts`, `apps/landing/vite.config.ts` (dev-proxy), `apps/landing/app/__tests__/**`                                  |
| D (crm-ui)     | `apps/web/app/routes/vacancies/index.tsx`, `apps/web/app/routes/vacancies/$vacancyId.tsx`, `apps/web/app/components/vacancies/**`, сайдбар-конфиг (+пункт ADMIN/HR)                                                                                                                                                                    |
| E (e2e)        | `apps/e2e/tests/vacancies.spec.ts`, фикстуры                                                                                                                                                                                                                                                                                           |
| F (devops)     | `.github/workflows/deploy.yml` (migration-step), `apps/landing/Dockerfile` (+ARG `VITE_TURNSTILE_SITE_KEY`), `.env.example`, `docs/runbooks/deployment.md` (секреты)                                                                                                                                                                   |

Пересечение только B→A (тот же модуль) — поэтому A и B последовательны в одном
Coder-pipeline (одна ветка, stacked-коммиты, один PR).

---

## Контракты (single source — копируются в task-файлы дословно)

### Zod (`packages/shared/src/schemas/vacancies.ts`) — ключевые схемы

```ts
export const vacancyDomainSchema = z.enum(['AI', 'EDTECH', 'ECOMMERCE', 'OTHER'])
export const vacancySenioritySchema = z.enum(['SENIOR', 'LEAD'])
export const vacancyEmploymentTypeSchema = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT'])
export const vacancyStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'CLOSED'])
export const vacancyApplicationStatusSchema = z.enum(['NEW', 'VIEWED', 'REJECTED'])

export const publicVacancySchema = z.object({
  slug: z.string(),
  title: z.string(),
  domain: vacancyDomainSchema,
  seniority: vacancySenioritySchema,
  employmentType: vacancyEmploymentTypeSchema,
  location: z.string(),
  publishedAt: z.string(), // ISO
})
export const publicVacancyDetailSchema = publicVacancySchema.extend({
  descriptionMd: z.string(),
})

export const vacancySchema = publicVacancyDetailSchema.extend({
  id: z.uuid(),
  status: vacancyStatusSchema,
  publishedAt: z.string().nullable(), // override: admin видит и DRAFT
  closedAt: z.string().nullable(),
  applicationsCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const createVacancySchema = z.object({
  title: z.string().min(3).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(3)
    .max(80),
  descriptionMd: z.string().min(10).max(20_000),
  domain: vacancyDomainSchema,
  seniority: vacancySenioritySchema,
  employmentType: vacancyEmploymentTypeSchema,
  location: z.string().min(2).max(120),
})
export const updateVacancySchema = createVacancySchema
  .partial()
  .extend({ status: vacancyStatusSchema.optional() })

export const applyVacancyFieldsSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.email().max(254),
  telegram: z.string().max(120).optional(),
  linkedinUrl: z.url().startsWith('https://').max(300).optional(),
  githubUrl: z.url().startsWith('https://').max(300).optional(),
  coverLetter: z.string().max(2000).optional(),
  turnstileToken: z.string().min(1),
  website: z.string().max(0).optional(), // honeypot: непустое → silent drop
})

export const vacancyApplicationSchema = z.object({
  id: z.uuid(),
  vacancyId: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  telegram: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  coverLetter: z.string().nullable(),
  resumeSizeBytes: z.number().int(),
  status: vacancyApplicationStatusSchema,
  createdAt: z.string(),
})
```

### Endpoints (метод → guard → вход → выход)

| Endpoint                                                | Guard              | Вход                                                  | Выход                                             |
| ------------------------------------------------------- | ------------------ | ----------------------------------------------------- | ------------------------------------------------- |
| `GET /api/public/vacancies`                             | нет                | —                                                     | `publicVacancySchema[]`                           |
| `GET /api/public/vacancies/:slug`                       | нет                | slug                                                  | `publicVacancyDetailSchema`; 404 для не-PUBLISHED |
| `POST /api/public/vacancies/:slug/apply`                | нет (Turnstile+RL) | multipart: `applyVacancyFieldsSchema` + file `resume` | 201 `{ ok: true }`                                |
| `GET /api/vacancies`                                    | ADMIN,HR           | —                                                     | `vacancySchema[]`                                 |
| `POST /api/vacancies`                                   | ADMIN,HR           | `createVacancySchema`                                 | `vacancySchema`                                   |
| `PATCH /api/vacancies/:id`                              | ADMIN,HR           | `updateVacancySchema`                                 | `vacancySchema`                                   |
| `DELETE /api/vacancies/:id`                             | ADMIN,HR           | —                                                     | 204; 409 если не-DRAFT или есть отклики           |
| `GET /api/vacancies/:id/applications`                   | ADMIN,HR           | —                                                     | `vacancyApplicationSchema[]`                      |
| `PATCH /api/vacancies/:id/applications/:appId`          | ADMIN,HR           | `{ status }`                                          | `vacancyApplicationSchema`                        |
| `DELETE /api/vacancies/:id/applications/:appId`         | ADMIN,HR           | —                                                     | 204 (строка + R2)                                 |
| `GET /api/vacancies/:id/applications/:appId/resume-url` | ADMIN,HR           | —                                                     | `{ url, expiresAt }` (TTL 600с)                   |

### Статус-переходы вакансии (сервис энфорсит)

`DRAFT → PUBLISHED` (ставит publishedAt) · `PUBLISHED → CLOSED` (ставит closedAt) ·
`CLOSED → PUBLISHED` (re-open: обнуляет closedAt) · всё остальное → 409.

### R2-ключ резюме

`vacancy-applications/<vacancyId>/<applicationId>.pdf` (только ASCII — uuid'ы).

---

## Порядок исполнения (волны)

```
Phase 0 (владелец + оркестратор, БЛОКИРУЕТ C и D):
  0.1 Claude Design сессия: landing (все секции, 320/768/1024/1440, состояния)
  0.2 Claude Design: CRM-экраны вакансий (список + деталка с откликами)
  0.3 Владелец: Turnstile site key + secret → GH secrets (блокирует only F/прод)
  → артефакты docs/design/landing-redesign.md + docs/design/crm-vacancies.md + assets

Phase 1 (параллельно с Phase 0): Task A+B — один Coder, одна ветка feat/vacancies-api
  → PR#1: code-review + security-review + integration-тесты

Phase 2 (после Phase 0 и мержа PR#1; волна из 2):
  Task C — Coder: лендинг (feat/landing-redesign)
  Task D — Coder: CRM-экраны (feat/crm-vacancies-ui)
  → PR#2, PR#3: code-review + security-review(C) + manual-qa + fidelity Mode B

Phase 3 (после мержа PR#2/PR#3; волна из 2):
  Task E — AutoTest: E2E vacancies (test/vacancies-e2e)
  Task F — DevOps: deploy-wiring (infra/vacancies-deploy)
  → PR#4, PR#5 → финальный User Testing → merge-сигналы → деплой → прод-smoke
```

Модель агентов: A+B — sonnet (Drizzle-миграция простая, но finance не трогаем;
эскалация на opus по триггерам model-routing) · C, D — sonnet · E — sonnet ·
F — sonnet. Reviewer'ы — по своим frontmatter-тирам.

---

### Task A: Vacancies core (schemas + DB + admin CRUD)

**Files:** см. файловую карту. **Модель:** sonnet. **Design tier:** — (без UI).

**Produces (для B/C/D):** таблицы `vacancies`/`vacancy_applications`, все Zod-схемы
выше, `VacanciesService` c методами `list/create/update/delete/transition`,
admin-контроллер по таблице endpoints.

- [ ] Zod-схемы (код выше) + экспорт из `packages/shared/src/schemas/index.ts`; unit-спеки схем (валидные/невалидные кейсы: slug-regex, honeypot max(0), лимиты длин).
- [ ] Drizzle-схема: 2 таблицы + 5 pgEnum (`vacancy_domain`, `vacancy_seniority`, `vacancy_employment_type`, `vacancy_status`, `vacancy_application_status`) точно по спеке §3.1; `pnpm --filter @crm/api db:generate` → миграция.
- [ ] `VacanciesService`: CRUD + slug-уникальность (409 на дубль) + статус-переходы (таблица выше) + `applicationsCount` подзапросом + delete-гард (только DRAFT без откликов, иначе 409).
- [ ] `VacanciesController` (`@UseGuards(JwtGuard, RolesGuard)` + `@Roles('ADMIN','HR')` на классе) — все приватные endpoints.
- [ ] Unit-спеки сервиса: переходы (валидные 3 + невалидные → 409), delete-гард, slug-дубль.
- [ ] Integration-спека (реальная БД, паттерн существующих `*.integration.spec.ts`): RBAC-матрица — ADMIN 200, HR 200, SENIOR/JUNIOR/ACCOUNTANT/DROP 403 на каждый приватный endpoint.
- [ ] `mcp eslint` + `pnpm typecheck` + полный Vitest-прогон; commit `feat(api): vacancies core module` c `ac_verified:`.

### Task B: Public surface + apply pipeline + retention (тот же Coder, та же ветка)

**Consumes:** всё из A. **Produces (для C):** публичные endpoints по таблице.

- [ ] `TurnstileService.verify(token, ip): Promise<boolean>` — POST `https://challenges.cloudflare.com/turnstile/v0/siteverify`, secret из env `TURNSTILE_SECRET_KEY` (добавить в env-схему; в dev/test допустим CF dummy-secret `1x0000000000000000000000000000000AA`).
- [ ] `PublicVacanciesController`: list/detail (404 на не-PUBLISHED — без раскрытия существования) + `apply`.
- [ ] `ApplicationsService.apply` — конвейер строго по спеке §4 (порядок: RL → honeypot(201-мимикрия+лог) → Turnstile(400) → дубль email+vacancy 24ч(429) → размер ≤5MB(413) → magic-bytes PDF (`detectMimeFromBuffer`, 415) → `CompressionService.compressPdf` → DB-row-first + компенсация → R2 `vacancy-applications/<vacancyId>/<appId>.pdf` → нотификация всем ADMIN/HR).
- [ ] Rate-limit: жёсткий бакет на apply (~5/час/IP; конкретный механизм — существующий throttler API, паттерн RelaxableThrottle для E2E-relax), мягкий на публичные GET.
- [ ] `NotificationType` + `'VACANCY_APPLICATION'` в shared; emitter после успешного персиста (link на CRM-страницу вакансии).
- [ ] `VacanciesRetentionCron` (ежесуточно, паттерн salary-cron): REJECTED > 90д и отклики вакансий с closedAt > 90д → delete строка + `S3Service.delete`; лог количества; ошибки R2 не прерывают батч.
- [ ] `applications`-методы сервиса: list по вакансии, transition статуса, delete (строка+R2), resume-url (`S3Service.getPresignedDownloadUrl`, TTL 600с, `attachment`).
- [ ] Unit-спеки: каждая ветка отказа apply (7 шт.) + идемпотентность cron + граничные даты (89/90/91 день).
- [ ] Integration-спеки: публичный happy-path (реальная БД, файл-фикстура PDF), 404 DRAFT-slug, RBAC 403 на applications-endpoints, throttle-429.
- [ ] eslint + typecheck + Vitest + локальный E2E-прогон; финальный commit c `ac_verified:`; `DATABASE_URL= git push`; PR#1 «feat(api): vacancies module + public apply».

### Task C: Landing redesign (после Phase 0 + PR#1)

**Consumes:** публичные endpoints B; артефакт `docs/design/landing-redesign.md` + `design.png` (320+1440 минимум). **Design tier:** 1.

- [ ] `apps/landing/app/lib/api.ts`: `fetchVacancies()`, `fetchVacancy(slug)`, `submitApplication(slug, FormData)` — типизировано схемами shared, `.parse()` ответов.
- [ ] `vite.config.ts`: `server.proxy = { '/api': 'http://localhost:3001' }`.
- [ ] Секции `/` по дизайн-артефакту (Hero/About/Cases/Services/HowWeWork/Stack/CareersTeaser/Footer) — компонент на секцию в `app/components/sections/`; careers-тизер: loader → до 3 PUBLISHED, при 0 — mailto-CTA.
- [ ] Кейсы: контент-драфты (3–4, challenge→solution→metrics, EN) — в отдельном `app/content/case-studies.ts` для лёгкой правки владельцем.
- [ ] `/careers` + `/careers/:slug` (loader'ы, markdown-рендер с санитизацией, 404-состояние).
- [ ] Форма отклика: Zod-валидация на клиенте, Turnstile-виджет (site key из `import.meta.env.VITE_TURNSTILE_SITE_KEY`), honeypot-поле `website` (visually-hidden), success/error-состояния, disabled-submit во время отправки.
- [ ] Анимации по дизайн-артефакту; `prefers-reduced-motion` отключает декоративные циклы.
- [ ] SEO: per-route title/OG.
- [ ] Vitest-компонентные: форма (валид/невалид/успех/ошибка сети), careers-список (данные/пусто), тизер.
- [ ] Playwright-скрин-прогон тест-ширин 320–1920: нет горизонтального overflow, тач-таргеты ≥ 44px (скриншоты в PR).
- [ ] eslint + typecheck + тесты; PR#2 «feat(landing): redesign + careers + application form».

### Task D: CRM vacancies UI (после Phase 0 + PR#1; параллельно C)

**Consumes:** admin endpoints A/B; артефакт `docs/design/crm-vacancies.md`. **Design tier:** 1.

- [ ] Сайдбар: пункт «Вакансии» (язык — консистентно с текущими пунктами), видимость ADMIN|HR (существующий RBAC-механизм навигации).
- [ ] `/vacancies`: список (статус-бейджи, счётчик откликов, NEW-индикатор), создание (форма по `createVacancySchema`), publish/close/re-open действия с конфирмом.
- [ ] `/vacancies/:id`: редактирование + markdown-редактор (существующий lazy CodeMirror) + таб «Отклики»: карточки (контакты, cover letter, дата), скачивание CV (presigned, `window.open`), смена статуса, удаление с конфирм-диалогом.
- [ ] Роут-гард: не-ADMIN/HR → редирект на дашборд (паттерн существующих страниц).
- [ ] Vitest-компонентные: формы, статус-действия, гард.
- [ ] Playwright-прогон тест-ширин; eslint + typecheck + локальный E2E; PR#3 «feat(web): vacancies management screens».

### Task E: E2E (после мержа PR#2/PR#3)

- [ ] `apps/e2e/tests/vacancies.spec.ts`: ADMIN создаёт → publish → публичный apply через API-запрос (CF-тест-ключи always-pass) → HR видит отклик → VIEWED → REJECTED → delete; RBAC-смоук (SENIOR/DROP 403 на /api/vacancies); лендинг-флоу `/careers` (список → деталка → форма-валидация).
- [ ] Шардинг: добавить спеку в подходящий E2E-шард CI (allow-list guard #274 — обновить).
- [ ] 3× стабильный локальный прогон (zero-flaky policy); PR#4.

### Task F: Deploy wiring (параллельно E)

- [ ] `deploy.yml`: шаг применения новой миграции (паттерн Step 2b из #350 — идемпотентный DDL через `docker exec psql`; после применения — de-wire по нашему паттерну ИЛИ постоянный `drizzle-kit migrate`-шаг, решить по текущему состоянию deploy.yml).
- [ ] `apps/landing/Dockerfile`: `ARG VITE_TURNSTILE_SITE_KEY` + прокидка в build; deploy.yml передаёт из GH secret.
- [ ] api prod env: `TURNSTILE_SECRET_KEY`; `.env.example` — оба ключа + комментарий про CF dummy-ключи для dev.
- [ ] `docs/runbooks/deployment.md`: раздел «Turnstile secrets».
- [ ] PR#5; после мержа всех — прод-smoke: лендинг открывается, вакансии видны, тестовый отклик проходит и виден в CRM, файл скачивается.

---

## Гейты качества (на каждый PR)

code-reviewer (все) · security-reviewer (PR#1, PR#2, PR#3) · manual-qa на живом
стеке (PR#2, PR#3) · ui-ux-designer Mode B fidelity-diff на ВСЕХ тест-ширинах
(PR#2, PR#3) · все находки H/M/L резолвятся · User Testing владельцем →
явный merge-сигнал per PR → лейбл `merge-approved` при mss=CLEAN.

## Self-review плана

- Покрытие спеки: §2 → C; §3 → A+B; §4 → B; §5 → B(cron); §6 → D; §7 → тесты в A/B/C/D + E; §8 → F; §9 → структура волн. Гэпов нет.
- Контракты согласованы: имена схем/endpoints/ключей единые во всех задачах (источник — раздел «Контракты»).
- Owner-блокеры вынесены в Phase 0 и не блокируют Phase 1.
