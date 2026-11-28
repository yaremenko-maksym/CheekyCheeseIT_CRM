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
--   schema that creates users, contract_templates, employee_contracts and signed_contracts.
--
-- OWNER DECISION (A3 Q-C, 2026-11-28)
--   No user holds ACCOUNTANT (the prod read of 2026-11-28 counted 0, active and archived), so no
--   user is retargeted and this file names no user id and no email. The ACCOUNTANT contract
--   templates are DELETED.
--
-- WHAT IT DOES
--   1. Refuses (RAISE EXCEPTION, counts only) when any employee_contracts or signed_contracts row
--      references an ACCOUNTANT template. A referenced template is never deleted: the contract
--      history needs it, and both FKs are RESTRICT / NO ACTION, so the delete would fail anyway,
--      with a less readable error.
--   2. Deletes every contract_templates row whose target_role is ACCOUNTANT.
--   3. Asserts that no users.role and no contract_templates.target_role holds ACCOUNTANT. A user
--      that holds it stops the deploy: the owner decides that user's role first (plan PR 1a).
--   Every comparison casts to text (`::text`), so the file still parses and passes after PR 1d
--   removes the label from the type: it is re-applied on every deploy.
--
-- IDEMPOTENT
--   A replay finds no ACCOUNTANT template, deletes nothing and the assertions pass. On a schema
--   without the label (after PR 1d) the same holds.
--
-- ROLLBACK
--   The delete is not reversible from this file. The deleted rows are in the owner's scheduled
--   backup (scripts/devops/pg-backup.sh, cron, not taken by the deploy); the owner restores a
--   template from there if needed. The old API keeps working without the rows: no user holds
--   ACCOUNTANT, so nothing asks for an ACCOUNTANT template.
--
-- LOCKS
--   Row locks on contract_templates only; the table has a handful of rows.
-- =============================================================================

SET LOCAL lock_timeout = '10s';

-- Step 1: a referenced ACCOUNTANT template stops the deploy.
DO $$
DECLARE
  n_employee bigint;
  n_signed bigint;
BEGIN
  SELECT count(*) INTO n_employee
    FROM employee_contracts ec
    JOIN contract_templates t ON t.id = ec.source_template_id
   WHERE t.target_role::text = 'ACCOUNTANT';
  SELECT count(*) INTO n_signed
    FROM signed_contracts sc
    JOIN contract_templates t ON t.id = sc.template_id
   WHERE t.target_role::text = 'ACCOUNTANT';
  IF n_employee > 0 OR n_signed > 0 THEN
    RAISE EXCEPTION 'accountant_role_retire: ACCOUNTANT contract templates are referenced (employee_contracts %, signed_contracts %); nothing deleted, the owner decides first', n_employee, n_signed;
  END IF;
END $$;

-- Step 2: the owner's decision.
DELETE FROM contract_templates WHERE target_role::text = 'ACCOUNTANT';

-- Step 3: no role-typed column holds ACCOUNTANT.
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
