# Audit-hardening constraints — prod deploy runbook

**Date:** 2026-07-04
**Relates to:** PR #328–#336 (audit-fix pass)
**DDL file:** `apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql`
**Status on dev `crm_db`:** already applied (via `drizzle-kit push`)
**Status on prod VPS:** NOT YET APPLIED — apply before or alongside next deploy

---

## 1. Why this matters

The audit-fix pass (PR #328–#336, 2026-06-27/07-03) added DB-level safety nets
for idempotency races and business invariants. Without them:

| Finding                                                                          | Risk without DB constraint                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **SEC-01** `uq_transactions_salary_receiver_month`                               | Salary-cron TOCTOU race → duplicate SALARY rows → double salary credit for same employee+month |
| **BIZ-07** `uq_interviews_created_project_id` + `created_project_id` column      | Concurrent HIRED transitions → duplicate project creation / duplicate `project_members`        |
| **BIZ-11** `uq_pending_obligations_source_pending`                               | Two concurrent income flows create two PENDING obligations for the same source transaction     |
| **BIZ-11** `employee_contracts_one_per_user`                                     | Admin race → duplicate active employee contracts per user                                      |
| **BIZ-11** `uq_contract_templates_active_role`                                   | Concurrent publish → two active templates for the same role                                    |
| **BIZ-11** `uq_tos_versions_active`                                              | Concurrent publish → two globally active ToS versions                                          |
| **BIZ-19** `uq_transactions_dividend_idempotency_key` + `idempotency_key` column | Network retry → DIVIDEND_TO_ADMIN created twice, double-crediting an admin                     |

The prod image does **not** ship `drizzle-kit` (dev dependency only). These
objects must be applied manually via `psql` before the audit-hardened API code
reaches prod. The DDL is fully idempotent — safe to re-run.

---

## 2. Pre-check: detect data violations before applying

Run each query below against the prod database. If any returns rows there are
existing data violations that **must** be resolved before the `CREATE INDEX`
statements can succeed (a unique index cannot be built over conflicting rows).

```sql
-- SEC-01: duplicate SALARY rows for same (receiver, month)?
SELECT receiver_id, salary_month, count(*)
  FROM transactions
 WHERE type = 'SALARY' AND salary_month IS NOT NULL
 GROUP BY receiver_id, salary_month
HAVING count(*) > 1;

-- BIZ-11: multiple PENDING obligations for same source transaction?
SELECT source_transaction_id, count(*)
  FROM pending_obligations
 WHERE status = 'PENDING'
 GROUP BY source_transaction_id
HAVING count(*) > 1;

-- BIZ-11: multiple non-CANCELLED contracts for same user?
SELECT user_id, count(*)
  FROM employee_contracts
 WHERE status != 'CANCELLED'
 GROUP BY user_id
HAVING count(*) > 1;

-- BIZ-11: multiple active contract templates for same role?
SELECT target_role, count(*)
  FROM contract_templates
 WHERE is_active = true
 GROUP BY target_role
HAVING count(*) > 1;

-- BIZ-11: more than one globally active ToS version?
SELECT count(*)
  FROM tos_versions
 WHERE is_active = true
HAVING count(*) > 1;

-- BIZ-07: same created_project_id on multiple interviews?
-- (column may not exist yet — skip if it returns "column does not exist")
SELECT created_project_id, count(*)
  FROM interviews
 WHERE created_project_id IS NOT NULL
 GROUP BY created_project_id
HAVING count(*) > 1;

-- BIZ-19: same idempotency_key on multiple DIVIDEND_TO_ADMIN rows?
-- (column may not exist yet — skip if it returns "column does not exist")
SELECT idempotency_key, count(*)
  FROM transactions
 WHERE type = 'DIVIDEND_TO_ADMIN' AND idempotency_key IS NOT NULL
 GROUP BY idempotency_key
HAVING count(*) > 1;
```

If any query returns rows — **stop and contact the owner** before proceeding.
Data cleanup is context-dependent (e.g. soft-delete the duplicate contract,
set the older obligation to `CANCELLED`, etc.). Do not force-drop duplicates
without business review.

If all queries return zero rows (or "column does not exist" for the two new
columns) — proceed to the apply step.

---

## 3. Apply to prod

### Option A — copy file to VPS then apply (recommended)

```bash
# From your local machine — copy the script to the VPS:
scp apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql \
    <user>@<vps-ip>:/tmp/audit_constraints.sql

# On the VPS — pipe into the running postgres container:
docker exec -i $(docker compose -f docker-compose.prod.yml ps -q postgres) \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < /tmp/audit_constraints.sql
```

### Option B — inline from the VPS where the stack lives

```bash
# cd to the deploy directory on the VPS that has docker-compose.prod.yml, then:
docker compose -f docker-compose.prod.yml exec -T postgres psql \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql
```

### Option C — manual psql session (for interactive troubleshooting)

```bash
docker exec -it $(docker compose -f docker-compose.prod.yml ps -q postgres) \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

-- Then paste statements individually from the SQL file.
-- \q to exit.
```

> **Timing:** apply **before** deploying the API image that contains PR #332–#335
> code. The service-layer guards assume the DB constraints exist as a backstop.
> Applying after code deploy is still safe (the service guards protect the window),
> but the DB-level race safety net is absent until the DDL runs.

---

## 4. Verify — expect 7 rows

After applying, run the following query and confirm **7 rows** are returned:

```sql
SELECT indexname
  FROM pg_indexes
 WHERE indexname IN (
   'uq_transactions_salary_receiver_month',
   'uq_pending_obligations_source_pending',
   'employee_contracts_one_per_user',
   'uq_contract_templates_active_role',
   'uq_tos_versions_active',
   'uq_interviews_created_project_id',
   'uq_transactions_dividend_idempotency_key'
 )
 ORDER BY indexname;
```

Expected output (7 rows, order may vary):

```
employee_contracts_one_per_user
uq_contract_templates_active_role
uq_interviews_created_project_id
uq_pending_obligations_source_pending
uq_tos_versions_active
uq_transactions_dividend_idempotency_key
uq_transactions_salary_receiver_month
```

Fewer than 7 rows → scroll back through the `psql` output for `ERROR:` lines
and resolve before re-running the idempotent script.

Also verify the two new columns exist:

```sql
-- created_project_id on interviews:
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'interviews'
   AND column_name = 'created_project_id';

-- idempotency_key on transactions:
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'transactions'
   AND column_name = 'idempotency_key';
```

Both should return one row each with `data_type = 'uuid'` and `is_nullable = 'YES'`.

---

## 5. Dev database status

The dev `crm_db` received these objects via `drizzle-kit push` as part of
merging PR #332 (`eed0d6d8`) and PR #335 (`46d21422`). No manual action needed
on dev.

If you recreate the dev database from scratch (`db:push` + `db:seed`), the
objects will be recreated automatically by `drizzle-kit push` — no manual SQL
needed on dev either.

---

## 6. Rollback (if needed)

All objects created by this script can be dropped without data loss:

```sql
DROP INDEX IF EXISTS uq_transactions_salary_receiver_month;
DROP INDEX IF EXISTS uq_pending_obligations_source_pending;
DROP INDEX IF EXISTS employee_contracts_one_per_user;
DROP INDEX IF EXISTS uq_contract_templates_active_role;
DROP INDEX IF EXISTS uq_tos_versions_active;
DROP INDEX IF EXISTS uq_interviews_created_project_id;
DROP INDEX IF EXISTS uq_transactions_dividend_idempotency_key;

-- Columns (data-bearing — only drop if you need to revert the schema fully):
ALTER TABLE interviews DROP COLUMN IF EXISTS created_project_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS idempotency_key;
```

> Dropping the columns drops any data stored in them. The column values for
> `created_project_id` are set by the HIRED-transition service; dropping the
> column means the next HIRED re-run will re-create the project (the service
> checks the column before creating). Rollback of columns should only be done
> if the corresponding code is also rolled back.
