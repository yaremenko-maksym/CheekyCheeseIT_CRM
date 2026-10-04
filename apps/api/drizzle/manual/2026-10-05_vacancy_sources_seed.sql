-- =============================================================================
-- Vacancy sourcing v1 — source catalogue seed (data; manual apply)
-- =============================================================================
--
-- Apply AFTER 2026-10-05_vacancy_sourcing_schema.sql: the new job_source_type
-- members and the min_interval_hours column must already exist (and a new enum
-- member cannot be used in the same transaction that adds it — hence two files).
--
-- EVERY row is seeded DISABLED (enabled = false). Nothing is collected until an
-- ADMIN switches a source on in the UI, and the collector for a type only exists
-- once its adapter ships — seeding a row is not the same as turning it on.
--
-- Idempotent: ON CONFLICT (type, config) DO NOTHING against
-- uq_job_sources_type_config, so a re-run (deploy.yml applies every manual file
-- on every deploy) neither duplicates rows nor re-disables a source an admin
-- already enabled.
--
-- Deliberately NOT seeded here (config needs a value that must be verified
-- against the live service first, so a guess would be worse than no row):
--   HIMALAYAS_API, JOBGETHER_API   — parameters come from the provider's OpenAPI;
--   GREENHOUSE/LEVER/ASHBY/WORKABLE/SMARTRECRUITERS/RECRUITEE/PERSONIO_ATS —
--                                    company slugs, each must return HTTP 200;
--   DJINNI_RSS, WWR_RSS            — primary keywords / categories to confirm;
--   *_HTML                         — added with their adapters (phase 3).
-- Later phases append rows to this same file (still ON CONFLICT DO NOTHING).
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-10-05_vacancy_sources_seed.sql

INSERT INTO job_sources (type, config, enabled, trigger_mode, budget_limit, budget_window, min_interval_hours)
VALUES
  ('REMOTEOK_API',      '{}'::jsonb,                                                                     false, 'SCHEDULED', NULL, NULL,    24),
  ('REMOTIVE_API',      '{"category":"software-dev"}'::jsonb,                                            false, 'SCHEDULED', NULL, NULL,    24),
  ('REMOTIVE_API',      '{"category":"devops"}'::jsonb,                                                  false, 'SCHEDULED', NULL, NULL,    24),
  ('REMOTIVE_API',      '{"category":"data"}'::jsonb,                                                    false, 'SCHEDULED', NULL, NULL,    24),
  ('JOBICY_API',        '{"count":100,"industry":"engineering","geo":"europe"}'::jsonb,                  false, 'SCHEDULED', NULL, NULL,    24),
  ('ARBEITNOW_API',     '{"maxPages":5}'::jsonb,                                                         false, 'SCHEDULED', NULL, NULL,    24),
  ('WORKINGNOMADS_API', '{"categories":["development"]}'::jsonb,                                         false, 'SCHEDULED', NULL, NULL,    24),
  ('HN_HIRING',         '{}'::jsonb,                                                                     false, 'SCHEDULED', NULL, NULL,    24),
  ('JOOBLE_API',        '{"keywords":"senior developer","location":"remote"}'::jsonb,                    false, 'SCHEDULED', 6,    'MONTH', 168),
  ('JSEARCH_API',       '{"query":"senior backend developer remote"}'::jsonb,                            false, 'SCHEDULED', 60,   'MONTH', 24),
  ('JSEARCH_API',       '{"query":"senior frontend developer remote"}'::jsonb,                           false, 'SCHEDULED', 60,   'MONTH', 24),
  ('JSEARCH_API',       '{"query":"senior ai engineer remote"}'::jsonb,                                  false, 'SCHEDULED', 60,   'MONTH', 24),
  ('THEIRSTACK_API',    '{"limit":25,"seniority":["senior"]}'::jsonb,                                    false, 'SCHEDULED', 8,    'MONTH', 96),
  ('MUSE_API',          '{"category":"Software Engineering","level":"Senior Level","maxPages":5}'::jsonb, false, 'SCHEDULED', NULL, NULL,    24),
  ('REED_API',          '{"keywords":"senior developer","locationName":"remote"}'::jsonb,                false, 'SCHEDULED', NULL, NULL,    24),
  ('EUREMOTEJOBS_RSS',  '{}'::jsonb,                                                                     false, 'SCHEDULED', NULL, NULL,    24)
ON CONFLICT (type, config) DO NOTHING;
