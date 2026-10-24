-- =============================================================================
-- Vacancy sourcing - manifest forward delta (r5 Task 3.7, correction C-16)
-- =============================================================================
--
-- GENERATED from apps/api/src/job-sourcing/providers/manifest.definitions.ts and the
-- fixtures' provenance. DO NOT EDIT BY HAND: `pnpm --filter @crm/api job-sources:manifest:generate` rewrites it, and
-- manifest.drift.spec.ts fails when this file differs from what the generator produces.
--
-- APPLY ORDER (load-bearing). Apply AFTER 2026-10-17_job_opportunities_store.sql: that migration ADDS
-- job_sources.manifest_id, namespace, config_version, readiness and readiness_reason, which this file
-- writes, and it runs AFTER 2026-10-05_vacancy_sources_seed.sql in scripts/devops/deploy-stack-on-vps.sh
-- (the real apply order; deploy.yml only copies the files). Placed straight after the 2026-10-05 seed
-- it dies on: column "manifest_id" does not exist. It also claims the rows that seed inserted, so it
-- must come after the seed too.
-- Both 2026-10-05 files are immutable; this is the forward delta that supersedes the "append
-- rows to this file" note in the seed header.
--
-- EVERY row inserted here is DISABLED (enabled = false). Nothing is collected until an ADMIN
-- switches a source on, and no source is runnable by this file: the service registry cannot reach
-- these adapters until plan Task 2.5 registers them.
--
-- Readiness is a snapshot at 2026-10-24T00:00:00.000Z (a source's permission can end on a date;
-- the manifest derives the live answer). It is never VERIFIED: that is earned by a smoke.
--
-- Idempotent and safe to re-run on every deploy:
--   1. claim      - gives the 2026-10-05 rows their manifest_id (only rows that have none)
--   2. revise     - a LOWER config_version is raised to the manifest's (config, namespace and
--                   versions with it), which starts a new checkpoint scope (a checkpoint
--                   belongs to its config version)
--   3. insert     - rows the seed never held; ON CONFLICT DO NOTHING, so a row an admin has
--                   enabled, paused, retired or re-budgeted is never reset or re-added
--   3b. verify    - RAISES when an entry still has no row (an unmanaged row of the same
--                   (type, config) swallowed the insert), so the skip is never silent
--   4. block      - rows of a not-ready type that no entry claimed
-- No job_account_meters row is created: a rolling meter needs the provider's billing-window
-- start, which nobody holds for a key nobody has.
--
-- How to apply (the deploy wires this file; see the DevOps note in the PR):
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
-- --single-transaction is REQUIRED, not a nicety: without it each statement commits on its own, and the
-- step 3b RAISE (an unmanaged row blocked an insert) would leave steps 1-3 committed and step 4 never
-- run, a half-applied delta behind a loud failure. In one transaction the RAISE rolls everything back.

DROP TABLE IF EXISTS pg_temp._jsm_doc;
DROP TABLE IF EXISTS pg_temp._jsm_sources;
DROP TABLE IF EXISTS pg_temp._jsm_blocks;

CREATE TEMP TABLE _jsm_doc AS
SELECT $manifest${"sources":[
  {"manifest_id":"remoteok.api.latest","type":"REMOTEOK_API","config":{},"namespace":"remoteok","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":true},
  {"manifest_id":"remotive.api.software-dev","type":"REMOTIVE_API","config":{"category":"software-dev"},"namespace":"remotive","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":true},
  {"manifest_id":"remotive.api.devops","type":"REMOTIVE_API","config":{"category":"devops"},"namespace":"remotive","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":true},
  {"manifest_id":"remotive.api.data","type":"REMOTIVE_API","config":{"category":"data"},"namespace":"remotive","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":true},
  {"manifest_id":"himalayas.api.browse","type":"HIMALAYAS_API","config":{},"namespace":"himalayas","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"jobicy.api.engineering-europe","type":"JOBICY_API","config":{"count":100,"industry":"engineering","geo":"europe"},"namespace":"jobicy","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":true},
  {"manifest_id":"arbeitnow.api.feed","type":"ARBEITNOW_API","config":{"maxPages":5},"namespace":"arbeitnow","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":true},
  {"manifest_id":"jobgether.api.jobs","type":"JOBGETHER_API","config":{},"namespace":"jobgether","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"hn-hiring.thread.latest","type":"HN_HIRING","config":{},"namespace":"hn-hiring","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":true},
  {"manifest_id":"greenhouse.board.stripe","type":"GREENHOUSE_ATS","config":{"board":"stripe","employer":{"name":"Stripe","domain":"stripe.com","evidence":"PAYLOAD_FIELD (720 of 720)"}},"namespace":"greenhouse:stripe","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"greenhouse.board.airbnb","type":"GREENHOUSE_ATS","config":{"board":"airbnb","employer":{"name":"Airbnb","domain":null,"evidence":"PAYLOAD_FIELD (191 of 191)"}},"namespace":"greenhouse:airbnb","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"greenhouse.board.cloudflare","type":"GREENHOUSE_ATS","config":{"board":"cloudflare","employer":{"name":"Cloudflare","domain":null,"evidence":"PAYLOAD_FIELD (453 of 453)"}},"namespace":"greenhouse:cloudflare","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"lever.board.spotify","type":"LEVER_ATS","config":{"board":"spotify","employer":{"name":"Spotify","domain":null,"evidence":"TEXT_PARTIAL (87 of 90)"}},"namespace":"lever:global:spotify","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"lever.board.eu.siteimprove","type":"LEVER_ATS","config":{"board":"siteimprove","region":"eu","employer":{"name":"Siteimprove","domain":null,"evidence":"TEXT_FULL (12 of 12)"}},"namespace":"lever:eu:siteimprove","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"lever.board.quantco-","type":"LEVER_ATS","config":{"board":"quantco-","employer":{"name":"QuantCo","domain":null,"evidence":"TEXT_FULL (14 of 14)"}},"namespace":"lever:global:quantco-","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"ashby.board.linear","type":"ASHBY_ATS","config":{"board":"linear","employer":{"name":"Linear","domain":null,"evidence":"TEXT_FULL (34 of 34)"}},"namespace":"ashby:linear","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR","legacy":false},
  {"manifest_id":"ashby.board.supabase","type":"ASHBY_ATS","config":{"board":"supabase","employer":{"name":"Supabase","domain":null,"evidence":"TEXT_FULL (59 of 59)"}},"namespace":"ashby:supabase","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR","legacy":false},
  {"manifest_id":"workable.board.huggingface","type":"WORKABLE_ATS","config":{"board":"huggingface","employer":{"name":"Hugging Face","domain":null,"evidence":"PAYLOAD_FIELD"}},"namespace":"workable:huggingface","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"workable.board.hirefellows","type":"WORKABLE_ATS","config":{"board":"hirefellows","employer":{"name":"Hire Fellows","domain":null,"evidence":"PAYLOAD_FIELD"}},"namespace":"workable:hirefellows","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"recruitee.board.bunq","type":"RECRUITEE_ATS","config":{"board":"bunq","employer":{"name":"bunq","domain":null,"evidence":"PAYLOAD_FIELD"}},"namespace":"recruitee:bunq","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"personio.board.westwing","type":"PERSONIO_ATS","config":{"board":"westwing","language":"en","employer":{"name":"Westwing","domain":null,"evidence":"PAYLOAD_FIELD"}},"namespace":"personio:westwing","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"personio.board.personio","type":"PERSONIO_ATS","config":{"board":"personio","language":"en","employer":{"name":"Personio","domain":null,"evidence":"PAYLOAD_FIELD"}},"namespace":"personio:personio","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"CANDIDATE","readiness_reason":null,"legacy":false},
  {"manifest_id":"jooble.api.senior-developer-remote","type":"JOOBLE_API","config":{"keywords":"senior developer","location":"remote"},"namespace":"jooble","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":168,"budget_limit":6,"budget_window":"MONTH","readiness":"BLOCKED","readiness_reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes are from public descriptions, not Jooble documentation","legacy":true},
  {"manifest_id":"jsearch.rapidapi.backend","type":"JSEARCH_API","config":{"query":"senior backend developer remote"},"namespace":"jsearch","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":60,"budget_window":"MONTH","readiness":"BLOCKED","readiness_reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no RapidAPI key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes and the num_pages billing rule are not verified against a response","legacy":true},
  {"manifest_id":"jsearch.rapidapi.frontend","type":"JSEARCH_API","config":{"query":"senior frontend developer remote"},"namespace":"jsearch","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":60,"budget_window":"MONTH","readiness":"BLOCKED","readiness_reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no RapidAPI key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes and the num_pages billing rule are not verified against a response","legacy":true},
  {"manifest_id":"jsearch.rapidapi.ai-engineer","type":"JSEARCH_API","config":{"query":"senior ai engineer remote"},"namespace":"jsearch","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":60,"budget_window":"MONTH","readiness":"BLOCKED","readiness_reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no RapidAPI key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes and the num_pages billing rule are not verified against a response","legacy":true},
  {"manifest_id":"theirstack.api.senior","type":"THEIRSTACK_API","config":{"limit":25,"seniority":["senior"]},"namespace":"theirstack","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":96,"budget_limit":8,"budget_window":"MONTH","readiness":"BLOCKED","readiness_reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes are from the published API reference, not from a response","legacy":true},
  {"manifest_id":"muse.api.software-engineering-senior","type":"MUSE_API","config":{"category":"Software Engineering","level":"Senior Level","maxPages":5},"namespace":"themuse","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR; STATUS_CONSTANT_BLOCKED: terms section 2.2 requires a registered app and section 3.1 licenses display only; no app is registered and storing postings is not addressed; owner decision required","legacy":true},
  {"manifest_id":"reed.api.senior-developer-remote","type":"REED_API","config":{"keywords":"senior developer","locationName":"remote"},"namespace":"reed","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; response field names and the date format are not verified against a response, and Reed terms/eligibility were not found","legacy":true},
  {"manifest_id":"djinni.rss.python","type":"DJINNI_RSS","config":{"primaryKeyword":"Python"},"namespace":"","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR","legacy":false},
  {"manifest_id":"djinni.rss.rust","type":"DJINNI_RSS","config":{"primaryKeyword":"Rust"},"namespace":"","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR","legacy":false},
  {"manifest_id":"wwr.rss.all-jobs","type":"WWR_RSS","config":{},"namespace":"","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR","legacy":false},
  {"manifest_id":"wwr.rss.devops","type":"WWR_RSS","config":{"category":"remote-devops-sysadmin-jobs"},"namespace":"","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR","legacy":false},
  {"manifest_id":"euremotejobs.rss.feed","type":"EUREMOTEJOBS_RSS","config":{},"namespace":"","manifest_version":1,"policy_version":1,"config_version":1,"min_interval_hours":24,"budget_limit":null,"budget_window":null,"readiness":"BLOCKED","readiness_reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR","legacy":true}
],"typeBlocks":[
  {"type":"WORKINGNOMADS_API","reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR; STATUS_CONSTANT_BLOCKED: blocked: no documented permission - the terms say nothing either way on automated access"},
  {"type":"ASHBY_ATS","reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR"},
  {"type":"JOOBLE_API","reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes are from public descriptions, not Jooble documentation"},
  {"type":"JSEARCH_API","reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no RapidAPI key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes and the num_pages billing rule are not verified against a response"},
  {"type":"THEIRSTACK_API","reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes are from the published API reference, not from a response"},
  {"type":"MUSE_API","reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR; STATUS_CONSTANT_BLOCKED: terms section 2.2 requires a registered app and section 3.1 licenses display only; no app is registered and storing postings is not addressed; owner decision required"},
  {"type":"REED_API","reason":"KEY_REQUIRED: a fixture records permission KEY_REQUIRED; NO_CAPTURE: every fixture is a hand-written unit example; STATUS_CONSTANT_BLOCKED: no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; response field names and the date format are not verified against a response, and Reed terms/eligibility were not found"},
  {"type":"DJINNI_RSS","reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR"},
  {"type":"WWR_RSS","reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR"},
  {"type":"EUREMOTEJOBS_RSS","reason":"PERMISSION_UNCLEAR: a fixture records permission UNCLEAR"}
]}$manifest$::jsonb AS doc;

CREATE TEMP TABLE _jsm_sources AS
SELECT x.*
FROM _jsm_doc d,
     jsonb_to_recordset(d.doc -> 'sources') AS x(
       manifest_id text, type text, config jsonb, namespace text,
       manifest_version int, policy_version int, config_version int,
       min_interval_hours int, budget_limit int, budget_window text,
       readiness text, readiness_reason text, legacy boolean);

CREATE TEMP TABLE _jsm_blocks AS
SELECT x.*
FROM _jsm_doc d,
     jsonb_to_recordset(d.doc -> 'typeBlocks') AS x(type text, reason text);

-- 1. claim: the rows the 2026-10-05 seed inserted get their durable identity.
UPDATE job_sources s
SET manifest_id      = m.manifest_id,
    namespace        = m.namespace,
    manifest_version = m.manifest_version,
    policy_version   = m.policy_version,
    readiness        = CASE
                         WHEN s.readiness = 'VERIFIED' AND m.readiness = 'CANDIDATE' THEN s.readiness
                         ELSE m.readiness::job_source_readiness
                       END,
    readiness_reason = CASE
                         WHEN s.readiness = 'VERIFIED' AND m.readiness = 'CANDIDATE' THEN s.readiness_reason
                         ELSE m.readiness_reason
                       END,
    updated_at       = clock_timestamp()
FROM _jsm_sources m
WHERE m.legacy
  AND s.type = m.type::job_source_type
  AND s.config = m.config
  AND s.manifest_id IS NULL;

-- 2. revise: a config revision raises config_version, so the old checkpoints stop applying.
UPDATE job_sources s
SET config           = m.config,
    namespace        = m.namespace,
    config_version   = m.config_version,
    manifest_version = m.manifest_version,
    policy_version   = m.policy_version,
    updated_at       = clock_timestamp()
FROM _jsm_sources m
WHERE s.manifest_id = m.manifest_id
  AND s.config_version < m.config_version;

-- 3. insert: everything the seed never held, DISABLED.
INSERT INTO job_sources
  (type, config, enabled, trigger_mode, budget_limit, budget_window, min_interval_hours,
   manifest_id, namespace, manifest_version, policy_version, config_version,
   readiness, readiness_reason)
SELECT m.type::job_source_type, m.config, false, 'SCHEDULED'::job_source_trigger_mode,
       m.budget_limit, m.budget_window::job_source_budget_window, m.min_interval_hours,
       m.manifest_id, m.namespace, m.manifest_version, m.policy_version, m.config_version,
       m.readiness::job_source_readiness, m.readiness_reason
FROM _jsm_sources m
ORDER BY m.manifest_id
ON CONFLICT DO NOTHING;

-- 3b. verify: every manifest entry must now be a row. A hand-made row with the same (type, config) and
-- no manifest_id makes step 3 a silent no-op for that entry; say so instead of leaving an entry the
-- manifest describes and the database does not hold.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(m.manifest_id, ', ' ORDER BY m.manifest_id)
    INTO missing
    FROM _jsm_sources m
   WHERE NOT EXISTS (SELECT 1 FROM job_sources s WHERE s.manifest_id = m.manifest_id);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'manifest entries with no job_sources row (an unmanaged row with the same (type, config) already exists; claim or retire it by hand): %', missing;
  END IF;
END
$$;

-- 4. block: a row of a not-ready type that no manifest entry claimed must not read as a candidate.
UPDATE job_sources s
SET readiness        = 'BLOCKED',
    readiness_reason = b.reason,
    updated_at       = clock_timestamp()
FROM _jsm_blocks b
WHERE s.type = b.type::job_source_type
  AND s.manifest_id IS NULL
  AND s.readiness = 'CANDIDATE';

DROP TABLE _jsm_blocks;
DROP TABLE _jsm_sources;
DROP TABLE _jsm_doc;
