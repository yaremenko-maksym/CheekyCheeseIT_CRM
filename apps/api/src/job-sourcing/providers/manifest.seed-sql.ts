import { join } from 'node:path'
import { isReporting, type Manifest, readinessAt, readinessReason } from './manifest'

/**
 * The forward seed delta (r5 Task 3.7, correction C-16), GENERATED from the manifest.
 *
 * The two seed files of 2026-10-05 are immutable (their checksum is in the deploy ledger), so what
 * the manifest adds is a NEW file: it gives the 2026-10-05 rows their stable identity, inserts the
 * sources that file never held, and starts a new checkpoint scope for a revised config. Every
 * inserted row is DISABLED; activation stays an ADMIN action and nothing seeds at startup.
 *
 * PARAMETERISED, NOT INTERPOLATED. The statements are fixed text; the data is ONE `jsonb` literal
 * (dollar-quoted) that they read through `jsonb_to_recordset`. So there is no per-column quoting
 * to get wrong, and "the rows the SQL produces equal the manifest" is checked by READING THE ROWS,
 * never by parsing this text.
 *
 * IDEMPOTENT, AND A REDEPLOY NEVER UNDOES AN ADMIN:
 *  - the backfill claims only rows whose `manifest_id` IS NULL, so a claimed row is never touched;
 *  - the insert is `ON CONFLICT DO NOTHING` (against both `uq_job_sources_type_config` and
 *    `uq_job_sources_manifest_id`), so an existing row, however an admin has since paused, retired
 *    or enabled it, is neither re-added nor reset;
 *  - `enabled`, `admin_state`, the budget columns and the cooldown are written ONLY by the insert,
 *    for a row that did not exist;
 *  - a revision touches a row only while its `config_version` is LOWER than the manifest's.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: create `job_account_meters` rows. A rolling meter needs the
 * instant the provider's billing window began, and nobody holds that for a key nobody has. A meter
 * is created at activation with the owner's figure, by the code that owns the meter (Task 2.5).
 * The manifest records the quota; the delta does not invent a window.
 */

/**
 * The instant the seeded `readiness` is a statement about. Readiness is a function of a clock
 * (Recruitee's permission ends on a date), so a committed snapshot has to say WHICH instant, and
 * the drift spec regenerates at this same constant rather than at "now": a snapshot that changed
 * with the calendar would fail a build on a day nobody touched anything.
 */
export const SEED_CLOCK = new Date('2026-10-24T00:00:00.000Z')

export const SEED_DELTA_FILE = '2026-10-24_job_sources_manifest_delta.sql'
export const GENERATE_COMMAND = 'pnpm --filter @crm/api job-sources:manifest:generate'

const DOLLAR_TAG = '$manifest$'

/**
 * Where the delta lives. It is generated into `drizzle/manual-staged/` and DevOps moves it to
 * `drizzle/manual/` together with the four deploy edits (see the PR). It cannot start in `manual/`:
 * `scripts/devops/check-prod-ddl-wiring.py` fails a build holding a manual file the deploy does not
 * copy and apply, and wiring the deploy is not this task's zone. The text of the file names no
 * directory, so the move changes no byte of it.
 */
export function seedDeltaLocations(drizzleRoot: string): { manual: string; staged: string } {
  return {
    manual: join(drizzleRoot, 'manual', SEED_DELTA_FILE),
    staged: join(drizzleRoot, 'manual-staged', SEED_DELTA_FILE),
  }
}

export interface SeedSource {
  manifest_id: string
  type: string
  config: Record<string, unknown>
  namespace: string
  manifest_version: number
  policy_version: number
  config_version: number
  min_interval_hours: number
  budget_limit: number | null
  budget_window: string | null
  readiness: 'CANDIDATE' | 'BLOCKED'
  readiness_reason: string | null
  legacy: boolean
}

export interface SeedTypeBlock {
  type: string
  reason: string
}

/**
 * What the delta will write, as plain data. Exported so the spec can compare ROWS against it
 * without going through the SQL text.
 */
export function seedRowsOf(manifest: Manifest, clock: Date = SEED_CLOCK) {
  const sources: SeedSource[] = manifest.entries.map((e) => {
    const r = readinessAt(e, clock)
    return {
      manifest_id: e.id,
      type: e.type,
      config: e.config as Record<string, unknown>,
      namespace: e.namespace,
      manifest_version: e.manifestVersion,
      policy_version: e.policyVersion,
      config_version: e.configVersion,
      min_interval_hours: e.intervalHours,
      budget_limit: e.budget?.limit ?? null,
      budget_window: e.budget?.window ?? null,
      // The manifest never says VERIFIED: that is what a smoke against the real provider earns.
      readiness: r.status === 'BLOCKED' ? 'BLOCKED' : 'CANDIDATE',
      readiness_reason: readinessReason(r),
      legacy: e.legacySeed,
    }
  })
  const typeBlocks: SeedTypeBlock[] = manifest.types
    .filter((t) => isReporting(t.disposition))
    .flatMap((t) => {
      const r = readinessAt(t, clock)
      return r.status === 'BLOCKED' ? [{ type: t.type, reason: readinessReason(r)! }] : []
    })
  return { sources, typeBlocks }
}

const line = (value: unknown): string => `  ${JSON.stringify(value)}`

const jsonArray = (items: readonly unknown[]): string =>
  items.length === 0 ? '[]' : `[\n${items.map(line).join(',\n')}\n]`

export function generateSeedDelta(manifest: Manifest, clock: Date = SEED_CLOCK): string {
  const { sources, typeBlocks } = seedRowsOf(manifest, clock)
  const doc = `{"sources":${jsonArray(sources)},"typeBlocks":${jsonArray(typeBlocks)}}`
  if (doc.includes(DOLLAR_TAG)) {
    throw new Error(`the manifest data contains ${DOLLAR_TAG}, which would end its own literal`)
  }
  return `-- =============================================================================
-- Vacancy sourcing - manifest forward delta (r5 Task 3.7, correction C-16)
-- =============================================================================
--
-- GENERATED from apps/api/src/job-sourcing/providers/manifest.definitions.ts and the
-- fixtures' provenance. DO NOT EDIT BY HAND: \`${GENERATE_COMMAND}\` rewrites it, and
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
-- Readiness is a snapshot at ${clock.toISOString()} (a source's permission can end on a date;
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
SELECT ${DOLLAR_TAG}${doc}${DOLLAR_TAG}::jsonb AS doc;

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
`
}
