# ADR: Least-privileged database roles — the API stops connecting as the bootstrap role

## Status

Proposed (2026-10-17). Direction approved by the owner on 2026-10-17 ("do it the right way").
Acceptance of this ADR is the owner's decision and has not been given.

## For the owner

**What you are accepting** — the six decisions summarised below: the role model, the privilege
classes, the append-only guarantees, the nine-step rollout, the effect on local work and CI, and
the ordering against the migration-ledger ADR. Accepting them authorises the implementing tasks,
not any production change: every step that touches production is listed separately and the
owner-only ones are marked **[OWNER]**.

**What you are choosing** — one question, now: how expired rows leave the action log (§3).
R-A keeps the trigger absolute and handles deletion by a reviewed file per run (interim only);
R-B adds a narrow exception reached through two privileged functions the API's cron calls;
R-C puts the same exception behind a separate retention process. **Recommendation: R-B now, R-C
once a separate scheduled process exists.** It is tied to the erasure design pending in PR #1019,
so it can also wait for that.

**What is deferred, needing nothing from you at any point unless you reopen it** — demoting
`crm_user` from superuser (A3: it is the cluster's only superuser); a separate `NOLOGIN` owner role
(`crm_owner`); a read-only role (`crm_readonly`). Each has its conditions for revisiting in §1.

**Two things that need somebody, though not necessarily you, and not today** — a legal
confirmation that shipping R-A as the interim is acceptable, which must land before Task 1.3
relies on it and is a question for the legal memo's author rather than for you; and changing the
audit-log foreign keys (§2), which is ours to schedule, is doable now, and needs your decision only
if you want it prioritised differently. Both appear in "Open owner decisions" near the end, which
is the full list.

## Summary of decisions

1. **Roles (§1).** `crm_user` stays the owner and migration role. Its password is rotated in the
   database and its TCP login refused, so only local-socket use remains. The API connects as
   `crm_app`, which owns nothing, is a member of no role and is not a superuser. The collection
   worker gets `crm_collector`. Three login roles; option R-B of §3, if chosen, adds a fourth —
   the `NOLOGIN` function owner `crm_retention_owner`.
2. **Privileges (§2).** Every table is in one class: A ordinary, A-log (the six existing audit
   tables: insert-only for the API, no triggers yet), B append-only, C job-sourcing, D collector
   inputs, E migration-internal. Default privileges cover new tables; `EXECUTE` is revoked from
   `PUBLIC`. A nine-part catalog check fails CI and the deploy on any drift.
3. **Append-only log (§3).** Revoked privileges, `ENABLE ALWAYS` row and `TRUNCATE` triggers, and
   foreign keys that never write the log row (`RESTRICT` / `NO ACTION`, or no FK at all).
   Nothing in the database protects the log from `crm_user`, and
   that is stated. End of retention is an **open owner decision** (R-A interim; R-B or R-C final),
   tied to the legal memo of PR #1019.
4. **Rollout (§4).** Nine steps, owner-only ones marked. Roles are created first; the API
   switches to `crm_app` with the owner password moved to a postgres-only env file; then the
   `crm_user` password is rotated and `pg_hba.conf` refuses its TCP login, with validation before
   and after the reload. Rollback is forward-only and never restores the owner credential to the
   API. Restores follow an ordered procedure.
5. **Local development, CI and guards (§5).** Two connection strings. CI runs the API as `crm_app`.
   Every guard checks every connection variable it finds.
6. **Migration ledger (§6).** This ADR comes first; the two stay separate, with a five-point
   interface.

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

Three login roles. Confidence **HIGH** on the model; it is the textbook split. If the owner
chooses option R-B for end-of-retention (§3), a fourth is added there: `crm_retention_owner`,
`NOLOGIN`, which exists only to own the two privileged functions and never connects.

| Role            | Kind  | Becomes / is                                                                                                                                                     | Attributes                                                                                                                                                                                                                                                                                          |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crm_user`      | LOGIN | **The owner / migration role.** Keeps owning every object; every deploy DDL file, the ledger runner (§6), `db:push`, `db:seed` and the backup keep running as it | Unchanged in this ADR (superuser today, very probably). Login attributes unchanged, but its password is **rotated** and TCP login refused (§4, step 7), so only local-socket use remains. The new password is held **only** by the `postgres` service and the deploy, never by the API (§4, step 5) |
| `crm_app`       | LOGIN | **The API's role.** The only credential the API process holds                                                                                                    | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, a `CONNECTION LIMIT` sized to the pool plus headroom, member of **no** role, owns **nothing**                                                                                                                                      |
| `crm_collector` | LOGIN | **The collection worker's role** that r5 Task 1.3 requires                                                                                                       | Same attributes as `crm_app`; explicit per-table grants only (§2). Created when the worker ships as its own process; its credential goes only to that process                                                                                                                                       |

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

**The existing audit logs — this reaches beyond the vacancy feature.** The CRM already
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
`crm_user`. Five of the six sit in the `audit.ts` schema module; the sixth,
`meeting_recorder_audit_log`, sits in the interviews module, which is why a search scoped to the
first one finds only five. The implementing task re-runs the search.)

**Decision for now — class A-log, privileges only, no triggers.** Revoking `UPDATE`, `DELETE` and
`TRUNCATE` from `crm_app` on these tables breaks **nothing** that runs today: the `SET NULL` and
`CASCADE` actions are executed with the privileges of the table's **owner** (`crm_user`), not of
the role that deleted the user, so user, team and project deletion keep working; and the API issues
no `UPDATE` / `DELETE` on them except the `document_access_log` cron, which keeps `DELETE` on that
one table. What this buys: a compromised API can no longer rewrite or delete rows of the
transaction, user, team, project and meeting-recorder audit logs directly, only add rows. What it
does **not** buy, stated by FK kind, because the referential action runs as the owner and the
revoke does not see it:

- **`CASCADE` FKs delete audit rows outright.** Deleting a user deletes every `user_audit_log` row
  whose `target_id` is that user; deleting a team deletes its `team_audit_log` rows; deleting a
  project deletes its `project_audit_log` rows (reproduced). So an attacker
  who may delete the parent through the API — or an ordinary hard delete — erases that subject's
  whole audit history, not just a link.
- **`SET NULL` FKs erase the link only.** Deleting a user nulls `actor_id` in every audit table,
  and the person columns of `meeting_recorder_audit_log`; the rows survive without saying who acted.
- **`document_access_log`** stays fully deletable by the API (its retention cron).

**How reachable is that cascade today?** Narrowly, and that matters for the priority. Users, teams
and projects are **archived, never deleted**: `DELETE /api/users/:id` routes to the controller's
`archiveUser`, and no production code path issues a row delete against `users`, `teams` or
`projects` (checked 2026-10-17: no Drizzle `.delete(users|teams|projects)` and no raw `DELETE`
outside specs). So the cascade is reachable only by arbitrary SQL — injection, or a future hard
delete added without noticing what it drags with it.

**Is that acceptable for an audit log?** As an interim, yes: it is today's behaviour, and the
revoke makes nothing worse while closing the direct rewrite and delete. As a final state, **no**
for the `CASCADE` tables — an audit log whose rows vanish with their subject cannot show what
happened to that subject — and the `CASCADE` FKs are the first thing that must change before those
three tables can leave the interim class (item 1 below). That change is **not** blocked by the
erasure decision: because nothing deletes these parents today, replacing the cascade is a plain
schema fix that breaks no current behaviour, and it can proceed ahead of items 2 and 3. Confidence
**HIGH** on the privilege and referential behaviour (both reproduced on `postgres:16-alpine` 16.15
during review).

**What must change before any of them can become class B** (each a separate task, outside this
ADR; `transaction_audit_log` is critical-path and needs a security review):

1. **FKs — drop them and keep the ids as plain data; `SET NULL` is not a target shape.** A class B
   table may carry only FKs whose referential action never writes the log row: `RESTRICT` /
   `NO ACTION`, or no FK at all (§3 layer 3 states the rule and why). `SET NULL` does not qualify —
   it is an `UPDATE` of the log row, which the immutability trigger refuses — so changing these
   six to `SET NULL` would be an interim shape only, valid exactly while there is no trigger, and
   it would have to be undone to make the transition. The target shape is therefore:
   - **Preferred: drop the FK on each column that points at a deletable row, keeping the `uuid` as
     plain data** (`transaction_audit_log`'s target column is already shaped this way). Deleting a
     parent then touches no log row, so the trigger is not involved, and **no test-suite work is
     needed**: the roughly 110 spec teardowns that delete users, teams and projects keep passing. The
     log keeps the id of whoever acted, which is what an audit trail is for; the id becomes dangling,
     which is correct here and is why erasure must come from the end-of-retention path rather than
     from a cascade (item 3).
   - **Acceptable: `RESTRICT`.** It keeps referential integrity but forbids deleting a referenced
     parent at all, so every teardown that deletes a user, team or project must first delete the
     log rows **as the migration role** (the application cannot). That is the test-suite work this
     option costs — around 110 teardowns — and it is the reason the preferred shape is the other one.

   Either way the schema change itself is doable now and breaks no production behaviour, because
   nothing in production deletes these parents.

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
revokes that, both for what exists and for what is created later:

```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_user REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

A function the API must call is then granted to `crm_app` by name, in the PR that adds it. Built-ins
in `pg_catalog` (`gen_random_uuid`, `now`, …) are unaffected. Firing a trigger does not check
`EXECUTE` on the trigger function, so the §3 triggers keep working.

No `SECURITY DEFINER` function exists today. A definer function runs with its owner's privileges
and is a hole through every boundary here, so one may be added only in the narrow form §3
specifies for the end-of-retention option R-B, if the owner chooses it: owned by a dedicated
non-superuser role (never `crm_user`), `search_path = pg_catalog, public, pg_temp`, static SQL
only, `EXECUTE` revoked from `PUBLIC` and granted by name, and pinned by the catalog check. Any
other definer function needs its own ADR-level justification.

**Database and schema.** On `crm_db`: `REVOKE ALL ON DATABASE crm_db FROM PUBLIC` (removes the
implicit `CONNECT` and `TEMPORARY`), then `GRANT CONNECT` to `crm_app` and `crm_collector`. On the
**other** databases of the cluster — `postgres` (the maintenance database) and `template1` —
`REVOKE CONNECT, TEMPORARY … FROM PUBLIC` as well; otherwise `crm_app` can still connect to
`postgres` and create temporary tables there. `pg_hba.conf` (§4 step 7) confines both
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
database built from the same DDL, and as a deploy step right after the DDL apply steps. It has nine
parts and reads `pg_class`, `pg_roles`, `pg_auth_members`, `pg_default_acl`, `pg_proc`,
`pg_namespace`, `pg_trigger` and `information_schema.column_privileges`, plus the
`has_*_privilege` functions — because `has_table_privilege` alone sees neither sequences, nor
column grants, nor default privileges:

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
8. **Role membership — in both directions, pinned.** `pg_auth_members` has **zero** rows with
   `member` = `crm_app` or `crm_collector` (they are members of no role — the direction that
   matters, because membership is what would let them `SET ROLE` to an owner). With `roleid` =
   either of them (someone is a member **of** them), the allowed set is exact and depends on step
   0's branch:
   - **Branch 1 (`crm_user` is a superuser):** zero rows. A superuser that creates a role is not
     made a member of it.
   - **Branch 2 (`crm_user` is not a superuser but has `CREATEROLE`):** exactly one row per
     application role — `member` = `crm_user`, `admin_option` = true, `inherit_option` = false,
     `set_option` = false. PostgreSQL 16 records this grant automatically whenever a
     non-superuser with `CREATEROLE` creates a role (reproduced on 16.15 during review); the
     `ADMIN` part cannot be avoided, because it is what lets the creator manage the role it
     created. File 1 sets `createrole_self_grant = ''` for its session before `CREATE ROLE` so the
     grant is **made** without `INHERIT` or `SET`. The row is harmless for the boundary: it lets
     the owner administer the application role, and the owner is already more powerful than it.
   - Any other row — another member, or this row with `inherit_option` or `set_option` true —
     fails the check.

   **The assertion is the guarantee; the setting is not.** `createrole_self_grant` constrains the
   grant at the moment it is made, not the creator's reach afterwards: holding `admin_option`,
   `crm_user` can re-grant the role to itself `WITH SET TRUE` at any time (done during review). So
   the protection is this check running on **every** deploy and failing on exactly that row — not
   the setting in file 1, which only keeps the initial state clean. The same reasoning is why the
   check names the column and the branch it expects: "no membership" without a direction is how a
   check passes while testing the harmless side, and a blanket "zero rows" would fail every deploy
   in branch 2.

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

- A `BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger that raises an exception. **Whether it raises
  unconditionally, or admits a narrow end-of-retention / redaction exception, is an open owner
  decision** — see "End of retention" below. Until the owner decides, Task 1.3 ships the
  unconditional form; every option below replaces the trigger function by a forward file, so
  nothing shipped now has to be undone.
- A `BEFORE TRUNCATE … FOR EACH STATEMENT` trigger that raises. A row-level `DELETE` trigger does
  **not** fire on `TRUNCATE`; without this second trigger, `TRUNCATE` empties the log silently.
- Both set to `ENABLE ALWAYS` (`ALTER TABLE … ENABLE ALWAYS TRIGGER …`). A trigger in the default
  state is skipped when `session_replication_role = replica`; an `ALWAYS` trigger fires in every
  mode. This removes the replication-role bypass even for a superuser who has not touched the
  trigger itself.
- The exception carries a dedicated SQLSTATE and message, so a test can tell "refused by the
  trigger" from "refused by a privilege" (SQLSTATE `42501`).

**Layer 3 — foreign keys out of the log. The rule, for every class B table.** A column that points
at a row somebody may delete carries **either no FK at all** (the `uuid` is kept as plain data) or
an FK with `ON DELETE RESTRICT` / `NO ACTION` and `ON UPDATE NO ACTION`. Never `CASCADE`, `SET
NULL` or `SET DEFAULT`.

The reason is exact: referential actions run with the privileges of the table's **owner**, not of
the role that deleted the parent row. A `CASCADE` or `SET NULL` FK would let `crm_app` delete or
rewrite log rows by deleting a parent it is allowed to delete, and layer 1 would not see it. Layer 2
does see it — row triggers fire for rows changed by referential actions — and refuses the whole
statement. So a writing referential action does not quietly weaken the boundary; it turns every
ordinary parent delete into a runtime error. That is the trade the two allowed shapes make
explicitly:

- **No FK:** deleting a parent touches no log row, so nothing fails and the log keeps the id of
  whoever acted. The id becomes dangling — acceptable and intended for an audit trail, and the
  reason erasure must come from the end-of-retention path rather than from a cascade.
- **`RESTRICT`:** referential integrity is kept and the refusal becomes a declared, testable part
  of the schema, but deleting a referenced parent is then impossible until the log rows are removed
  **by the migration role**. Any test teardown that deletes such a parent must do that first.

PR #1017 already declares the actor FKs `restrict`; Task 1.3 must hold every FK on the log to this
rule and write its teardowns accordingly. The same rule is what the six existing audit logs must
satisfy before they can leave their interim class (§2).

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
   against the migration role is **procedural**: DDL reaches production only as reviewed files
   applied by `deploy.yml`. Detection is narrow, and stated exactly: the catalog check (§2, item 9)
   runs on every deploy and fails if a class B trigger is missing or not `ENABLE ALWAYS`, so a
   trigger **left** disabled or dropped is caught at the next deploy. Nothing catches a
   disable–edit–re-enable inside one transaction, and nothing compares the log with the nightly
   `pg_dump` copies or alerts on trigger changes between deploys; the dumps make a manual comparison
   possible after the fact, nothing more.
2. **Append-only is not authenticity.** `crm_app` can insert a row with any actor, kind and reason
   that passes the table's `CHECK` constraints. The log proves "nothing written was later changed
   through the API's credential", not "every row is true". Tamper evidence (hash chaining,
   external anchoring) is out of scope.
3. **Insert volume is not bounded** by these layers (a compromised API can flood the log); that is
   a rate-limit concern, not an immutability one.
4. **End of retention and redaction are not designed here** — see the next subsection. The
   application never receives a plain `DELETE` or `UPDATE` on the log under any option.

**End of retention — an open owner decision (conflict with the legal memo, PR #1019).** The legal
memo on erasure in the action log (`docs/legal/2026-10-17-job-queue-actions-erasure.md`, PR #1019)
requires two things that an unconditional trigger does not provide: a **recurring
end-of-retention path** (delete expired rows, or re-point `actor_id` / `subject_user_id` to a
shared "former staff" sentinel), run only by the retention job through "a second, narrow,
privileged exception" in the trigger; and a **redaction path for `reason`** only (replace the text
with a fixed token, append a `REASON_REDACTED` event, through one privileged function). The memo
states that the first is required whichever erasure option is chosen, because a log that is
append-only forever does not meet storage limitation (GDPR Art. 5(1)(e); UA Law 2297-VI
art. 6(8)). The erasure design is pending with the owner, so this ADR does **not** pick; it lays
out the options in database terms.

**R-A is an interim state only, never a final option.** It is what Task 1.3 ships so that the log
is protected from day one. By the memo's own conclusion, a refusing trigger with no exception does
not meet storage limitation once retention periods apply, so R-A must be replaced by R-B or R-C;
it is listed in the table only to show what the interim costs.

|                                 | R-A — no exception (interim only)                                                                            | R-B — bounded exception through definer functions                                                                                                                                                                                                    | R-C — bounded exception for a separate retention role                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Trigger                         | Raises unconditionally                                                                                       | Admits **only** (1) `DELETE` of rows whose kind's retention has expired, (2) re-pointing the two person columns to the sentinel on expired rows, (3) `UPDATE` of `reason` to the fixed token — and only when `current_user` is `crm_retention_owner` | The same three shapes, admitted only when `current_user` is a dedicated `crm_retention` login |
| Who runs it                     | A reviewed DDL file per run, applied by the deploy as `crm_user` with the trigger disabled for the statement | Two `SECURITY DEFINER` functions (purge expired; redact one row's `reason` with a request id, appending `REASON_REDACTED`), specified below; `EXECUTE` granted to `crm_app` by name; called by an API cron                                           | A separate scheduled process holding the `crm_retention` credential; the API holds nothing    |
| Where "expired" comes from      | The file's own `WHERE`                                                                                       | A retention-policy table (class E: owned by `crm_user`, no grants to the API), read by the trigger                                                                                                                                                   | Same                                                                                          |
| Recurring, as the memo requires | **No** — each run is a PR and a deploy                                                                       | Yes                                                                                                                                                                                                                                                  | Yes                                                                                           |
| What a compromised API can do   | Nothing to the log beyond inserting                                                                          | Purge rows that are already due (no loss); **redact any row's `reason`** — evidence text lost, but each redaction leaves a `REASON_REDACTED` row                                                                                                     | Nothing to the log beyond inserting                                                           |
| Cost                            | Manual, slow; an on-request redaction takes a PR + deploy                                                    | Two definer functions and one owner role (the only definer functions allowed, §2 Functions); the trigger must validate the shape of every admitted change                                                                                            | One more credential, secret and process; the same trigger validation                          |
| Fit with the memo               | Does not meet storage limitation once any period applies                                                     | Meets it; "only by the retention job" is procedural (only the cron calls the functions)                                                                                                                                                              | Meets it, and "only by the retention job" is enforced by the database                         |

What holds under every option: the exception is bounded by **data shape** (expired rows; one
column to one fixed token), not merely by who calls it, so even a misuse of the exception cannot
delete a row that is not yet due or rewrite any column other than `reason`. A `crm_user` session
can still do anything (it can disable the trigger), which §3 already states.

**R-B, fully specified — the conditions under which it is acceptable.** R-B is acceptable as the
owner's choice only with all six of these; the implementing task treats each as a requirement and
the catalog check pins them:

1. **A dedicated owner role.** Both functions are owned by `crm_retention_owner`: `NOLOGIN`,
   `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOBYPASSRLS`, member of no role, and holding
   **only** `SELECT, DELETE` on `job_queue_actions`, column-level `UPDATE (reason, actor_id,
subject_user_id)` on it, `INSERT` on it (for the `REASON_REDACTED` event), and `SELECT` on the
   retention-policy table. Not `crm_user`: a definer function owned by `crm_user` would run with
   every privilege of the owner, and probably as superuser, so one mistake in its body would be a
   full compromise. The trigger keys its exception on `current_user = 'crm_retention_owner'`, the
   identity inside the functions.
2. **A pinned `search_path` ending in `pg_temp`:** `SET search_path = pg_catalog, public, pg_temp`
   on each function. Without `pg_temp` listed explicitly, PostgreSQL searches the temporary schema
   **first**, so a caller could shadow a table or operator with a temporary object. This is
   load-bearing, not hygiene: during review a definer function without the explicit `pg_temp`
   read its data from the caller's temporary table instead of the real one.
3. **Static SQL only.** No dynamic `EXECUTE` built from arguments, no `format()` into statements.
   Arguments are used only as bound values (`WHERE id = p_id`), and validated in the body (the
   request id is non-empty and bounded).
4. **`EXECUTE` revoked from `PUBLIC`** and granted to `crm_app` by name only.
5. **The trigger validates the shape** of every admitted change, independently of the functions,
   so a bug in a function cannot widen the exception.
6. **The catalog check pins both functions:** they exist with the expected signatures;
   `prosecdef` = true; `proowner` = `crm_retention_owner`; `proconfig` is exactly the
   `search_path` above; `proacl` grants `EXECUTE` to `crm_app` and to no one else (no `PUBLIC`);
   and the body's checksum — `md5(pg_get_functiondef(oid))`, **not** `md5(prosrc)`, which is the
   empty string for a `BEGIN ATOMIC` body and would make the check pass on any such function —
   equals the manifest's, so a body changed outside a
   reviewed file is caught. `crm_retention_owner` passes the same attribute, ownership and
   membership checks as the application roles, except that it owns exactly these two functions.

**Why R-A is acceptable as the interim — pending legal confirmation.** No row has yet reached the
end of retention: the retention periods are themselves pending with the owner, and r5 Task 1.4
keeps new-store cleanup disabled until they are frozen. On that basis this ADR **assumes** that
shipping R-A now does not breach storage limitation, and that it would begin to on the day a period
is set and rows expire under it. That is a legal conclusion, not an architectural one: it is
**pending confirmation by the legal memo's author** before Task 1.3 relies on it. A redaction
request that arrives earlier can be served under R-A by a reviewed DDL file — slow, but possible.

**Recommendation (for the owner, A2):** R-B as specified above, moving to R-C once a separately
scheduled process exists (the r5 collection worker is the natural host); the move changes only who
holds `EXECUTE`, or swaps the `current_user` check. Reason: R-B meets the memo's recurring
requirement without a new login credential, and its only extra exposure — a compromised API
redacting reasons — is self-logging and bounded to one column. Confidence **MED**: the database
mechanics are standard, but the trigger-side shape validation is new code and needs its own tests
(one per admitted shape, plus one per refused near-miss — a non-expired row, a second column
changed, a non-token value, a call from a session whose `current_user` is not
`crm_retention_owner`).

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
| `TRUNCATE`                                                       | `crm_app`                    | `42501` (privilege; the trigger is the second layer)               |
| `SET session_replication_role = replica`                         | `crm_app`                    | `42501` (superuser-only parameter)                                 |
| `INSERT … ON CONFLICT (idempotency key) DO UPDATE …`             | `crm_app`                    | `42501` (needs `UPDATE`), log row unchanged                        |

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
2. **The process list — on the VPS and on the CI runner.** Any value in a command's argv is
   readable by any local user via `ps`. The rule covers **every** command that touches a password,
   not just file 1:
   - applying file 1: `docker compose exec -e NAME` (name only, value from the calling
     environment), never `-e NAME=value`, never `psql -v name=value`;
   - the probes (step 3, step 7): the password reaches the client through `PGPASSWORD` passed by
     name (`docker run -e PGPASSWORD`), never inside a connection URI or a `-W` argument on the
     command line;
   - computing the SCRAM verifier on the runner: the tool reads the password from its environment
     or stdin, never from an argument.
3. **`DO` blocks.** psql substitutes `:'var'` in ordinary statements, **not** inside a `DO $$ … $$`
   body. So the `DO` block only creates missing roles, without a password; the passwords are set
   by plain `ALTER ROLE … PASSWORD :'app_verifier'` statements after it, reading the variable via
   psql `\getenv` (psql 15+).

Re-applying file 1 every deploy makes rotation of any of the three passwords "change the secret,
deploy".

**The environment split.** Compose interpolates `${POSTGRES_PASSWORD:?…}` in
`docker-compose.prod.yml` from the file given to `--env-file` — today the same `.env.production`
the `api` service loads as its `env_file`. So the owner password cannot leave the API's
environment while both come from one file. PR B splits it:

| File                 | Loaded by                                                 | Contains                                                                                           | Must never contain                                                                          |
| -------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `.env.production`    | the `api` service (`env_file`) and Compose's `--env-file` | `DATABASE_URL` for `crm_app`; non-secret `POSTGRES_USER` / `POSTGRES_DB` (the DDL steps read them) | the `crm_user` password in any form; any URL with user `crm_user`; `MIGRATION_DATABASE_URL` |
| a postgres-only file | the `postgres` service only (`env_file`)                  | `POSTGRES_PASSWORD`                                                                                | anything the API needs                                                                      |

The `postgres` service drops its `${POSTGRES_PASSWORD:?…}` interpolation and reads the variable
from its own file. That file is written with mode `0600`, owned by the deploy user, so no other
local account on the VPS can read the owner password. `MIGRATION_DATABASE_URL` (§5) exists **only** in CI and on developer machines;
production has no use for it, because every production DDL path goes over the local socket.

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Who                                                                                     | Effect on production                                                                                                                                                                                                                                                                                                                                                                           | Done when                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Read-only check of the current role (commands below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **[OWNER]**                                                                             | none                                                                                                                                                                                                                                                                                                                                                                                           | The answer is recorded in the implementing PR                                                                                                                                                                                                                                                             |
| 1   | Add the CI secret `CRM_APP_DB_PASSWORD` (value: `openssl rand -hex 32` — hex, so it is URL-safe in `DATABASE_URL`). One line: "Settings → Secrets → New: `CRM_APP_DB_PASSWORD`, value from `openssl rand -hex 32`"                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **[OWNER]**                                                                             | none                                                                                                                                                                                                                                                                                                                                                                                           | The deploy fails loudly if the secret is absent                                                                                                                                                                                                                                                           |
| 2   | PR A (DevOps): files 1 and 2, their wiring, the catalog check (§2) as a deploy step after the DDL steps and as a CI job. The API still connects as `crm_user`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | DevOps; merge **[OWNER]**                                                               | Roles and grants exist; behaviour unchanged                                                                                                                                                                                                                                                                                                                                                    | Deploy green, catalog check green                                                                                                                                                                                                                                                                         |
| 3   | Automated probes, in the same deploy, **from a throwaway client container on the backend network** (e.g. a one-off `postgres:16-alpine` run with `--no-deps`), connecting to host `postgres` — never from inside the postgres container, where `127.0.0.1` and `::1` are `trust` and a wrong password also succeeds. Probes: `crm_app` with the right password → accepted; `crm_app` with a deliberately wrong password → **refused** (proves the probe is not hitting a trust rule); inside a rolled-back transaction, `UPDATE job_queue_actions` as `crm_app` → `42501`                                                                                                          | DevOps (in PR A)                                                                        | none                                                                                                                                                                                                                                                                                                                                                                                           | All probes as expected                                                                                                                                                                                                                                                                                    |
| 4   | CI runs the API **as `crm_app`** (§5) on `main` — the strongest proof that the grants are sufficient for every query the code makes; **plus** one real-database spec per cron service whose job issues `DELETE` or `UPDATE` (see "What step 4 does not reach"), each asserting the statement succeeds as `crm_app`                                                                                                                                                                                                                                                                                                                                                                 | DevOps + AutoTest                                                                       | none                                                                                                                                                                                                                                                                                                                                                                                           | CI green on `main` with the new connection                                                                                                                                                                                                                                                                |
| 5   | PR B (DevOps): the deploy writes `DATABASE_URL` with `crm_app` and `CRM_APP_DB_PASSWORD`, and splits the environment as in the table above. **Prerequisites:** the `42501` alert of measure 2 ("What step 4 does not reach") is live, and the API registers a pool `error` listener ("What a database restart does to the API today"). **Order inside the deploy:** apply file 1 → run the step 3 `crm_app` login probe → only then recreate the `api` container. If `crm_app` cannot log in, the deploy stops while the old container is still serving; recreation is a plain `docker compose up -d`, not a health-gated swap, so this order is the only thing that guarantees it | DevOps; merge **[OWNER]**                                                               | The API restarts as `crm_app`, as on any deploy                                                                                                                                                                                                                                                                                                                                                | Deploy green and step 6 checks green                                                                                                                                                                                                                                                                      |
| 6   | Verify (commands below): API sessions are `crm_app` only; the API container's environment contains neither the `crm_user` password **value**, nor any `crm_user@` URL, nor `MIGRATION_DATABASE_URL`; a sign-in, a finance page read and one write work; no `permission denied` in API logs for 48 h                                                                                                                                                                                                                                                                                                                                                                                | DevOps automates the first two as deploy steps; the smoke and the log watch **[OWNER]** | none                                                                                                                                                                                                                                                                                                                                                                                           | All four hold                                                                                                                                                                                                                                                                                             |
| 7   | **Revoke the old owner credential (PR C, DevOps).** (a) **[OWNER]** sets the CI secret `POSTGRES_PASSWORD` to a new `openssl rand -hex 32`; (b) the deploy rotates `crm_user`'s password **in the database** to that value (file 1 does it on every deploy over the local socket, so the database and the secret cannot drift); (c) `pg_hba.conf` refuses TCP login for `crm_user` (below); (d) the deploy refuses to write any `DATABASE_URL` whose user is `crm_user`                                                                                                                                                                                                            | DevOps; secret and merge **[OWNER]**                                                    | A few seconds of database unavailability: the postgres-only env file changes, so `docker compose up -d` recreates the `postgres` container. **Expect the API process to restart too** (see below), i.e. a brief window of failed requests, not a transparent reconnect. Nothing legitimate logs in as `crm_user` over TCP after step 5. Schedule it like any deploy that restarts the database | The step 3 probes, extended with **one** probe: `crm_user` over TCP → refused. One probe suffices because the `reject` rule fires before authentication, so the result does not depend on which password is tried (the old one is no longer available once the secret is overwritten); `crm_app` accepted |
| 8   | Collector, when the worker ships as its own process: `CRM_COLLECTOR_DB_PASSWORD` **[OWNER]**, the role in file 1, class C / D grants in file 2, the URL only in the worker's environment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | r5 Task 1.3 / DevOps                                                                    | Worker runs as `crm_collector`                                                                                                                                                                                                                                                                                                                                                                 | Catalog check covers `crm_collector`                                                                                                                                                                                                                                                                      |

**What step 4 does not reach — the scheduled jobs, and what it costs.** Step 4's proof is only as
wide as the code CI actually executes against a real database, and the gap is exactly where the
risk is. Of the eight cron services, one has a real-database spec; six use a fully mocked
`DatabaseService`, and those six are the `DELETE`-heavy ones: telemetry retention
(`telemetry_events`, `telemetry_errors`, `csp_reports`), vacancy-application retention
(`vacancy_applications`), meeting-recorder retention (`meeting_recorder_webhook_receipts`), and
document-access-log retention. A mocked spec passes whatever the grants are, so a table
misclassified as class B or A-log would be found not by CI but by the first cron fire — daily or
monthly, i.e. plausibly **after** step 6's 48-hour log watch, as a `42501` inside a handler that
deliberately swallows its errors so a failed run cannot crash the process. With no widen-grants
file (by decision, §Rollback) the fix is a PR and a deploy.

Three measures, all of them cheap, none of them a widen file. Each has an owner and a step, so
none of them floats:

| #   | Measure                                                                                                                                                                                                                                                                        | Owner and where it lands                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Extend step 4's proof to those paths.** Every cron service whose job issues `DELETE` or `UPDATE` gets one real-database spec that runs the statement as `crm_app`. The only measure that closes the gap rather than shortening it                                            | DevOps + AutoTest, **step 4** (in the step row above)                                                                                         |
| 2   | **Alert on `42501`.** The API logs it; the deploy's log watch and the standing alerting must match `permission denied` / SQLSTATE `42501` and **page**, not merely record. Without it the exposure lasts until someone reads logs; with it, until the next fire                | DevOps, **a prerequisite of step 5** — the switch does not ship without it, since it is the only detection that covers paths measure 1 misses |
| 3   | **Classify with the scheduled jobs in view.** Any table a retention job prunes is class A (or A-log with an explicit `DELETE`, as `document_access_log` has) — never class B. The manifest review for each new table asks "does any scheduled job delete from or update this?" | Whoever adds a table, enforced by the **class manifest review** in §2; the catalog check already fails on an unclassified table               |

**The bound, stated plainly:** between step 5 and the first fire of each scheduled job, a
misclassified table is undetected. The blast radius is that job's work not happening — a retention
job fails to prune (growing storage), or an `UPDATE`-shaped job fails to write (stale rows, e.g. a
status or a `last_seen` field never advancing). Measure 1 covers both shapes, so the bound does
too; in neither shape is data lost or corrupted, because the statement is refused outright rather
than half-applied, and in neither is there a user-facing error, because these handlers deliberately
swallow their failures. Recovery is one grant in file 2. That is the accepted cost of not having a
widen-grants file. Confidence **HIGH** on the exposure (the mocked-spec coverage was measured);
**MED** on measure 2's exact alerting wiring (DevOps).
**What a database restart does to the API today — and the prerequisite it creates for step 7.**
Read against the code, not assumed: `DatabaseService.onModuleInit` constructs a `pg` `Pool` from
`DATABASE_URL` and hands it to Drizzle. It registers **no** `error` listener on the pool, there is
no `uncaughtException` handler in the API's bootstrap, and no reconnect or retry logic anywhere
around it. When Postgres is recreated, its idle backends go away; `pg` emits `error` on the pool
for each idle client that dies, and an `error` event on an `EventEmitter` with no listener is
rethrown — so the likely outcome is an unhandled exception that ends the process. The container
carries `restart: unless-stopped`, so Docker restarts it and service returns on its own, but the
mechanism is a **process restart**, not a pool that reconnects. In-flight requests fail.

Two consequences, both deliberate:

1. **Step 7 states the real effect** (a brief window of failed requests), not a transparent
   reconnect. Any deploy that recreates the `postgres` container already behaves this way; step 7
   does not make it worse.
2. **Adding a pool `error` listener is a prerequisite of step 7**, and a small one: log the error
   and let the pool discard the client, which is `pg`'s documented way to survive an idle-client
   failure. It belongs to the API's own code (Coder zone), it is useful regardless of this ADR, and
   with it the restart window narrows to the in-flight requests alone. The implementing task must
   confirm the behaviour by killing the database under a running API in a scratch environment —
   before and after adding the listener — rather than inferring it from this paragraph.

This is written out because the same class of defect has already been caught three times on this
feature: a guarantee documented ahead of the mechanism that delivers it.

**Step 7 — why rotation, and why refusing TCP is required, not recommended.** The `crm_user`
password has been readable from the API's environment since the first deploy, so it must be
treated as disclosed: removing it from the environment (step 5) stops **future** reads, rotation
invalidates the **past** ones. The Postgres image applies `POSTGRES_PASSWORD` only when it
initialises an empty data directory; on a running cluster only `ALTER ROLE crm_user PASSWORD …`
changes it, which is why file 1 re-asserts it from the secret on every deploy. Refusing TCP login
for `crm_user` is **required**: every legitimate use of `crm_user` — every `psql` and
`pg_isready` in `deploy.yml`, the `pg_dump` in `pg-backup.sh`, the owner's checks — goes over the
trusted local socket inside the container, so the rule costs nothing, and it is the only control
that still holds if the **new** password leaks too (it lives in a CI secret and in the `postgres`
service's environment).

The rule set, in order:

```
local  all     all                    trust
host   crm_db  crm_app,crm_collector  172.30.0.0/24  scram-sha-256
host   all     all                    all            reject
```

`local … trust` is unchanged (the deploy depends on it). `172.30.0.0/24` is the `backend` network,
pinned by `ipam` in `docker-compose.prod.yml`; the `api` and the future worker reach Postgres only
from it. The last line also refuses replication connections over TCP and confines both
application roles to `crm_db` at the network layer. The reject fires **before** authentication,
so it does not depend on any password being known.

**Installing it safely — a malformed file is silently ignored on reload.** If `pg_hba.conf` has an
error, `pg_reload_conf()` still returns `true`, the server keeps the **old** rules loaded and logs
`pg_hba.conf was not reloaded`, and probes that the old rules already satisfy still pass. On the
next restart the server refuses to start and the container exits. So the step, run on every
deploy, is:

1. **Write** the candidate file into the data directory under a temporary name, keep the previous
   file alongside it, then move the candidate into place. A shell `trap` restores the previous file
   on any non-zero exit from here to the end of step 4 — without it, a failure between the move and
   the assertion leaves a file on disk that the next **restart** would reject, which is the same
   outage this sequence exists to prevent.
2. **Validate before reloading:** `SELECT … FROM pg_hba_file_rules` (which parses the file on disk
   now) must return **no row with a non-NULL `error`**, and its rows must equal the three expected
   rules exactly. Failure aborts the deploy **before** the reload, and the `trap` restores the
   previous file.
3. **Reload without a database superuser:** `docker compose exec -u postgres postgres pg_ctl reload
-D "$PGDATA"`, as the container's `postgres` OS user. Verified during review: it works and needs
   no SQL privilege, so it also covers step 0's branch 2, where `pg_reload_conf()` would need an
   explicit `EXECUTE` grant. **Its exit code is not a check:** `pg_ctl reload` exits 0 for a
   malformed file too — it only delivers the signal. That is why validation precedes it and the
   assertion follows it; neither is optional.
4. **Assert after reloading** that the expected rules are live. No catalog shows the **loaded**
   rules (`pg_hba_file_rules` shows the file on disk), so this is done by behaviour and by the log:
   from a throwaway container on the backend network, `crm_user` → refused; `crm_app` → accepted on
   `crm_db` and refused on `postgres`; and the server log since the reload must not contain
   `pg_hba.conf was not reloaded`. Any failure fails the deploy and the `trap` restores the previous
   file.

**Branch 2 needs a one-time grant, and it is two statements, not one.** Reading
`pg_hba_file_rules` as a non-superuser requires both of these, and the first alone fails with
`permission denied for function pg_hba_file_rules`:

```sql
GRANT SELECT ON pg_hba_file_rules TO crm_user;
GRANT EXECUTE ON FUNCTION pg_hba_file_rules() TO crm_user;
```

The view and the function behind it are separate objects with separate ACLs. Membership in
`pg_read_all_settings` does **not** cover either. Both statements are run once by the cluster's
superuser, as part of resolving branch 2 (an owner action — see step 0). Verified during review in
exactly this form. Omitting the second statement fails closed, which is why it is written out here:
it is the half that gets forgotten.
The file lives in the data volume, so it is **not** in a `pg_dump` and is lost on a restore onto a
fresh volume; the restore procedure therefore re-runs this step (see "Restore from backup").
Pointing `hba_file` at a mounted file instead would need a restart and would not remove the need
to validate. Confidence **HIGH** throughout: the ignore-on-error behaviour, the reload command, the
`pg_ctl reload` exit code, and the two-statement grant were each reproduced on
`postgres:16-alpine` 16.15 during review.

**Step 0 — the owner's read-only check.** The brief's form, plus the attributes this design depends
on:

```bash
ssh crm-vps "docker exec crm-postgres-1 psql -U crm_user -d crm_db -tAc \"SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user\""
# extended (same, read-only):
ssh crm-vps "docker exec crm-postgres-1 psql -U crm_user -d crm_db -tAc \"SELECT rolname, rolsuper, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = current_user; SHOW log_statement; SHOW log_min_error_statement;\""
```

How each answer changes the plan:

- `rolsuper = t` (expected): the plan as written.
- `rolsuper = f, rolcreaterole = t` (**branch 2**): the plan as written (`CREATE ROLE` needs
  `CREATEROLE`), with three additions. (a) File 1 cannot `SET log_min_error_statement`; the SCRAM
  verifier alone keeps passwords out of the log. (b) **An owner action, once:** the cluster's
  superuser runs both grants that let `crm_user` read `pg_hba_file_rules` — `GRANT SELECT ON
pg_hba_file_rules TO crm_user;` **and** `GRANT EXECUTE ON FUNCTION pg_hba_file_rules() TO
crm_user;`. One without the other fails. (c) `crm_user` is automatically made a member of each
  role it creates, which the catalog check expects in this branch and only this one (§2, item 8).
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
- **After step 5 — a missing grant or a wrong class.** Fix forward, and only forward: correct the
  table's class in the manifest and the matching line in file 2, in a PR that the catalog check
  covers, deployed like any other. The grant added is the **one** the failing query needs, on the
  **one** table it names in its `permission denied` error. There is deliberately **no**
  pre-built "widen everything" file: a blanket class A grant would hand `crm_app` `UPDATE` and
  `DELETE` on the trigger-less audit logs and the ledger, undoing the over-grant protection this ADR
  builds, and a file that is never wired, tested or run is not a path anyone can trust in an
  emergency. If the fix is urgent, the same PR is fast-tracked through review; the path does not
  change. The cost is accepted: one feature may be down for the length of a small PR and a deploy.
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

**Restore from backup — the ordered procedure.** `pg-backup.sh` dumps with `--no-owner --no-acl`,
and its restore notes restart the API right after `psql`. Under this ADR that order breaks: the
restored objects carry no grants, default privileges live per database (`pg_default_acl`) and are
not in the dump, and `pg_hba.conf` lives in the data directory, not in the dump at all. So the API
would either fail every query or — on a fresh volume — start against the image's default
`pg_hba.conf`, which accepts `crm_user` over TCP again. The procedure becomes:

1. Stop the API (as today).
2. Restore as `crm_user` over the local socket (as today), so `crm_user` owns every restored object.
3. Apply file 1, then file 2 (or run a deploy, which does both in order).
4. Install `pg_hba.conf` with the validate → reload → assert sequence of step 7 (on a restore into
   the existing volume this re-asserts the file; on a fresh volume it replaces the image default).
5. Run the catalog check; it must pass.
6. Only then start the API.

The implementing PR rewrites the restore notes in `pg-backup.sh` and the runbook to this order.
On a **fresh** cluster (disaster recovery onto an empty volume), `POSTGRES_PASSWORD` initialises
`crm_user` with the current secret, then the same six steps apply.

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
   variable.** Three of the guards key off the **database name** in the URL path, not the user
   name: `seed-db-guard.ts` (`extractDbName`, `assertSeedTargetIsDisposable`,
   `assertDbPushTargetIsDisposable`), `integration-db-guard.ts` (`setup`, which refuses a URL ending
   in `/crm_db`) and the hook `pre-bash-live-db-guard.sh`. A user-name change alone breaks none of
   them. The fourth is different: `require-real-db.ts` `hasDatabaseUrl` is a **presence** test only
   (`DATABASE_URL` is a non-empty string), and it is the gate the `DATABASE_URL= git push`
   convention relies on to skip integration specs. What would break them is moving `db:seed` /
   `db:push` / fixture setup to `MIGRATION_DATABASE_URL` while the guards keep reading
   `DATABASE_URL`: the guard would inspect a harmless (or empty) URL while the command truncates the
   live one — the class of the 2026-08-18 incident, where an inherited variable let a seed wipe the
   live `crm_db`. Concretely, a shell-inherited `MIGRATION_DATABASE_URL` pointing at `crm_db`
   would survive `DATABASE_URL= git push` untouched, and any setup code reading it would run.
   Hard requirements for the implementing PR:
   - every code path that reads `MIGRATION_DATABASE_URL` is gated by the **same** skip predicate as
     the specs, and the predicate is false unless **both** variables are set;
   - `integration-db-guard.ts` `setup` and the seed / push guards run their database-name check on
     **each** variable they find set, and refuse if **either** names `crm_db`, whether or not the
     other is empty;
   - the push convention in `git-policy.md` becomes `DATABASE_URL= MIGRATION_DATABASE_URL= git
push`, and the live-db hook recognises both variable names (the migration URL is now the more
     dangerous one);
   - the guards' tests gain cases with the migration variable pointing at `crm_db` while
     `DATABASE_URL` is empty, and the reverse.
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
- **Backups do not carry grants.** `pg-backup.sh` dumps with `--no-owner --no-acl`, and default
  privileges are not in the dump. A restore follows the ordered procedure of §4 ("Restore from
  backup"): stop the API, restore as `crm_user`, apply files 1 and 2, run the catalog check, start
  the API. The implementing PR rewrites the restore notes in `pg-backup.sh` and the runbook.
- **The existing audit logs get only the privilege layer for now** (class A-log, §2). Making them
  append-only needs their foreign keys dropped (or set to `RESTRICT`) and a deletion policy, both
  outside this ADR; §2 item 1 states which shape and what each costs.
- **End of retention for the action log is an open owner decision** (§3, R-A / R-B / R-C). R-A
  ships first and must be replaced before any retention period is set.

**Assumptions (A1, recorded per `autonomy-levels.md`)**

- Role names `crm_app` / `crm_collector` — reversible by rename before step 5.
- `crm_user` keeps its name and its role as owner, with no `REASSIGN OWNED` — reversible, and
  cheaper than a new owner role.
- Demoting `crm_user` from superuser is deferred — a separate A3 decision for the owner, not part
  of this rollout.
- The variable name `MIGRATION_DATABASE_URL` — reversible; the implementing task may rename it.
- Refusing TCP login for `crm_user` is classed as **required**, not recommended (§4 step 7) —
  reversible by one `pg_hba.conf` line, but re-opening it is an owner decision.
- The six existing audit logs are class A-log, not class A — reversible by a line in file 2.

**Open owner decisions (not taken here)**

- **End of retention / redaction for `job_queue_actions`** (§3): R-A, R-B or R-C; recommendation
  R-B, moving to R-C. Tied to the erasure design pending from PR #1019.
- **Legal confirmation that shipping R-A as the interim is acceptable** (§3) — a legal conclusion
  this ADR assumes and does not make. It is needed before Task 1.3 relies on it, and it is a
  question for the legal memo's author; the owner is not the one who answers it, which is why the
  owner block lists it as "needs somebody, not you".
- **Dropping the `CASCADE` and `SET NULL` FKs on the six audit logs, keeping the ids as plain
  data** (§2, item 1) — doable now, breaks no current behaviour, needs no test-suite work in that
  shape, and is the prerequisite for those tables ever becoming append-only. Ours to schedule; the
  owner decides only whether to prioritise it ahead of other work.
- **Demoting `crm_user` from superuser** (§1) — deferred, A3: it is the cluster's only superuser,
  so it needs a break-glass superuser first, and it changes nothing for the API boundary.
- **A separate `NOLOGIN` owner role (`crm_owner`) and a read-only role (`crm_readonly`)** (§1) —
  considered and deferred, with the conditions for revisiting stated there.

**Not verified by running — the implementing task proves each before relying on it**

Everything this ADR asserts about PostgreSQL's own behaviour was reproduced on a throwaway
`postgres:16-alpine` 16.15 container; the list is in Sources, and it includes the reload command
`pg_ctl reload -D "$PGDATA"` as the container's `postgres` OS user, which needs no SQL privilege,
and the one-off `pg_hba_file_rules` grant, which is needed and takes **two** statements (§4, step 0
branch 2). What remains unproved is plumbing — all of it inside our own deploy, none of it a claim
about the database:

| Unproved                                                                                                   | Where                            | How the implementing task proves it                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing and moving `pg_hba.conf` inside the data volume, and the `trap` that restores it                   | §4, install sequence             | A deliberately malformed candidate file on a scratch container: the deploy must fail at validation and leave the previous file live and the server restartable |
| Computing the SCRAM verifier on the CI runner, and `\getenv` reaching psql without the value touching argv | §4, password handling            | Apply file 1 to a scratch database, then log in with the secret; `ps` output captured during the run contains no secret                                        |
| The env-file split and `0600`, with Compose no longer interpolating the owner password from the API's file | §4, environment split            | The step 6 environment check, run against a scratch stack                                                                                                      |
| Alerting on `42501` reaching a person                                                                      | §4, "What step 4 does not reach" | A forced `42501` in staging must page, not merely log                                                                                                          |
| The class manifest's format, and where the catalog check runs from                                         | §2, §6                           | The check runs in CI and in the deploy against a scratch database built from the same DDL                                                                      |
| Two connection strings in CI and locally, and the guard changes                                            | §5                               | The guards' own tests, including the new both-directions cases                                                                                                 |

## Rollback

Per step: §4, "Rollback". The rule there: no rollback puts the `crm_user` credential back into
the API's environment, and none can leave the API without a working credential. Summary:

| What to undo                                   | How                                                                                                                                                               | Expected state                                                 | Verify                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| This ADR (docs only)                           | Revert its merge commit                                                                                                                                           | The file is gone; nothing else changed                         | The revert's file list shows only this ADR                                       |
| A missing or wrong grant after step 5          | A forward fix: the table's class in the manifest and the one missing grant in file 2, deployed; no blanket widen-grants file exists                               | The API works as `crm_app`; every other table keeps its class  | The catalog check passes for the new manifest; no `42501` in API logs            |
| `crm_app` cannot log in                        | **[OWNER]** re-enters `CRM_APP_DB_PASSWORD`, deploy; file 1 re-asserts the password; the probe-before-recreate ordering keeps the old container serving meanwhile | The API connects as `crm_app`                                  | The step 3 probes pass                                                           |
| The URL switch (PR B), **before** step 7 only  | Not a rollback path — it restores the owner credential to the API. If the owner nevertheless decides it (A3), revert PR B and deploy                              | The API connects as `crm_user` again, and the boundary is gone | The `pg_stat_activity` query of §4 step 6 shows `crm_user` sessions from the API |
| The roles (PR A), only while nothing uses them | A forward file that drops `crm_app` / `crm_collector` (they own nothing, so `DROP OWNED` + `DROP ROLE` suffice) and removes the default privileges                | No new roles; their grants gone with them                      | `SELECT rolname FROM pg_roles` lists neither role                                |

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
- Behaviours reproduced on a throwaway `postgres:16-alpine` 16.15 container while this ADR was
  being written and reviewed (each is re-proved by the implementing task's tests, not cited from
  here): in-container `127.0.0.1` / `::1` are `trust`; a failing `ALTER ROLE … PASSWORD` is logged
  in clear text with `log_statement = none`; referential actions run as the table owner; the image
  applies `POSTGRES_PASSWORD` only at first initialisation; a malformed `pg_hba.conf` is ignored on
  reload while `pg_reload_conf()` returns true and `pg_ctl reload` exits 0; `pg_ctl reload -D
"$PGDATA"` as the container's `postgres` OS user needs no SQL privilege; `pg_hba_file_rules`
  needs both a view `SELECT` and a function `EXECUTE` grant; a non-superuser with `CREATEROLE` is
  auto-granted `ADMIN` on roles it creates and can later re-grant itself `SET`; a `SECURITY
DEFINER` function without an explicit `pg_temp` in its `search_path` reads a caller's temporary
  table; `md5(prosrc)` is the md5 of the empty string for a `BEGIN ATOMIC` body.
- `docs/legal/2026-10-17-job-queue-actions-erasure.md` (PR #1019) — the end-of-retention and
  redaction requirements of §3.
- Audit tables by symbol: `userAuditLog`, `teamAuditLog`, `projectAuditLog`,
  `transactionAuditLog`, `documentAccessLog` (schema module `audit.ts`), `meetingRecorderAuditLog`
  (schema module `interviews.ts`); pruning by `DocumentAccessLogRetentionCronService`.
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
