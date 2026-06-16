# @crm/api — NestJS backend

## Running tests

### Unit tests (no database required)

```bash
pnpm --filter @crm/api test
```

Runs all `*.spec.ts` / `*.test.ts` files excluding integration specs.
No `DATABASE_URL` needed — database-dependent code is mocked.

### Integration tests (real Postgres)

Integration specs (`*.integration.spec.ts`) hit a real Postgres database.
They must **never** run against the working `crm_db` locally to avoid
residue (stale test rows in production data).

#### One-time setup — create `crm_qa`

```bash
createdb crm_qa
DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
  pnpm --filter @crm/api db:push
```

> `db:push` applies the Drizzle schema to `crm_qa` without generating
> migration files. Re-run it after any schema change.

#### Running integration tests

```bash
pnpm --filter @crm/api test integration
```

`vitest` automatically loads `.env.test` which sets
`DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa`.
No manual `export DATABASE_URL=...` needed.

#### DB isolation guard

A `globalSetup` guard (`src/test/integration-db-guard.ts`) fires before
any integration spec runs:

| Condition                         | Result                                      |
| --------------------------------- | ------------------------------------------- |
| `DATABASE_URL` → `crm_qa` (local) | Allowed — logs the target DB name           |
| `DATABASE_URL` → `crm_db` (local) | **Hard error** — run is aborted             |
| `CI=true` (GitHub Actions)        | Guard skipped — container DB is safe        |
| `DATABASE_URL` unset              | Specs skip themselves via `describe.skipIf` |

The guard is active **only** for integration runs (`vitest run integration.spec`).
Unit runs are unaffected.

#### CI behaviour

The `integration` job in `.github/workflows/ci.yml` runs against a
throwaway Postgres container (also named `crm_db` for consistency).
Because `CI=true` is set by GitHub Actions, the guard is skipped and the
job proceeds normally.
