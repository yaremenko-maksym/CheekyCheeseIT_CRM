-- =============================================================================
-- Vacancy sourcing - host keys of the manifest sources (r5 Task 2.5 T8)
-- =============================================================================
--
-- GENERATED from apps/api/src/job-sourcing/providers/manifest.definitions.ts (each type's
-- hostKey(config)). DO NOT EDIT BY HAND: `pnpm --filter @crm/api job-sources:manifest:generate` rewrites it, and
-- manifest.drift.spec.ts fails when this file differs from what the generator produces.
--
-- APPLY ORDER (load-bearing). AFTER 2026-10-24_job_source_hosts.sql (it adds the column this
-- file writes) and AFTER 2026-10-24_job_sources_manifest_delta.sql (it gives the rows the manifest_id this file
-- keys on, and inserts the rows the 2026-10-05 seed never held).
--
-- WHAT IT DOES: sets host_key on every manifest-owned (reporting) source whose host_key is
-- still NULL. It NEVER overwrites a key, and it never touches a row without a manifest_id,
-- so DOU (legacy path, outside the ledger) keeps NULL. Idempotent: a second application
-- matches no row. A changed key for an existing entry is therefore NOT applied by a later
-- run of this file; that needs its own reviewed migration.
--
-- How to apply (the deploy wires this file; see the DevOps note in the PR):
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>

DROP TABLE IF EXISTS pg_temp._jsh_keys;

CREATE TEMP TABLE _jsh_keys AS
SELECT x.*
FROM jsonb_to_recordset($hostkeys$[
  {"manifest_id":"remoteok.api.latest","host_key":"remoteok.com"},
  {"manifest_id":"remotive.api.software-dev","host_key":"remotive.com"},
  {"manifest_id":"remotive.api.devops","host_key":"remotive.com"},
  {"manifest_id":"remotive.api.data","host_key":"remotive.com"},
  {"manifest_id":"himalayas.api.browse","host_key":"himalayas.app"},
  {"manifest_id":"jobicy.api.engineering-europe","host_key":"jobicy.com"},
  {"manifest_id":"arbeitnow.api.feed","host_key":"www.arbeitnow.com"},
  {"manifest_id":"jobgether.api.jobs","host_key":"jobgether.com"},
  {"manifest_id":"hn-hiring.thread.latest","host_key":"hn.algolia.com"},
  {"manifest_id":"greenhouse.board.stripe","host_key":"boards-api.greenhouse.io"},
  {"manifest_id":"greenhouse.board.airbnb","host_key":"boards-api.greenhouse.io"},
  {"manifest_id":"greenhouse.board.cloudflare","host_key":"boards-api.greenhouse.io"},
  {"manifest_id":"lever.board.spotify","host_key":"api.lever.co"},
  {"manifest_id":"lever.board.eu.siteimprove","host_key":"api.eu.lever.co"},
  {"manifest_id":"lever.board.quantco-","host_key":"api.lever.co"},
  {"manifest_id":"ashby.board.linear","host_key":"api.ashbyhq.com"},
  {"manifest_id":"ashby.board.supabase","host_key":"api.ashbyhq.com"},
  {"manifest_id":"workable.board.huggingface","host_key":"apply.workable.com"},
  {"manifest_id":"workable.board.hirefellows","host_key":"apply.workable.com"},
  {"manifest_id":"recruitee.board.bunq","host_key":"recruitee.com"},
  {"manifest_id":"personio.board.westwing","host_key":"personio.de"},
  {"manifest_id":"personio.board.personio","host_key":"personio.de"},
  {"manifest_id":"jooble.api.senior-developer-remote","host_key":"jooble.org"},
  {"manifest_id":"jsearch.rapidapi.backend","host_key":"jsearch.p.rapidapi.com"},
  {"manifest_id":"jsearch.rapidapi.frontend","host_key":"jsearch.p.rapidapi.com"},
  {"manifest_id":"jsearch.rapidapi.ai-engineer","host_key":"jsearch.p.rapidapi.com"},
  {"manifest_id":"theirstack.api.senior","host_key":"api.theirstack.com"},
  {"manifest_id":"muse.api.software-engineering-senior","host_key":"www.themuse.com"},
  {"manifest_id":"reed.api.senior-developer-remote","host_key":"www.reed.co.uk"},
  {"manifest_id":"djinni.rss.python","host_key":"djinni.co"},
  {"manifest_id":"djinni.rss.rust","host_key":"djinni.co"},
  {"manifest_id":"wwr.rss.all-jobs","host_key":"weworkremotely.com"},
  {"manifest_id":"wwr.rss.devops","host_key":"weworkremotely.com"},
  {"manifest_id":"euremotejobs.rss.feed","host_key":"euremotejobs.com"}
]$hostkeys$::jsonb) AS x(manifest_id text, host_key text);

UPDATE job_sources s
SET host_key   = k.host_key,
    updated_at = clock_timestamp()
FROM _jsh_keys k
WHERE s.manifest_id = k.manifest_id
  AND s.host_key IS NULL;

DROP TABLE _jsh_keys;
