# ADR: Least-privileged database roles — the API stops connecting as the bootstrap role

## Status

**Accepted (2026-10-17).** Direction approved by the owner on 2026-10-17 ("do it the right way"),
and the ADR accepted by him the same day — "yes, I accept, R-B" — which also settles the one
question it left open: **R-B is the chosen end-of-retention option** (§3).

**Amended 2026-10-18** to match the implementation (PR #1027) — see "Amendment 2026-10-18" below.
The status is unchanged: the amendment records one owner decision and several measurements; it
reverses no decision the owner accepted.

**Amended 2026-10-19** with facts measured against the accepted text — see "Amendment 2026-10-19"
below. Again the status is unchanged and no decision is reversed: what changes is the accounting of
the scheduled jobs and three statements of fact.

## Amendment 2026-10-18 — reconciled with the implementation

The implementation of this ADR (PR #1027, branch `feat/db-least-privilege-roles`, r5 Task 1.3c)
departs from the text as first accepted. Each departure was either **decided by the owner** or
**forced by a measurement**, and each is argued in that PR's body and in its code, security and
spec reviews. The PR is the measured truth; this ADR now follows it. The body below has been
edited to agree with this list, so a reader who starts at §1 is not misled; this section is the
index of what changed and why.

| #   | What changed                                                                                                                                                                                                                                                                                                                                                                                                       | Cause                                                                                                                                                                                                                                                                                                                                                          | Where in the body                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No deploy rotates the `crm_user` password.** File 1 sets the passwords of `crm_app` and `crm_collector` only. Rotating `crm_user` is a deliberate owner step, done by hand with the machine in reach (§4 step 7 (a))                                                                                                                                                                                             | **Owner decision, 2026-10-18.** The deploy connects to the database as `crm_user`, so "a CI secret appears, the next deploy rotates the password" turns one divergence between the secret and the stored password into a broken deploy — every later one — recoverable only with machine access. Full reasoning: §4, "Step 7 — why rotation"                   | Summary 1 and 4; Context, consequence 3; §1 role table; §4 file 1, password handling, steps 7 and 8, "Step 7 — why"; §6 item 3; Consequences |
| 2   | **Class V for views, `SELECT` only**, and **no default privilege on `TABLES`** (with a forward `REVOKE` repairing a database where one was applied)                                                                                                                                                                                                                                                                | **Measured** by the security review: as `crm_app`, a direct `UPDATE` on an append-only table was refused while the same `UPDATE` through a view over it succeeded, and an `INSERT` through a view over the `transactions` row backup succeeded too. The `TABLES` default privilege's benefit was already delivered by the generator; it bought only the window | §2 class table, "Class V", "Default privileges"; §3 layer 1; §5 item 3                                                                       |
| 3   | **Default privileges are issued `FOR ROLE CURRENT_USER`**, not `FOR ROLE crm_user`; **`crm_retention_owner` gets `USAGE` on schema `public`**                                                                                                                                                                                                                                                                      | `CURRENT_USER` ties the defaults to whoever applies the DDL, and part 5 pins it. A definer function's privilege checks run as its owner, which must resolve names in `public`                                                                                                                                                                                  | §2 "Functions", "Database and schema", "Default privileges"; §3 R-B condition 1; §6 item 5                                                   |
| 4   | **The membership assertion checks the shape of any membership row unconditionally, plus "at most one"**, instead of an expected count — and never derives a count from `rolsuper`                                                                                                                                                                                                                                  | **Measured.** Production's creating role is a superuser, which gets **no** automatic membership row; the original prose stressed the one-row (non-superuser) case. Deriving the count from the current `rolsuper` would break on the ADR's own hardening step `ALTER ROLE crm_user NOSUPERUSER CREATEROLE`                                                     | §2 catalog check item 8; §4 step 0                                                                                                           |
| 5   | **The manifest is reconciled against production's real relation list**, not only against the Drizzle schema; relations no schema file declares go to class E, marked optional                                                                                                                                                                                                                                      | **Measured.** The coverage check found relations in production that no schema file declares, including row backups of `transactions` and of salary data — one of them created by no file in this repository                                                                                                                                                    | §2 "Relations no schema file declares"; catalog check item 1; Consequences                                                                   |
| 6   | **Smaller reconciliations:** the password verifier arrives as a connection parameter (a custom setting) instead of psql `\getenv`; the DDL is **three** files — roles, grants, catalog check — and the last two are generated from one manifest; `crm_collector` is created from the first deploy, with no password; classes C and D ship empty; `document_access_log` has its own manifest class `A-log-prunable` | Testability (the GUC path), measurement (the log exposure), and A1 assumptions recorded in PR #1027                                                                                                                                                                                                                                                            | §1 role table; §2 class table; §4 "Shape of the DDL", password trap 3, step 8; "Not verified by running"                                     |

**Production facts this amendment rests on**, measured 2026-10-18 by read-only queries: `crm_user`
is `super=true login=true createrole=true`, the only non-system role in the cluster, on PostgreSQL
16.14 — so §4 step 0 is answered, **branch 1**. The implementation's own measurements ran on 16.15;
nothing it relies on is newer than 16.0, so the patch-level gap carries no risk.

## Amendment 2026-10-19 — the accounting, corrected by measurement

Four facts were measured on 2026-10-19 against the accounting in §4 ("What step 4 does not reach"),
two of them by an independent reviewer who corrected a first reading. **Every item below came from
measurement, not from a new decision**; the ADR's decisions stand. The accepted sentences are not
rewritten — the one that is wrong carries an inline correction pointing here, so the error stays
visible next to its fix.

1. **Seven of the eight cron services issue `DELETE` or `UPDATE`, not the four the ADR names.** Four
   hold `DatabaseService` directly; three reach it through a service (resume-extraction,
   notification-email, job-sourcing) and were missed by the ADR's "mocked `DatabaseService`"
   accounting. The salary cron is the eighth and writes nothing in that path — only `paySalary`, a
   user action, updates `transactions`.
2. **The ADR's "six" is a mislabelled count.** It does not claim six services; it names four whose
   tables number exactly six (3+1+1+1). Read it as four services and six tables, so the next reader
   does not re-derive it.
3. **"One cron has a real-database spec" is wrong, and in our favour: three do** —
   `salary-cron-idempotency`, `job-sourcing.integration`, `notification-email-delivery.integration`.
4. **Those existing real-database specs connect as `crm_user`, which owns the tables and bypasses
   every grant — so they prove nothing about `crm_app`.** This is true _today_ and is an
   **environment** fact, not a code property: they read `DATABASE_URL`, and §5 flips it to the
   `crm_app` URL at step 4. Until step 4 flips `DATABASE_URL`, three real-database specs exist and
   none of them exercises a grant.

**A measured consequence, not a decision.** PR #1040 (open) adds one real-database spec per
affected cron, each asserting that the connected role is `crm_app` — which is what measure 1 asked
for. It is recorded here because it closes the gap items 1, 3 and 4 describe, not because this
amendment chose it.

Two more facts, each of which corrects a piece of the ADR's own reasoning:

- **The transaction wrap on the 1.3b triggers holds `ShareRowExclusiveLock`, not
  `ACCESS EXCLUSIVE`, so readers are never blocked** — measured from `pg_locks`. The ADR argued
  the DDL's safety for concurrent sessions from MVCC visibility (§4, file 2) and does not state the
  lock level of the trigger DDL; a reader would reasonably assume the stronger lock. Writers still
  queue behind it for the length of the transaction (that follows from the lock conflict table, it
  was not part of the measurement), which is what `lock_timeout` is for.
- **Measure 2's log-grep alert cannot see the paths it exists for until the API writes the SQLSTATE
  into its log text**, because a Drizzle query error carries it only on `.cause`. PR #1042 (open)
  adds the chokepoint. Until it is merged, "match `permission denied` / SQLSTATE `42501`" (measure 2) is a requirement the API's logging does not yet satisfy, and the prerequisite of step 5 is
  not met by the alert's configuration alone.

## For the owner

**What was accepted (2026-10-17)** — the six decisions summarised below: the role model, the
privilege classes, the append-only guarantees, the nine-step rollout, the effect on local work and
CI, and the ordering against the migration-ledger ADR. Acceptance authorises the implementing
tasks, not any production change: every step that touches production is listed separately and the
owner-only ones are marked **[OWNER]**.

**What was chosen (2026-10-17): R-B**, for how expired rows leave the action log (§3) — the narrow
exception reached through two privileged functions the API's cron calls, under the six conditions
§3 specifies. R-C, the same exception behind a separate retention process, is the intended
successor once such a process exists. R-A was not chosen.

**Still open, and not settled by choosing R-B: the erasure decision itself.** R-B is the
_mechanism_; **what** is deleted or re-pointed, and **when**, is the erasure design still pending
with the owner (§3, "The dependency R-B does not resolve"). Choosing the mechanism deliberately did
not pre-empt that.

**What is deferred, needing nothing from you at any point unless you reopen it** — demoting
`crm_user` from superuser (A3: it is the cluster's only superuser); a separate `NOLOGIN` owner role
(`crm_owner`); a read-only role (`crm_readonly`). Each has its conditions for revisiting in §1.

**What the 2026-10-18 amendment asks of you** — nothing new to decide. It records your decision that
rotating `crm_user`'s password stays your own manual step (§4 step 7), and otherwise catches the
text up with what the implementation measured.

**One thing that needs somebody, though not necessarily you** — changing the audit-log foreign keys
(§2), which is ours to schedule, is doable now, and needs your decision only if you want it
prioritised differently. It appears in "Open owner decisions" near the end, which
is the full list.

## Summary of decisions

1. **Roles (§1).** `crm_user` stays the owner and migration role. Its TCP login is refused, so only
   local-socket use remains, and its password is rotated in the database **by the owner, by hand** —
   no deploy rotates it (amended 2026-10-18). The API connects as
   `crm_app`, which owns nothing, is a member of no role and is not a superuser. The collection
   worker gets `crm_collector`. Three login roles, plus the `NOLOGIN` function owner
   `crm_retention_owner` that chosen option R-B of §3 requires.
2. **Privileges (§2).** Every relation in `public` — table or view — is in one class: A ordinary,
   A-log (the six existing audit tables: insert-only for the API, no triggers yet), B append-only,
   C job-sourcing, D collector inputs, E migration-internal (including relations no schema file
   declares), V views (`SELECT` only). No default privilege grants tables: a new relation is
   unreachable until the grants file, generated from the class manifest, names it. `EXECUTE` is
   revoked from `PUBLIC`. A nine-part catalog check fails CI and the deploy on any drift.
3. **Append-only log (§3).** Revoked privileges, `ENABLE ALWAYS` row and `TRUNCATE` triggers, and
   foreign keys that never write the log row (`RESTRICT` / `NO ACTION`, or no FK at all).
   Nothing in the database protects the log from `crm_user`, and
   that is stated. End of retention follows **R-B**, chosen by the owner on 2026-10-17: a bounded
   exception reached through two privileged functions, under six specified conditions. The erasure
   policy it enforces — what is deleted or re-pointed, and when — is still pending (PR #1019).
4. **Rollout (§4).** Nine steps, owner-only ones marked. Roles are created first; the API
   switches to `crm_app` with the owner password moved to a postgres-only env file; then the
   owner rotates the `crm_user` password by hand and `pg_hba.conf` refuses its TCP login, with validation before
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
catalog `crm_user` has `rolsuper = t`. Production was checked on 2026-10-18 (see the Amendment): `crm_user` is a superuser
there too.

**Why production is very probably a superuser too.** Production Postgres is the official
`postgres:16-alpine` image, and `docker-compose.prod.yml` sets `POSTGRES_USER` to `crm_user`. The
image entrypoint creates `POSTGRES_USER` as the cluster's bootstrap superuser at `initdb`. So the
prior is "superuser", and the owner's check (§4, step 0) confirmed it on 2026-10-18. This ADR does **not**
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
   over TCP. The password must be **rotated in the database** — by the owner, by hand — and TCP login
   for `crm_user` refused (§4, step 7). The image reads `POSTGRES_PASSWORD` **only at first initialisation** of an empty
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

Three login roles. Confidence **HIGH** on the model; it is the textbook split. Chosen option R-B
for end-of-retention (§3) adds a fourth role there: `crm_retention_owner`, `NOLOGIN`, which exists
only to own the two privileged functions and never connects.

| Role                  | Kind    | Becomes / is                                                                                                                                                     | Attributes                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crm_user`            | LOGIN   | **The owner / migration role.** Keeps owning every object; every deploy DDL file, the ledger runner (§6), `db:push`, `db:seed` and the backup keep running as it | Unchanged in this ADR (a superuser, measured 2026-10-18). Login attributes unchanged, but its password is **rotated by the owner, by hand** — never by a deploy (§4, step 7) — and TCP login refused, so only local-socket use remains. The new password is held **only** by the `postgres` service and the deploy, never by the API (§4, step 5)                        |
| `crm_app`             | LOGIN   | **The API's role.** The only credential the API process holds                                                                                                    | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, a `CONNECTION LIMIT` sized to the pool plus headroom, member of **no** role, owns **nothing**                                                                                                                                                                                                           |
| `crm_collector`       | LOGIN   | **The collection worker's role** that r5 Task 1.3 requires                                                                                                       | Same attributes as `crm_app`; explicit per-table grants only (§2). **Created by file 1 from the first deploy, with no password** — a role without one cannot authenticate — so the catalog check covers it from the start. It gets a password and its class C / D grants when the worker ships as its own process (§4 step 8); that credential goes only to that process |
| `crm_retention_owner` | NOLOGIN | **The owner of the two R-B functions** (§3); never connects                                                                                                      | Same attributes as `crm_app` but `NOLOGIN`; `USAGE` on schema `public` and no `CONNECT` (§2, "Database and schema"); owns exactly the R-B functions and nothing else                                                                                                                                                                                                     |

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

Every relation in `public` — table, partitioned table, view or materialised view — belongs to
**exactly one class**. The class decides the grants; the class list lives in one manifest,
`privilege-classes.ts` (`PRIVILEGE_CLASSES` assigns, `CLASS_PRIVILEGES` states each class's
policy), from which the grants file and the catalog check are both generated (§4). Confidence
**HIGH** on the grants; the manifest format, open when this ADR was accepted, is settled by the
implementation.

| Class                                                | Members (examples, by table)                                                                                                                                                                               | `crm_app`                                                                                                     | `crm_collector`                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A — ordinary**                                     | Default for every product table: users, projects, transactions, contracts, …                                                                                                                               | `SELECT, INSERT, UPDATE, DELETE`                                                                              | nothing                                                                                           |
| **B — append-only**                                  | `job_queue_actions`; any future audit / action log                                                                                                                                                         | `SELECT, INSERT` only — `UPDATE, DELETE, TRUNCATE` explicitly revoked, plus the triggers in §3                | nothing, unless r5 names it                                                                       |
| **C — job-sourcing**                                 | The job-sourcing tables r5 Task 1.3 lists for the collector                                                                                                                                                | as class A                                                                                                    | `SELECT, INSERT, UPDATE, DELETE` on exactly the listed tables                                     |
| **D — collector evaluation inputs**                  | users / team memberships, project-derived exclusion inputs, legacy résumé inputs (r5's list)                                                                                                               | as class A                                                                                                    | `SELECT` — **column-level** on any table that also carries credentials, tokens or finance columns |
| **A-log — existing audit logs, not yet append-only** | The six existing audit tables, listed below. The manifest splits them: `A-log` for five, `A-log-prunable` for `document_access_log` — the same privileges, one fewer exception for the check to understand | `SELECT, INSERT`; `DELETE` **only** on `document_access_log` (its retention cron); no `UPDATE`, no `TRUNCATE` | nothing                                                                                           |
| **E — migration-internal**                           | The migration ledger (§6), any deploy bookkeeping, and every relation in `public` that no schema file declares — row backups and data-fix bookkeeping (below)                                              | nothing                                                                                                       | nothing                                                                                           |
| **V — views**                                        | Every view in `public`; the manifest names each one                                                                                                                                                        | `SELECT` only                                                                                                 | nothing                                                                                           |

**Class V — why views need their own class (amended 2026-10-18).** `GRANT … ON ALL TABLES` and
`ALTER DEFAULT PRIVILEGES … ON TABLES` both cover views — PostgreSQL uses "table" loosely there —
and the privileges on the base tables of an auto-updatable view are checked against the **view
owner**, which is the migration role. So a write through a view is a path around a revoke on the
table under it. The security review of PR #1027 proved it by running, as `crm_app`: a direct
`UPDATE` on the append-only class B table was refused with `permission denied`, while the same
`UPDATE` through a plain `SELECT *` view over it changed a row, a `DELETE` through that view
succeeded, and an `INSERT` through a view over the `transactions` row backup (class E) succeeded
too. Hence class V: `SELECT` for `crm_app`, nothing for the collector. The implementation verified
that none of today's views reads an audit log and that no production code writes through a view;
a view the API must write through is outside this ADR and needs its own justification.

**The class is necessary but not sufficient.** The default privilege on `TABLES` that this ADR first
specified also reached views, so a view created after the grants file ran was writable whatever its
class. Removing that default privilege is what closes the path ("Default privileges", below).

**Relations no schema file declares — reconcile against production, not only against the schema
(amended 2026-10-18).** The manifest must cover production's **real** relation list. The Drizzle
schema is not that list: data-fix files and hand operations leave relations in `public` that no
schema module declares, and a unit check derived from the schema (`privilege-classes.spec.ts`)
cannot see them. The implementation's coverage check, which reads `pg_class`, found them. A
read-only comparison of production's relation list with the manifest on 2026-10-18 found three in
production:

- `_settle_phantom_backup_20260715` — a row backup of `transactions`, left by a 2026-07-15 data-fix
  file;
- `drop_cascade_origin_marker_state` — bookkeeping of a 2026-07-27 backfill file;
- `salary_month_shift_backup` — a hand-taken row backup of salary data that **no file in this
  repository creates**, so neither reading the repository nor running a test could have found it;
  the first production deploy would have failed on it.

A fourth, `_drop_share_pending_parity_backup_20260727`, is created by a data-fix file that
integration specs apply; production does not carry it.

The rule: such a relation lands in **class E** — the API gets nothing — and is listed in
`MANUAL_DDL_RELATIONS` as **optional**, so it must be classified where present and is not required
to exist. It never defaults to writable: the grants file revokes everything on every relation
before granting by class, so an unclassified relation is stripped, and catalog check part 1 fails
the deploy naming it. A row backup of `transactions` or of salary data carries the same data as the
table it copies; class A would hand that copy to the API. The comparison with production's
relation list is a read-only `SELECT`, repeated before any deploy that may meet a relation the
repository does not know about. The manifest makes no claim about production's contents; a
measurement belongs next to the date it was taken.

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

1. **FKs — drop them and keep the ids as plain data.** A class B table may carry only FKs whose
   referential action never writes the log row: `RESTRICT` / `NO ACTION`, or no FK at all (§3
   layer 3 states the rule and why). `SET NULL` does not qualify — it is an `UPDATE` of the log
   row, which the immutability trigger refuses — so changing these six to `SET NULL` would be an
   interim shape only, valid exactly while there is no trigger, and it would have to be undone to
   make the transition.

   **Dropping the FKs is not a concession; against the current schema it is strictly more
   evidentiary.** Today `target_id` is `CASCADE` on the user, team and project logs, so deleting a
   parent destroys that subject's entire audit history, and `actor_id` is `SET NULL` everywhere, so
   deleting a person erases the record of who acted. With no FK, both rows survive intact with
   their ids — the delete touches nothing. What is given up is referential enforcement, and here it
   protects almost nothing: a class B table keeps `INSERT` by design, so the FK never stopped a
   forged row, it only required the forged `actor_id` to name an **existing** user — which is
   worse, because it means a real person can be framed by a value that passes every constraint.

   This generalises a precedent already reviewed and in the schema, rather than inventing a shape:
   `transaction_audit_log.target_id` and `document_access_log.target_id` carry no FK **by
   decision**, with the rationale in a comment beside them ("an audit trail must OUTLIVE the row it
   describes"). The six tables simply extend it from the target to every column pointing at a
   deletable row.
   - **Preferred: drop the FK on each such column, keeping the `uuid` as plain data.** Deleting a
     parent touches no log row, so the trigger is not involved, and **no test-suite work is
     needed**: the roughly 110 spec teardowns that delete users, teams and projects keep passing.
     The id becomes dangling, which is correct here, and is why erasure must come from the
     end-of-retention path rather than from a cascade (item 3).
   - **Acceptable: `RESTRICT`.** It keeps referential integrity but forbids deleting a referenced
     parent at all, so every teardown that deletes a user, team or project must first delete the
     log rows **as the migration role** — `crm_app` gets `permission denied` trying to clear the
     way, which is the point of the class but also the cost. That is the test-suite work this
     option carries, around 110 teardowns, and it is why the other shape is preferred.

   Either way the schema change itself is doable now and breaks no production behaviour, because
   nothing in production deletes these parents.

2. **Pruning.** `document_access_log` retention moves off the API's credential onto the
   end-of-retention path §3 defines — whichever option the owner decides there.
3. **Erasure — and the obligation the dropped FKs create.** The same legal question the memo of
   PR #1019 answers for `job_queue_actions` applies to these tables; their end-of-retention path
   follows the same owner decision. **With the FKs dropped, nothing sweeps these tables when a user
   is deleted or pseudonymised, so the end-of-retention path must name all six explicitly** — see
   §3, "What the end-of-retention path must cover". An erasure job written for
   `job_queue_actions` alone, trusting a cascade that no longer exists, would leave
   `user_audit_log.changes` holding plain-text personal data indefinitely.
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
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

A function the API must call is then granted to `crm_app` by name, in the PR that adds it. Built-ins
in `pg_catalog` (`gen_random_uuid`, `now`, …) are unaffected. Firing a trigger does not check
`EXECUTE` on the trigger function, so the §3 triggers keep working.

No `SECURITY DEFINER` function exists today. A definer function runs with its owner's privileges
and is a hole through every boundary here, so one may be added only in the narrow form §3
specifies for the chosen end-of-retention option R-B: owned by a dedicated
non-superuser role (never `crm_user`), `search_path = pg_catalog, public, pg_temp`, static SQL
only, `EXECUTE` revoked from `PUBLIC` and granted by name, and pinned by the catalog check. Any
other definer function needs its own ADR-level justification.

**Database and schema.** On `crm_db`: `REVOKE ALL ON DATABASE crm_db FROM PUBLIC` (removes the
implicit `CONNECT` and `TEMPORARY`), then `GRANT CONNECT` to `crm_app` and `crm_collector`. On the
**other** databases of the cluster — `postgres` (the maintenance database) and `template1` —
`REVOKE CONNECT, TEMPORARY … FROM PUBLIC` as well; otherwise `crm_app` can still connect to
`postgres` and create temporary tables there. `pg_hba.conf` (§4 step 7) confines both
application roles to `crm_db` at the network layer too. Schema: `GRANT USAGE ON SCHEMA public` to
both application roles **and to `crm_retention_owner`** — privilege checks inside a `SECURITY
DEFINER` function run as the function's owner, so the owner of the R-B functions must resolve
names in `public` even though it never connects (it gets no `CONNECT`); `REVOKE CREATE ON SCHEMA public FROM PUBLIC` — already the default on a cluster initialised
by PostgreSQL 15+, issued explicitly so the file is correct on any cluster. No `TEMPORARY` for
either role; if the API ever needs temp tables, the grant is added by a PR that states why.

**Default privileges — sequences and the function revoke, and nothing on tables (amended
2026-10-18).**

```sql
-- Forward repair only: removes a TABLES default privilege a database may carry from an
-- earlier revision. A no-op where none was ever applied, which is production.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE ALL ON TABLES FROM crm_app, crm_collector, crm_retention_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE GRANT OPTION FOR USAGE, SELECT ON SEQUENCES FROM crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- crm_collector: deliberately NO default privileges (fail closed).
```

What this gives, exactly:

- **A new relation of any class is unreachable by the API until the grants file names it.** That is
  fail closed, and loud: `permission denied`, SQLSTATE `42501`, not wrong data. It costs nothing in
  reachability: a new table cannot ship without a manifest entry, because `privilege-classes.spec.ts`
  derives its list from the Drizzle schema and fails the unit suite on any unclassified table, and
  the grants file is generated from the manifest. The deploy applies the grants file after every
  file that creates a relation, so by the end of the deploy the new table holds its class's grants.
- **Why the `ON TABLES` grant this ADR first specified was removed** (security review of PR #1027).
  Its stated benefit — "a new class A table is reachable the moment it is created" — was already
  delivered by the generator, so it bought only the **window** between a `CREATE TABLE` and the
  grants file. In that window it failed **open**: `ON TABLES` covers views, so a new view over a
  class B, A-log or E relation was writable by `crm_app` (class V, above); and a new class B, A-log
  or E table started with `UPDATE, DELETE` for the API. The window is never zero inside a deploy,
  and unbounded if a deploy dies between the DDL and the grants file or if DDL is applied outside a
  deploy. The mitigation first written here — revoke in the same `BEGIN … COMMIT` as the
  `CREATE TABLE` — was discipline that no gate enforced.
- **Why the file carries a `REVOKE` and not merely the absence of the `GRANT`.** Deleting a
  statement does not undo its effect on a database that already ran it, and catalog check part 5
  would then fail every deploy with no forward fix. "The fix is a PR, not a hand-made `GRANT`" has to
  hold for this too. The same argument gives `REVOKE GRANT OPTION FOR` on sequences: re-granting a
  privilege already held grantably leaves the grant option standing (measured on 16.15).
- **Sequences keep a default privilege**, so a table whose grants do arrive does not then fail on
  its own identity column. A sequence is not a view and has no owner-checked write path.

- A new table the **collector** needs is unreachable until a grant names it. Fail closed is loud: the
  worker gets `permission denied` (SQLSTATE `42501`), not wrong data.
- **`FOR ROLE CURRENT_USER`, not `FOR ROLE crm_user`.** The trap: default privileges apply only to
  objects created **by the role named**; an object created by any other role gets none, silently.
  `CURRENT_USER` ties them to whichever role applies file 1, which by construction is the role that
  applies every other DDL file in the same deploy — and on a developer machine the role behind
  `db:push`. On production that records `defaclrole = crm_user`, the same row the literal would
  give (verified on 16.15). Catalog check part 5 closes the loop: it **derives** the migration role
  from who owns the tables and fails if the default privileges are attached to anyone else, so if
  DDL ever starts running as a second role the deploy fails instead of new objects quietly losing
  their defaults.

**The catalog check — what makes "silently" impossible.** One check, run in CI against a scratch
database built from the same DDL, and as a deploy step right after the DDL apply steps. It ships
as a generated SQL file applied immediately after the grants file (file 3, §4), and the integration
spec `db-privileges.integration.spec.ts` turns each deciding branch red by its own test. It has nine
parts and reads `pg_class`, `pg_roles`, `pg_auth_members`, `pg_default_acl`, `pg_proc`,
`pg_namespace`, `pg_trigger` and `information_schema.column_privileges`, plus the
`has_*_privilege` functions — because `has_table_privilege` alone sees neither sequences, nor
column grants, nor default privileges:

1. **Manifest coverage, both directions.** Every relation in `public` (table, partitioned table,
   view, materialised view) appears in the class manifest exactly once, and every non-optional
   manifest entry exists. A relation missing from the manifest **fails the check** — the author of
   a new table must choose its class. Optional entries — relations no schema file declares (above)
   — must be classified where present and need not exist.
2. **Table privileges.** For every relation and each of the three roles, `has_table_privilege` for each of `SELECT,
INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` equals what the class prescribes — no
   more, no less. For class D tables with column-level grants, the table-level `SELECT` for
   `crm_collector` must be **false** (a table-level grant would silently cover every column).
3. **Column privileges.** For each role, the set of `(table, column)` pairs carrying a
   column-level privilege (`information_schema.column_privileges`) equals the manifest's list
   exactly — the class D columns for `crm_collector`, and the empty set for the other two. `has_table_privilege` cannot see these.
4. **Sequence privileges.** For every sequence in `public`, `has_sequence_privilege` gives `crm_app`
   `USAGE` and `SELECT` and **not** `UPDATE`; `crm_collector` only `USAGE`, and only on sequences of
   its class C tables.
5. **Default privileges.** `pg_default_acl` holds exactly the entries of the block above, for
   `defaclrole` = the migration role derived from table ownership — sequences (`crm_app=rU`, not
   grantable) and functions (no `PUBLIC` `EXECUTE`) — **no** entry granting anything on tables, and
   no entry for any other role, so a stray `ALTER DEFAULT PRIVILEGES` is caught.
6. **Database and function privileges.** `has_database_privilege` — `crm_app` / `crm_collector` have
   `CONNECT` on `crm_db` only, `TEMPORARY` nowhere, and `CREATE` on schema `public` is false.
   `has_function_privilege` — `PUBLIC` holds `EXECUTE` on no function in `public`.
7. **Role attributes and ownership.** For `crm_app`, `crm_collector` and `crm_retention_owner`:
   `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolbypassrls`, `rolreplication` are all false, and
   login and connection limit are as file 1 sets them; they own no object (`pg_class.relowner`,
   `pg_proc.proowner`, `pg_namespace.nspowner`), except that `crm_retention_owner` owns exactly the
   R-B functions.
8. **Role membership — in both directions, pinned (amended 2026-10-18).** `pg_auth_members` has
   **zero** rows with `member` = any of the three roles (they are members of no role — the
   direction that matters, because membership is what would let them `SET ROLE` to an owner). With
   `roleid` = one of them (someone is a member **of** it), the check asserts two things,
   **unconditionally** — in every branch, with no expected count derived from anything:
   - **The shape of every such row** is the creator shape: `member` = the migration role,
     `admin_option` = true, `inherit_option` = false, `set_option` = false. Any other member, or
     this row with `inherit_option` or `set_option` true, fails the check.
   - **At most one such row** per role.

   **Why no count is asserted.** Whether the creator-membership row exists depends on who
   **created** the role, and production's creating role is a **superuser** — measured 2026-10-18:
   `crm_user super=true login=true createrole=true`, the only non-system role, PostgreSQL 16.14.
   Measured on 16.15 with the same statements and only the creator differing: a superuser creator
   gets **zero** rows; a non-superuser creator with `CREATEROLE` gets **one** row of exactly the
   creator shape, which PostgreSQL 16 records automatically. So:
   - a check expecting one row would pass in a non-superuser scratch database and **fail the first
     production deploy**;
   - a check expecting zero rows would fail every deploy in branch 2;
   - a check deriving the count from the migration role's **current** `rolsuper` is wrong as well
     (security review of PR #1027, reproduced). Creator-membership is a fact about who created the
     role; `rolsuper` is a fact about who the creator is **now**. This ADR's own hardening step,
     `ALTER ROLE crm_user NOSUPERUSER CREATEROLE` (the deferred demotion of §1), changes the second
     without touching the first, and such a check would then fail every deploy with a message whose
     only remedy reads `GRANT crm_app TO crm_user` — directing the operator to add the very route
     this item exists to constrain.

   "Creator shape, at most one" holds in both branches, under demotion and under promotion, and
   still catches every case the count caught: an injected membership row, and the creator row
   re-granted `WITH SET TRUE`. A second grant to the **same** member is merged by PostgreSQL
   (measured on 16.15), so the count's remaining job is to catch a second member.

   **The earlier emphasis of this item was the risk.** As first accepted, the text enumerated both
   branches correctly, but its prose dwelt on the one-row case — the **non-superuser** branch — and
   the implementing task compressed it to "exactly one row". An implementation that followed the
   prose would have failed the first production deploy. Zero rows is the expected production state.

   File 1 still sets `createrole_self_grant = ''` for its session before `CREATE ROLE`, so that in
   branch 2 the automatic row is **made** without `INHERIT` or `SET`; the `ADMIN` part cannot be
   avoided, because it is what lets the creator manage the role it created. That row is harmless
   for the boundary: it lets the owner administer the role, and the owner is already more powerful.

   **The assertion is the guarantee; the setting is not.** `createrole_self_grant` constrains the
   grant at the moment it is made, not the creator's reach afterwards: holding `admin_option`,
   `crm_user` can re-grant the role to itself `WITH SET TRUE` at any time (done during review). So
   the protection is this check running on **every** deploy and failing on exactly that row — not
   the setting in file 1, which only keeps the initial state clean. The same reasoning is why the
   check names the column and the shape it expects: "no membership" without a direction is how a
   check passes while testing the harmless side.

9. **Triggers.** Every class B table has its §3 triggers, in state `A` (`ENABLE ALWAYS`) in
   `pg_trigger.tgenabled`.

This is the same philosophy as `check-prod-ddl-wiring.py`: an enumeration in one place, and CI fails
when reality and the enumeration diverge. Where the check lives, open when this ADR was accepted, is
settled: a generated SQL file in the deploy's manual-DDL sequence, applied after the grants file (§4);
it remains a candidate for the ledger ADR's "catalog validation" step (§6). Confidence **HIGH** that
it must exist, because without it every failure mode listed in this section is invisible until
production.

### 3. The append-only audit log under the new model

Applies to `job_queue_actions` and to every future class B table. Task 1.3 implements from this
text; everything below is stated as a property the schema **delivers** and a test that proves it,
because a guarantee without its test is the failure mode of the previous PR on this feature.

**Layer 1 — privileges (binds `crm_app`, `crm_collector`; does not bind `crm_user`).**
`crm_app` holds `SELECT, INSERT` only. `UPDATE`, `DELETE` and `TRUNCATE` are never granted, and
that is re-asserted on every deploy: the grants file revokes everything on every relation and then
grants each class its set, in one transaction, so a hand-made grant does not survive the next deploy
(no default privilege grants tables, §2). `crm_collector` holds nothing
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

- **No FK (preferred):** deleting a parent touches no log row, so nothing fails and the log keeps
  the id of whoever acted. The id becomes dangling — intended for an audit trail, and the reason
  erasure must come from the end-of-retention path rather than from a cascade. The referential
  enforcement given up protects little here: a class B table keeps `INSERT` by design, so the FK
  never stopped a forged row; it only required the forged id to name an existing person. This is
  the shape `transaction_audit_log.target_id` and `document_access_log.target_id` already use by
  reviewed decision.
- **`RESTRICT`:** referential integrity is kept and the refusal becomes a declared, testable part
  of the schema, but deleting a referenced parent is then impossible until the log rows are removed
  **by the migration role**. Any test teardown that deletes such a parent must do that first.

PR #1017 already declares the actor FKs `restrict`; Task 1.3 must hold every FK on the log to this
rule and write its teardowns accordingly. The same rule is what the six existing audit logs must
satisfy before they can leave their interim class (§2).

**What a class B log may carry — and what it may not.** Immutability turns a column choice into a
permanent one, so the shape of the row is part of this design, not a later detail.

- **Do not denormalise raw identity into the row:** no email, display name, legal name, phone or
  any other direct identifier copied from `users`. In a mutable table such a copy is a redundancy;
  in an append-only one it is **PII that nothing can ever reach again** — pseudonymising or
  deleting the `users` row leaves every copy intact, which defeats the minimisation step the legal
  memo relies on and converts the trigger into a guarantee that personal data cannot be erased.
- **Do carry the actor's role at the time of the action** (and the scope it was exercised in). It
  is the authorisation fact the row exists to prove, it is **unrecoverable afterwards** — roles
  change, and today's `users` row cannot say what the role was last March — and it survives
  pseudonymisation, because a role is not an identifier.
- **Reference people only by id**, and accept that the id is dangling after erasure (layer 3).

Note what this does **not** claim about the six existing logs: they are not "only ids". Their
`changes` column is unconstrained `jsonb` holding before-and-after values of whatever fields were
edited, so a name change records the plain-text name on both sides. That is exactly why item 3 of
§2 makes the end-of-retention path enumerate them, and why this rule exists before any of them
becomes append-only — freezing those rows first and discovering the PII afterwards is the
irreversible version of this mistake.

**What the end-of-retention path must cover** (under R-B, as under any option):
`job_queue_actions` **and** each of the six existing audit logs — `user_audit_log`,
`team_audit_log`, `project_audit_log`, `transaction_audit_log`, `document_access_log`,
`meeting_recorder_audit_log` — **named one by one, not by a pattern and not by assuming a cascade**.
Once their FKs are dropped (§2, item 1), deleting or pseudonymising a `users` row sweeps nothing:
every one of these tables keeps its ids, and `user_audit_log.changes` keeps plain-text personal
data, until a job written for that table removes or re-points it. A retention design scoped to the
action log alone silently retains the rest forever. The retention-policy table (class E) therefore
carries one row per table and per event kind, and the catalog check asserts that every class B and
A-log table appears in it — the same arithmetic device used elsewhere in this ADR, so an added
table cannot be forgotten.

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
4. **End of retention and redaction** follow the chosen option below. The application never
   receives a plain `DELETE` or `UPDATE` on the log under any of them.

**End of retention — R-B, chosen by the owner on 2026-10-17.** The legal memo on erasure in the
action log (`docs/legal/2026-10-17-job-queue-actions-erasure.md`, PR #1019) requires two things
that an unconditional trigger does not provide: a **recurring end-of-retention path** (delete
expired rows, or re-point `actor_id` / `subject_user_id` to a shared "former staff" sentinel), run
only by the retention job through "a second, narrow, privileged exception" in the trigger; and a
**redaction path for `reason`** only (replace the text with a fixed token, append a
`REASON_REDACTED` event, through one privileged function). The memo states that the first is
required whichever erasure option is chosen, because a log that is append-only forever does not
meet storage limitation (GDPR Art. 5(1)(e); UA Law 2297-VI art. 6(8)).

**The decision: R-B** — the bounded exception reached through two `SECURITY DEFINER` functions,
under the six conditions specified below, all six of which are requirements rather than
recommendations. Task 1.3 implements the trigger in this form from the start; there is no
unconditional-trigger stage to replace later.

**R-A was not chosen; R-C is not yet applicable.** R-A (no exception at all) is kept in the table
below because it is the baseline the other two are measured against, and because it documents why
an absolute trigger is not an option: by the memo's conclusion it does not meet storage limitation
once retention periods apply. **R-C is the intended successor to R-B**, not a rejected
alternative — it moves the same exception behind a separate scheduled process, and the move is
cheap by construction (it changes who holds `EXECUTE`, or swaps the `current_user` check). It
becomes the preferred shape as soon as such a process exists; the r5 collection worker is the
natural host.

|                                 | R-A — no exception (**not chosen**)                                                                          | R-B — bounded exception through definer functions (**chosen**)                                                                                                                                                                                       | R-C — bounded exception for a separate retention role (**intended successor**)                |
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
   (besides `USAGE` on schema `public`, §2) **only** `SELECT, DELETE` on `job_queue_actions`, column-level `UPDATE (reason, actor_id,
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

**Why R-B.** It meets the memo's recurring requirement without a new login credential, and its
only extra exposure — a compromised API redacting reasons — is self-logging and bounded to one
column. Confidence **MED**: the database mechanics are standard, but the trigger-side shape
validation is new code and needs its own tests (one per admitted shape, plus one per refused
near-miss — a non-expired row, a second column changed, a non-token value, a call from a session
whose `current_user` is not `crm_retention_owner`).

**The dependency R-B does not resolve — the erasure decision is still open.** R-B is the
**mechanism**: it defines who may delete or re-point an expired row, and in what shape. It does not
decide **what** is erased or **when**, and choosing it did not settle that. Three things remain
genuinely open, and the implementing task must not read past them:

- **Retention periods are not set.** The functions need a retention-policy table to answer "has
  this row expired", and until the owner freezes periods per event kind that table has no rows —
  so the purge function has nothing to purge. r5 Task 1.4 keeps new-store cleanup disabled until
  they are frozen, which is consistent: R-B can ship inert and start working the day the periods
  land.
- **Pseudonymisation is minimisation, not erasure.** The memo concludes that re-pointing a
  `users` row does **not** amount to erasure, and recommends the hybrid whose end-of-retention path
  R-B implements. Which of the two shapes a given event kind gets at expiry — delete the rows, or
  re-point the person columns to the sentinel — is part of the erasure decision, not of this ADR.
  The function supports both; the policy chooses per kind.
- **The memo's own LOW conclusions ask for a practising privacy lawyer.** This ADR does not stand in
  for that, and R-B being chosen does not discharge it.

So the correct reading is: the database-side mechanism is decided and implementable now; the policy
it enforces is pending. Nothing in §2 or §3 assumes otherwise, and the retention-policy table
starting empty is the designed-for state, not a gap.

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

**Shape of the DDL (three files, for ordering — amended 2026-10-18).** The deploy re-applies every
manual file on every deploy, in a fixed order. Roles must exist before any file mentions them, and
grants must run after every relation exists. So:

- **File 1 — roles** (`2026-10-18_db_roles.sql`, applied **first**): creates `crm_app`,
  `crm_collector` and `crm_retention_owner` if missing (a `DO` block — `CREATE ROLE` has no
  `IF NOT EXISTS`), re-asserts their attributes, sets the passwords of **`crm_app` and
  `crm_collector` only** — each only when its verifier parameter is set — the database and schema
  rules, and the default privileges of §2. It sets **no password for `crm_user`**: that rotation is
  the owner's manual step (step 7). Attributes are repaired by issuing only the clauses that differ
  from the catalog, one `ALTER ROLE` at a time, because PostgreSQL 16 lets a non-superuser change an
  attribute only if it holds that attribute: in branch 2 the file repairs what it may and warns
  about the rest, and the catalog check fails the deploy until a superuser finishes it.
- **File 2 — grants** (`2026-10-18_db_grants.sql`, applied **last**), as **one explicit transaction**
  (`BEGIN … COMMIT`, with a `lock_timeout`): revoke everything on every relation in `public` from
  the three roles, then grant each class its set **by relation name**, then the sequences, then the
  collector's class C / D grants. It raises a named exception if the roles do not exist, and fails on
  a missing non-optional relation. Privileges are catalog rows under MVCC, so no other session ever
  sees the intermediate, fully revoked state (verified during the security review: a concurrent
  `crm_app` session kept reading mid-transaction). Idempotent; re-applying it every deploy also
  repairs drift.
- **File 3 — the catalog check** (`2026-10-18_db_privileges_check.sql`), immediately after file 2:
  asserts what file 2 applied (§2), signalling drift with `RAISE EXCEPTION`, so it must run under
  `-v ON_ERROR_STOP=1`.

Files 2 and 3 are **generated** from the one manifest, `privilege-classes.ts`, by
`pnpm --filter @crm/api db:privileges:generate`, and a spec fails if the committed files differ from
the generator's output. A grant and the assertion that the grant is in place are the same fact
written twice; written by hand they drift silently, and the check would then assert the stale
expectation and pass.

All three follow the existing wiring contract (r5 C-15: scp `source:` entry, an apply step, the
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
3. **`DO` blocks — and why the verifier arrives as a connection parameter (amended 2026-10-18).**
   psql substitutes `:'var'` in ordinary statements, **not** inside a `DO $$ … $$` body, so this
   ADR first had the passwords set by plain `ALTER ROLE … PASSWORD :'app_verifier'` statements
   reading psql `\getenv`. The implementation reads the verifier instead from a custom setting —
   `crm_roles.app_verifier`, `crm_roles.collector_verifier` — passed as a connection parameter
   (`PGOPTIONS="-c crm_roles.app_verifier=…"`, forwarded by name with `docker compose exec -e
PGOPTIONS`), uses it inside a `DO` block, and clears it with `set_config` afterwards. The reason
   is testability: `manual-sql-statements.ts`, the splitter every forward-DDL spec uses to apply a
   manual file the way psql does, refuses a file containing a psql meta-command, so with `\getenv`
   file 1 would be the one manual file no spec can apply and the password path would stay unproved.
   All three traps stay closed — a connection parameter never reaches argv and is readable only by
   the session that set it — and the security review measured the difference on trap 1: with
   `log_statement = all`, the parameter path put the verifier in the server log **zero** times,
   while the `\getenv`-shaped plain `ALTER ROLE` was logged in full as statement text. A value that
   is not a well-formed SCRAM verifier is refused rather than stored; an unset parameter leaves that
   role's password untouched, which is what lets one file serve every step.

Re-applying file 1 every deploy makes rotation of the **two application roles'** passwords "change
the secret, deploy". It deliberately does not do this for `crm_user` — see "Step 7 — why rotation".

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

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Who                                                                                     | Effect on production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Done when                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Read-only check of the current role (commands below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **[OWNER]**                                                                             | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The answer is recorded in the implementing PR                                                                                                                                                                                                                                                             |
| 1   | Add the CI secret `CRM_APP_DB_PASSWORD` (value: `openssl rand -hex 32` — hex, so it is URL-safe in `DATABASE_URL`). One line: "Settings → Secrets → New: `CRM_APP_DB_PASSWORD`, value from `openssl rand -hex 32`"                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **[OWNER]**                                                                             | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The deploy fails loudly if the secret is absent                                                                                                                                                                                                                                                           |
| 2   | PR A: files 1, 2 and 3 (file 3 is the catalog check of §2, a deploy step right after file 2) and their wiring; in CI the integration spec applies them to the integration database. The API still connects as `crm_user`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Coder (files) and DevOps (wiring); merge **[OWNER]**                                    | Roles and grants exist; behaviour unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Deploy green, catalog check green                                                                                                                                                                                                                                                                         |
| 3   | Automated probes, in the same deploy, **from a throwaway client container on the backend network** (e.g. a one-off `postgres:16-alpine` run with `--no-deps`), connecting to host `postgres` — never from inside the postgres container, where `127.0.0.1` and `::1` are `trust` and a wrong password also succeeds. Probes: `crm_app` with the right password → accepted; `crm_app` with a deliberately wrong password → **refused** (proves the probe is not hitting a trust rule); inside a rolled-back transaction, `UPDATE job_queue_actions` as `crm_app` → `42501`                                                                                                          | DevOps (in PR A)                                                                        | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | All probes as expected                                                                                                                                                                                                                                                                                    |
| 4   | CI runs the API **as `crm_app`** (§5) on `main` — the strongest proof that the grants are sufficient for every query the code makes; **plus** one real-database spec per cron service whose job issues `DELETE` or `UPDATE` (see "What step 4 does not reach"), each asserting the statement succeeds as `crm_app`                                                                                                                                                                                                                                                                                                                                                                 | DevOps + AutoTest                                                                       | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | CI green on `main` with the new connection                                                                                                                                                                                                                                                                |
| 5   | PR B (DevOps): the deploy writes `DATABASE_URL` with `crm_app` and `CRM_APP_DB_PASSWORD`, and splits the environment as in the table above. **Prerequisites:** the `42501` alert of measure 2 ("What step 4 does not reach") is live, and the API registers a pool `error` listener ("What a database restart does to the API today"). **Order inside the deploy:** apply file 1 → run the step 3 `crm_app` login probe → only then recreate the `api` container. If `crm_app` cannot log in, the deploy stops while the old container is still serving; recreation is a plain `docker compose up -d`, not a health-gated swap, so this order is the only thing that guarantees it | DevOps; merge **[OWNER]**                                                               | The API restarts as `crm_app`, as on any deploy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Deploy green and step 6 checks green                                                                                                                                                                                                                                                                      |
| 6   | Verify (commands below): API sessions are `crm_app` only; the API container's environment contains neither the `crm_user` password **value**, nor any `crm_user@` URL, nor `MIGRATION_DATABASE_URL`; a sign-in, a finance page read and one write work; no `permission denied` in API logs for 48 h                                                                                                                                                                                                                                                                                                                                                                                | DevOps automates the first two as deploy steps; the smoke and the log watch **[OWNER]** | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | All four hold                                                                                                                                                                                                                                                                                             |
| 7   | **Revoke the old owner credential (PR C, DevOps, plus one owner step).** (a) **[OWNER]**, by hand and with the machine in reach: rotate `crm_user`'s password **in the database** over the local socket (`ALTER ROLE crm_user PASSWORD` with a SCRAM verifier, never a plain password — trap 1), and set the CI secret `POSTGRES_PASSWORD` to the same new value in the same sitting. **No deploy rotates it** (owner decision 2026-10-18, see "Step 7 — why rotation"); (b) `pg_hba.conf` refuses TCP login for `crm_user` (below); (c) the deploy refuses to write any `DATABASE_URL` whose user is `crm_user`                                                                   | DevOps (b, c); rotation, secret and merge **[OWNER]**                                   | A few seconds of database unavailability: the postgres-only env file changes, so `docker compose up -d` recreates the `postgres` container. **Expect the API process to restart too, and to be unavailable for longer than the database** — it crash-loops through Docker's backoff while Postgres initialises (see below), so plan for seconds to tens of seconds of failed requests, not a transparent reconnect. Adding the pool `error` listener removes the loop. Nothing legitimate logs in as `crm_user` over TCP after step 5. Schedule it like any deploy that restarts the database | The step 3 probes, extended with **one** probe: `crm_user` over TCP → refused. One probe suffices because the `reject` rule fires before authentication, so the result does not depend on which password is tried (the old one is no longer available once the secret is overwritten); `crm_app` accepted |
| 8   | Collector, when the worker ships as its own process: `CRM_COLLECTOR_DB_PASSWORD` **[OWNER]**, its verifier passed to file 1 as `crm_roles.collector_verifier` (the role itself exists from step 2, with no password), class C / D entries in the manifest and so in file 2, the URL only in the worker's environment                                                                                                                                                                                                                                                                                                                                                               | r5 Task 1.3 / DevOps                                                                    | Worker runs as `crm_collector`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Catalog check covers `crm_collector`                                                                                                                                                                                                                                                                      |

**What step 4 does not reach — the scheduled jobs, and what it costs.** Step 4's proof is only as
wide as the code CI actually executes against a real database, and the gap is exactly where the
risk is. **[Corrected 2026-10-19, by measurement — see "Amendment 2026-10-19": three of the eight
cron services have a real-database spec, seven issue `DELETE` or `UPDATE`, and the "six" below
counts tables, not services (four services, 3+1+1+1 tables). The accepted sentence is left as it
was so the correction is visible.]** Of the eight cron services, one has a real-database spec; six use a fully mocked
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

**And the API-side outage is longer than the database's.** `docker-compose.prod.yml` does declare
`depends_on: postgres: condition: service_healthy` for the `api` service, but that governs the
ordering of `docker compose up` only — it does not gate the **restart policy**. So while Postgres
is still initialising, Docker restarts the API immediately, the fresh process fails to reach the
database, exits again, and Docker backs off with a growing delay. The visible outage is therefore
the database's few seconds **plus** however far into the backoff the last failed attempt landed —
seconds to tens of seconds, not "a few seconds", and it is a crash-loop rather than a graceful
wait. A pool `error` listener (below) removes the crash entirely and with it the loop.

Two consequences, both deliberate:

1. **Step 7 states the real effect** — a window of failed requests outlasting the database
   restart — not a transparent reconnect. Any deploy that recreates the `postgres` container
   already behaves this way; step 7 does not make it worse.
2. **Adding a pool `error` listener is a prerequisite of step 7**, and a small one: log the error
   and let the pool discard the client, which is `pg`'s documented way to survive an idle-client
   failure. It belongs to the API's own code (Coder zone), it is useful regardless of this ADR, and
   with it the restart window narrows to the in-flight requests alone. The implementing task must
   confirm the behaviour by killing the database under a running API in a scratch environment —
   before and after adding the listener — rather than inferring it from this paragraph.

   **The listener may log the error object as it is.** A pool error carries a `client` reference,
   which looks like a path to the connection password reaching the logs; it is not. `pg` defines
   `password` on the client as non-enumerable, so neither `JSON.stringify` nor the structured
   logger emits it. Checked and discarded during review, recorded here so it is not re-raised as a
   blocker — but the listener should still log a message and error code rather than dumping the
   whole object, on general grounds.

This is written out because the same class of defect has already been caught on this feature
several times: a guarantee documented ahead of the mechanism that delivers it.

**Step 7 — why rotation, and why refusing TCP is required, not recommended.** The `crm_user`
password has been readable from the API's environment since the first deploy, so it must be
treated as disclosed: removing it from the environment (step 5) stops **future** reads, rotation
invalidates the **past** ones. The Postgres image applies `POSTGRES_PASSWORD` only when it
initialises an empty data directory; on a running cluster only `ALTER ROLE crm_user PASSWORD …`
changes it.

**Who runs that statement is the owner, by hand — never the deploy (owner decision, 2026-10-18).**
As first accepted, this ADR had file 1 re-assert `crm_user`'s password from the CI secret on every
deploy, so that the database and the secret could not drift. The owner removed that, and the
removal is the safer direction rather than the lazier one. The deploy itself connects to the
database **as `crm_user`**, so a mechanism of the shape "a CI secret appears, the next deploy
rotates the password" turns one divergence between the secret and the stored password into a
broken deploy — every later one — recoverable only with access to the machine, not by another
deploy. Nothing would exercise that path before the day it locked the deploy out: the application
roles' passwords are proved by logging in with them, while the migration role's rotation could be
proved only by rotating the credential the test harness itself uses. So rotation is a deliberate
owner step, done with the machine in reach (step 7 (a)). `generate-privilege-sql.spec.ts` asserts
that file 1 sets no password but the two application roles', so the path cannot return without
this decision being revisited. The secret follows the database **by hand**, in the same sitting:
the image applies `POSTGRES_PASSWORD` when it initialises an empty data directory, so a secret left
at the old value would re-create `crm_user` with the disclosed password on a restore onto a fresh
volume.

Refusing TCP login
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

**Answered 2026-10-18:** `crm_user` is `super=true login=true createrole=true`, the only
non-system role, on PostgreSQL 16.14 — the first case below, the plan as written.

How each answer changes the plan:

- `rolsuper = t` (expected): the plan as written.
- `rolsuper = f, rolcreaterole = t` (**branch 2**): the plan as written (`CREATE ROLE` needs
  `CREATEROLE`), with three additions. (a) File 1 cannot `SET log_min_error_statement`; the SCRAM
  verifier alone keeps passwords out of the log. (b) **An owner action, once:** the cluster's
  superuser runs both grants that let `crm_user` read `pg_hba_file_rules` — `GRANT SELECT ON
pg_hba_file_rules TO crm_user;` **and** `GRANT EXECUTE ON FUNCTION pg_hba_file_rules() TO
crm_user;`. One without the other fails. (c) `crm_user` is automatically made a member of each
  role it creates; the catalog check accepts that row by its shape, in either branch, and expects
  no particular count (§2, item 8).
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
  check (c) of step 7 refuses the deploy, and even without (c) the `crm_user` TCP login is refused,
  so the API would start with no working credential. Hence check (c), and hence the forward fixes
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
   `docker-compose.yml` keeps `POSTGRES_USER: crm_user`. Applying file 1 to a local cluster revokes
   `PUBLIC`'s `CONNECT` and `TEMPORARY` on `postgres` and `template1`, which are cluster-wide, and
   nothing undoes it (the check asserts it); reverse with
   `GRANT CONNECT, TEMPORARY ON DATABASE postgres, template1 TO PUBLIC` where that matters.
3. **`db:push` ordering locally.** No default privilege grants tables (§2), so a table `db:push`
   creates after the bootstrap is unreachable by `crm_app` until file 2 is re-applied — the
   bootstrap command re-applies it, and a forgotten re-apply fails loudly with `42501`. The catalog check (§2) is the
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
   and the rotation path for the two application roles' passwords (not `crm_user`'s, §4 step 7). The ledger marks them "re-apply always" or exempts them by name;
   it must not run them once and skip them thereafter. Their checksum stays stable because the
   password comes from the environment, not from the file.
4. **The catalog check of §2 is a candidate for the ledger's "catalog validation" step.** If the
   ledger builds a validation stage, the privilege check runs there; until then it is a standalone
   deploy step. Either way it runs after every apply.
5. **Default privileges are attached to the role that applies file 1** (`FOR ROLE CURRENT_USER`,
   §2), and catalog check part 5 fails if they are attached to a role other than the one that owns
   the tables. If the ledger ever introduces a separate DDL role, it inherits §2's trap: that role
   applies file 1 too, or DDL runs after `SET ROLE` to the role that did.

r5 Task 1.3 implements on top of both: the collector's concrete table list (classes C and D), the
`job_queue_actions` revokes and triggers of §3, and the tests of §3.

## Consequences

**Gains**

- **Once the `crm_user` password has been rotated in the database — by the owner, by hand (§4
  step 7) — and its TCP login refused,** the API, the internet-facing process, can no longer change schema, disable a trigger,
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
- A new table costs one more decision (its class) and, for class B, its §3 triggers. No revoke is
  needed: no default privilege grants tables (§2).
- The manifest must cover production's real relation list, not only the Drizzle schema (§2,
  "Relations no schema file declares"): a relation left by a data-fix file or by hand otherwise
  fails the next deploy.
- Rotating `crm_user`'s password is a manual owner step with the machine in reach, not "change the
  secret, deploy" (§4 step 7).
- Three more manual DDL files under the wiring contract, each costing the four C-15 edits.
- The migration role stays all-powerful over the data. This ADR does not claim otherwise (§3).
- **Backups do not carry grants.** `pg-backup.sh` dumps with `--no-owner --no-acl`, and default
  privileges are not in the dump. A restore follows the ordered procedure of §4 ("Restore from
  backup"): stop the API, restore as `crm_user`, apply files 1 and 2, run the catalog check, start
  the API. The implementing PR rewrites the restore notes in `pg-backup.sh` and the runbook.
- **The existing audit logs get only the privilege layer for now** (class A-log, §2). Making them
  append-only needs their foreign keys dropped (or set to `RESTRICT`) and a deletion policy, both
  outside this ADR; §2 item 1 states which shape and what each costs.
- **End of retention for the action log is R-B** (§3), chosen 2026-10-17: two privileged
  functions under six specified conditions, with R-C the intended successor. The erasure policy it
  enforces is still pending.

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

- **The erasure design itself** (§3, "The dependency R-B does not resolve") — retention periods
  per event kind, and whether each kind is deleted or re-pointed to the sentinel at expiry. The
  mechanism is settled (R-B, chosen 2026-10-17); the policy is not. Pending from PR #1019, whose
  LOW conclusions also ask for a practising privacy lawyer.
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

| Unproved                                                                                                                                           | Where                            | How the implementing task proves it                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Writing and moving `pg_hba.conf` inside the data volume, and the `trap` that restores it                                                           | §4, install sequence             | A deliberately malformed candidate file on a scratch container: the deploy must fail at validation and leave the previous file live and the server restartable                                                                                                                                                                                                     |
| Computing the SCRAM verifier on the CI runner, and the verifier reaching psql as a connection parameter without touching argv (amended 2026-10-18) | §4, password handling            | **Partly proved by PR #1027:** the verifier tool reads the password on stdin and matches the test oracle byte for byte; file 1 applied with the verifier as a connection parameter, then a login with the password. **Left to DevOps:** the `docker compose exec -e PGOPTIONS` hop, the runner-to-VPS hop, and a `ps` capture during the run                       |
| The env-file split and `0600`, with Compose no longer interpolating the owner password from the API's file                                         | §4, environment split            | The step 6 environment check, run against a scratch stack                                                                                                                                                                                                                                                                                                          |
| Alerting on `42501` reaching a person                                                                                                              | §4, "What step 4 does not reach" | A forced `42501` in staging must page, not merely log                                                                                                                                                                                                                                                                                                              |
| The class manifest's format, and where the catalog check runs from                                                                                 | §2, §6                           | **Proved by PR #1027:** `privilege-classes.spec.ts` checks the manifest against the Drizzle schema; the integration spec runs the committed check against a scratch database built from the same DDL, with each deciding branch turned red by its own test. Production's relation list was reconciled against the manifest by a read-only comparison on 2026-10-18 |
| Two connection strings in CI and locally, and the guard changes                                                                                    | §5                               | The guards' own tests, including the new both-directions cases                                                                                                                                                                                                                                                                                                     |

## Rollback

Per step: §4, "Rollback". The rule there: no rollback puts the `crm_user` credential back into
the API's environment, and none can leave the API without a working credential. Summary:

| What to undo                                   | How                                                                                                                                                                                                      | Expected state                                                 | Verify                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| This ADR (docs only)                           | Revert its merge commit                                                                                                                                                                                  | The file is gone; nothing else changed                         | The revert's file list shows only this ADR                                       |
| A missing or wrong grant after step 5          | A forward fix: the table's class in the manifest and the one missing grant in file 2, deployed; no blanket widen-grants file exists                                                                      | The API works as `crm_app`; every other table keeps its class  | The catalog check passes for the new manifest; no `42501` in API logs            |
| `crm_app` cannot log in                        | **[OWNER]** re-enters `CRM_APP_DB_PASSWORD`, deploy; file 1 re-asserts the password; the probe-before-recreate ordering keeps the old container serving meanwhile                                        | The API connects as `crm_app`                                  | The step 3 probes pass                                                           |
| The URL switch (PR B), **before** step 7 only  | Not a rollback path — it restores the owner credential to the API. If the owner nevertheless decides it (A3), revert PR B and deploy                                                                     | The API connects as `crm_user` again, and the boundary is gone | The `pg_stat_activity` query of §4 step 6 shows `crm_user` sessions from the API |
| The roles (PR A), only while nothing uses them | A forward file that drops `crm_app`, `crm_collector` and `crm_retention_owner` (they own nothing until the R-B functions land, so `DROP OWNED` + `DROP ROLE` suffice) and removes the default privileges | No new roles; their grants gone with them                      | `SELECT rolname FROM pg_roles` lists none of the three                           |

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
- PR #1027 (`feat/db-least-privilege-roles`) — the implementation this ADR was amended to on
  2026-10-18: its body ("The membership assertion, measured both ways", the undeclared-relations
  finding, the owner's rotation decision) and its three reviews — the security review (the view
  write-through and the `TABLES` default privilege; the `rolsuper`-derived count), the spec review
  (the `crm_user` rotation; the deviations living only in code comments), the code review (the
  attribute-repair and catalog-check branches). In code, by symbol: `PRIVILEGE_CLASSES`,
  `CLASS_PRIVILEGES`, `MANUAL_DDL_RELATIONS` in `privilege-classes.ts`; the files
  `2026-10-18_db_roles.sql`, `2026-10-18_db_grants.sql`, `2026-10-18_db_privileges_check.sql`.
- Production, read-only, 2026-10-18: role attributes and server version; the relation list in
  `public` compared with the manifest.
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
  table; on an append-only table an `ON DELETE SET NULL` parent delete is refused by the
  `ENABLE ALWAYS` row trigger while `RESTRICT` refuses with `23503` and a column with no FK keeps
  its dangling id untouched, and `crm_app` gets `permission denied` trying to clear a `RESTRICT`
  itself; `pg` defines a client's `password` as non-enumerable, so an unhandled pool error cannot
  carry it into logs through `JSON.stringify` or a structured logger; `md5(prosrc)` is the md5 of
  the empty string for a `BEGIN ATOMIC` body.
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
