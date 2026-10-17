# Rule: Access to the live `crm_db` database — reading allowed, writing forbidden

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, DevOps, code-reviewer, security-reviewer, manual-qa, Master)

> Rationale, why the absolute prohibition was replaced rather than tightened, and the 2026-08-18
> wipe incident: `docs/architecture/rules-rationale/live-db-access.md`

---

## The rule

| Operation                                                      | `crm_db`      |
| -------------------------------------------------------------- | ------------- |
| `SELECT`, `EXPLAIN`, reading the schema                        | **allowed**   |
| `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE`                    | **forbidden** |
| DDL of any kind (`ALTER`, `CREATE`, `DROP`, migrations)        | **forbidden** |
| `db:push`, `db:seed`, `db:migrate`                             | **forbidden** |
| Running tests that write (integration specs, E2E)              | **forbidden** |
| Starting a dev server with `DATABASE_URL` pointing at `crm_db` | **forbidden** |

**Writing work is always on a scratch/QA database**, `DATABASE_URL` set **inline in the command
itself** (not `export` — an export lives until the end of the session and reproduces exactly the hole
that once wiped the database).

## Mandatory confirmation by fact

Before the first command to any database — confirm where you connected:

```sql
SELECT current_database(), version();
```

The reason is not formal: on port 5432 on the owner's machine **two different Postgres** coexist
(native Homebrew and docker-compose), and `localhost` resolves to the one you don't expect.
Same-named databases in them are different databases.

## Read hygiene

- Read **surgically**: the slice the conclusion needs, not "let's see what's there".
- **Do not drag personal data into the report.** If names are needed for the conclusion — aggregate
  (counts, sums) or anonymize.
- A read result is **an argument in review, not a source of truth for editing data**. Found a
  discrepancy in data — prepare SQL for the owner, do not fix it yourself.

## What stays mechanically protected (and why that is not enough)

- `apps/api/src/database/seed-db-guard.ts` — `db:seed` refuses to work on a database whose name does
  not look disposable (escape hatch `SEED_CONFIRM_LIVE_DB_NAME` — inline only).
- `apps/api/src/test/integration-db-guard.ts` — the same for integration specs.
- `.claude/hooks/pre-bash-live-db-guard.sh` (id `pre:bash:live-db-guard`) — blocks starting a dev
  server against the live database.

All three catch **destructive** operations. A plain `psql` / `SELECT` catches nothing — and that is
now **intentional**, not a gap: reading is allowed.

## Related rules

- `.claude/rules/common/git-policy.md` — `DATABASE_URL=` (empty) when pushing feature branches.
- `.claude/rules/common/agent-isolation.md` — worktree and process isolation.
- `.claude/rules/common/light-track.md` — scratch databases during parallel agent work.
