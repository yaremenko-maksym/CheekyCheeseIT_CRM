-- =============================================================================
-- Retire the ACCOUNTANT role: data step (manager-role plan PR 1a, design §13.2)
-- =============================================================================
--
-- APPLY (one transaction, so a failed assertion rolls the delete back):
--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
--
-- ORDER
--   Before the container swap, and before the file of PR 1d that recreates the `role` type
--   without ACCOUNTANT: that file cannot convert a column that still holds the value, and the API
--   of PR 1d refuses the value in Zod, so a stored ACCOUNTANT row would fail to parse. Needs the
--   schema that creates users and contract_templates.
--
-- OWNER DECISION (A3 Q-C, 2026-11-28)
--   No user holds ACCOUNTANT (the prod read of 2026-11-28 counted 0, active and archived), so no
--   user is retargeted and this file names no user id and no email. The ACCOUNTANT contract
--   templates that exist before the cutoff (created_at before 2026-11-29 00:00 UTC) are DELETED.
--
-- WHAT IT DOES
--   1. Refuses (RAISE EXCEPTION, counts only) when an ACCOUNTANT template was created on or after
--      the cutoff. The owner's decision covers the templates that existed when it was taken; a
--      newer one is a fact the owner has not seen, so nothing is deleted.
--   2. Refuses (RAISE EXCEPTION, counts only) when any row references an ACCOUNTANT template. The
--      referencing columns are not named by hand: the guard walks every FK onto
--      contract_templates in pg_constraint and counts per FK column, so a table added later is
--      covered too, including one whose FK is ON DELETE CASCADE (the delete would otherwise remove
--      its rows silently). A referenced template is never deleted.
--   3. Deletes every ACCOUNTANT contract_templates row created before the cutoff.
--   4. Asserts that no users.role and no contract_templates.target_role holds ACCOUNTANT. A user
--      that holds it stops the deploy: the owner decides that user's role first (plan PR 1a).
--   Every comparison casts to text (`::text`), so the file still parses and passes after PR 1d
--   removes the label from the type: it is re-applied on every deploy.
--
-- IDEMPOTENT
--   A replay finds no ACCOUNTANT template, deletes nothing and the assertions pass. On a schema
--   without the label (after PR 1d) the same holds.
--
-- ROLLBACK
--   The delete is by design and is not reversible from this file. The deleted rows are in the
--   owner's scheduled backup (scripts/devops/pg-backup.sh, cron, not taken by the deploy); the
--   owner restores a template from there if needed. Rolling the API back is safe: the old API
--   keeps working without the rows, because no user holds ACCOUNTANT. From this PR on, the API
--   refuses ACCOUNTANT on every write path (user create and update, role change, template
--   publish), so an ACCOUNTANT user or template can no longer be created through it.
--
-- LOCKS
--   Row locks on contract_templates only; the table has a handful of rows. The reference counts
--   are plain reads of the referencing tables.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

-- Step 1: an ACCOUNTANT template newer than the owner's decision stops the deploy.
DO $$
DECLARE
  n_new bigint;
BEGIN
  SELECT count(*) INTO n_new
    FROM contract_templates
   WHERE target_role::text = 'ACCOUNTANT'
     AND created_at >= timestamptz '2026-11-29 00:00:00+00';
  IF n_new > 0 THEN
    RAISE EXCEPTION 'accountant_role_retire: % ACCOUNTANT contract templates were created on or after 2026-11-29; nothing deleted, the owner decides first', n_new;
  END IF;
END $$;

-- Step 2: a referenced ACCOUNTANT template stops the deploy. Every FK onto contract_templates is
-- found in pg_constraint, so no referencing table is named by hand.
DO $$
DECLARE
  fk record;
  n_refs bigint;
  found_refs text := '';
BEGIN
  FOR fk IN
    SELECT c.conname,
           c.conrelid::regclass AS ref_table,
           cardinality(c.conkey) AS n_cols,
           a.attname AS ref_column,
           ta.attname AS template_column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = c.confkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'contract_templates'::regclass
     ORDER BY c.conname
  LOOP
    IF fk.n_cols <> 1 THEN
      RAISE EXCEPTION 'accountant_role_retire: FK % on % has % columns, this guard counts single-column FKs only; nothing deleted', fk.conname, fk.ref_table, fk.n_cols;
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM %s r WHERE r.%I IN (SELECT t.%I FROM contract_templates t WHERE t.target_role::text = %L)',
      fk.ref_table, fk.ref_column, fk.template_column, 'ACCOUNTANT'
    ) INTO n_refs;
    IF n_refs > 0 THEN
      found_refs := found_refs || format(' %s.%s %s;', fk.ref_table, fk.ref_column, n_refs);
    END IF;
  END LOOP;
  IF found_refs <> '' THEN
    RAISE EXCEPTION 'accountant_role_retire: ACCOUNTANT contract templates are referenced (%); nothing deleted, the owner decides first', trim(found_refs);
  END IF;
END $$;

-- Step 3: the owner's decision, bounded by the cutoff.
DELETE FROM contract_templates
 WHERE target_role::text = 'ACCOUNTANT'
   AND created_at < timestamptz '2026-11-29 00:00:00+00';

-- Step 4: no role-typed column holds ACCOUNTANT.
DO $$
DECLARE
  n_users bigint;
  n_templates bigint;
BEGIN
  SELECT count(*) INTO n_users FROM users WHERE role::text = 'ACCOUNTANT';
  IF n_users > 0 THEN
    RAISE EXCEPTION 'accountant_role_retire: % users still hold ACCOUNTANT; the owner decides their role first', n_users;
  END IF;
  SELECT count(*) INTO n_templates FROM contract_templates WHERE target_role::text = 'ACCOUNTANT';
  IF n_templates > 0 THEN
    RAISE EXCEPTION 'accountant_role_retire: % contract templates still target ACCOUNTANT', n_templates;
  END IF;
END $$;
