import * as schema from '../schema'
import { SEED_USERS } from './users.data'
import type { SeedCtx } from './shared'

export async function seedUsers({ db }: SeedCtx): Promise<void> {
  // ---- 1. Truncate all data (order matters for FK constraints) ----
  //
  // `company_account` (backlog 109): NOT named here from the table's
  // introduction (#249) through 2026-08-25 — checked, no commit or comment
  // ever explains an intentional exclusion. Verified by direct experiment
  // (TRUNCATE run standalone against a scratch DB) that it was NEVER actually
  // skipped in practice: it carries `updated_by → users.id`, and `users` IS
  // in this list, so plain Postgres TRUNCATE...CASCADE semantics already pull
  // it (and nine other unlisted tables — consumed_tx_hashes among them) into
  // the same truncation as a side effect, before this line ever existed. A
  // two-cycle db:seed rehearsal with a real credit+debit in between confirms
  // the derived company-account balance returns to 0 on the second run either
  // way. Listed explicitly anyway: the single-row invariant `company_account`
  // depends on (`CompanyAccountService.getRow`'s "single row, created in
  // seed" comment) should not rest on an incidental FK that a later refactor
  // could silently remove, re-opening exactly the accumulation this backlog
  // item worried about with no test to catch it.
  console.log('\n[1/8] Truncating existing data...')
  await db.execute(
    'TRUNCATE TABLE tos_acceptances, employee_contracts, signed_contracts, tos_versions, contract_templates, notifications, user_audit_log, team_audit_log, project_audit_log, invoice_signatures, pending_obligations, company_account, transactions, payout_requests, project_credentials, legend_entries, legends, project_finance_settings, project_members, projects, interviews, team_members, teams, documents, users RESTART IDENTITY CASCADE' as unknown as Parameters<
      typeof db.execute
    >[0],
  )
  console.log('  ✓ Tables truncated')

  // ---- 2. Users ----
  console.log('\n[2/8] Inserting users...')
  await db.insert(schema.users).values(SEED_USERS)
  console.log(`  ✓ ${SEED_USERS.length} users inserted`)

  // security-review PR #623 (SR-H-3, HIGH): this bulk insert bypasses
  // UsersService.createUser entirely (fixture data, not a request path) —
  // which means it also bypasses `upsertWorkEmail`, the ONLY other place a
  // `users.email` write is paired with the matching `user_emails` WORK row
  // login now actually reads (see `findLoginableUserByEmail`). Without
  // this, db:seed produces a database where NO seeded user can log in —
  // caught by two red E2E shards on `dev-login … 404` before this was
  // added. Every SEED_USERS entry gets its own login-enabled WORK row here,
  // by the same rule `UsersService.upsertWorkEmail`'s docblock states: every
  // writer of `users.email` maintains the matching `user_emails` row, or is
  // named as a documented exception. See `user-emails-writer-inventory.spec.ts`
  // for the mechanical check that keeps this list honest.
  await db.insert(schema.userEmails).values(
    SEED_USERS.map((u) => ({
      userId: u.id!,
      email: u.email,
      kind: 'WORK' as const,
      canLogin: true,
      verifiedAt: u.createdAt ?? new Date(),
    })),
  )
  console.log(`  ✓ ${SEED_USERS.length} user_emails (WORK) rows inserted`)
}
