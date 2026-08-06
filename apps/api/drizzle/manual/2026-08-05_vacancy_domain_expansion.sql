-- =============================================================================
-- Vacancy domains — widen `vacancy_domain` from 4 values to 17 (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-domains-expansion (owner request 2026-08-05): a vacancy could only be
-- posted in AI / EdTech / E-Commerce / Other. The owner asked for "самые
-- популярные домены в индустрии, около 15 доменов и опция «прочее»", so 13
-- values are appended here.
--
-- The dev/CI database gets these via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push, see `.github/workflows/ci.yml`). The prod image ships no
-- drizzle-kit, so prod is migrated with THIS script.
--
-- ORDER OF APPLICATION MATTERS: the API image that renders/accepts the new
-- values must NOT serve traffic before this runs. `POST /api/vacancies` with
-- e.g. `domain: "FINTECH"` against a prod type that lacks the value fails with
-- `invalid input value for enum vacancy_domain` (a 500), which is precisely
-- the incident class `scripts/devops/check-prod-ddl-wiring.py` exists to
-- prevent. Wiring this file into `.github/workflows/deploy.yml` ("Pull, up,
-- migrate, health-check") is DevOps' zone and ships in its own PR.
--
-- How to apply manually (VPS / any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-08-05_vacancy_domain_expansion.sql
--
-- Idempotency
-- -----------
-- Every statement is `ALTER TYPE … ADD VALUE IF NOT EXISTS`, so re-running the
-- whole file on an already-migrated database is a no-op (Postgres 12+ makes
-- `IF NOT EXISTS` a no-op, not an error). Re-running is expected: deploy.yml
-- applies its DDL list on EVERY deploy.
--
-- One statement per value, and NO wrapping transaction — deliberate:
--   * `ALTER TYPE … ADD VALUE` cannot run inside a transaction block that
--     later uses the new value, and historically could not run in one at all;
--     our psql invocation has no `--single-transaction`, so each statement
--     here is its own implicit transaction. Do not add BEGIN/COMMIT, and do
--     not fold these into a DO block (`ADD VALUE` is not allowed there).
--   * Values are NOT removable or renamable once rows reference them
--     (Postgres has no DROP VALUE) — see `VACANCY_DOMAINS` in
--     `packages/shared/src/schemas/vacancies.ts` for why these identifiers
--     were picked to outlive their display labels.
--
-- The original four values (`AI`, `EDTECH`, `ECOMMERCE`, `OTHER`) are created
-- by `2026-07-22_vacancies.sql` and are deliberately NOT repeated here —
-- existing vacancies already carry them.
--
-- Enum sort order after this script: the original four, then the 13 below in
-- statement order. `VACANCY_DOMAINS` (`@crm/shared`) and `vacancyDomainEnum`
-- (`apps/api/src/database/schema.ts`) list them in exactly that order;
-- `vacancy-domain-enum-consistency.spec.ts` fails the build if any of the
-- three sides drifts from the others.
-- =============================================================================

ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'FINTECH';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'IGAMING';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'ADULT';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'SAAS';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'HEALTHTECH';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'ADTECH';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'LOGISTICS';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'PROPTECH';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'TRAVEL';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'MEDIA';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'WEB3';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'HRTECH';
ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS 'CYBERSEC';
