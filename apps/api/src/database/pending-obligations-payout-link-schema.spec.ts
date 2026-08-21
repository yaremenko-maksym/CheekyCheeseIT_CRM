/**
 * task-settle-payout-link-lost (backlog 74/B-1, mutation gate). CI's
 * `pnpm mutation:changed` flagged 5 SURVIVED mutants on
 * `pendingObligations.payoutRequestId`'s new column declaration in
 * `schema.ts` — nothing in the unit suite reads the column's own compiled
 * shape (name / FK target / onDelete action), same structural gap
 * `source-income-drop-link-schema.spec.ts` and
 * `sender-receiver-check-schema.spec.ts` already closed for their own
 * columns/constraints:
 *   1. The column's DB name string mutated to `''` — no test noticed.
 *   2. The FK's `.references(() => payoutRequests.id, ...)` callback mutated
 *      to `() => undefined` — no test noticed the FK would then fail to
 *      resolve its target table/column.
 *   3. The FK options object `{ onDelete: 'set null' }` mutated to `{}` —
 *      no test noticed `onDelete` silently reverting to Postgres's default
 *      (`NO ACTION`, which would turn a future `payout_requests` cleanup
 *      into a blocked DELETE instead of a harmless null-out).
 *   4. The `onDelete` VALUE string mutated to `''` — same consequence as 3,
 *      via a different survivor.
 *   5. The new lookup index's NAME string mutated to `''` — no test noticed.
 *
 * The real-Postgres proof that this column round-trips end to end already
 * lives in `drop-payout-company-account.integration.spec.ts`'s AC4 test —
 * excluded from the unit/mutation run by design (`describe.skipIf
 * (!hasDatabaseUrl())`, Stryker's default run carries no DATABASE_URL). This
 * spec closes the mutation-gate gap the same way its precedents do: compile
 * schema.ts's ACTUAL Drizzle object (never a hand-typed restatement) and
 * assert against it directly. Pure unit spec — no live DB needed;
 * `getTableConfig` is pure compile-time introspection, the `Pool` below is
 * never `.connect()`-ed.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { pendingObligations, payoutRequests } from './schema'

describe('pending_obligations.payout_request_id — schema.ts column shape (mutation-gate closure)', () => {
  it("the column DB name is the real string 'payout_request_id', not empty (kills the StringLiteral→'' mutant)", () => {
    const { columns } = getTableConfig(pendingObligations)
    const col = columns.find((c) => c.name === 'payout_request_id')
    expect(
      col,
      `expected a column literally named 'payout_request_id' — got names: ${columns
        .map((c) => c.name)
        .join(', ')}`,
    ).not.toBeUndefined()
  })

  it("the FK really targets payout_requests.id (kills the references-callback→'() => undefined' mutant)", () => {
    const { foreignKeys } = getTableConfig(pendingObligations)
    const fk = foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'payout_request_id'),
    )
    expect(
      fk,
      'expected a foreign key on pending_obligations.payout_request_id',
    ).not.toBeUndefined()
    const ref = fk!.reference()
    expect(ref.foreignTable).toBe(payoutRequests)
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(['id'])
  })

  it("the FK really is ON DELETE SET NULL (kills the options-object→'{}' AND the onDelete-value→'' mutants)", () => {
    const { foreignKeys } = getTableConfig(pendingObligations)
    const fk = foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'payout_request_id'),
    )
    expect(fk!.onDelete).toBe('set null')
  })

  it("the lookup index is the real string 'idx_pending_obligations_payout_request', not empty (kills the StringLiteral→'' mutant)", () => {
    const { indexes } = getTableConfig(pendingObligations)
    const idx = indexes.find((i) => i.config.name === 'idx_pending_obligations_payout_request')
    expect(
      idx,
      `expected an index literally named 'idx_pending_obligations_payout_request' — got names: ${indexes
        .map((i) => i.config.name)
        .join(', ')}`,
    ).not.toBeUndefined()
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    // Mirrors the two precedent specs' own sanity note: constructing the
    // Pool/db objects above is enough to drive `getTableConfig` — nothing in
    // this file calls `.connect()` or issues a query, so it belongs in the
    // default (non-integration) unit run, same as the mutation gate expects.
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})
