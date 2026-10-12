/**
 * Characterization (pin-the-current-behaviour) unit spec for the SENIOR_INCOME /
 * DROP_INCOME creation cluster of TransactionsService — `createSeniorIncome` and
 * `createDropIncome`.
 *
 * WHY THIS FILE EXISTS. Both methods were covered only by integration specs, which the
 * unit mutation gate cannot see. A verbatim extraction into a dedicated service would
 * therefore surface a pile of "unkillable" survivors, and the temptation would be to
 * paper over them with Stryker directives. This spec is the unit net laid BEFORE the
 * move: it drives each branch over a recording drizzle double and pins observable
 * behaviour (exact inserted row, resolved share snapshot, lifecycle hook args, query
 * predicates, error code + status, guard ORDER) so that mutating the moved code fails
 * a test — no directives needed.
 *
 * DB DOUBLE. Only the query EXECUTOR is stubbed; `transactions`, `projects`, ... are the
 * real schema tables, so every captured `where` is a real Drizzle SQL AST that
 * `compileWhere` turns into the SQL text + bound params Postgres would receive.
 * `findOne` is the read-back facade (it ends both methods), spied exactly as the sibling
 * specs do — its own guards live in transaction-read.util / visibility specs.
 *
 * Scope: this pins what the code does today. It is not an AC spec; the end-to-end
 * guarantees (real Postgres, real RBAC guards, the partial unique indexes) stay in
 * senior-drop-income-idempotency.integration.spec.ts and friends.
 */
import { ForbiddenException } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { projects, teamMembers, transactions, users } from '../database/schema'
import { compileWhere } from './__test-helpers__/drizzle-where-introspection'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { TransactionsService } from './transactions.service'
import { TransactionLifecycleService } from './transaction-lifecycle.service'

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-03-10T12:34:56.000Z')

const SENIOR_ID = 'senior-1'
const DROP_ID = 'drop-1'

function session(role: SessionUser['role'], id: string): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.spec`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

const SENIOR_SESSION = session('SENIOR', SENIOR_ID)
const DROP_SESSION = session('DROP', DROP_ID)

const SENIOR_USER = { id: SENIOR_ID, archivedAt: null as Date | null, seniorSharePercent: 31 }
const DROP_USER = { id: DROP_ID, archivedAt: null as Date | null, dropSharePercent: 12 }

const SENIOR_PROJECT = {
  id: 'proj-s',
  status: 'ACTIVE',
  paymentType: 'FOP',
  companyName: 'Acme Senior Co',
  seniorId: SENIOR_ID,
  dropId: null,
  seniorSharePercentOverride: null as number | null,
  financeSettings: null,
}

const DROP_PROJECT = {
  id: 'proj-d',
  status: 'ACTIVE',
  paymentType: 'FOP',
  companyName: 'Acme Drop Co',
  seniorId: 'someone-else',
  dropId: DROP_ID,
  dropSharePercentOverride: null as number | null,
}

const KEY = '11111111-1111-4111-8111-111111111111'
const URL_OK = 'https://drive.google.com/file/d/1abc/view'
const URL_EXPLORER = 'https://etherscan.io/tx/0xabc123def456'

/** Sentinel for what `.returning()` hands back — identity-checked downstream. */
const CREATED_ROW = { id: 'tx-created-1', type: 'MARKER', amount: '999', currency: 'USD' }

type Payload = Parameters<TransactionsService['createSeniorIncome']>[0]

function payload(overrides: Partial<Payload> = {}): Payload {
  return {
    projectId: 'proj-x',
    amount: 1000,
    currency: 'USD',
    idempotencyKey: KEY,
    receiptExternalUrl: URL_OK,
    ...overrides,
  }
}

// ── DB double ───────────────────────────────────────────────────────────────

interface Harness {
  svc: TransactionsService
  order: string[]
  txFindFirst: ReturnType<typeof vi.fn>
  projectsFindFirst: ReturnType<typeof vi.fn>
  usersFindFirst: ReturnType<typeof vi.fn>
  documentsFindFirst: ReturnType<typeof vi.fn>
  teamMembersFindMany: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  values: ReturnType<typeof vi.fn>
  returning: ReturnType<typeof vi.fn>
  afterCreated: ReturnType<typeof vi.fn>
  findOne: ReturnType<typeof vi.fn>
}

function build(opts: { project?: unknown; user?: unknown; teams?: unknown }): Harness {
  const order: string[] = []
  const txFindFirst = vi.fn().mockResolvedValue(undefined)
  const projectsFindFirst = vi.fn().mockResolvedValue(opts.project)
  const usersFindFirst = vi.fn().mockResolvedValue(opts.user)
  const documentsFindFirst = vi.fn().mockResolvedValue(undefined)
  const teamMembersFindMany = vi.fn().mockResolvedValue(opts.teams ?? [])
  const returning = vi.fn(async () => {
    order.push('insert')
    return [CREATED_ROW]
  })
  const values = vi.fn(() => ({ returning }))
  const insert = vi.fn(() => ({ values }))
  const db = {
    db: {
      query: {
        transactions: { findFirst: txFindFirst },
        projects: { findFirst: projectsFindFirst },
        users: { findFirst: usersFindFirst },
        documents: { findFirst: documentsFindFirst },
        teamMembers: { findMany: teamMembersFindMany },
      },
      insert,
    },
  } as never
  const afterCreated = vi.fn(async () => {
    order.push('lifecycle')
  })
  const lifecycleService = {
    afterTransactionCreated: afterCreated,
  } as unknown as TransactionLifecycleService
  const svc = makeTransactionsService({ db, lifecycleService })
  const findOne = vi.fn(async (id: string) => {
    order.push('findOne')
    return `FOUND:${id}`
  })
  ;(svc as unknown as { findOne: unknown }).findOne = findOne
  return {
    svc,
    order,
    txFindFirst,
    projectsFindFirst,
    usersFindFirst,
    documentsFindFirst,
    teamMembersFindMany,
    insert,
    values,
    returning,
    afterCreated,
    findOne,
  }
}

function pg23505(constraint: string): Error {
  return Object.assign(new Error('duplicate key value'), { code: '23505', constraint })
}

/** Makes the INSERT chain throw `err` (instead of resolving the created row). */
function failInsertWith(h: Harness, err: unknown): void {
  h.returning.mockImplementation(async () => {
    throw err
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Shared behaviour, driven for BOTH methods ──────────────────────────────

interface Kind {
  name: 'createSeniorIncome' | 'createDropIncome'
  type: 'SENIOR_INCOME' | 'DROP_INCOME'
  session: SessionUser
  otherRoles: SessionUser['role'][]
  project: Record<string, unknown>
  user: Record<string, unknown>
  wrongOwnerProject: Record<string, unknown>
  wrongOwnerCode: string
  constraint: string
}

const KINDS: Kind[] = [
  {
    name: 'createSeniorIncome',
    type: 'SENIOR_INCOME',
    session: SENIOR_SESSION,
    otherRoles: ['ADMIN', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'],
    project: SENIOR_PROJECT,
    user: SENIOR_USER,
    wrongOwnerProject: { ...SENIOR_PROJECT, seniorId: 'other-senior' },
    wrongOwnerCode: 'FINANCE_INCOME_OWN_PROJECTS_ONLY',
    constraint: 'uq_transactions_senior_income_idempotency_key',
  },
  {
    name: 'createDropIncome',
    type: 'DROP_INCOME',
    session: DROP_SESSION,
    otherRoles: ['ADMIN', 'JUNIOR', 'HR', 'ACCOUNTANT', 'SENIOR'],
    project: DROP_PROJECT,
    user: DROP_USER,
    wrongOwnerProject: { ...DROP_PROJECT, dropId: 'other-drop' },
    wrongOwnerCode: 'FINANCE_NOT_YOUR_DROP_PROJECT',
    constraint: 'uq_transactions_drop_income_idempotency_key',
  },
]

function call(h: Harness, k: Kind, p: Payload, who: SessionUser = k.session): Promise<unknown> {
  return h.svc[k.name](p, who)
}

describe.each(KINDS)('$name — shared guards and write path', (k) => {
  // ── RBAC gate ───────────────────────────────────────────────────────────
  it.each(k.otherRoles)(
    'role %s is refused with a bare ForbiddenException BEFORE any db access',
    async (role) => {
      const h = build({ project: k.project, user: k.user })

      const err = await call(h, k, payload(), session(role, k.session.id)).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ForbiddenException)
      expect((err as ForbiddenException).getStatus()).toBe(403)
      expect(h.txFindFirst).not.toHaveBeenCalled()
      expect(h.projectsFindFirst).not.toHaveBeenCalled()
      expect(h.insert).not.toHaveBeenCalled()
    },
  )

  // ── Idempotency replay (early SELECT) ──────────────────────────────────
  it('replay hit: reads by (type, idempotencyKey), returns findOne(existing.id, user) and does nothing else', async () => {
    const h = build({ project: k.project, user: k.user })
    h.txFindFirst.mockResolvedValueOnce({ id: 'existing-1' })

    const result = await call(h, k, payload())

    expect(result).toBe('FOUND:existing-1')
    expect(h.findOne).toHaveBeenCalledTimes(1)
    expect(h.findOne).toHaveBeenCalledWith('existing-1', k.session)
    expect(h.txFindFirst).toHaveBeenCalledTimes(1)
    const compiled = compileWhere(h.txFindFirst.mock.calls[0]![0].where)
    expect(compiled.params).toEqual([k.type, KEY])
    expect(compiled.sql).toMatch(/"type" = \$1 and .*"idempotency_key" = \$2/)
    // Nothing downstream of the replay guard ran.
    expect(h.projectsFindFirst).not.toHaveBeenCalled()
    expect(h.usersFindFirst).not.toHaveBeenCalled()
    expect(h.insert).not.toHaveBeenCalled()
    expect(h.afterCreated).not.toHaveBeenCalled()
  })

  it('replay miss: proceeds to the project read (the replay SELECT is not the only gate)', async () => {
    const h = build({ project: k.project, user: k.user })

    await call(h, k, payload())

    expect(h.projectsFindFirst).toHaveBeenCalledTimes(1)
    expect(h.insert).toHaveBeenCalledTimes(1)
  })

  // ── Project fetch + status guard ───────────────────────────────────────
  it('fetches the project by payload.projectId', async () => {
    const h = build({ project: k.project, user: k.user })

    await call(h, k, payload({ projectId: 'proj-lookup-42' }))

    const arg = h.projectsFindFirst.mock.calls[0]![0]
    const compiled = compileWhere(arg.where)
    expect(compiled.params).toEqual(['proj-lookup-42'])
    expect(compiled.sql).toMatch(/"id" = \$1/)
  })

  it('project not found → PROJECT_NOT_FOUND 404; nothing is written', async () => {
    const h = build({ project: undefined, user: k.user })

    await expect(call(h, k, payload())).rejects.toMatchObject({
      response: { code: 'PROJECT_NOT_FOUND', statusCode: 404 },
    })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it.each(['DRAFT', 'REJECTED', 'ARCHIVED', 'COMPLETED'])(
    'project status %s → PROJECT_NOT_ACTIVE 400; nothing is written',
    async (status) => {
      const h = build({ project: { ...k.project, status }, user: k.user })

      await expect(call(h, k, payload())).rejects.toMatchObject({
        response: { code: 'PROJECT_NOT_ACTIVE', statusCode: 400 },
      })
      expect(h.insert).not.toHaveBeenCalled()
    },
  )

  // ── Ownership + USDT admin-only ────────────────────────────────────────
  it('project routed to someone else → 403 with the ownership code', async () => {
    const h = build({ project: k.wrongOwnerProject, user: k.user })

    await expect(call(h, k, payload())).rejects.toMatchObject({
      response: { code: k.wrongOwnerCode, statusCode: 403 },
    })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('USDT-payment project → 403 FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY (only ADMIN declares there)', async () => {
    const h = build({ project: { ...k.project, paymentType: 'USDT' }, user: k.user })

    await expect(call(h, k, payload())).rejects.toMatchObject({
      response: { code: 'FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY', statusCode: 403 },
    })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('ownership is checked BEFORE the USDT rule (wrong owner + USDT → ownership code)', async () => {
    const h = build({ project: { ...k.wrongOwnerProject, paymentType: 'USDT' }, user: k.user })

    await expect(call(h, k, payload())).rejects.toMatchObject({
      response: { code: k.wrongOwnerCode },
    })
  })

  it('a GIG project is NOT treated like USDT — the income is recorded', async () => {
    const h = build({ project: { ...k.project, paymentType: 'GIG' }, user: k.user })

    await call(h, k, payload())

    expect(h.insert).toHaveBeenCalledTimes(1)
  })

  // ── Receipt gate (service-side defence-in-depth) ───────────────────────
  it.each([
    ['no receipt at all', {}, 'RECEIPT_REQUIRED'],
    [
      'both a document and a url',
      { receiptDocumentId: 'doc-1', receiptExternalUrl: URL_OK },
      'RECEIPT_BOTH_NOT_ALLOWED',
    ],
    [
      'USDT with a document instead of a link',
      { currency: 'USDT', receiptDocumentId: 'doc-1', receiptExternalUrl: undefined },
      'RECEIPT_USDT_LINK_ONLY',
    ],
    [
      'USDT with a non-explorer link',
      { currency: 'USDT', receiptExternalUrl: URL_OK },
      'RECEIPT_USDT_LINK_REQUIRED',
    ],
  ] as const)(
    '%s → 400 %s-style receipt refusal, nothing is written',
    async (_label, extra, code) => {
      const h = build({ project: k.project, user: k.user })
      const base = payload({ receiptExternalUrl: undefined })

      await expect(call(h, k, { ...base, ...extra })).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code, statusCode: 400 }),
      })
      expect(h.insert).not.toHaveBeenCalled()
      expect(h.afterCreated).not.toHaveBeenCalled()
      expect(h.documentsFindFirst).not.toHaveBeenCalled()
    },
  )

  it('USDT with an explorer link is accepted and the currency is written as given', async () => {
    const h = build({ project: k.project, user: k.user })

    await call(h, k, payload({ currency: 'USDT', receiptExternalUrl: URL_EXPLORER }))

    const row = h.values.mock.calls[0]![0] as Record<string, unknown>
    expect(row['currency']).toBe('USDT')
    expect(row['receiptExternalUrl']).toBe(URL_EXPLORER)
  })

  // ── Receipt document binding (HIGH-1) ──────────────────────────────────
  it('with a receiptDocumentId: reads that document, binds it, and nulls the url', async () => {
    const h = build({ project: k.project, user: k.user })
    h.documentsFindFirst.mockResolvedValue({
      id: 'doc-77',
      category: 'RECEIPT',
      ownerId: k.session.id,
    })

    await call(
      h,
      k,
      payload({ receiptDocumentId: 'doc-77', receiptExternalUrl: undefined, currency: 'EUR' }),
    )

    expect(h.documentsFindFirst).toHaveBeenCalledTimes(1)
    expect(compileWhere(h.documentsFindFirst.mock.calls[0]![0].where).params).toEqual(['doc-77'])
    const row = h.values.mock.calls[0]![0] as Record<string, unknown>
    expect(row['receiptDocumentId']).toBe('doc-77')
    expect(row['receiptExternalUrl']).toBeNull()
  })

  it('without a receiptDocumentId the documents table is never read', async () => {
    const h = build({ project: k.project, user: k.user })

    await call(h, k, payload())

    expect(h.documentsFindFirst).not.toHaveBeenCalled()
  })

  it('receipt document missing → FINANCE_RECEIPT_DOCUMENT_NOT_FOUND 404', async () => {
    const h = build({ project: k.project, user: k.user })

    await expect(
      call(h, k, payload({ receiptDocumentId: 'doc-x', receiptExternalUrl: undefined })),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_RECEIPT_DOCUMENT_NOT_FOUND', statusCode: 404 },
    })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('receipt document of the wrong category → FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY 400', async () => {
    const h = build({ project: k.project, user: k.user })
    h.documentsFindFirst.mockResolvedValue({
      id: 'doc-x',
      category: 'CONTRACT',
      ownerId: k.session.id,
    })

    await expect(
      call(h, k, payload({ receiptDocumentId: 'doc-x', receiptExternalUrl: undefined })),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY', statusCode: 400 },
    })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it("receipt document owned by someone else → FINANCE_RECEIPT_DOCUMENT_NOT_OWNED 403 (the caller's own id is the expected owner)", async () => {
    const h = build({ project: k.project, user: k.user })
    h.documentsFindFirst.mockResolvedValue({
      id: 'doc-x',
      category: 'RECEIPT',
      ownerId: 'stranger',
    })

    await expect(
      call(h, k, payload({ receiptDocumentId: 'doc-x', receiptExternalUrl: undefined })),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_RECEIPT_DOCUMENT_NOT_OWNED', statusCode: 403 },
    })
    expect(h.insert).not.toHaveBeenCalled()
  })

  // ── Insert target + amount/notes/date plumbing ─────────────────────────
  it('inserts into the transactions table exactly once', async () => {
    const h = build({ project: k.project, user: k.user })

    await call(h, k, payload())

    expect(h.insert).toHaveBeenCalledTimes(1)
    expect(h.insert).toHaveBeenCalledWith(transactions)
    expect(h.values).toHaveBeenCalledTimes(1)
  })

  it.each([
    [1000, '1000'],
    [1234.5, '1234.5'],
    [0.01, '0.01'],
  ])('amount %s is written as the string %s', async (amount, expected) => {
    const h = build({ project: k.project, user: k.user })

    await call(h, k, payload({ amount }))

    expect((h.values.mock.calls[0]![0] as Record<string, unknown>)['amount']).toBe(expected)
  })

  it.each(['USD', 'EUR', 'UAH'])('currency %s is passed through verbatim', async (currency) => {
    const h = build({ project: k.project, user: k.user })

    await call(h, k, payload({ currency }))

    expect((h.values.mock.calls[0]![0] as Record<string, unknown>)['currency']).toBe(currency)
  })

  it('notes: provided → stored; omitted/null → null', async () => {
    const h1 = build({ project: k.project, user: k.user })
    await call(h1, k, payload({ notes: 'hello there' }))
    expect((h1.values.mock.calls[0]![0] as Record<string, unknown>)['notes']).toBe('hello there')

    const h2 = build({ project: k.project, user: k.user })
    await call(h2, k, payload({ notes: null }))
    expect((h2.values.mock.calls[0]![0] as Record<string, unknown>)['notes']).toBeNull()

    const h3 = build({ project: k.project, user: k.user })
    await call(h3, k, payload())
    expect((h3.values.mock.calls[0]![0] as Record<string, unknown>)['notes']).toBeNull()
  })

  it('txDate: omitted/null → now; today → the live instant; another day → UTC midnight of that day', async () => {
    const h1 = build({ project: k.project, user: k.user })
    await call(h1, k, payload())
    expect((h1.values.mock.calls[0]![0] as Record<string, unknown>)['txDate']).toEqual(NOW)

    const h2 = build({ project: k.project, user: k.user })
    await call(h2, k, payload({ txDate: null }))
    expect((h2.values.mock.calls[0]![0] as Record<string, unknown>)['txDate']).toEqual(NOW)

    const h3 = build({ project: k.project, user: k.user })
    await call(h3, k, payload({ txDate: '2026-03-10' }))
    expect((h3.values.mock.calls[0]![0] as Record<string, unknown>)['txDate']).toEqual(NOW)

    const h4 = build({ project: k.project, user: k.user })
    await call(h4, k, payload({ txDate: '2026-03-05' }))
    expect((h4.values.mock.calls[0]![0] as Record<string, unknown>)['txDate']).toEqual(
      new Date('2026-03-05T00:00:00.000Z'),
    )
  })

  // ── Post-insert: lifecycle hook + read-back facade ─────────────────────
  it('after the insert: lifecycle.afterTransactionCreated(created.id, created, actor), THEN findOne(created.id, actor); returns the facade result', async () => {
    const h = build({ project: k.project, user: k.user })

    const result = await call(h, k, payload())

    expect(h.afterCreated).toHaveBeenCalledTimes(1)
    const [id, created, actor] = h.afterCreated.mock.calls[0]! as unknown[]
    expect(id).toBe(CREATED_ROW.id)
    expect(created).toBe(CREATED_ROW)
    expect(actor).toBe(k.session)
    expect(h.findOne).toHaveBeenCalledTimes(1)
    expect(h.findOne).toHaveBeenCalledWith(CREATED_ROW.id, k.session)
    expect(result).toBe(`FOUND:${CREATED_ROW.id}`)
    expect(h.order).toEqual(['insert', 'lifecycle', 'findOne'])
  })

  // ── Idempotency race (23505) ───────────────────────────────────────────
  it("23505 on THIS type's idempotency index → re-reads the committed winner by (type,key) and returns findOne(winner); no lifecycle hook", async () => {
    const h = build({ project: k.project, user: k.user })
    failInsertWith(h, pg23505(k.constraint))
    h.txFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'winner-1' })

    const result = await call(h, k, payload())

    expect(result).toBe('FOUND:winner-1')
    expect(h.txFindFirst).toHaveBeenCalledTimes(2)
    const compiled = compileWhere(h.txFindFirst.mock.calls[1]![0].where)
    expect(compiled.params).toEqual([k.type, KEY])
    expect(compiled.sql).toMatch(/"type" = \$1 and .*"idempotency_key" = \$2/)
    expect(h.findOne).toHaveBeenCalledWith('winner-1', k.session)
    expect(h.afterCreated).not.toHaveBeenCalled()
  })

  it('23505 on the idempotency index but NO committed row found → the original error is rethrown', async () => {
    const h = build({ project: k.project, user: k.user })
    const err = pg23505(k.constraint)
    failInsertWith(h, err)

    await expect(call(h, k, payload())).rejects.toBe(err)
    expect(h.afterCreated).not.toHaveBeenCalled()
    expect(h.findOne).not.toHaveBeenCalled()
  })

  it('23505 on a DIFFERENT constraint is rethrown, not misread as an idempotency race', async () => {
    const h = build({ project: k.project, user: k.user })
    const err = pg23505('uq_transactions_receipt_document_id')
    failInsertWith(h, err)
    h.txFindFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 'would-be-wrong-winner' })

    await expect(call(h, k, payload())).rejects.toBe(err)
    // only the early replay SELECT ran; the catch block did not re-read
    expect(h.txFindFirst).toHaveBeenCalledTimes(1)
    expect(h.findOne).not.toHaveBeenCalled()
  })

  it("the OTHER type's idempotency index does not trigger the race path", async () => {
    const h = build({ project: k.project, user: k.user })
    const other =
      k.type === 'SENIOR_INCOME'
        ? 'uq_transactions_drop_income_idempotency_key'
        : 'uq_transactions_senior_income_idempotency_key'
    const err = pg23505(other)
    failInsertWith(h, err)
    h.txFindFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 'would-be-wrong-winner' })

    await expect(call(h, k, payload())).rejects.toBe(err)
    expect(h.txFindFirst).toHaveBeenCalledTimes(1)
  })

  it('a non-unique-violation insert failure is rethrown untouched', async () => {
    const h = build({ project: k.project, user: k.user })
    const err = new Error('connection reset')
    failInsertWith(h, err)

    await expect(call(h, k, payload())).rejects.toBe(err)
    expect(h.afterCreated).not.toHaveBeenCalled()
  })

  it('a lifecycle failure propagates (the hook is awaited, not fire-and-forget) and findOne is not reached', async () => {
    const h = build({ project: k.project, user: k.user })
    const err = new Error('lifecycle boom')
    h.afterCreated.mockRejectedValue(err)

    await expect(call(h, k, payload())).rejects.toBe(err)
    expect(h.findOne).not.toHaveBeenCalled()
  })
})

// ── createSeniorIncome — specifics ─────────────────────────────────────────

describe('createSeniorIncome — specifics', () => {
  function run(opts: {
    project?: Record<string, unknown>
    user?: unknown
    teams?: unknown
    p?: Payload
  }): { h: Harness; done: Promise<unknown> } {
    const h = build({
      project: { ...SENIOR_PROJECT, ...opts.project },
      user: 'user' in opts ? opts.user : SENIOR_USER,
      teams: opts.teams,
    })
    return { h, done: h.svc.createSeniorIncome(opts.p ?? payload(), SENIOR_SESSION) }
  }

  it('inserts the exact SENIOR_INCOME row (default share path)', async () => {
    const { h, done } = run({ p: payload({ projectId: 'proj-s', amount: 2500.75, notes: 'n1' }) })
    await done

    expect(h.values).toHaveBeenCalledWith({
      type: 'SENIOR_INCOME',
      status: 'PENDING',
      amount: '2500.75',
      currency: 'USD',
      senderId: null,
      senderLabel: 'Acme Senior Co',
      receiverId: SENIOR_ID,
      projectId: 'proj-s',
      seniorSharePercent: 31,
      seniorSharePercentSource: 'USER_DEFAULT',
      idempotencyKey: KEY,
      receiptDocumentId: null,
      receiptExternalUrl: URL_OK,
      notes: 'n1',
      txDate: NOW,
      createdBy: SENIOR_ID,
    })
  })

  it('writes projectId from the PAYLOAD (not from the fetched project row)', async () => {
    const { h, done } = run({ p: payload({ projectId: 'payload-proj-id' }) })
    await done

    expect((h.values.mock.calls[0]![0] as Record<string, unknown>)['projectId']).toBe(
      'payload-proj-id',
    )
  })

  it("reads the caller's own users row by session id", async () => {
    const { h, done } = run({})
    await done

    expect(h.usersFindFirst).toHaveBeenCalledTimes(1)
    const compiled = compileWhere(h.usersFindFirst.mock.calls[0]![0].where)
    expect(compiled.params).toEqual([SENIOR_ID])
    expect(compiled.sql).toMatch(/"id" = \$1/)
    expect(h.usersFindFirst.mock.calls[0]![0].where).toBeDefined()
    // keep the schema import honest: the predicate targets users.id
    expect(compiled.sql).toContain(`"${users.id.name}"`)
  })

  it('reads the project with the financeSettings relation loaded', async () => {
    const { h, done } = run({})
    await done

    expect(h.projectsFindFirst.mock.calls[0]![0].with).toEqual({ financeSettings: true })
    expect(compileWhere(h.projectsFindFirst.mock.calls[0]![0].where).sql).toContain(
      `"${projects.id.name}"`,
    )
  })

  it('senior row missing → SENIOR_NOT_FOUND 404; nothing is written', async () => {
    const { h, done } = run({ user: undefined })

    await expect(done).rejects.toMatchObject({
      response: { code: 'SENIOR_NOT_FOUND', statusCode: 404 },
    })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('archived senior → FINANCE_INCOME_RECEIVER_ARCHIVED 403 before the team lookup, receipt gate and insert', async () => {
    // payload deliberately has NO receipt: the archived guard must win over the receipt gate.
    const { h, done } = run({
      user: { ...SENIOR_USER, archivedAt: new Date('2026-02-01T00:00:00.000Z') },
      p: payload({ receiptExternalUrl: undefined }),
    })

    await expect(done).rejects.toMatchObject({
      response: { code: 'FINANCE_INCOME_RECEIVER_ARCHIVED', statusCode: 403 },
    })
    expect(h.teamMembersFindMany).not.toHaveBeenCalled()
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('a missing receipt is refused AFTER the senior lookup (users row was read first)', async () => {
    const { h, done } = run({ p: payload({ receiptExternalUrl: undefined }) })

    await expect(done).rejects.toMatchObject({ response: { code: 'RECEIPT_REQUIRED' } })
    expect(h.usersFindFirst).toHaveBeenCalledTimes(1)
  })

  it('the USDT rule fires before the senior row is read', async () => {
    const { h, done } = run({ project: { paymentType: 'USDT' } })

    await expect(done).rejects.toMatchObject({
      response: { code: 'FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY' },
    })
    expect(h.usersFindFirst).not.toHaveBeenCalled()
  })

  // Share-percent snapshot hierarchy: project override → exactly-one team override → user default (26)
  describe('senior share snapshot', () => {
    const team = (id: string, ov: number | null, archivedAt: Date | null = null) => ({
      team: { id, seniorSharePercentOverride: ov, archivedAt },
    })

    async function shareOf(opts: Parameters<typeof run>[0]): Promise<Record<string, unknown>> {
      const { h, done } = run(opts)
      await done
      const row = h.values.mock.calls[0]![0] as Record<string, unknown>
      return {
        value: row['seniorSharePercent'],
        source: row['seniorSharePercentSource'],
      }
    }

    it('project override wins over a team override and the user default', async () => {
      expect(
        await shareOf({
          project: { seniorSharePercentOverride: 40 },
          teams: [team('t1', 33)],
        }),
      ).toEqual({ value: 40, source: 'PROJECT' })
    })

    it('project override of 0 is a real override, not "unset"', async () => {
      expect(
        await shareOf({ project: { seniorSharePercentOverride: 0 }, teams: [team('t1', 33)] }),
      ).toEqual({ value: 0, source: 'PROJECT' })
    })

    it('exactly one team override applies when the project has none', async () => {
      expect(await shareOf({ teams: [team('t1', 33), team('t2', null)] })).toEqual({
        value: 33,
        source: 'TEAM',
      })
    })

    it('a team override of 0 applies', async () => {
      expect(await shareOf({ teams: [team('t1', 0)] })).toEqual({ value: 0, source: 'TEAM' })
    })

    it('two overriding teams are ambiguous → falls through to the user default', async () => {
      expect(await shareOf({ teams: [team('t1', 33), team('t2', 35)] })).toEqual({
        value: 31,
        source: 'USER_DEFAULT',
      })
    })

    it('an archived team never participates', async () => {
      expect(
        await shareOf({ teams: [team('t1', 33, new Date('2026-01-01T00:00:00.000Z'))] }),
      ).toEqual({ value: 31, source: 'USER_DEFAULT' })
    })

    it('an archived team does not make a second live override ambiguous', async () => {
      expect(
        await shareOf({
          teams: [team('t1', 33, new Date('2026-01-01T00:00:00.000Z')), team('t2', 35)],
        }),
      ).toEqual({ value: 35, source: 'TEAM' })
    })

    it('no memberships → user default', async () => {
      expect(await shareOf({ teams: [] })).toEqual({ value: 31, source: 'USER_DEFAULT' })
    })

    it('team lookup failing (unstubbed/db error) degrades to the user default instead of failing the income', async () => {
      const h = build({ project: SENIOR_PROJECT, user: SENIOR_USER })
      h.teamMembersFindMany.mockRejectedValue(new Error('unstubbed'))

      await h.svc.createSeniorIncome(payload(), SENIOR_SESSION)

      const row = h.values.mock.calls[0]![0] as Record<string, unknown>
      expect(row['seniorSharePercent']).toBe(31)
      expect(row['seniorSharePercentSource']).toBe('USER_DEFAULT')
    })

    it('user default null → falls back to 26', async () => {
      expect(await shareOf({ user: { ...SENIOR_USER, seniorSharePercent: null } })).toEqual({
        value: 26,
        source: 'USER_DEFAULT',
      })
    })

    it('user default of 0 is kept (not replaced by 26)', async () => {
      expect(await shareOf({ user: { ...SENIOR_USER, seniorSharePercent: 0 } })).toEqual({
        value: 0,
        source: 'USER_DEFAULT',
      })
    })

    it("looks up the caller's ACTIVE memberships (userId = session id, leftAt IS NULL, team relation loaded)", async () => {
      const { h, done } = run({})
      await done

      expect(h.teamMembersFindMany).toHaveBeenCalledTimes(1)
      const arg = h.teamMembersFindMany.mock.calls[0]![0]
      const compiled = compileWhere(arg.where)
      expect(compiled.params).toEqual([SENIOR_ID])
      expect(compiled.sql).toContain(`"${teamMembers.userId.name}" = $1`)
      expect(compiled.sql).toMatch(/"left_at" is null/)
      expect(arg.with).toEqual({ team: true })
    })

    it('the resolved share is taken from the project/user/teams of THIS call and lands next to the source', async () => {
      const { h, done } = run({
        project: { seniorSharePercentOverride: 17 },
      })
      await done

      const row = h.values.mock.calls[0]![0] as Record<string, unknown>
      expect(row['seniorSharePercent']).toBe(17)
      expect(row['seniorSharePercentSource']).toBe('PROJECT')
      expect('dropSharePercent' in row).toBe(false)
      expect('recipientId' in row).toBe(false)
    })
  })
})

// ── createDropIncome — specifics ───────────────────────────────────────────

describe('createDropIncome — specifics', () => {
  function run(opts: { project?: Record<string, unknown>; user?: unknown; p?: Payload }): {
    h: Harness
    done: Promise<unknown>
  } {
    const h = build({
      project: { ...DROP_PROJECT, ...opts.project },
      user: 'user' in opts ? opts.user : DROP_USER,
    })
    return { h, done: h.svc.createDropIncome(opts.p ?? payload(), DROP_SESSION) }
  }

  it('inserts the exact DROP_INCOME row (user-default share path)', async () => {
    const { h, done } = run({ p: payload({ projectId: 'proj-d', amount: 500, notes: 'dn' }) })
    await done

    expect(h.values).toHaveBeenCalledWith({
      type: 'DROP_INCOME',
      status: 'PENDING',
      amount: '500',
      currency: 'USD',
      senderId: null,
      senderLabel: 'Acme Drop Co',
      receiverId: DROP_ID,
      recipientId: DROP_ID,
      projectId: 'proj-d',
      dropSharePercent: 12,
      dropSharePercentSource: 'USER_DEFAULT',
      idempotencyKey: KEY,
      receiptDocumentId: null,
      receiptExternalUrl: URL_OK,
      notes: 'dn',
      txDate: NOW,
      createdBy: DROP_ID,
    })
  })

  it('writes projectId from the PAYLOAD (not from the fetched project row)', async () => {
    const { h, done } = run({ p: payload({ projectId: 'payload-proj-id' }) })
    await done

    expect((h.values.mock.calls[0]![0] as Record<string, unknown>)['projectId']).toBe(
      'payload-proj-id',
    )
  })

  it('reads the project WITHOUT any relation (no `with`)', async () => {
    const { h, done } = run({})
    await done

    const arg = h.projectsFindFirst.mock.calls[0]![0]
    expect(Object.keys(arg)).toEqual(['where'])
    expect(compileWhere(arg.where).sql).toContain(`"${projects.id.name}"`)
  })

  it("reads the caller's own users row by session id", async () => {
    const { h, done } = run({})
    await done

    expect(h.usersFindFirst).toHaveBeenCalledTimes(1)
    const compiled = compileWhere(h.usersFindFirst.mock.calls[0]![0].where)
    expect(compiled.params).toEqual([DROP_ID])
    expect(compiled.sql).toContain(`"${users.id.name}" = $1`)
  })

  it('archived drop → FINANCE_INCOME_RECEIVER_ARCHIVED 403; nothing is written', async () => {
    const { h, done } = run({
      user: { ...DROP_USER, archivedAt: new Date('2026-02-01T00:00:00.000Z') },
    })

    await expect(done).rejects.toMatchObject({
      response: { code: 'FINANCE_INCOME_RECEIVER_ARCHIVED', statusCode: 403 },
    })
    expect(h.insert).not.toHaveBeenCalled()
    expect(h.afterCreated).not.toHaveBeenCalled()
  })

  it('a missing drop user row is NOT an error (no NOT_FOUND guard here): the default 5 applies', async () => {
    const { h, done } = run({ user: undefined })
    await done

    const row = h.values.mock.calls[0]![0] as Record<string, unknown>
    expect(row['dropSharePercent']).toBe(5)
    expect(row['dropSharePercentSource']).toBe('USER_DEFAULT')
  })

  it('the receipt gate and document binding run BEFORE the drop user is read', async () => {
    const { h, done } = run({ p: payload({ receiptExternalUrl: undefined }) })

    await expect(done).rejects.toMatchObject({ response: { code: 'RECEIPT_REQUIRED' } })
    expect(h.usersFindFirst).not.toHaveBeenCalled()
  })

  it('the archived guard comes AFTER the receipt gate (archived drop + no receipt → receipt error)', async () => {
    const { done } = run({
      user: { ...DROP_USER, archivedAt: new Date('2026-02-01T00:00:00.000Z') },
      p: payload({ receiptExternalUrl: undefined }),
    })

    await expect(done).rejects.toMatchObject({ response: { code: 'RECEIPT_REQUIRED' } })
  })

  describe('drop share snapshot', () => {
    async function shareOf(opts: Parameters<typeof run>[0]): Promise<Record<string, unknown>> {
      const { h, done } = run(opts)
      await done
      const row = h.values.mock.calls[0]![0] as Record<string, unknown>
      return { value: row['dropSharePercent'], source: row['dropSharePercentSource'] }
    }

    it('project override wins over the user default', async () => {
      expect(await shareOf({ project: { dropSharePercentOverride: 9 } })).toEqual({
        value: 9,
        source: 'PROJECT',
      })
    })

    it('project override of 0 is a real override', async () => {
      expect(await shareOf({ project: { dropSharePercentOverride: 0 } })).toEqual({
        value: 0,
        source: 'PROJECT',
      })
    })

    it('no override → the drop user default', async () => {
      expect(await shareOf({})).toEqual({ value: 12, source: 'USER_DEFAULT' })
    })

    it('user default null → DEFAULT_DROP_SHARE_PERCENT (5)', async () => {
      expect(await shareOf({ user: { ...DROP_USER, dropSharePercent: null } })).toEqual({
        value: 5,
        source: 'USER_DEFAULT',
      })
    })

    it('user default of 0 is kept (not replaced by 5)', async () => {
      expect(await shareOf({ user: { ...DROP_USER, dropSharePercent: 0 } })).toEqual({
        value: 0,
        source: 'USER_DEFAULT',
      })
    })

    it('there is no senior-share / team lookup on the drop path, and the row has no senior fields', async () => {
      const { h, done } = run({})
      await done

      expect(h.teamMembersFindMany).not.toHaveBeenCalled()
      const row = h.values.mock.calls[0]![0] as Record<string, unknown>
      expect('seniorSharePercent' in row).toBe(false)
      expect('seniorSharePercentSource' in row).toBe(false)
    })
  })
})
