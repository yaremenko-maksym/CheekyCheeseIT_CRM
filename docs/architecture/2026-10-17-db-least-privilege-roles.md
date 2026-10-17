# ADR: Least-privileged database roles — the API stops connecting as the bootstrap role

## Status

Proposed (2026-10-17). Direction approved by the owner on 2026-10-17 ("do it the right way").

## Context

**Trigger.** The security review of PR #1017 (vacancy-sourcing queue tables: assignments,
dismissals, triage subscriptions, the `job_queue_actions` action log, generations) found that the
API connects as `crm_user` — the same role that applies every DDL file on deploy. On the scratch
catalog `crm_user` has `rolsuper = t`. Production has not been checked; only the owner can run
production commands (`ssh crm-vps`).

**Why production is very probably a superuser too.** Production Postgres is the official
`postgres:16-alpine` image, and `docker-compose.prod.yml` sets `POSTGRES_USER` to `crm_user`. The
image entrypoint creates `POSTGRES_USER` as the cluster's bootstrap superuser at `initdb`. So the
prior is "superuser", and the owner's check (§4, step 0) confirms or refutes it. This ADR does **not**
depend on the answer: the attacks it closes need only table **ownership**, which `crm_user` has
either way.

**What follows from today's setup** (each verified against the repository, by symbol / config key):

| Fact                                                                                                                                                  | Where                                                                     | Consequence                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The API opens one `pg` `Pool` from `DATABASE_URL`                                                                                                     | `DatabaseService.onModuleInit`, `env.ts` schema key `DATABASE_URL`        | One credential for every query the API makes                                                                                          |
| The deploy writes `DATABASE_URL=postgresql://crm_user:…@postgres:5432/crm_db`                                                                         | `deploy.yml`, the `write-env` job writing `.env.production`               | The API holds the owner credential                                                                                                    |
| The API container loads the **whole** `.env.production`                                                                                               | `docker-compose.prod.yml`, service `api`, `env_file`                      | The API also holds `POSTGRES_PASSWORD` — the owner password — even though no API code reads it                                        |
| Every manual DDL file is applied as `psql -U "$PGUSER" … -v ON_ERROR_STOP=1 < file` via `docker compose exec -T postgres`, `PGUSER` = `POSTGRES_USER` | `deploy.yml` apply steps; guard `scripts/devops/check-prod-ddl-wiring.py` | DDL runs over the in-container local socket; the image's `pg_hba.conf` trusts local connections, so the deploy path needs no password |
| The nightly backup runs `pg_dump -U crm_user --no-owner --no-acl` the same way                                                                        | `scripts/devops/pg-backup.sh`                                             | Backups depend on the owner role, not on the API's                                                                                    |
| Every table is in schema `public`; ids are `uuid` `defaultRandom()` except one `bigserial` and one identity column                                    | `apps/api/src/database/schema*`                                           | Sequences exist and need a rule                                                                                                       |
| No manual SQL file creates a trigger, a function or an extension                                                                                      | `apps/api/drizzle/manual/*.sql`                                           | The append-only triggers r5 plans are the first; PR #1017 pins the gap with a test named "GAP PIN: no trigger exists yet"             |

Three consequences, stated exactly:

1. **No grant-based boundary works for the API today.** A superuser bypasses every privilege
   check. Even if `crm_user` were not a superuser, it **owns** every table, and an owner can
   `ALTER TABLE … DISABLE TRIGGER`, drop a trigger, `TRUNCATE`, and re-grant itself anything.
2. **Append-only triggers would stop application bugs only.** SQL injection or a compromised API
   process runs as the owner (and probably as superuser) and can disable any trigger — by
   `ALTER TABLE … DISABLE TRIGGER`, or, as superuser, `SET session_replication_role = replica`,
   which skips every trigger left in the default `ENABLE` state.
3. **Changing only the URL is not enough.** While the API's environment contains
   `POSTGRES_PASSWORD`, a compromised API can open a second connection as `crm_user`. The owner
   password must leave the API's environment in the same rollout (§4, step 5).

**What already constrains this ADR.** The vacancy-sourcing plan r5
(`docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`), Task 1.3 "Prod DDL and deploy
wiring", requires (a) a dedicated least-privileged role and connection string for the **collection
worker** (DML on job-sourcing tables, SELECT on evaluation inputs, no DDL, no
finance/session/credential tables) and (b) a **separate** DevOps task + ADR for a migration
ledger. This ADR provides the role model (a) sits in and the boundary (b) must respect; it
implements neither.

**Owner decision.** 2026-10-17, in answer to the recommendation of a dedicated non-superuser
application role: "yes, do it the right way".

## Decision

### 1. The role model

**Conflict-resolution note.** This adopts the established PostgreSQL pattern — objects owned by a
DDL role, the application connecting as a separate login that owns nothing and holds only the
grants it needs, new objects covered by `ALTER DEFAULT PRIVILEGES` (PostgreSQL 16 manual,
"Privileges", "ALTER DEFAULT PRIVILEGES", "CREATE TRIGGER") — over local invention such as
in-application write filters or row-level security as the primary boundary. Priority 1 of the
architect hierarchy (hard safety) is what makes the pattern mandatory rather than taste; nothing in
the project requirements (priority 2) conflicts with it.

Three roles. Confidence **HIGH** on the model; it is the textbook split.

| Role            | Kind  | Becomes / is                                                                                                                                                     | Attributes                                                                                                                                                               |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crm_user`      | LOGIN | **The owner / migration role.** Keeps owning every object; every deploy DDL file, the ledger runner (§6), `db:push`, `db:seed` and the backup keep running as it | Unchanged in this ADR (superuser today, very probably). Its password stays, but is held **only** by the `postgres` service and the deploy, never by the API (§4, step 5) |
| `crm_app`       | LOGIN | **The API's role.** The only credential the API process holds                                                                                                    | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, a `CONNECTION LIMIT` sized to the pool plus headroom, member of **no** role, owns **nothing**           |
| `crm_collector` | LOGIN | **The collection worker's role** that r5 Task 1.3 requires                                                                                                       | Same attributes as `crm_app`; explicit per-table grants only (§2). Created when the worker ships as its own process; its credential goes only to that process            |

Why each property matters (the attack each one closes):

- **Owns nothing** — ownership, not superuser, is what allows `DISABLE TRIGGER`, `DROP TRIGGER`,
  `ALTER TABLE`, and re-granting. A role that owns no table can do none of these.
- **Member of no role** — membership in `crm_user` would allow `SET ROLE crm_user`, i.e. ownership
  again. Verification (§4, step 4) asserts `crm_app` has no rows in `pg_auth_members`.
- **NOSUPERUSER** — `session_replication_role` is settable only by a superuser (or by an explicit
  `GRANT SET ON PARAMETER`, which this design never issues).
- **NOCREATEROLE** — otherwise the role could mint a more privileged role.

**The collector role binds only across a process boundary** (confidence **HIGH**). If the
collection worker runs inside the API process, both credentials sit in one memory space and
one environment, and a compromise of that process gets both. Then `crm_collector` still contains
**bugs** in collector code (a wrong `UPDATE` against `users` is refused), but not a compromise. r5
already says extractor secrets are "read only by the worker process"; the collector's
`DATABASE_URL` follows the same rule.

**Considered and not adopted now** (each can be added later without redoing this design):

| Candidate                                                                                  | Why not now                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A separate `NOLOGIN` owner role (`crm_owner`) with `crm_user` as a member doing `SET ROLE` | Cleaner in theory; costs a whole-catalog `REASSIGN OWNED BY crm_user`, and buys nothing while `crm_user` is the only DDL login. Revisit if a second human or tool needs DDL rights                                                                                                                      |
| Demoting `crm_user` from superuser                                                         | It is the cluster's only superuser (image bootstrap). Demoting it needs a break-glass superuser first, and changes nothing for the API boundary, which comes from the API not holding `crm_user`'s credential. Separate decision, **A3** (irreversible without single-user-mode recovery), out of scope |
| A read-only role `crm_readonly` (backups, agent reads)                                     | Backups and owner checks run over the trusted local socket in the container; a read-only role would not remove that path. Revisit if any reader ever connects over TCP                                                                                                                                  |
| Row-level security                                                                         | Solves a different problem (per-row tenancy). The CRM's RBAC lives in service code; RLS here would be a second, divergent RBAC                                                                                                                                                                          |

### 2. Privileges per role, per table class

Every table in `public` belongs to **exactly one class**. The class decides the grants; the class
list lives in one manifest that a catalog check reads (below). Confidence **HIGH** on the grants,
**MED** on the manifest format (to be settled by the implementing task).

| Class                               | Members (examples, by table)                                                                 | `crm_app`                                                                                      | `crm_collector`                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A — ordinary**                    | Default for every product table: users, projects, transactions, contracts, …                 | `SELECT, INSERT, UPDATE, DELETE`                                                               | nothing                                                                                           |
| **B — append-only**                 | `job_queue_actions`; any future audit / action log                                           | `SELECT, INSERT` only — `UPDATE, DELETE, TRUNCATE` explicitly revoked, plus the triggers in §3 | nothing, unless r5 names it                                                                       |
| **C — job-sourcing**                | The job-sourcing tables r5 Task 1.3 lists for the collector                                  | as class A                                                                                     | `SELECT, INSERT, UPDATE, DELETE` on exactly the listed tables                                     |
| **D — collector evaluation inputs** | users / team memberships, project-derived exclusion inputs, legacy résumé inputs (r5's list) | as class A                                                                                     | `SELECT` — **column-level** on any table that also carries credentials, tokens or finance columns |
| **E — migration-internal**          | The migration ledger (§6), any deploy bookkeeping                                            | nothing                                                                                        | nothing                                                                                           |

**Never granted to `crm_app` or `crm_collector`, on any class:** `TRUNCATE`, `REFERENCES`,
`TRIGGER` (the right to _create_ triggers on a table), and any `WITH GRANT OPTION`. `crm_collector`
gets nothing on finance, session or credential tables, per r5 — this is enforced by class D being
column-level and by the default privileges below granting the collector **nothing**.

**Sequences.** `crm_app`: `USAGE, SELECT` (calls `nextval`, reads `currval`). Never `UPDATE`, which
is `setval` — the ability to rewind a sequence and collide ids. `crm_collector`: `USAGE` on the
sequences of its class C tables only. Identity columns need no sequence grant; `uuid`
`gen_random_uuid()` defaults need none.

**Functions.** No `SECURITY DEFINER` function exists, and none may be added without an explicit
justification in its own PR: a definer function runs as its owner (`crm_user`) and is a hole
through every boundary here. If one is ever added, it must `SET search_path = pg_catalog, public`
and have `EXECUTE` revoked from `PUBLIC` and granted by name. Trigger functions cannot be called
directly, so the §3 trigger functions need no `EXECUTE` handling.

**Database and schema.** `REVOKE ALL ON DATABASE crm_db FROM PUBLIC` (removes the implicit
`CONNECT` and `TEMPORARY`), then `GRANT CONNECT` to `crm_app` and `crm_collector`. `GRANT USAGE ON
SCHEMA public` to both. `REVOKE CREATE ON SCHEMA public FROM PUBLIC` — already the default on a
cluster initialised by PostgreSQL 15+, issued explicitly so the file is correct on any cluster.
No `TEMPORARY` for either role; if the API ever needs temp tables, the grant is added by a PR and
the need is stated there.

**Default privileges — so a new table is neither unreachable nor over-granted.**

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE crm_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
-- crm_collector: deliberately NO default privileges (fail closed).
```

What this gives, exactly:

- A new class A table is reachable by the API the moment it is created. Nothing to remember.
- A new table the **collector** needs is unreachable until a grant names it. Fail closed is loud: the
  worker gets `permission denied` (SQLSTATE `42501`), not wrong data.
- A new class B table starts **over-granted** (it inherits `UPDATE, DELETE` for `crm_app`). The DDL
  file that creates it must revoke them and add the §3 triggers **in the same explicit
  `BEGIN … COMMIT` block** as the `CREATE TABLE` — the deploy applies files with statement-level
  autocommit, so without the block there is a window where the new table is mutable.
- **The trap:** default privileges apply only to objects created **by `crm_user`** (the `FOR ROLE`).
  A table created by any other role gets no grants at all. Every DDL path in this repository runs as
  `crm_user` today; that must stay true, and the catalog check below catches it if it does not.

**The catalog check — what makes "silently" impossible.** One check, run in CI against a scratch
database built from the same DDL, and as a deploy step right after the DDL apply steps:

1. Every table in `public` appears in the class manifest exactly once. A table missing from the
   manifest **fails the check** — the author of a new table must choose its class.
2. For every table and both roles, `has_table_privilege` for each of `SELECT, INSERT, UPDATE,
DELETE, TRUNCATE, REFERENCES, TRIGGER` equals what the class prescribes — no more, no less.
3. `crm_app` and `crm_collector`: `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolbypassrls`,
   `rolreplication` are all false; they own no object (`pg_class.relowner`); they have no rows in
   `pg_auth_members`.
4. Every class B table has its §3 triggers, in state `A` (`ENABLE ALWAYS`) in `pg_trigger.tgenabled`.

This is the same philosophy as `check-prod-ddl-wiring.py`: an enumeration in one place, and CI fails
when reality and the enumeration diverge. Confidence **MED** on where the check lives (a script in
`scripts/devops/` called from both CI and deploy, or the "catalog validation" step the ledger ADR is
asked for — see §6); **HIGH** that it must exist, because without it the four failure modes above
are invisible until production.

### 3. The append-only audit log under the new model

TODO

### 4. Rollout without downtime

TODO

### 5. Impact on local development, CI and the integration-test guards

TODO

### 6. Relationship to the migration-ledger ADR

TODO

## Consequences

TODO

## Rollback

TODO

## Sources

TODO
