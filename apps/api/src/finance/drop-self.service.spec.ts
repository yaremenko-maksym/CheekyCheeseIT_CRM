/**
 * Direct unit tests for DropSelfService — the query SHAPE each self-view method
 * sends to the database: what is bound, which column it is ordered and
 * windowed on, and which relation it loads. The behavioural contract is covered
 * through the facade in transactions.drop-self-feeds.spec.ts and
 * transactions.drop-self-summary.spec.ts; this file pins what a canned
 * `findMany` stub cannot see on its own.
 *
 * CR-809-M-6 moved the from/to window out of JS and into the SQL predicate, so
 * what used to be asserted here as a filtered row count is now asserted as the
 * compiled predicate plus its bound values. The window's inclusive EDGES are
 * pinned against real Postgres in `drop-self-business-date.integration.spec.ts`
 * — a boundary is a property of the comparison the database performs, and this
 * file has no database.
 */
import { describe, expect, it, vi } from 'vitest'
import { dropIncomesQuerySchema } from '@crm/shared'
import type { DropIncomesQuery, SessionUser } from '@crm/shared'
import { DropSelfService } from './drop-self.service'
import { collectParamValues, compileWhere } from './__test-helpers__/drizzle-where-introspection'

const DROP_ID = 'drop-A'

const dropUser: SessionUser = {
  id: DROP_ID,
  role: 'DROP',
  displayName: 'Drop A',
  email: 'drop-a@test.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function q(overrides: Partial<DropIncomesQuery> = {}): DropIncomesQuery {
  return dropIncomesQuerySchema.parse(overrides)
}

function makeService(rows: unknown[] = [], self: unknown = undefined) {
  const findMany = vi.fn((_args?: unknown) => Promise.resolve(rows))
  const findFirst = vi.fn((_args?: unknown) => Promise.resolve(self))
  const db = { db: { query: { transactions: { findMany }, users: { findFirst } } } }
  const nbu = { getRates: () => Promise.resolve({}) }
  const svc = new DropSelfService(db as never, nbu as never)
  return { svc, findMany, findFirst }
}

function lastArgs(mock: { mock: { calls: unknown[][] } }): {
  where?: unknown
  orderBy?: unknown[]
  with?: unknown
} {
  return mock.mock.calls[mock.mock.calls.length - 1]![0] as never
}

/**
 * The Date values a captured `where` binds, as ISO strings.
 *
 * Read off `compileWhere`, not `collectParamValues`: the window bounds are bound
 * through a raw `sql` fragment (`gte(sql\`coalesce(...)\`, bound)`), and those
 * params are not `Param`-shaped nodes in the AST, so the walker returns `[]` for
 * them — verified, which is why this helper exists rather than reusing the
 * walker. Comparing ISO strings rather than `Date`s also sidesteps `toContain`'s
 * reference equality for objects.
 */
function boundDates(where: unknown): string[] {
  return compileWhere(where)
    .params.filter((v): v is Date => v instanceof Date)
    .map((d) => d.toISOString())
}

describe('DropSelfService.getDropSelfSummary — query shape', () => {
  it('looks the caller up by their own id', async () => {
    const { svc, findFirst } = makeService([], {
      id: DROP_ID,
      displayName: 'Drop A',
      dropSharePercent: 30,
    })
    await svc.getDropSelfSummary(dropUser)
    expect(collectParamValues(lastArgs(findFirst).where)).toEqual([DROP_ID])
  })
})

describe('DropSelfService.getDropSelfIncomes — query shape', () => {
  it('orders newest-first with exactly one key and loads only the project companyName', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q())
    const args = lastArgs(findMany)
    expect(args.orderBy).toHaveLength(1)
    expect(args.with).toEqual({ project: { columns: { companyName: true } } })
  })

  // CR-809-M-6: the sort key is the BUSINESS date. `toHaveLength(1)` above
  // cannot see WHICH column is sorted on, so it held just as well while the
  // feed was ordering by `created_at` — this is the assertion that discriminates.
  it('sorts on coalesce(tx_date, created_at), not on created_at', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q())
    const { sql: text } = compileWhere(lastArgs(findMany).orderBy![0])
    expect(text).toContain('coalesce("transactions"."tx_date", "transactions"."created_at") desc')
  })
})

/**
 * CR-809-M-6. The from/to window moved from a JS filter over a full table read
 * into the SQL predicate, and its key changed from `created_at` to the business
 * date. The four cases that used to live here fed canned rows through a stub
 * whose `findMany` ignores `where`, so they measured the JS comparison — which
 * no longer exists. They are replaced by assertions on the predicate the
 * database would actually receive (bound values + compiled text), and the
 * inclusive EDGES are re-pinned against real Postgres in
 * `drop-self-business-date.integration.spec.ts` — which is the stronger place
 * for them, since a boundary is a property of the comparison Postgres performs.
 */
describe('DropSelfService.getDropSelfIncomes — business-date window (CR-809-M-6)', () => {
  it('binds no date bound at all when neither from nor to is given', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q())
    const { sql: text } = compileWhere(lastArgs(findMany).where)
    expect(text).not.toContain('coalesce')
  })

  /**
   * The omitted-bound arms, asserted on the WHOLE compiled predicate.
   *
   * `...(fromBound ? [gte(...)] : [])` has an empty-array arm that no
   * "does it contain X" assertion can see: a mutant replacing `[]` with
   * `['Stryker was here']` adds a junk conjunct while every `toContain` /
   * `not.toContain` check above still holds. Both arms survived the mutation
   * gate for exactly that reason. Comparing the ENTIRE predicate — so the
   * absence of a term is asserted as rigorously as its presence — is what
   * kills them, and it is the honest assertion anyway: the claim being made is
   * "this request produces exactly this WHERE", not "it mentions coalesce".
   *
   * This matters beyond the gate. The window is the half of the feed the
   * push-down newly owns, and an unbounded side that silently acquires a bound
   * (or a bounded side that loses one) is precisely how a feed starts hiding a
   * drop's own rows without erroring.
   */
  // The three type literals and the caller id are BOUND ($1-$4), not inlined,
  // so the window's placeholders start at $5.
  const SELF_SCOPE =
    '"transactions"."type" in ($1, $2, $3) and "transactions"."receiver_id" = $4 and "transactions"."deleted_at" is null'
  const COALESCE = 'coalesce("transactions"."tx_date", "transactions"."created_at")'
  const TYPES = ['DROP_INCOME', 'DROP_PENDING_PAYOUT', 'PAYOUT_DROP']

  it('produces EXACTLY the self-scope and no window when both bounds are absent', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q())
    const { sql: text, params } = compileWhere(lastArgs(findMany).where)
    expect(text).toBe(`(${SELF_SCOPE})`)
    expect(params).toEqual([...TYPES, DROP_ID])
  })

  it('produces EXACTLY the self-scope plus a lower bound for `from` only', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q({ from: '2026-06-01' }))
    const { sql: text, params } = compileWhere(lastArgs(findMany).where)
    expect(text).toBe(`(${SELF_SCOPE} and ${COALESCE} >= $5)`)
    expect(params).toEqual([...TYPES, DROP_ID, new Date('2026-06-01T00:00:00.000Z')])
  })

  it('produces EXACTLY the self-scope plus an upper bound for `to` only', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q({ to: '2026-06-30' }))
    const { sql: text, params } = compileWhere(lastArgs(findMany).where)
    expect(text).toBe(`(${SELF_SCOPE} and ${COALESCE} <= $5)`)
    expect(params).toEqual([...TYPES, DROP_ID, new Date('2026-06-30T23:59:59.999Z')])
  })

  it('produces EXACTLY both bounds, in order, when both are given', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q({ from: '2026-06-01', to: '2026-06-30' }))
    const { sql: text, params } = compileWhere(lastArgs(findMany).where)
    expect(text).toBe(`(${SELF_SCOPE} and ${COALESCE} >= $5 and ${COALESCE} <= $6)`)
    expect(params).toEqual([
      ...TYPES,
      DROP_ID,
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-30T23:59:59.999Z'),
    ])
  })

  it('windows on coalesce(tx_date, created_at), never on created_at alone', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q({ from: '2026-06-01', to: '2026-06-15' }))
    const { sql: text } = compileWhere(lastArgs(findMany).where)
    expect(text).toContain('coalesce("transactions"."tx_date", "transactions"."created_at") >=')
    expect(text).toContain('coalesce("transactions"."tx_date", "transactions"."created_at") <=')
    expect(text).not.toContain('"transactions"."created_at" >=')
    expect(text).not.toContain('"transactions"."created_at" <=')
  })

  it('binds `from` as that day midnight UTC — inclusive from the first instant', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q({ from: '2026-06-01' }))
    expect(boundDates(lastArgs(findMany).where)).toContain('2026-06-01T00:00:00.000Z')
  })

  it('binds `to` as that day 23:59:59.999 UTC — inclusive through the whole day', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q({ to: '2026-06-15' }))
    // The +86_399_999 ms extension (MED review finding code-review-2) is what
    // makes the last requested day included rather than only its 00:00:00
    // instant. Mutating that literal changes this bound and fails here.
    expect(boundDates(lastArgs(findMany).where)).toContain('2026-06-15T23:59:59.999Z')
  })

  it('omits the lower bound when only `to` is given (and vice versa)', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q({ to: '2026-06-15' }))
    const onlyTo = compileWhere(lastArgs(findMany).where).sql
    expect(onlyTo).toContain('<=')
    expect(onlyTo).not.toContain(
      'coalesce("transactions"."tx_date", "transactions"."created_at") >=',
    )

    await svc.getDropSelfIncomes(dropUser, q({ from: '2026-06-01' }))
    const onlyFrom = compileWhere(lastArgs(findMany).where).sql
    expect(onlyFrom).toContain('>=')
    expect(onlyFrom).not.toContain(
      'coalesce("transactions"."tx_date", "transactions"."created_at") <=',
    )
  })
})

describe('DropSelfService.getDropSelfPayments — query shape', () => {
  it('binds the PAYOUT type and the caller as sender, ordered newest-first', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfPayments(dropUser)
    const args = lastArgs(findMany)
    expect(collectParamValues(args.where).sort()).toEqual([DROP_ID, 'PAYOUT'].sort())
    expect(args.orderBy).toHaveLength(1)
  })

  // CR-809-M-6 names BOTH drop-self queries. This is the second one.
  it('sorts on coalesce(tx_date, created_at), not on created_at', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfPayments(dropUser)
    const { sql: text } = compileWhere(lastArgs(findMany).orderBy![0])
    expect(text).toContain('coalesce("transactions"."tx_date", "transactions"."created_at") desc')
  })
})
