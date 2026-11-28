BEGIN TRANSACTION READ ONLY;

-- =============================================================================
-- ACCOUNTANT fact-finding (manager-role plan PR 1a AC 1-2, design §13.1). READ ONLY.
-- =============================================================================
--
-- OWNER / MASTER-RUN ONLY, NEVER WIRED into deploy.yml: the repo and its Action logs are public,
-- and the output is shared as aggregates in the owner chat, never in a PR or a log.
--
-- RUN (after `SELECT current_database();` confirms the database):
--   psql -v ON_ERROR_STOP=1 -f <this file>
--
-- The transaction is READ ONLY, so any write in it fails; the file ends with ROLLBACK.
-- Output: aggregates and ids only. No email, no name.
--
-- Result sets:
--   1. ACCOUNTANT users, split active / archived.
--   2. Per ACCOUNTANT user: id, archived, created_at.
--   3. Per FK column that references users.id (derived from pg_constraint at run time, so a
--      column added later is never missed): rows naming an ACCOUNTANT user.
--   4. Per column of type `role` (derived from pg_attribute): rows holding ACCOUNTANT.
--   5. ACCOUNTANT contract templates, split active / inactive.
--   6. Per FK column that references contract_templates.id: rows naming an ACCOUNTANT template.
-- =============================================================================

-- 1. ACCOUNTANT users, active / archived.
SELECT count(*) FILTER (WHERE archived_at IS NULL) AS active,
       count(*) FILTER (WHERE archived_at IS NOT NULL) AS archived
  FROM users
 WHERE role::text = 'ACCOUNTANT';

-- 2. Per ACCOUNTANT user: id only, no email, no name.
SELECT id, archived_at IS NOT NULL AS archived, created_at
  FROM users
 WHERE role::text = 'ACCOUNTANT'
 ORDER BY created_at;

-- 3. Per single-column FK onto users.id: rows naming an ACCOUNTANT user.
SELECT c.conrelid::regclass AS table_ref,
       a.attname AS column_ref,
       (xpath('/row/n/text()', query_to_xml(
          format('SELECT count(*) AS n FROM %s x WHERE x.%I IN (SELECT id FROM users WHERE role::text = %L)',
                 c.conrelid::regclass, a.attname, 'ACCOUNTANT'),
          false, true, '')))[1]::text::bigint AS accountant_rows
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
 WHERE c.contype = 'f'
   AND c.confrelid = 'users'::regclass
   AND cardinality(c.conkey) = 1
 ORDER BY 1, 2;

-- 4. Per column of type `role`: rows holding ACCOUNTANT (today users.role and
--    contract_templates.target_role).
SELECT a.attrelid::regclass AS table_ref,
       a.attname AS column_ref,
       (xpath('/row/n/text()', query_to_xml(
          format('SELECT count(*) AS n FROM %s x WHERE x.%I::text = %L',
                 a.attrelid::regclass, a.attname, 'ACCOUNTANT'),
          false, true, '')))[1]::text::bigint AS accountant_rows
  FROM pg_attribute a
  JOIN pg_class r ON r.oid = a.attrelid
 WHERE a.atttypid = 'role'::regtype
   AND a.attnum > 0
   AND NOT a.attisdropped
   AND r.relkind IN ('r', 'p')
 ORDER BY 1, 2;

-- 5. ACCOUNTANT contract templates, active / inactive.
SELECT count(*) FILTER (WHERE is_active) AS active,
       count(*) FILTER (WHERE NOT is_active) AS inactive
  FROM contract_templates
 WHERE target_role::text = 'ACCOUNTANT';

-- 6. Per single-column FK onto contract_templates.id: rows naming an ACCOUNTANT template.
SELECT c.conrelid::regclass AS table_ref,
       a.attname AS column_ref,
       (xpath('/row/n/text()', query_to_xml(
          format('SELECT count(*) AS n FROM %s x WHERE x.%I IN (SELECT id FROM contract_templates WHERE target_role::text = %L)',
                 c.conrelid::regclass, a.attname, 'ACCOUNTANT'),
          false, true, '')))[1]::text::bigint AS accountant_rows
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
 WHERE c.contype = 'f'
   AND c.confrelid = 'contract_templates'::regclass
   AND cardinality(c.conkey) = 1
 ORDER BY 1, 2;

ROLLBACK;
