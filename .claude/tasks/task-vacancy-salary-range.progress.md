# task-vacancy-salary-range — progress

current_milestone: 1/6
last_commit: (none yet)
last_push: (none yet)

## Milestones

1. packages/shared schema (vacancies.ts + vacancies.spec.ts) — module doc update, salary fields,
   VACANCY_SALARY_PERIODS/VACANCY_SALARY_CURRENCIES (LOCAL enum — do NOT import from
   payment-requisites.ts, see blast_radius note below).
2. apps/api DB schema.ts + manual DDL (idempotent, nullable columns).
3. apps/api VacanciesService (create/update/publish-gate) + mapping + unit/integration tests.
4. apps/landing: seo.ts baseSalary + seo.spec.ts, vacancy-domain.ts formatSalaryRange,
   VacancyCard + vacancy-detail-page-content, dictionary (5 locales), fixture updates in
   existing landing tests.
5. apps/web (CRM): VacancySalaryFields component, VacancyFormFields wiring, constants.ts
   (buildSalaryFieldsDto etc.), VacancySheet/$vacancyId prefill+dto, publish-gate on
   Опубликовать/Восстановить buttons (VacancyCard.tsx + $vacancyId.tsx), tests.
6. Full verification: typecheck, lint, unit (api+web+shared+landing filtered), landing
   Playwright E2E, Rich Results Test (real example), final commit + PR.

## blast_radius (call-sites of publicVacancySchema / vacancySchema / createVacancySchema / buildJobPostingJsonLd)

- apps/landing/app/lib/api.ts (`@crm/shared/public` — RUNTIME parse, narrow subpath —
  DO NOT import anything from packages/shared/src/schemas/payment-requisites.ts into
  vacancies.ts, would re-leak finance schemas into landing's Lighthouse-gated bundle,
  see project_landing_i18n_seo_2026_07_25 PR #421 RCA). Salary currency enum for vacancies
  MUST be declared locally in vacancies.ts (own literal array), not imported.
- apps/landing/app/lib/seo.ts buildJobPostingJsonLd — used by vacancy-detail-page-content.tsx
- apps/web/app/routes/\_authenticated/vacancies/\*\* (constants.ts, VacancyFormFields.tsx,
  VacancySheet.tsx, $vacancyId.tsx, VacancyCard.tsx) — createVacancySchema.shape.title/slug/
  descriptionMd + createVacancySchema.partial() used directly — confirmed via scratch Zod
  probe: refine() on createVacancySchema would break .partial() (throws) — do NOT add
  cross-field (max>=min) refine to createVacancySchema itself; enforce ordering via CRM field
  onBlur validator (closure over `form`) + service-level assertSalaryFilled (presence only).
- Existing tests needing salary-field fixture updates (found via isFallback/applicationsCount
  grep): apps/api/src/vacancies/{vacancies.integration,vacancies.service}.spec.ts;
  apps/landing/app/**tests**/{api,careers-list,careers-teaser,prerender-seo,seo}.spec.ts;
  apps/web/app/routes/\_authenticated/vacancies/**tests**/{VacancyCard,VacancySheet}.test.tsx;
  packages/shared/src/schemas/vacancies.spec.ts.

## Design decisions locked in

- DB: 4 nullable columns (salary_min/salary_max numeric(12,2), salary_currency reusing
  existing `currency` pg enum, salary_period NEW `vacancy_salary_period` pg enum
  HOUR/DAY/WEEK/MONTH/YEAR — matches Google unitText spec exactly, verified via
  developers.google.com/search/docs/appearance/structured-data/job-posting).
- Zod: createVacancySchema — 4 fields REQUIRED (no .default, no .nullable) → AC1 schema-level.
  updateVacancySchema (.partial()) → optional, omitted = no-op. Nullable READ shape
  (vacancySalaryFieldsSchema) on publicVacancySchema/vacancySchema for legacy rows (AC3).
- Service: assertSalaryFilled() called in create() (defense-in-depth) AND in update() ONLY
  when dto.status transitions to PUBLISHED (effective post-update value, dto overrides row) →
  AC2. Existing 3 prod PUBLISHED vacancies untouched (no forced re-validation on unrelated
  PATCHes) → AC3.
- JSON-LD: baseSalary omitted entirely when any of the 4 fields is null (AC3/AC4). currency
  mapped USDT→USD for the JSON-LD only (ISO 4217 requirement, USDT is 1:1 USD-pegged, not an
  ISO code) — page's visible text still shows the vacancy's actual selected currency unchanged.
