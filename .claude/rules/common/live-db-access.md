# Rule: Access to the live `crm_db` database — reading allowed, writing forbidden

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, DevOps, code-reviewer, security-reviewer, manual-qa, Master)
**Source:** Owner decision 2026-08-22 following an observation incident (backlog item 166):
security-reviewer connected to `crm_db` for reading to verify a finding — and that is exactly what produced
two HIGH findings on PR #589 that no test caught.

---

## Why the rule was rewritten, not tightened

The prior wording was absolute ("**never** connect to `crm_db`") and lived **only
in prompt text** — no canonical file existed, scraps were in `git-policy.md`,
`light-track.md`, `agent-isolation.md`. The rule was broken not out of carelessness but because
read-only access to real data is the only way to tell a real finding from a
hypothetical one. A rule broken for the sake of useful work breeds circumvention and devalues
itself entirely — the same argument by which we narrowed the guards in PR #561.

So the boundary is drawn where it is meaningful: **not "connect / don't connect", but
"read / write"**.

## The rule

| Operation                                                      | `crm_db`      |
| -------------------------------------------------------------- | ------------- |
| `SELECT`, `EXPLAIN`, reading the schema                        | **allowed**   |
| `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE`                    | **forbidden** |
| DDL of any kind (`ALTER`, `CREATE`, `DROP`, migrations)        | **forbidden** |
| `db:push`, `db:seed`, `db:migrate`                             | **forbidden** |
| Running tests that write (integration specs, E2E)              | **forbidden** |
| Starting a dev server with `DATABASE_URL` pointing at `crm_db` | **forbidden** |

**Writing work is always on a scratch/QA database**, `DATABASE_URL` set **inline in the
command itself** (not `export` — an export lives until the end of the session and reproduces exactly the hole
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
- **Do not drag personal data into the report.** If names are needed for the conclusion — aggregate (counts,
  sums) or anonymize. In the #589 report the employees' real full names ended up in the transcript without
  necessity: for the conclusion "the report shows the whole population" a number was enough.
- A read result is **an argument in review, not a source of truth for editing data**. Found
  a discrepancy in data — prepare SQL for the owner, do not fix it yourself.

## What stays mechanically protected (and why that is not enough)

Already exists and remains in force:

- `apps/api/src/database/seed-db-guard.ts` — `db:seed` refuses to work on a database whose name does not
  look disposable (escape hatch `SEED_CONFIRM_LIVE_DB_NAME` — inline only).
- `apps/api/src/test/integration-db-guard.ts` — the same for integration specs.
- `.claude/hooks/pre-bash-live-db-guard.sh` — blocks starting a dev server against the live database.

All three catch **destructive** operations. A plain `psql` / `SELECT` catches nothing — and that is
now **intentional**, not a gap: reading is allowed.

## Related rules

- `.claude/rules/common/git-policy.md` — `DATABASE_URL=` (empty) when pushing feature branches.
- `.claude/rules/common/agent-isolation.md` — worktree and process isolation.
- `.claude/rules/common/light-track.md` — scratch databases during parallel agent work.

## Sources

- Owner decision 2026-08-22 (in response to backlog item 166).
- Incident 2026-08-18: the live `crm_db` was wiped by a seed because of an inherited environment variable
  (item 140, closed by PR #576/#579).
