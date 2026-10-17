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
3. **Changing only the URL is not enough, and removing the password is not enough either.** The
   deploy writes the `crm_user` password into `.env.production` twice — as `POSTGRES_PASSWORD` and
   inside `DATABASE_URL` — and the `api` service has loaded that file **since the first deploy**.
   Taking the password out of the API's environment does not revoke it: anyone who ever read the
   API's environment, and any container on the backend network, can still log in as `crm_user`
   over TCP. The password must be **rotated in the database** and TCP login for `crm_user` refused
   (§4, step 7). The image reads `POSTGRES_PASSWORD` **only at first initialisation** of an empty
   data directory, so changing the CI secret alone changes nothing in a running cluster.

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

| Class                                                | Members (examples, by table)                                                                 | `crm_app`                                                                                                     | `crm_collector`                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A — ordinary**                                     | Default for every product table: users, projects, transactions, contracts, …                 | `SELECT, INSERT, UPDATE, DELETE`                                                                              | nothing                                                                                           |
| **B — append-only**                                  | `job_queue_actions`; any future audit / action log                                           | `SELECT, INSERT` only — `UPDATE, DELETE, TRUNCATE` explicitly revoked, plus the triggers in §3                | nothing, unless r5 names it                                                                       |
| **C — job-sourcing**                                 | The job-sourcing tables r5 Task 1.3 lists for the collector                                  | as class A                                                                                                    | `SELECT, INSERT, UPDATE, DELETE` on exactly the listed tables                                     |
| **D — collector evaluation inputs**                  | users / team memberships, project-derived exclusion inputs, legacy résumé inputs (r5's list) | as class A                                                                                                    | `SELECT` — **column-level** on any table that also carries credentials, tokens or finance columns |
| **A-log — existing audit logs, not yet append-only** | The six existing audit tables, listed below                                                  | `SELECT, INSERT`; `DELETE` **only** on `document_access_log` (its retention cron); no `UPDATE`, no `TRUNCATE` | nothing                                                                                           |
| **E — migration-internal**                           | The migration ledger (§6), any deploy bookkeeping                                            | nothing                                                                                                       | nothing                                                                                           |

**The existing audit logs (SR-M-1) — this reaches beyond the vacancy feature.** The CRM already
has six audit tables. Under a blanket class A they would give `crm_app` `UPDATE` and `DELETE` on
the finance audit trail, which is exactly what an injected statement would want. They cannot simply
become class B either, because class B's triggers would break today's behaviour:

| Table                                             | FKs out of the table (on delete)                                                    | Writes by the API other than `INSERT`                                     | Blocks class B                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `user_audit_log`                                  | `actor_id` → users `SET NULL`; `target_id` → users `CASCADE`                        | none found                                                                | both FKs: deleting a user would fire the `UPDATE` / `DELETE` trigger and fail |
| `team_audit_log`                                  | `actor_id` → users `SET NULL`; team → teams `CASCADE`                               | none found                                                                | both FKs                                                                      |
| `project_audit_log`                               | `actor_id` → users `SET NULL`; project → projects `CASCADE`                         | none found                                                                | both FKs                                                                      |
| `transaction_audit_log` (the finance audit trail) | `actor_id` → users `SET NULL`; the target is a plain id, no FK                      | none found                                                                | the `SET NULL` FK                                                             |
| `document_access_log`                             | `actor_id` → users `SET NULL`                                                       | **`DELETE`** — `DocumentAccessLogRetentionCronService`, daily, as the API | the FK, and the API's own pruning                                             |
| `meeting_recorder_audit_log`                      | `actor_user_id` → users, `connection_id`, `interview_recording_id` — all `SET NULL` | none found                                                                | the `SET NULL` FKs                                                            |

("None found" = no Drizzle `.update(…)` / `.delete(…)` and no raw `UPDATE` / `DELETE` / `TRUNCATE`
against the table in `apps/api/src` outside specs, checked 2026-10-17; the seed truncates them as
`crm_user`. The security review counted five; the sixth, `meeting_recorder_audit_log`, lives in the
interviews schema module. The implementing task re-runs the search.)

**Decision for now — class A-log, privileges only, no triggers.** Revoking `UPDATE`, `DELETE` and
`TRUNCATE` from `crm_app` on these tables breaks **nothing** that runs today: the `SET NULL` and
`CASCADE` actions are executed with the privileges of the table's **owner** (`crm_user`), not of
the role that deleted the user, so user, team and project deletion keep working; and the API issues
no `UPDATE` / `DELETE` on them except the `document_access_log` cron, which keeps `DELETE` on that
one table. What this buys: a compromised API can no longer rewrite or delete rows of the
transaction, user, team, project and meeting-recorder audit logs directly, only add rows. What it
does **not** buy: an attacker can still erase an audit row's link to a person **indirectly**, by
deleting the user (or team, or project) — if `crm_app` may delete those — because the referential
action runs as the owner. And `document_access_log` stays fully deletable by the API. Confidence
**HIGH** on the privilege behaviour (owner-run referential actions are what makes the interim safe).

**What must change before any of them can become class B** (each a separate task, outside this
ADR; `transaction_audit_log` is critical-path and needs a security review):

1. **FKs.** `SET NULL` / `CASCADE` → `RESTRICT`, or drop the FK and keep the id as plain data. That
   requires a decided user / team / project deletion policy (soft delete, or sentinel
   re-pointing), because with `RESTRICT` a hard delete of a referenced user fails.
2. **Pruning.** `document_access_log` retention moves off the API's credential onto the
   end-of-retention path §3 defines — whichever option the owner decides there.
3. **Erasure.** The same legal question the memo of PR #1019 answers for `job_queue_actions`
   applies to these tables; their end-of-retention path follows the same owner decision.

**Never granted to `crm_app` or `crm_collector`, on any class:** `TRUNCATE`, `REFERENCES`,
`TRIGGER` (the right to _create_ triggers on a table), and any `WITH GRANT OPTION`. `crm_collector`
gets nothing on finance, session or credential tables, per r5 — this is enforced by class D being
column-level and by the default privileges below granting the collector **nothing**.

**Sequences.** `crm_app`: `USAGE, SELECT` (calls `nextval`, reads `currval`). Never `UPDATE`, which
is `setval` — the ability to rewind a sequence and collide ids. `crm_collector`: `USAGE` on the
sequences of its class C tables only. Identity columns need no sequence grant; `uuid`
`gen_random_uuid()` defaults need none.

**Functions.** By default, PostgreSQL grants `EXECUTE` on every new function to `PUBLIC`. File 1
revokes that, both for what exists and for what is created later (SR-L-4):

```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_user REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

A function the API must call is then granted to `crm_app` by name, in the PR that adds it. Built-ins
in `pg_catalog` (`gen_random_uuid`, `now`, …) are unaffected. Firing a trigger does not check
`EXECUTE` on the trigger function, so the §3 triggers keep working.

No `SECURITY DEFINER` function exists today. A definer function runs as its owner (`crm_user`) and
is a hole through every boundary here, so one may be added only in the narrow form §3 describes
for the end-of-retention option R-B, if the owner chooses it: a fixed `search_path = pg_catalog,
public`, `EXECUTE` revoked from `PUBLIC` and granted by name, and arguments validated inside the
body. Any other definer function needs its own ADR-level justification.

**Database and schema.** On `crm_db`: `REVOKE ALL ON DATABASE crm_db FROM PUBLIC` (removes the
implicit `CONNECT` and `TEMPORARY`), then `GRANT CONNECT` to `crm_app` and `crm_collector`. On the
**other** databases of the cluster — `postgres` (the maintenance database) and `template1` —
`REVOKE CONNECT, TEMPORARY … FROM PUBLIC` as well; otherwise `crm_app` can still connect to
`postgres` and create temporary tables there (SR-L-2). `pg_hba.conf` (§4 step 7) confines both
application roles to `crm_db` at the network layer too. Schema: `GRANT USAGE ON SCHEMA public` to
both; `REVOKE CREATE ON SCHEMA public FROM PUBLIC` — already the default on a cluster initialised
by PostgreSQL 15+, issued explicitly so the file is correct on any cluster. No `TEMPORARY` for
either role; if the API ever needs temp tables, the grant is added by a PR that states why.

**Default privileges — so a new table is neither unreachable nor over-granted.**

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE crm_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_user
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- crm_collector: deliberately NO default privileges (fail closed).
```

What this gives, exactly:

- A new class A table is reachable by the API the moment it is created. Nothing to remember.
- A new table the **collector** needs is unreachable until a grant names it. Fail closed is loud: the
  worker gets `permission denied` (SQLSTATE `42501`), not wrong data.
- A new class B, A-log or **E** table starts **over-granted** (it inherits `UPDATE, DELETE` for
  `crm_app`; a new ledger table would be fully writable by the API). The DDL file that creates it
  must revoke those grants — and for class B add the §3 triggers — **in the same explicit
  `BEGIN … COMMIT` block** as the `CREATE TABLE`. The deploy applies files with statement-level
  autocommit, so without the block there is a window where the new table is mutable. File 2
  re-asserts the revokes on every deploy, inside its own transaction (§4).
- **The trap:** default privileges apply only to objects created **by `crm_user`** (the `FOR ROLE`).
  A table created by any other role gets no grants at all. Every DDL path in this repository runs as
  `crm_user` today; that must stay true, and the catalog check below catches it if it does not.

**The catalog check — what makes "silently" impossible.** One check, run in CI against a scratch
database built from the same DDL, and as a deploy step right after the DDL apply steps. It reads
five catalogs, because `has_table_privilege` alone sees neither sequences, nor column grants, nor
default privileges (SPEC-M-3):

1. **Manifest coverage.** Every table in `public` appears in the class manifest exactly once. A
   table missing from the manifest **fails the check** — the author of a new table must choose its
   class.
2. **Table privileges.** For every table and both roles, `has_table_privilege` for each of `SELECT,
INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` equals what the class prescribes — no
   more, no less. For class D tables with column-level grants, the table-level `SELECT` for
   `crm_collector` must be **false** (a table-level grant would silently cover every column).
3. **Column privileges.** For class D, the set of `(table, column)` pairs with `SELECT` for
   `crm_collector` (`information_schema.column_privileges`, or `has_column_privilege` per column)
   equals the manifest's column list exactly. `has_table_privilege` cannot see these.
4. **Sequence privileges.** For every sequence in `public`, `has_sequence_privilege` gives `crm_app`
   `USAGE` and `SELECT` and **not** `UPDATE`; `crm_collector` only `USAGE`, and only on sequences of
   its class C tables.
5. **Default privileges.** `pg_default_acl` holds exactly the three entries of the block above for
   `defaclrole = crm_user` — tables (`crm_app=arwd`), sequences (`crm_app=rU`), functions (no
   `PUBLIC` `EXECUTE`) — and no entry for any other role, so a stray `ALTER DEFAULT PRIVILEGES` is
   caught.
6. **Database and function privileges.** `has_database_privilege` — `crm_app` / `crm_collector` have
   `CONNECT` on `crm_db` only, `TEMPORARY` nowhere, and `CREATE` on schema `public` is false.
   `has_function_privilege` — `PUBLIC` holds `EXECUTE` on no function in `public`.
7. **Role attributes and ownership.** For `crm_app` and `crm_collector`: `rolsuper`,
   `rolcreaterole`, `rolcreatedb`, `rolbypassrls`, `rolreplication` are all false; they own no
   object (`pg_class.relowner`, `pg_proc.proowner`, `pg_namespace.nspowner`).
8. **Role membership — in both directions, pinned (SR-L-3).** `pg_auth_members` has **zero** rows
   with `member` = `crm_app` or `crm_collector` (they are members of no role — the direction that
   matters, because membership is what would let them `SET ROLE` to an owner), and zero rows with
   `roleid` = either of them (nobody is a member of them, so no one inherits their grants by
   accident). The check names the column it tests; "no membership" without a direction is how a
   check passes while testing the harmless side.
9. **Triggers.** Every class B table has its §3 triggers, in state `A` (`ENABLE ALWAYS`) in
   `pg_trigger.tgenabled`.

This is the same philosophy as `check-prod-ddl-wiring.py`: an enumeration in one place, and CI fails
when reality and the enumeration diverge. Confidence **MED** on where the check lives (a script in
`scripts/devops/` called from both CI and deploy, or the "catalog validation" step the ledger ADR is
asked for — see §6); **HIGH** that it must exist, because without it every failure mode listed in
this section is invisible until production.

### 3. The append-only audit log under the new model

Applies to `job_queue_actions` and to every future class B table. Task 1.3 implements from this
text; everything below is stated as a property the schema **delivers** and a test that proves it,
because a guarantee without its test is the failure mode of the previous PR on this feature.

**Layer 1 — privileges (binds `crm_app`, `crm_collector`; does not bind `crm_user`).**
`crm_app` holds `SELECT, INSERT` only. `UPDATE`, `DELETE` and `TRUNCATE` are revoked explicitly
(`REVOKE UPDATE, DELETE, TRUNCATE ON job_queue_actions FROM crm_app`) — explicit because the
default privileges of §2 grant `UPDATE, DELETE` to every new table. `crm_collector` holds nothing
on the log unless r5 names a reason. Consequences for application code: idempotent writes use
`INSERT … ON CONFLICT DO NOTHING` (needs `INSERT` only); `ON CONFLICT DO UPDATE` needs `UPDATE`
and is therefore refused — by design.

**Layer 2 — triggers (binds every role that does not disable them, superuser included).**

- A `BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger that raises an exception unconditionally.
- A `BEFORE TRUNCATE … FOR EACH STATEMENT` trigger that raises. A row-level `DELETE` trigger does
  **not** fire on `TRUNCATE`; without this second trigger, `TRUNCATE` empties the log silently.
- Both set to `ENABLE ALWAYS` (`ALTER TABLE … ENABLE ALWAYS TRIGGER …`). A trigger in the default
  state is skipped when `session_replication_role = replica`; an `ALWAYS` trigger fires in every
  mode. This removes the replication-role bypass even for a superuser who has not touched the
  trigger itself.
- The exception carries a dedicated SQLSTATE and message, so a test can tell "refused by the
  trigger" from "refused by a privilege" (SQLSTATE `42501`).

**Layer 3 — foreign keys out of the log.** Every FK **from** a class B table uses `ON DELETE
RESTRICT` (or `NO ACTION`) and `ON UPDATE NO ACTION` — never `CASCADE`, `SET NULL` or `SET
DEFAULT`. The reason is exact: referential actions run with the privileges of the table's
**owner**, not of the role that deleted the parent row. A cascading FK would let `crm_app` delete
or rewrite log rows by deleting a parent it is allowed to delete; layer 1 would not see it. Layer 2
would still fire (row triggers fire for rows changed by referential actions) and refuse the whole
statement — loud, but it turns an ordinary parent delete into an error at runtime. `RESTRICT` makes
the same refusal a declared, testable part of the schema. PR #1017 already declares the actor FKs
`restrict`; Task 1.3 must hold every FK on the log to this rule.

**What the three layers guarantee, by actor.** "Refused" means the statement fails and no row
changes.

| Actor                                                                                     | Can it UPDATE / DELETE a log row?                                                                              | TRUNCATE?              | Disable or drop a trigger?                                                                                                                                                                                                                                                                                                    | Forge a new row?          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| A bug in API code (`crm_app`, ORM SQL)                                                    | Refused by layer 1; layer 2 refuses even if a grant is wrongly added                                           | Refused (layers 1 + 2) | No — not the owner                                                                                                                                                                                                                                                                                                            | **Yes** — it has `INSERT` |
| SQL injection / compromised API process (`crm_app`, arbitrary SQL)                        | Refused (layers 1 + 2; layer 3 closes the cascade path)                                                        | Refused                | **Only after §4 step 7:** no — it is not the owner, not a member of `crm_user`, not a superuser, and the `crm_user` password it once held has been rotated in the database and TCP login for `crm_user` is refused. **Before step 7: yes** — it can log in as `crm_user` with the password it has held since the first deploy | **Yes**                   |
| Collector process (`crm_collector`)                                                       | Refused — no grant                                                                                             | Refused                | No                                                                                                                                                                                                                                                                                                                            | No — no `INSERT`          |
| Deploy DDL / anyone holding `crm_user`                                                    | **Not protected.** Can `DISABLE TRIGGER` or `DROP TRIGGER` (owner), then `UPDATE` / `DELETE`; can `DROP TABLE` | **Not protected**      | **Yes**                                                                                                                                                                                                                                                                                                                       | Yes                       |
| Superuser / anyone with shell on the VPS (`docker exec` reaches the trusted local socket) | **Not protected**                                                                                              | **Not protected**      | **Yes**                                                                                                                                                                                                                                                                                                                       | Yes                       |

What remains unprotected, stated so that nobody documents more than the schema delivers:

1. **Nothing in the database protects the log from `crm_user`.** Ownership alone suffices to
   disable the triggers; demoting `crm_user` from superuser would not change this. The protection
   against the migration role is **procedural and detective only**: DDL reaches production only as
   reviewed files applied by `deploy.yml`; the nightly `pg_dump` keeps earlier copies of the log.
2. **Append-only is not authenticity.** `crm_app` can insert a row with any actor, kind and reason
   that passes the table's `CHECK` constraints. The log proves "nothing written was later changed
   through the API's credential", not "every row is true". Tamper evidence (hash chaining,
   external anchoring) is out of scope.
3. **Insert volume is not bounded** by these layers (a compromised API can flood the log); that is
   a rate-limit concern, not an immutability one.
4. **Retention of class B rows** — if r5 Task 1.4 ever requires deleting old action rows, that
   deletion is a reviewed migration-role operation (a DDL file that disables the trigger, deletes,
   and re-enables it inside one transaction). The application never receives `DELETE` on the log.

**Tests that prove the layers** (AutoTest zone; Task 1.3 replaces the "GAP PIN" test of PR #1017
with these). Each layer needs its own test, run as the role it is about — a test run as `crm_user`
proves the trigger and **nothing** about privileges:

| Test                                                             | Connects as                  | Expect                                                             |
| ---------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `UPDATE` / `DELETE` of a log row                                 | `crm_app`                    | SQLSTATE `42501` (privilege)                                       |
| `UPDATE` / `DELETE` of a log row                                 | `crm_user`                   | the trigger's SQLSTATE (trigger fires for the owner while enabled) |
| `TRUNCATE`                                                       | `crm_user`                   | the trigger's SQLSTATE                                             |
| `UPDATE` under `SET session_replication_role = replica`          | `crm_user` (superuser in CI) | the trigger's SQLSTATE — proves `ENABLE ALWAYS`                    |
| Delete a parent row referenced by a log row                      | `crm_app`                    | FK violation (`23503`), log row intact                             |
| `ALTER TABLE … DISABLE TRIGGER`                                  | `crm_app`                    | `42501` (must be owner)                                            |
| `INSERT … ON CONFLICT DO NOTHING` on a duplicate idempotency key | `crm_app`                    | succeeds, no new row                                               |

Confidence **HIGH** on every PostgreSQL behaviour above (documented in the PostgreSQL 16 manual:
`CREATE TRIGGER` — truncate triggers; `ALTER TABLE` — `ENABLE ALWAYS`, ownership for `DISABLE
TRIGGER`; `INSERT` — privileges for `ON CONFLICT`). The implementing task re-proves each with the
tests above rather than citing this ADR.

### 4. Rollout without downtime

"Without downtime" means: no maintenance window and no step that stops the API beyond the
container swap every deploy already does. Steps marked **[OWNER]** can be performed only by the
owner (production shell, CI secrets, merge); per `docs/runbooks/human-only.md` each is reduced to
one line, everything else is automated. Each step leaves a working production.

**Shape of the DDL (two files, for ordering).** The deploy re-applies every manual file on every
deploy, in a fixed order. Roles must exist before any file mentions them, and table-wide grants
must run after every table exists. So:

- **File 1 — roles** (applied **first**): creates `crm_app` (and later `crm_collector`) if missing
  (a `DO` block — `CREATE ROLE` has no `IF NOT EXISTS`), sets their attributes, sets the passwords
  of `crm_app`, `crm_collector` **and `crm_user`** (step 7), the database and schema rules, and the
  default privileges of §2.
- **File 2 — grants** (applied **last**), as **one explicit transaction** (`BEGIN … COMMIT`):
  `GRANT … ON ALL TABLES / ALL SEQUENCES IN SCHEMA public` to `crm_app`, then, inside the same
  transaction, the revokes for every class B, class A-log and class E table, then the collector's
  class C / D grants. Privileges are catalog rows under MVCC, so no other session ever sees the
  intermediate state in which the log or the ledger is briefly granted; without the transaction,
  every deploy would re-grant `UPDATE, DELETE` on the log and grant the ledger to `crm_app` for the
  length of a few statements. Idempotent; re-applying it every deploy also repairs drift.

Both follow the existing wiring contract (r5 C-15: scp `source:` entry, an apply step, the
hard-required file list, runbook §9 mirror; `check-prod-ddl-wiring.py` stays green).

**Password handling in file 1 — three traps, each closed.** Confidence **HIGH** on the traps,
**MED** on the plumbing (DevOps chooses):

1. **The server log.** Even with `log_statement = none`, a **failing** statement is logged with its
   full text (`log_min_error_statement` defaults to `error`), so an `ALTER ROLE … PASSWORD 'plain'`
   that fails — say, on a typo in the role name — writes the plain password to the server log.
   Therefore file 1 **never sends a plain password**: the deploy computes a SCRAM-SHA-256 verifier
   from the secret on the CI runner and sends only the verifier (`ALTER ROLE … PASSWORD
'SCRAM-SHA-256$…'` is stored as given). As a second belt, file 1 starts with `SET
log_min_error_statement = panic` (settable because it runs as `crm_user`, a superuser; if step 0
   shows it is not, the verifier alone carries the guarantee).
2. **The host's process list.** `docker compose exec -e NAME=value` puts the value in the argv of a
   process on the VPS, readable by any local user via `ps`. Pass the **name only** —
   `exec -e NAME` — so the value is taken from the calling environment; and never `psql -v
name=value`.
3. **`DO` blocks.** psql substitutes `:'var'` in ordinary statements, **not** inside a `DO $$ … $$`
   body. So the `DO` block only creates missing roles, without a password; the passwords are set
   by plain `ALTER ROLE … PASSWORD :'app_verifier'` statements after it, reading the variable via
   psql `\getenv` (psql 15+).

Re-applying file 1 every deploy makes rotation of any of the three passwords "change the secret,
deploy".

**The environment split (SR-M-4).** Compose interpolates `${POSTGRES_PASSWORD:?…}` in
`docker-compose.prod.yml` from the file given to `--env-file` — today the same `.env.production`
the `api` service loads as its `env_file`. So the owner password cannot leave the API's
environment while both come from one file. PR B splits it:

| File                 | Loaded by                                                 | Contains                                                                                           | Must never contain                                                                          |
| -------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `.env.production`    | the `api` service (`env_file`) and Compose's `--env-file` | `DATABASE_URL` for `crm_app`; non-secret `POSTGRES_USER` / `POSTGRES_DB` (the DDL steps read them) | the `crm_user` password in any form; any URL with user `crm_user`; `MIGRATION_DATABASE_URL` |
| a postgres-only file | the `postgres` service only (`env_file`)                  | `POSTGRES_PASSWORD`                                                                                | anything the API needs                                                                      |

The `postgres` service drops its `${POSTGRES_PASSWORD:?…}` interpolation and reads the variable
from its own file. `MIGRATION_DATABASE_URL` (§5) exists **only** in CI and on developer machines;
production has no use for it, because every production DDL path goes over the local socket.

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Who                                                                                     | Effect on production                                                  | Done when                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0   | Read-only check of the current role (commands below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **[OWNER]**                                                                             | none                                                                  | The answer is recorded in the implementing PR                                                                           |
| 1   | Add the CI secret `CRM_APP_DB_PASSWORD` (value: `openssl rand -hex 32` — hex, so it is URL-safe in `DATABASE_URL`). One line: "Settings → Secrets → New: `CRM_APP_DB_PASSWORD`, value from `openssl rand -hex 32`"                                                                                                                                                                                                                                                                                                                                                        | **[OWNER]**                                                                             | none                                                                  | The deploy fails loudly if the secret is absent                                                                         |
| 2   | PR A (DevOps): files 1 and 2, their wiring, the catalog check (§2) as a deploy step after the DDL steps and as a CI job. The API still connects as `crm_user`                                                                                                                                                                                                                                                                                                                                                                                                             | DevOps; merge **[OWNER]**                                                               | Roles and grants exist; behaviour unchanged                           | Deploy green, catalog check green                                                                                       |
| 3   | Automated probes, in the same deploy, **from a throwaway client container on the backend network** (e.g. a one-off `postgres:16-alpine` run with `--no-deps`), connecting to host `postgres` — never from inside the postgres container, where `127.0.0.1` and `::1` are `trust` and a wrong password also succeeds. Probes: `crm_app` with the right password → accepted; `crm_app` with a deliberately wrong password → **refused** (proves the probe is not hitting a trust rule); inside a rolled-back transaction, `UPDATE job_queue_actions` as `crm_app` → `42501` | DevOps (in PR A)                                                                        | none                                                                  | All probes as expected                                                                                                  |
| 4   | CI runs the API **as `crm_app`** (§5) on `main` — the only real proof that the grants are sufficient for every query the code makes                                                                                                                                                                                                                                                                                                                                                                                                                                       | DevOps + AutoTest                                                                       | none                                                                  | CI green on `main` with the new connection                                                                              |
| 5   | PR B (DevOps): the deploy writes `DATABASE_URL` with `crm_app` and `CRM_APP_DB_PASSWORD`, and splits the environment as in the table above                                                                                                                                                                                                                                                                                                                                                                                                                                | DevOps; merge **[OWNER]**                                                               | The API restarts as `crm_app`, as on any deploy                       | Deploy green and step 6 checks green                                                                                    |
| 6   | Verify (commands below): API sessions are `crm_app` only; the API container's environment contains neither the `crm_user` password **value**, nor any `crm_user@` URL, nor `MIGRATION_DATABASE_URL`; a sign-in, a finance page read and one write work; no `permission denied` in API logs for 48 h                                                                                                                                                                                                                                                                       | DevOps automates the first two as deploy steps; the smoke and the log watch **[OWNER]** | none                                                                  | All four hold                                                                                                           |
| 7   | **Revoke the old owner credential (PR C, DevOps).** (a) **[OWNER]** sets the CI secret `POSTGRES_PASSWORD` to a new `openssl rand -hex 32`; (b) the deploy rotates `crm_user`'s password **in the database** to that value (file 1 does it on every deploy over the local socket, so the database and the secret cannot drift); (c) `pg_hba.conf` refuses TCP login for `crm_user` (below); (d) the deploy refuses to write any `DATABASE_URL` whose user is `crm_user`                                                                                                   | DevOps; secret and merge **[OWNER]**                                                    | none — nothing legitimate logs in as `crm_user` over TCP after step 5 | The step 3 probes, extended: `crm_user` over TCP refused with **both** the old and the new password; `crm_app` accepted |
| 8   | Collector, when the worker ships as its own process: `CRM_COLLECTOR_DB_PASSWORD` **[OWNER]**, the role in file 1, class C / D grants in file 2, the URL only in the worker's environment                                                                                                                                                                                                                                                                                                                                                                                  | r5 Task 1.3 / DevOps                                                                    | Worker runs as `crm_collector`                                        | Catalog check covers `crm_collector`                                                                                    |

**Step 7 — why rotation, and why refusing TCP is required, not recommended.** The `crm_user`
password has been readable from the API's environment since the first deploy, so it must be
treated as disclosed: removing it from the environment (step 5) stops **future** reads, rotation
invalidates the **past** ones. The Postgres image applies `POSTGRES_PASSWORD` only when it
initialises an empty data directory; on a running cluster only `ALTER ROLE crm_user PASSWORD …`
changes it, which is why file 1 re-asserts it from the secret on every deploy. Refusing TCP login
for `crm_user` is **required**: every legitimate use of `crm_user` — the DDL apply steps, the
backup, the owner's checks — goes over the trusted local socket inside the container, so the rule
costs nothing, and it is the only control that still holds if the **new** password leaks too (it
lives in a CI secret and in the `postgres` service's environment). The rule set, in order:
`local all all trust` (unchanged — the deploy depends on it); `host crm_db crm_app,crm_collector
<backend network> scram-sha-256`; `host all all all reject`. That also confines both application
roles to `crm_db` at the network layer (SR-L-2). It is installed by writing the file in the data
volume and calling `pg_reload_conf()` — a reload, not a restart, so no downtime; pointing
`hba_file` at a mounted file would need a server restart. The deploy re-asserts the file and
reloads on every run. Confidence **HIGH** on the need, **MED** on the install mechanics (DevOps
chooses).

**Step 0 — the owner's read-only check.** The brief's form, plus the attributes this design depends
on:

```bash
ssh crm-vps "docker exec crm-postgres-1 psql -U crm_user -d crm_db -tAc \"SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user\""
# extended (same, read-only):
ssh crm-vps "docker exec crm-postgres-1 psql -U crm_user -d crm_db -tAc \"SELECT rolname, rolsuper, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = current_user; SHOW log_statement; SHOW log_min_error_statement;\""
```

How each answer changes the plan:

- `rolsuper = t` (expected): the plan as written.
- `rolsuper = f, rolcreaterole = t`: the plan as written (`CREATE ROLE` needs `CREATEROLE`), except
  that file 1 cannot `SET log_min_error_statement`; the SCRAM verifier alone keeps passwords out of
  the log.
- `rolsuper = f, rolcreaterole = f`: file 1 cannot run as `crm_user`. **Stop (A3)** — the owner must
  find who holds superuser in that cluster; nothing is changed until then.

**Step 6 — verification commands** (read-only; the deploy runs the first two itself after PR B):

```bash
ssh crm-vps "docker exec crm-postgres-1 psql -U crm_user -d crm_db -tAc \"SELECT usename, count(*) FROM pg_stat_activity WHERE datname = 'crm_db' AND backend_type = 'client backend' GROUP BY 1\""
#  expect: crm_app with the pool's sessions; crm_user only for this check itself
```

The environment check must look for the password **value**, not a variable name — a renamed
variable, or the password embedded in some URL, would pass a name check. The deploy step runs, on
the VPS, `docker compose exec -T api printenv` and fails if the output contains the `crm_user`
password (matched with `grep -F -f` reading the pattern from a file descriptor, so the value never
enters argv), the string `crm_user@`, or `MIGRATION_DATABASE_URL`.

**Rollback (by step).** Rule: **no rollback ever puts the `crm_user` credential back into the
API's environment, and none can leave the API without a working credential.**

- **After step 2 or 3** — nothing uses the roles. Leave them, or a forward file that drops them
  (`DROP OWNED` + `DROP ROLE`; they own nothing). The API is unaffected.
- **After step 5, before step 7 — a missing grant or a wrong class.** Fix forward: a line in file 2,
  deployed. If production needs relief faster than a PR, the emergency file widens `crm_app` to the
  class A grant on every table (still not the owner, still no DDL, no `TRUNCATE`, no trigger
  control) — the boundary narrows, it does not disappear.
- **After step 5, before step 7 — `crm_app` cannot log in at all** (a wrong verifier, a secret
  mismatch). File 1 re-asserts the password from the secret on the next deploy; the **[OWNER]**
  re-enters `CRM_APP_DB_PASSWORD` and re-runs the deploy. To keep this case from ever reaching
  users, PR B orders the deploy so that the step 3 `crm_app` login probe runs **after** file 1 and
  **before** the `api` container is recreated: if `crm_app` cannot log in, the deploy stops while
  the old container is still serving. Recreation today is a plain `docker compose up -d`, not a
  health-gated swap, so this ordering is the only thing that guarantees it.
- **Reverting PR B is not a rollback path.** It would silently restore the `crm_user` credential to
  the API. Before step 7 it would work, which is exactly the problem; after step 7 it fails closed —
  check (d) of step 7 refuses the deploy, and even without (d) the `crm_user` TCP login is refused,
  so the API would start with no working credential. Hence check (d), and hence the forward fixes
  above.
- **After step 7.** Forward only, as above. Undoing step 7 itself means re-opening TCP for
  `crm_user`; that is an **[OWNER]** A3 decision, not a rollback.
- **Note on image rollback.** `workflow_dispatch` with `image_tag` (runbook §9) redeploys an old
  image but writes the environment from the current workflow, so after step 5 an old image also
  runs as `crm_app`. That is safe: class A grants are table-wide, so older code finds every table it
  used. It is not a way to undo step 5.

**Restore from backup — the ordered procedure (SR-M-6).** `pg-backup.sh` dumps with `--no-owner
--no-acl`, and its restore notes restart the API right after `psql`. Under this ADR that order
breaks: the restored objects carry no grants, default privileges live per database
(`pg_default_acl`) and are not in the dump, so the API would either fail every query or — on a fresh
database — the deploy's grants would not yet exist. The procedure becomes:

1. Stop the API (as today).
2. Restore as `crm_user` over the local socket (as today), so `crm_user` owns every restored object.
3. Apply file 1, then file 2 (or run a deploy, which does both in order).
4. Run the catalog check; it must pass.
5. Only then start the API.

The implementing PR rewrites the restore notes in `pg-backup.sh` and the runbook to this order.
On a **fresh** cluster (disaster recovery onto an empty volume), `POSTGRES_PASSWORD` initialises
`crm_user` with the current secret, then the same five steps apply.

### 5. Impact on local development, CI and the integration-test guards

Today one variable, `DATABASE_URL`, serves the API, `drizzle-kit` (`drizzle.config.ts`),
`db:seed`, the integration specs and the guards. After this ADR there are **two connection
strings with two jobs**:

| Variable                                                                 | Role       | Used by                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                           | `crm_app`  | The API process (`DatabaseService`) and the service code integration specs exercise                                                                                                                         |
| `MIGRATION_DATABASE_URL` (name to be confirmed by the implementing task) | `crm_user` | `drizzle.config.ts` (`db:push`), `db:seed` (it `TRUNCATE`s, and `crm_app` has no `TRUNCATE`), applying the manual SQL and files 1 / 2 to scratch databases, fixture setup and teardown in integration specs |

Decisions (confidence **MED** — the direction is clear; the mechanics need the implementing task's
experiment):

1. **CI runs the API as `crm_app`.** The CI service containers keep `POSTGRES_USER: crm_user`
   (bootstrap superuser, as in production); a setup step applies files 1 and 2 to `crm_ci`; the
   E2E API process and the integration specs' service code get the `crm_app` URL. This is §4
   step 4: a missing grant fails CI, not production. Without it the role split is tested only in
   production.
2. **Local development follows in two stages.** First release: `.env.example` documents both
   variables, and `DATABASE_URL` may still point at `crm_user` locally — nothing breaks. Second
   release, once CI has been green as `crm_app`: `.env.example` points `DATABASE_URL` at
   `crm_app`, and one bootstrap command applies files 1 and 2 to the local database.
   `docker-compose.yml` keeps `POSTGRES_USER: crm_user`.
3. **`db:push` ordering locally.** Default privileges are attached to `crm_user`, so tables that
   `db:push` creates as `crm_user` after the bootstrap get class A grants automatically; class B
   tables need file 2 re-applied (the bootstrap command does both). The catalog check (§2) is the
   same script locally and in CI.
4. **The guards: whichever variable a destructive command uses, its guard reads that same
   variable.** `seed-db-guard.ts` (`extractDbName`, `assertSeedTargetIsDisposable`,
   `assertDbPushTargetIsDisposable`), `integration-db-guard.ts` (`setup`), `require-real-db.ts`
   (`hasDatabaseUrl`) and the hook `pre-bash-live-db-guard.sh` key off the **database name** in the
   URL path, not the user name, so a user-name change alone breaks none of them. What would break
   them is moving `db:seed` / `db:push` to `MIGRATION_DATABASE_URL` while the guard keeps reading
   `DATABASE_URL`: the guard would inspect a harmless URL while the command truncates the live
   one — the class of the 2026-08-18 incident, where an inherited variable let a seed wipe the live
   `crm_db`. Hard requirement for the implementing PR: the guard and the command read the same
   variable, and the guard's tests gain a case with the migration variable pointing at `crm_db`.
   Because the migration URL is now the more dangerous one, the live-db hook must recognise both
   variable names.
5. **`live-db-access.md` is unchanged in substance.** Reading the local `crm_db` stays allowed; the
   rule is about read vs write, not about which role reads. The implementing PR updates its wording
   where it names the single variable.
6. **Unit tests** open no database and are unaffected.

### 6. Relationship to the migration-ledger ADR

**Decision: this ADR precedes the ledger ADR; they stay separate.** Confidence **HIGH**.

- **Why not merge.** They change different axes: this ADR changes **who** connects and **who**
  applies; the ledger changes **how** files are applied (applied ID + checksum, fail on mismatch,
  catalog validation after partial DDL, a deployment lock). Merging couples an urgent security
  boundary to a larger redesign of deploy mechanics, and delays the boundary until both are agreed.
- **Why not follow.** Waiting for the ledger keeps the API on the owner credential — probably a
  superuser — while r5 adds the first append-only table, whose triggers mean little against that
  credential.
- **Why preceding is safe.** Files 1 and 2 fit the **current** contract (idempotent, re-applied
  every deploy, wired per C-15) and need nothing from the ledger.

The interface the ledger ADR must respect:

1. **The ledger runner connects as `crm_user`** over the container's local socket, like today's
   apply steps. It never uses `crm_app`.
2. **The ledger table is class E:** owned by `crm_user`, no grants to `crm_app` or `crm_collector`;
   the class manifest lists it, so the catalog check passes.
3. **Files 1 and 2 keep re-apply semantics** under the ledger: they are the drift-repair mechanism
   and the password-rotation path. The ledger marks them "re-apply always" or exempts them by name;
   it must not run them once and skip them thereafter. Their checksum stays stable because the
   password comes from the environment, not from the file.
4. **The catalog check of §2 is a candidate for the ledger's "catalog validation" step.** If the
   ledger builds a validation stage, the privilege check runs there; until then it is a standalone
   deploy step. Either way it runs after every apply.
5. **Default privileges depend on DDL running as `crm_user`.** If the ledger ever introduces a
   separate DDL role, it inherits §2's trap: `ALTER DEFAULT PRIVILEGES FOR ROLE` that role, or
   `SET ROLE crm_user` before DDL.

r5 Task 1.3 implements on top of both: the collector's concrete table list (classes C and D), the
`job_queue_actions` revokes and triggers of §3, and the tests of §3.

## Consequences

**Gains**

- **Once §4 step 7 has rotated the `crm_user` password in the database and refused its TCP
  login,** the API, the internet-facing process, can no longer change schema, disable a trigger,
  truncate a table or reach a superuser — whether or not production `crm_user` is a superuser.
  Between steps 5 and 7 it still can, with the password it has held since the first deploy.
- The append-only log becomes a guarantee against SQL injection and a compromised API, not only
  against bugs, within the limits §3 states.
- The collector gets a boundary that contains its bugs now, and its compromise once it is a
  separate process.
- New tables are classified on purpose: the catalog check turns "forgot the grant" and "forgot the
  revoke" into CI failures.

**Costs and trade-offs**

- Two connection strings in CI and locally; the guards must follow (§5, item 4).
- A new table costs one more decision (its class) and, for class B, the revoke and triggers in the
  same transaction as the `CREATE TABLE`.
- Two more manual DDL files under the wiring contract, each costing the four C-15 edits.
- The migration role stays all-powerful over the data. This ADR does not claim otherwise (§3).
- **Backups do not carry grants.** `pg-backup.sh` dumps with `--no-owner --no-acl`. A restore must
  run as `crm_user` (so it owns the restored objects) and be followed by a deploy, or a manual run
  of files 1 and 2, before the API can connect. The restore section of the runbook must say so;
  the implementing PR adds it.

**Assumptions (A1, recorded per `autonomy-levels.md`)**

- Role names `crm_app` / `crm_collector` — reversible by rename before step 5.
- `crm_user` keeps its name and its role as owner, with no `REASSIGN OWNED` — reversible, and
  cheaper than a new owner role.
- Demoting `crm_user` from superuser is deferred — a separate A3 decision for the owner, not part
  of this rollout.
- The variable name `MIGRATION_DATABASE_URL` — reversible; the implementing task may rename it.

## Rollback

Per step: §4, "Rollback". Summary:

| What to undo          | How                                                                                                                                                                        | Expected state                            | Verify                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| This ADR (docs only)  | Revert its merge commit                                                                                                                                                    | The file is gone; nothing else changed    | The revert's file list shows only this ADR                                       |
| The URL switch (PR B) | Revert PR B's merge commit, let it deploy                                                                                                                                  | The API connects as `crm_user` again      | The `pg_stat_activity` query of §4 step 6 shows `crm_user` sessions from the API |
| The roles (PR A)      | After PR B is reverted: a forward file that drops `crm_app` / `crm_collector` (they own nothing, so `DROP OWNED` + `DROP ROLE` suffice) and removes the default privileges | No new roles; their grants gone with them | `SELECT rolname FROM pg_roles` lists neither role                                |

## Sources

- Repository, by symbol or config key: `DatabaseService` in `apps/api/src/database/database.service.ts`;
  `env.ts` key `DATABASE_URL`; `deploy.yml` — the `write-env` job and the DDL apply steps;
  `docker-compose.prod.yml` — service `api` (`env_file`) and service `postgres` (`POSTGRES_USER`,
  `POSTGRES_PASSWORD`); `scripts/devops/pg-backup.sh`; `scripts/devops/check-prod-ddl-wiring.py`;
  `seed-db-guard.ts`, `integration-db-guard.ts`, `require-real-db.ts`;
  `.claude/hooks/pre-bash-live-db-guard.sh`; `ci.yml` service containers (`POSTGRES_USER: crm_user`,
  database `crm_ci`).
- `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md` — Task 1.3 (collector role,
  ledger ADR), reconciliation row C-15 (wiring contract), the `job_queue_actions` row of the store
  table.
- PR #1017 — the security finding, and the "GAP PIN: no trigger exists yet" test.
- `docs/runbooks/deployment.md` §9 (rollback by `image_tag`); `docs/runbooks/human-only.md`
  (conversion rule; items 1 and 3).
- `.claude/rules/common/live-db-access.md`; `.claude/rules/common/autonomy-levels.md`.
- PostgreSQL 16 documentation: "Privileges" (owner rights; `TRUNCATE`, `REFERENCES`, `TRIGGER` as
  separate privileges); `ALTER DEFAULT PRIVILEGES` (`FOR ROLE` scope); `CREATE TRIGGER` (truncate
  triggers are statement-level; row triggers do not fire on `TRUNCATE`); `ALTER TABLE` (`ENABLE
ALWAYS TRIGGER`; ownership required to disable triggers); `session_replication_role`
  (superuser-settable; skips triggers not in `ALWAYS` / `REPLICA` state); `INSERT` (privileges for
  `ON CONFLICT DO NOTHING` vs `DO UPDATE`); `CREATE ROLE`; psql `\getenv`.
- Official `postgres` Docker image documentation: `POSTGRES_USER` is created as the superuser at
  `initdb`; the generated `pg_hba.conf` trusts local-socket connections.
