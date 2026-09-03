/**
 * feat/user-emails-dual-login (§4.4, security-review PR #623, mutation gate).
 * CI's `pnpm mutation:changed` flagged 6 SURVIVED mutants on the `userEmails`
 * table declaration in `schema.ts` — nothing in the unit suite reads the
 * table's own compiled shape, same structural gap `pending-obligations-
 * payout-link-schema.spec.ts` / `source-income-drop-link-schema.spec.ts`
 * already closed for their own tables:
 *   1. `lowerEmail()`'s SQL template mutated to an empty `sql``` — no test
 *      noticed the case-folding (SR-H-1) would then silently stop happening.
 *   2. The whole index-list callback `(t) => [...]` mutated to `() =>
 *      undefined` — no test noticed BOTH unique indexes would vanish.
 *   3. The same callback mutated to `(t) => []` — same consequence, a
 *      different survivor.
 *   4. `idx_user_emails_email_lower`'s NAME string mutated to `''` — no test
 *      noticed.
 *   5. `idx_user_emails_user_kind`'s NAME string mutated to `''` — no test
 *      noticed.
 *   6. `updatedAt`'s `withTimezone: true` mutated to `false` — no test
 *      noticed a bare `timestamp` column (no tz) would then silently drift
 *      from every other timestamp column in this schema.
 *
 * The real-Postgres proof that this table round-trips end to end already
 * lives in `user-emails-uniqueness.integration.spec.ts` and `user-emails-
 * backfill-migration.integration.spec.ts` — excluded from the unit/mutation
 * run by design (Stryker's default run carries no DATABASE_URL, see
 * `.claude/rules/common/mutation-gate-integration-specs.md`). This spec
 * closes the mutation-gate gap the same way its precedents do: compile
 * schema.ts's ACTUAL Drizzle object (never a hand-typed restatement) and
 * assert against it directly. Pure unit spec — no live DB needed;
 * `getTableConfig` / `PgDialect#sqlToQuery` are pure compile-time
 * introspection, the `Pool` below is never `.connect()`-ed.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { userEmails, userEmailInvites, lowerEmail } from './schema'

describe('user_emails — schema.ts column/index shape (mutation-gate closure)', () => {
  it("lowerEmail() compiles to a real 'lower(...)' SQL fragment, not empty (kills the sql``->sql`` mutant)", () => {
    const compiled = new PgDialect().sqlToQuery(lowerEmail(userEmails.email))
    expect(compiled.sql.length).toBeGreaterThan(0)
    expect(compiled.sql.toLowerCase()).toContain('lower(')
  })

  it('the case-folded unique index idx_user_emails_email_lower exists (kills the ArrayDeclaration->[] AND ArrowFunction->undefined mutants, which drop it along with every other index)', () => {
    const { indexes } = getTableConfig(userEmails)
    const idx = indexes.find((i) => i.config.name === 'idx_user_emails_email_lower')
    expect(
      idx,
      `expected an index literally named 'idx_user_emails_email_lower' — got names: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(idx!.config.unique).toBe(true)
  })

  it("the per-user-per-kind unique index idx_user_emails_user_kind exists (kills the same ArrayDeclaration/ArrowFunction mutants from the other side, plus its own StringLiteral->'' mutant)", () => {
    const { indexes } = getTableConfig(userEmails)
    const idx = indexes.find((i) => i.config.name === 'idx_user_emails_user_kind')
    expect(
      idx,
      `expected an index literally named 'idx_user_emails_user_kind' — got names: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(idx!.config.unique).toBe(true)
  })

  it('updatedAt really carries withTimezone: true (kills the withTimezone:true->false mutant)', () => {
    const { columns } = getTableConfig(userEmails)
    const col = columns.find((c) => c.name === 'updated_at')
    expect(col, 'expected a column named updated_at').not.toBeUndefined()
    expect((col as { withTimezone?: boolean }).withTimezone).toBe(true)
    expect(col!.getSQLType()).toBe('timestamp with time zone')
  })

  // CI round (2026-09-03): CI's full-diff `pnpm mutation:changed` flagged a
  // 4th survivor this file's original 3 index/array assertions did not
  // cover — `idx_user_emails_google_id`'s NAME string mutated to `''`. The
  // ArrayDeclaration/ArrowFunction tests above already prove the WHOLE
  // index list survives; this one names THIS specific index the same way
  // its two siblings above already do.
  it("the Google-identity unique index idx_user_emails_google_id exists (kills its own StringLiteral->'' mutant)", () => {
    const { indexes } = getTableConfig(userEmails)
    const idx = indexes.find((i) => i.config.name === 'idx_user_emails_google_id')
    expect(
      idx,
      `expected an index literally named 'idx_user_emails_google_id' — got names: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(idx!.config.unique).toBe(true)
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})

// CI round (2026-09-03): CI's full-diff `pnpm mutation:changed` flagged 4
// SURVIVED mutants on `userEmailInvites`'s own index-list — the sibling
// table to `userEmails` above, same structural gap, never previously
// covered by a dedicated schema spec:
//   1. The whole index-list callback `(t) => [...]` mutated to `() =>
//      undefined` — no test noticed BOTH unique indexes would vanish.
//   2. The same callback mutated to `(t) => []` — same consequence, a
//      different survivor.
//   3. `idx_user_email_invites_user_email`'s NAME string mutated to `''`.
//   4. `idx_user_email_invites_token_hash`'s NAME string mutated to `''`.
describe('user_email_invites — schema.ts index shape (mutation-gate closure)', () => {
  it('the one-active-invite-per-row unique index idx_user_email_invites_user_email exists (kills the ArrayDeclaration->[] AND ArrowFunction->undefined mutants, which drop it along with its sibling)', () => {
    const { indexes } = getTableConfig(userEmailInvites)
    const idx = indexes.find((i) => i.config.name === 'idx_user_email_invites_user_email')
    expect(
      idx,
      `expected an index literally named 'idx_user_email_invites_user_email' — got names: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(idx!.config.unique).toBe(true)
  })

  it("the accept-flow lookup index idx_user_email_invites_token_hash exists (kills the same ArrayDeclaration/ArrowFunction mutants from the other side, plus its own StringLiteral->'' mutant)", () => {
    const { indexes } = getTableConfig(userEmailInvites)
    const idx = indexes.find((i) => i.config.name === 'idx_user_email_invites_token_hash')
    expect(
      idx,
      `expected an index literally named 'idx_user_email_invites_token_hash' — got names: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).not.toBeUndefined()
    expect(idx!.config.unique).toBe(true)
  })
})
