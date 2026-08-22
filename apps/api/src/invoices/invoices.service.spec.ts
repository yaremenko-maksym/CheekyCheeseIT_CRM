/**
 * InvoicesService — unit tests.
 *
 * Harness rationale: drizzle predicates are circular so we use a
 * semantic-only stub (same approach as documents.service.spec.ts). External
 * services (PDF, Documents, S3, Notifications, Config) are fully mocked so
 * the assertions focus on the contract between InvoicesService and its
 * collaborators:
 *   - autoCreate triggers the PDF generator + uploadInternal + insert
 *     signature + emit notification, in that order
 *   - sign verifies the hash before accepting the COUNTERPARTY signature
 *   - RBAC denies non-counterparty viewers
 *   - verify only exposes public fields
 *
 * Coverage:
 *  - autoCreate idempotent (re-trigger no-op)
 *  - autoCreate full happy path
 *  - autoCreate skips non-SENIOR_INCOME / non-SALARY
 *  - sign: 403 for non-counterparty
 *  - sign: 409 already signed
 *  - sign: 409 hash mismatch (tampered PDF)
 *  - listInvoices: returns array of items
 *  - verifyInvoice: returns only public fields
 *  - verifyInvoice: 404 when invoice missing
 */
import { ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyRequest } from 'fastify'
import type { SessionUser } from '@crm/shared'
import { InvoicesService } from './invoices.service'
// security-review PR #456 round 2: autoCreateForSeniorPayout/autoCreateForPayout
// /autoCreateForSalary/signInvoice's linked-income lookup now read the
// `nonDeletedTransactions` VIEW via `.select().from(...)` instead of the
// relational-query `transactions.findFirst/findMany` — the harness below
// compares the `.from(...)` argument by reference to route the stub.
import { nonDeletedTransactions } from '../database/schema'

const u = (id: string, role: SessionUser['role'], name = id): SessionUser => ({
  id,
  role,
  displayName: name,
  email: `${id}@x.com`,
  avatarUrl: null,
  seniorSharePercent: 26,
})

const ADMIN = u('admin-1', 'ADMIN', 'Maksym')
const SENIOR = u('senior-1', 'SENIOR', 'Alice')
const SENIOR2 = u('senior-2', 'SENIOR', 'Bob')
const JUNIOR = u('junior-1', 'JUNIOR', 'Carol')
const ACCOUNTANT = u('acc-1', 'ACCOUNTANT', 'Dana')

interface TxRow {
  id: string
  type: string
  status: string
  amount: string
  currency: string
  senderId: string | null
  receiverId: string | null
  projectId: string | null
  payoutRequestId?: string | null
  invoiceDocumentId: string | null
  salaryMonth: string | null
  txDate: Date | null
  createdAt: Date
}

interface SigRow {
  id: string
  transactionId: string
  signerRole: 'COMPANY' | 'COUNTERPARTY'
  signerId: string
  pdfHash: string
  ipAddress: string | null
  userAgent: string | null
  method: 'AUTO_COMPANY' | 'MANUAL_CLICK'
  signedAt: Date
  // security-review round 2 (PR #600, HIGH-1/MED-3 mutation-gate closure):
  // optional so every EXISTING fixture (which never set these) keeps
  // getting `undefined` — same effective "no snapshot" shape as before —
  // while a test that DOES care about the NULL-snapshot fallback branch in
  // verifyInvoice can set `amountSnapshot: null` explicitly.
  amountSnapshot?: string | null
  currencySnapshot?: string | null
}

interface UserRow {
  id: string
  displayName: string
  role: string
  paymentMethod?: string | null
  walletUsdtErc20?: string | null
  walletUsdtLabel?: string | null
  bankUahRecipient?: string | null
  bankUahIban?: string | null
  bankUahRnokpp?: string | null
  bankUahBankName?: string | null
  createdAt?: Date
}

interface ProjectRow {
  id: string
  name: string
}

interface SignedContractRow {
  userId: string
  templateId: string
  contractNumber: string
  targetRole: string
  signedAt: Date
}

interface HarnessState {
  txs: TxRow[]
  sigs: SigRow[]
  users: UserRow[]
  projects: ProjectRow[]
  signedContracts?: SignedContractRow[]
}

function buildHarness(state: HarnessState) {
  // Control hints set by tests BEFORE invoking the service:
  //  - findTxId             — pinned transactions.findFirst target id
  //  - lookupProjectId      — pinned projects.findFirst target id
  //  - userFindFirstQueue   — list of ids consumed in order by users.findFirst
  //  - sigQueueRoles        — for sign(), order of signature lookups
  //                           (the service does COUNTERPARTY-lookup then
  //                           COMPANY-lookup; tests pre-seed the queue)
  const ctrl = {
    findTxId: null as string | null,
    lookupProjectId: null as string | null,
    userFindFirstQueue: [] as string[],
    sigQueueRoles: [] as Array<'COMPANY' | 'COUNTERPARTY'>,
    // task-aggregate-invoice-per-payout. When set, transactions.findMany
    // returns the SENIOR_INCOME / DROP_INCOME rows from `state.txs` whose
    // `payoutRequestId` matches this value. Used by autoCreateForPayout
    // happy-path tests.
    linkedPayoutRequestId: null as string | null,
    // The projects lookup id queue: autoCreateForPayout iterates over the
    // linked income rows and calls projects.findFirst once per unique project.
    // The test seeds the queue in the order the service will consume them.
    projectFindQueue: [] as string[],
    // task-aggregate-invoice-per-payout. When set, the update().set().where()
    // patch targets this specific tx id instead of the `findTxId` (used by
    // aggregated PAYOUT flow which queries the PAYOUT row via findFirst but
    // patches it via a separate update keyed on its id).
    updateTargetTxId: null as string | null,
  }

  // -------- select chains --------
  // We model two distinct chains because the service uses two distinct
  // call shapes that cannot share a builder:
  //   (1) select({field}).from(users).where().orderBy().limit()      ← admin lookup
  //   (2) select().from(invoice_signatures).where().limit()          ← sig role lookup
  //   (3) select({fields...}).from(transactions).leftJoin(users).where().orderBy()
  //                                                                  ← list (no limit)
  //   (4) select({fields...}).from(invoice_signatures).leftJoin(users).where()
  //                                                                  ← awaited array
  //
  // Heuristic to distinguish:
  //   - If the resulting builder's .limit() is called → admin lookup or sig lookup
  //     - if fields contains 'id'-only → admin lookup
  //     - else → sig lookup
  //   - If .orderBy() is awaited (no .limit follow-up) → listInvoices
  //   - If .where() result is awaited directly (no orderBy/limit) → all-sigs

  function buildSelectBuilder(fields: unknown) {
    return {
      from: (t: unknown) => {
        const chain = {
          where: (_p: unknown) => chain,
          leftJoin: (_t2: unknown, _on: unknown) => chain,
          innerJoin: (_t2: unknown, _on: unknown) => chain,
          orderBy: (_o: unknown) => {
            // Make orderBy return a chainable: limit() OR awaited-list.
            const ordered = {
              limit: async (lim: number) => resolveLimit(lim, fields, t),
              then: (resolve: (v: unknown) => void) => {
                // security-review round 4 (PR #600, HIGH-3 mutation-gate
                // closure): route by `fields` — a bare `.select()` (no
                // field map, `fields` undefined) is what
                // `resolvePayoutAggregateAmount`'s linked-income query
                // uses (`.select().from(nonDeletedTransactions).where(...)
                // .orderBy(...)`, awaited directly, no `.limit()`); ordering
                // does not change a row's SHAPE, only its sequence, and
                // this harness does not model sequence — so it belongs on
                // the SAME raw-row path as the no-`orderBy()` bare-select
                // case (`resolveSelectArray`), not the `listInvoices`
                // synthesis. `select({...})` WITH a field map is the one
                // caller that actually wants `resolveOrderByList()`
                // (listInvoices's own `.orderBy()` call, also awaited
                // directly with no `.limit()`).
                resolve(fields ? resolveOrderByList() : resolveSelectArray(t))
              },
            }
            return ordered
          },
          limit: async (lim: number) => resolveLimit(lim, fields, t),
          then: (resolve: (v: unknown) => void) => {
            resolve(resolveSelectArray(t))
          },
        }
        return chain
      },
    }
  }

  function resolveLimit(lim: number, fields: unknown, table?: unknown): unknown[] {
    // security-review PR #456 round 2: single-tx-by-id fetch via the
    // `nonDeletedTransactions` VIEW — `.select().from(nonDeletedTransactions)
    // .where(eq(id, X)).limit(1)` (autoCreateForSeniorPayout/
    // autoCreateForPayout/autoCreateForSalary). Routed by comparing the
    // `.from(...)` argument by reference, since `fields` is bare (no
    // column-map) for this call shape, same as the sig-lookup default branch
    // below used to assume.
    if (table === nonDeletedTransactions) {
      const id = ctrl.findTxId
      const t = id ? state.txs.find((x) => x.id === id) : state.txs[0]
      return t ? [t] : []
    }
    // Contract number lookup: select({contractNumber}) + innerJoin + where + orderBy + limit(1)
    if (
      fields &&
      typeof fields === 'object' &&
      Object.keys(fields as object).length === 1 &&
      'contractNumber' in (fields as object)
    ) {
      // The service looks up by userId + role; we return the first match from
      // the harness signedContracts list (tests seed it in desired order).
      const contracts = state.signedContracts ?? []
      return contracts.slice(0, lim).map((c) => ({ contractNumber: c.contractNumber }))
    }
    // Admin lookup: select({id}) + orderBy(asc) + limit(1)
    if (
      fields &&
      typeof fields === 'object' &&
      Object.keys(fields as object).length === 1 &&
      'id' in (fields as object)
    ) {
      return state.users
        .filter((u_) => u_.role === 'ADMIN')
        .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
        .slice(0, lim)
        .map((u_) => ({ id: u_.id }))
    }
    // Signature lookup: select() + where(transactionId AND role) + limit(1)
    const role = ctrl.sigQueueRoles.shift() ?? null
    const txId = ctrl.findTxId
    return state.sigs
      .filter((s) => (!role || s.signerRole === role) && (!txId || s.transactionId === txId))
      .slice(0, lim)
  }

  function resolveOrderByList(): unknown[] {
    // listInvoices result — synthesize rows that look like the production
    // select(fields...).from(transactions).leftJoin(users).where(...).orderBy() shape.
    return state.txs
      .filter((t) => t.type === 'SENIOR_INCOME' || t.type === 'SALARY')
      .filter((t) => t.invoiceDocumentId !== null)
      .map((t) => {
        const receiver = state.users.find((u_) => u_.id === t.receiverId)
        const hasCounterpartySig = state.sigs.some(
          (s) => s.transactionId === t.id && s.signerRole === 'COUNTERPARTY',
        )
        return {
          id: t.id,
          type: t.type,
          amount: t.amount,
          currency: t.currency,
          receiverId: t.receiverId,
          receiverName: receiver?.displayName ?? null,
          createdAt: t.createdAt,
          signedFlag: hasCounterpartySig,
        }
      })
  }

  function resolveSelectArray(table?: unknown): unknown[] {
    // security-review PR #456 round 2: linkedIncomes fetch via the
    // `nonDeletedTransactions` VIEW — `.select().from(nonDeletedTransactions)
    // .where(and(...))` awaited directly, no `.limit()` (autoCreateForPayout /
    // signInvoice's PAYOUT branch).
    if (table === nonDeletedTransactions) {
      const reqId = ctrl.linkedPayoutRequestId
      if (!reqId) return []
      return state.txs.filter(
        (t) =>
          t.payoutRequestId === reqId && (t.type === 'SENIOR_INCOME' || t.type === 'DROP_INCOME'),
      )
    }
    // getSignaturesWithSignerNames — select(fields).from(invoiceSignatures).leftJoin(users).where()
    const txId = ctrl.findTxId
    return state.sigs
      .filter((s) => !txId || s.transactionId === txId)
      .map((s) => ({
        ...s,
        signerName: state.users.find((u_) => u_.id === s.signerId)?.displayName ?? null,
      }))
  }

  const db = {
    db: {
      query: {
        transactions: {
          findFirst: async (args: { where?: unknown; with?: unknown }) => {
            const id = ctrl.findTxId
            const t = id ? state.txs.find((x) => x.id === id) : state.txs[0]
            if (!t) return undefined
            if (args.with) {
              return {
                ...t,
                receiver: t.receiverId
                  ? (() => {
                      const r = state.users.find((u_) => u_.id === t.receiverId)
                      return r ? { id: r.id, displayName: r.displayName } : null
                    })()
                  : null,
                project: t.projectId
                  ? (state.projects.find((p) => p.id === t.projectId) ?? null)
                  : null,
              }
            }
            return t
          },
          // task-aggregate-invoice-per-payout. autoCreateForPayout uses
          // findMany to pull all SENIOR_INCOME / DROP_INCOME rows linked to a
          // PAYOUT row via payoutRequestId. The harness returns the income tx
          // rows pre-seeded in state.txs whose `payoutRequestId` matches the
          // pinned `linkedPayoutRequestId` hint (set by the test before calling
          // the service).
          findMany: async (_args: { where?: unknown }) => {
            const reqId = ctrl.linkedPayoutRequestId
            if (!reqId) return []
            return state.txs.filter(
              (t) =>
                t.payoutRequestId === reqId &&
                (t.type === 'SENIOR_INCOME' || t.type === 'DROP_INCOME'),
            )
          },
        },
        users: {
          findFirst: async (_args: unknown) => {
            const id = ctrl.userFindFirstQueue.shift()
            if (!id) return undefined
            return state.users.find((u_) => u_.id === id)
          },
        },
        projects: {
          findFirst: async (_args: unknown) => {
            // Aggregated PAYOUT flow consumes the projectFindQueue (one call
            // per linked income's projectId). Falls back to the legacy single
            // `lookupProjectId` hint when the queue is empty — keeps the
            // existing autoCreateForSeniorPayout tests untouched.
            const queued = ctrl.projectFindQueue.shift()
            const id = queued ?? ctrl.lookupProjectId
            if (!id) return undefined
            return state.projects.find((p) => p.id === id)
          },
        },
      },
      select: (fields?: unknown) => buildSelectBuilder(fields),
      insert: (_t: unknown) => ({
        values: (v: Record<string, unknown>) => {
          const sig: SigRow = {
            id: `s-new-${state.sigs.length}`,
            transactionId: v['transactionId'] as string,
            signerRole: v['signerRole'] as 'COMPANY' | 'COUNTERPARTY',
            signerId: v['signerId'] as string,
            pdfHash: v['pdfHash'] as string,
            ipAddress: (v['ipAddress'] as string | null) ?? null,
            userAgent: (v['userAgent'] as string | null) ?? null,
            method: v['method'] as 'AUTO_COMPANY' | 'MANUAL_CLICK',
            signedAt: (v['signedAt'] as Date) ?? new Date(),
          }
          state.sigs.push(sig)
          return Object.assign(
            { returning: async () => [sig] },
            { then: (resolve: (v: unknown) => void) => resolve(undefined) },
          )
        },
      }),
      update: (_t: unknown) => ({
        set: (v: Record<string, unknown>) => ({
          where: async (_p: unknown) => {
            if ('invoiceDocumentId' in v) {
              // task-aggregate-invoice-per-payout. When `updateTargetTxId` is
              // set, prefer that as the update target — aggregated PAYOUT
              // flow patches the PAYOUT row, not the row matched by
              // `findTxId` (which is the income tx the test pinned for the
              // primary lookup). Falls back to legacy behavior when unset.
              const id = ctrl.updateTargetTxId ?? ctrl.findTxId
              const target = id ? state.txs.find((t) => t.id === id) : state.txs[0]
              if (target) target.invoiceDocumentId = v['invoiceDocumentId'] as string | null
            }
          },
        }),
      }),
    },
  } as unknown as ConstructorParameters<typeof InvoicesService>[0]

  // Mocks for external dependencies.
  const pdfBuffer = Buffer.from('PDFDATA')
  const pdfHash = 'b'.repeat(64)
  const pdfService = {
    generateSignableInvoicePdf: vi.fn(async (_p: unknown) => ({ pdfBuffer, sha256Hash: pdfHash })),
  } as unknown as ConstructorParameters<typeof InvoicesService>[1]

  const uploadInternal = vi.fn(async (params: { ownerId: string }) => ({
    id: `doc-new-${Date.now()}`,
    ownerId: params.ownerId,
    projectId: null,
    category: 'INVOICE' as const,
    name: 'invoice.pdf',
    originalName: 'invoice.pdf',
    s3Key: `documents/INVOICE/${params.ownerId}/x.pdf`,
    thumbnailS3Key: null,
    sizeBytes: 100,
    mimeType: 'application/pdf',
    uploadedBy: ADMIN.id,
    uploadedByDisplayName: ADMIN.displayName,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date().toISOString(),
  }))
  const softDeleteInternal = vi.fn(async (_id: string, _by: string) => undefined)
  const findByIdInternal = vi.fn(async (id: string) => ({
    id,
    s3Key: `documents/INVOICE/x/${id}.pdf`,
  }))
  const documentsService = {
    uploadInternal,
    softDeleteInternal,
    findByIdInternal,
  } as unknown as ConstructorParameters<typeof InvoicesService>[2]

  const getObject = vi.fn(async (_key: string) => pdfBuffer)
  const s3 = { getObject } as unknown as ConstructorParameters<typeof InvoicesService>[3]

  const notifCreate = vi.fn(async (_input: unknown) => ({
    id: 'notif-1',
    type: 'INVOICE_SIGN_REQUIRED' as const,
    title: 'x',
    body: null,
    link: null,
    readAt: null,
    createdAt: new Date().toISOString(),
  }))
  const notificationsService = {
    create: notifCreate,
  } as unknown as ConstructorParameters<typeof InvoicesService>[4]

  const config = {
    get: (_k: string) => 'http://localhost:3000',
  } as unknown as ConstructorParameters<typeof InvoicesService>[5]

  const svc = new InvoicesService(
    db,
    pdfService,
    documentsService,
    s3,
    notificationsService,
    config,
  )

  return {
    svc,
    ctrl,
    state,
    pdfBuffer,
    pdfHash,
    pdfService,
    documentsService,
    uploadInternal,
    softDeleteInternal,
    findByIdInternal,
    s3,
    getObject,
    notifCreate,
  }
}

// Helper to build a baseline tx row with only the fields a test cares about
function tx(overrides: Partial<TxRow> = {}): TxRow {
  return {
    id: overrides.id ?? 'tx-1',
    type: overrides.type ?? 'SENIOR_INCOME',
    status: overrides.status ?? 'PAID',
    amount: overrides.amount ?? '1000',
    currency: overrides.currency ?? 'USDT',
    senderId: overrides.senderId ?? null,
    receiverId: overrides.receiverId ?? null,
    projectId: overrides.projectId ?? null,
    payoutRequestId: overrides.payoutRequestId ?? null,
    invoiceDocumentId: overrides.invoiceDocumentId ?? null,
    salaryMonth: overrides.salaryMonth ?? null,
    txDate: overrides.txDate ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('InvoicesService', () => {
  // security-review round 2 (PR #600, mutation-gate closure): the MED-7
  // tests below spy on `Logger.prototype.warn` — a SHARED prototype, not a
  // per-harness instance — so without a restore it would leak into every
  // test that runs after it in this file and silently swallow real warn
  // output. `restoreAllMocks` also cleans up every `vi.spyOn(h.svc, ...)`
  // call in this file, which previously relied on each harness being
  // freshly constructed per test (true for the mocked methods themselves,
  // but not for spy state on shared prototypes).
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('autoCreateForSeniorPayout', () => {
    it('idempotent — second trigger with same tx is no-op', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-existing',
          }),
        ],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-1'
      await h.svc.autoCreateForSeniorPayout('tx-1')
      expect(h.pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
      expect(h.uploadInternal).not.toHaveBeenCalled()
      expect(h.notifCreate).not.toHaveBeenCalled()
    })

    it('happy path — PDF generated, doc linked, COMPANY signature inserted, notification fired', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            projectId: 'p-1',
            amount: '1000',
            currency: 'USDT',
          }),
        ],
        sigs: [],
        users: [
          {
            id: SENIOR.id,
            displayName: SENIOR.displayName,
            role: 'SENIOR',
            paymentMethod: 'USDT_ERC20',
            walletUsdtErc20: '0xabc',
            createdAt: new Date('2026-02-01'),
          },
          {
            id: ADMIN.id,
            displayName: ADMIN.displayName,
            role: 'ADMIN',
            createdAt: new Date('2026-01-01'),
          },
        ],
        projects: [{ id: 'p-1', name: 'Acme Corp' }],
      })

      // Flow:
      // 1. tx lookup (findTxId)
      // 2. users.findFirst counterparty (SENIOR)
      // 3. getAdminId → select admin
      // 4. users.findFirst admin
      // 5. projects.findFirst p-1
      h.ctrl.findTxId = 'tx-1'
      h.ctrl.userFindFirstQueue = [SENIOR.id, ADMIN.id]
      h.ctrl.lookupProjectId = 'p-1'

      await h.svc.autoCreateForSeniorPayout('tx-1')

      expect(h.pdfService.generateSignableInvoicePdf).toHaveBeenCalledTimes(1)
      expect(h.uploadInternal).toHaveBeenCalledTimes(1)
      expect(h.uploadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'INVOICE',
          ownerId: SENIOR.id,
          mimeType: 'application/pdf',
        }),
      )
      expect(h.state.sigs.length).toBe(1)
      expect(h.state.sigs[0]!.signerRole).toBe('COMPANY')
      expect(h.state.sigs[0]!.method).toBe('AUTO_COMPANY')
      expect(h.state.sigs[0]!.pdfHash).toBe(h.pdfHash)
      expect(h.notifCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: SENIOR.id,
          type: 'INVOICE_SIGN_REQUIRED',
        }),
      )
    })

    it('returns early for non-SENIOR_INCOME tx', async () => {
      const h = buildHarness({
        txs: [tx({ id: 'tx-1', type: 'EXPENSE' })],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-1'
      await h.svc.autoCreateForSeniorPayout('tx-1')
      expect(h.pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
    })

    it('returns early for non-SALARY tx via the salary trigger', async () => {
      const h = buildHarness({
        txs: [tx({ id: 'tx-1', type: 'PAYOUT' })],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-1'
      await h.svc.autoCreateForSalary('tx-1')
      expect(h.pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
    })
  })

  describe('signInvoice', () => {
    const mkReq = (ip = '127.0.0.1', ua = 'Mozilla/5.0'): FastifyRequest =>
      ({ ip, headers: { 'user-agent': ua } }) as unknown as FastifyRequest

    it('RBAC — non-counterparty viewer → ForbiddenException', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
          }),
        ],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-1'
      // SENIOR2 is not the counterparty (receiver is SENIOR.id)
      await expect(h.svc.signInvoice(SENIOR2, 'tx-1', mkReq())).rejects.toThrow(ForbiddenException)
    })

    it('throws ConflictException when COUNTERPARTY signature already exists', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
          }),
        ],
        sigs: [
          {
            id: 's-existing',
            transactionId: 'tx-1',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date(),
          },
        ],
        users: [],
        projects: [],
      })

      h.ctrl.findTxId = 'tx-1'
      // First sig query in signInvoice is the COUNTERPARTY existence check.
      h.ctrl.sigQueueRoles = ['COUNTERPARTY']
      await expect(h.svc.signInvoice(SENIOR, 'tx-1', mkReq())).rejects.toThrow(ConflictException)
    })

    it('throws ConflictException when current PDF hash does not match stored COMPANY hash', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
          }),
        ],
        sigs: [
          // Pre-seeded COMPANY sig with hash 'c'... — our default getObject
          // returns the buffer that hashes to 'b'... (the pdfHash mock), so
          // tampered-detection should fire. We override getObject below.
          {
            id: 's-company',
            transactionId: 'tx-1',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'c'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date(),
          },
        ],
        users: [],
        projects: [],
      })

      h.ctrl.findTxId = 'tx-1'
      // Sequence: COUNTERPARTY (0 → ok) then COMPANY (1 → check hash).
      h.ctrl.sigQueueRoles = ['COUNTERPARTY', 'COMPANY']
      // Override getObject to a different buffer so SHA-256 mismatches.
      h.getObject.mockImplementation(async () => Buffer.from('TAMPERED'))

      await expect(h.svc.signInvoice(SENIOR, 'tx-1', mkReq())).rejects.toThrow(ConflictException)
      expect(h.state.sigs.filter((s) => s.signerRole === 'COUNTERPARTY').length).toBe(0)
    })
  })

  describe('listInvoices', () => {
    it('ADMIN sees all generated invoices', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
          }),
          tx({
            id: 'tx-2',
            type: 'SALARY',
            receiverId: JUNIOR.id,
            invoiceDocumentId: 'doc-2',
            amount: '2000',
            currency: 'USD',
          }),
          tx({ id: 'tx-3', type: 'EXPENSE', invoiceDocumentId: null }),
        ],
        sigs: [],
        users: [
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
          { id: JUNIOR.id, displayName: JUNIOR.displayName, role: 'JUNIOR' },
        ],
        projects: [],
      })
      const result = await h.svc.listInvoices(ADMIN, { status: undefined, type: undefined })
      // Only the 2 tx with invoiceDocumentId pass our filter — the EXPENSE
      // row is filtered out by the stub directly (mirrors the production
      // SQL filter on `isNotNull(invoiceDocumentId)`).
      expect(result.length).toBe(2)
      expect(result.every((r) => r.status === 'PENDING' || r.status === 'SIGNED')).toBe(true)
    })

    it('ACCOUNTANT also sees all invoices', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
          }),
        ],
        sigs: [],
        users: [{ id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' }],
        projects: [],
      })
      const result = await h.svc.listInvoices(ACCOUNTANT, { status: undefined, type: undefined })
      expect(result.length).toBe(1)
    })
  })

  describe('verifyInvoice', () => {
    it('returns only public fields — no IP, no user-agent, no full hash', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
            amount: '500',
          }),
        ],
        sigs: [
          {
            id: 's-c',
            transactionId: 'tx-1',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: '10.0.0.1',
            userAgent: 'Mozilla/5.0 (Mac)',
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-x',
            transactionId: 'tx-1',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: '203.0.113.5',
            userAgent: 'Mozilla/5.0 (Win)',
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })

      h.ctrl.findTxId = 'tx-1'
      const result = await h.svc.verifyInvoice('tx-1')

      expect(result.transactionId).toBe('tx-1')
      expect(result.status).toBe('SIGNED')
      expect(result.amount).toBe('500')
      expect(result.currency).toBe('USDT')
      expect(result.type).toBe('SENIOR_INCOME')
      expect(result.signatures.length).toBe(2)
      for (const s of result.signatures) {
        expect(s.pdfHashShort.length).toBe(8)
        expect(s).not.toHaveProperty('ipAddress')
        expect(s).not.toHaveProperty('userAgent')
        expect(s).not.toHaveProperty('pdfHash')
      }
    })

    // security-review round 2 (PR #600, HIGH-1/MED-3 mutation-gate closure).
    // Every OTHER verifyInvoice fixture in this file omits amountSnapshot/
    // currencySnapshot entirely (→ `undefined`, not `null`), so the
    // `=== null` branch is technically reached (the harness always returns
    // SOME value for the field) but never in a way any assertion
    // distinguishes — these two tests set the field explicitly on both
    // sides of the check.
    it('HIGH-1/MED-3: NULL amount_snapshot (legacy/bypassed row) falls back to live tx.amount AND logs a warning', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-null-snap',
            type: 'SALARY',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
            amount: '777',
            currency: 'USD',
          }),
        ],
        sigs: [
          {
            id: 's-c',
            transactionId: 'tx-null-snap',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-x',
            transactionId: 'tx-null-snap',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
            amountSnapshot: null,
            currencySnapshot: null,
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-null-snap'
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

      const result = await h.svc.verifyInvoice('tx-null-snap')

      expect(result.amount).toBe('777')
      expect(result.currency).toBe('USD')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tx=tx-null-snap'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NULL amount_snapshot'))
    })

    it('AC3: a POPULATED amount_snapshot is used verbatim (never the live tx.amount) AND does NOT log the NULL-snapshot warning', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-real-snap',
            type: 'SALARY',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
            amount: '999', // LIVE amount — must NOT be what verify returns
            currency: 'USD',
          }),
        ],
        sigs: [
          {
            id: 's-c',
            transactionId: 'tx-real-snap',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-x',
            transactionId: 'tx-real-snap',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
            amountSnapshot: '500.000000',
            currencySnapshot: 'USD',
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-real-snap'
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

      const result = await h.svc.verifyInvoice('tx-real-snap')

      expect(result.amount).toBe('500.000000')
      expect(result.amount).not.toBe('999')
      expect(warnSpy).not.toHaveBeenCalled()
      // security-review round 5 (PR #600, mutation-gate closure): the
      // snapshot-present branch never recomputes through
      // `resolvePayoutAggregateAmount`, so `mixedCurrency` stays at its
      // declared default — pins that default down to `false` (a mutant
      // flipping the initializer to `true` would otherwise survive, since
      // no OTHER test on this branch reads the field at all).
      expect(result.mixedCurrency).toBe(false)
    })

    it('AC2-bis (round 4, HIGH-3): a NULL-snapshot PAYOUT row with payoutRequestId IS NULL refuses to confirm an amount, instead of falling back to the unrelated live tx.amount', async () => {
      // Defensive-only case per `resolvePayoutAggregateAmount`'s own doc
      // comment — structurally shouldn't happen for a PAYOUT row that
      // reached signInvoice/verifyInvoice, but the helper still has to
      // answer something for it rather than crash. `!payoutRequestId`
      // short-circuits BEFORE any query, so this is exercisable through the
      // mocked harness (unlike the "no linked incomes" / "mixed currency"
      // branches, which run a real `.orderBy()` query and are covered
      // against real Postgres instead — see
      // invoice-signature-integrity.integration.spec.ts's AC2-bis tests).
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-payout-no-req',
            type: 'PAYOUT',
            senderId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
            amount: '740', // the USDT payable — must NEVER be what verify returns
            currency: 'USDT',
            payoutRequestId: null,
          }),
          // mutation-gate closure (round 4): a DECOY linked-income row,
          // deliberately wired to a `ctrl.linkedPayoutRequestId` set below
          // that does NOT match this tx's own (null) payoutRequestId. If
          // the `if (!payoutRequestId) return null` early-return were ever
          // deleted (mutation-gate's own BlockStatement/ConditionalExpression
          // mutants at this line), the helper would fall through to the
          // query — which this harness resolves purely from the CONTROL
          // HINT below, not from the actual (null) argument passed in — and
          // wrongly "resolve" using this decoy row instead of refusing.
          // Asserting refusal STILL happens with a decoy present proves the
          // early-return fires before the query is ever reached.
          tx({
            id: 'tx-decoy-income',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            amount: '999',
            currency: 'EUR',
            payoutRequestId: 'decoy-req',
          }),
        ],
        sigs: [
          {
            id: 's-c',
            transactionId: 'tx-payout-no-req',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-x',
            transactionId: 'tx-payout-no-req',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
            amountSnapshot: null,
            currencySnapshot: null,
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-payout-no-req'
      // The decoy hint: if `!payoutRequestId` were ever bypassed, the query
      // would resolve via THIS control hint (matching the decoy row above)
      // instead of the real (null) argument — see the decoy tx's comment.
      h.ctrl.linkedPayoutRequestId = 'decoy-req'
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

      await expect(h.svc.verifyInvoice('tx-payout-no-req')).rejects.toThrow(ConflictException)
      await expect(h.svc.verifyInvoice('tx-payout-no-req')).rejects.toThrow(
        'Не удалось подтвердить сумму этого инвойса',
      )
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('the linked-income aggregate could not be resolved'),
      )
    })

    it('mutation-gate closure (round 4, HIGH-3): a NULL-snapshot PAYOUT row with a TRUTHY payoutRequestId but ZERO matching linked incomes refuses to confirm an amount', async () => {
      // Distinguishes `if (linkedIncomes.length === 0) return null` from a
      // deleted/always-false mutant — needs `payoutRequestId` truthy (past
      // the earlier `!payoutRequestId` guard) with the query still
      // resolving to an empty array. `ctrl.linkedPayoutRequestId` left
      // unset (defaults to null) makes `resolveSelectArray` return `[]`
      // unconditionally, regardless of what state.txs contains — exactly
      // "the linked income was soft-deleted after signing" from the
      // integration spec's AC2-bis test, reproduced at the unit level.
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-payout-empty',
            type: 'PAYOUT',
            senderId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
            amount: '740',
            currency: 'USDT',
            payoutRequestId: 'req-empty',
          }),
        ],
        sigs: [
          {
            id: 's-c',
            transactionId: 'tx-payout-empty',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-x',
            transactionId: 'tx-payout-empty',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
            amountSnapshot: null,
            currencySnapshot: null,
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-payout-empty'
      // Deliberately NOT set — `resolveSelectArray` returns `[]` when
      // `ctrl.linkedPayoutRequestId` is unset, modelling zero linked
      // incomes for a payoutRequestId that IS truthy.

      await expect(h.svc.verifyInvoice('tx-payout-empty')).rejects.toThrow(ConflictException)
      await expect(h.svc.verifyInvoice('tx-payout-empty')).rejects.toThrow(
        'Не удалось подтвердить сумму этого инвойса',
      )
    })

    it('mutation-gate closure (round 5, HIGH-4): a NULL-snapshot PAYOUT row whose linked incomes span more than one currency confirms the blind sum and flags mixedCurrency, instead of refusing (unit-level twin of the integration AC2-bis test)', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-payout-mixed',
            type: 'PAYOUT',
            senderId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
            amount: '740',
            currency: 'USDT',
            payoutRequestId: 'req-mixed',
          }),
          tx({
            id: 'tx-income-mixed-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            amount: '1000',
            currency: 'USD',
            payoutRequestId: 'req-mixed',
          }),
          tx({
            id: 'tx-income-mixed-2',
            type: 'DROP_INCOME',
            receiverId: SENIOR.id,
            amount: '500',
            currency: 'EUR',
            payoutRequestId: 'req-mixed',
          }),
        ],
        sigs: [
          {
            id: 's-c',
            transactionId: 'tx-payout-mixed',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-x',
            transactionId: 'tx-payout-mixed',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
            amountSnapshot: null,
            currencySnapshot: null,
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-payout-mixed'
      h.ctrl.linkedPayoutRequestId = 'req-mixed'
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

      // security-review round 5 (PR #600, HIGH-4): no longer throws — the
      // helper counts the blind sum (1000 USD + 500 EUR = 1500) and settles
      // on the FIRST row's currency (harness declaration order = USD),
      // flagging `mixedCurrency: true` instead of refusing.
      const result = await h.svc.verifyInvoice('tx-payout-mixed')
      expect(result.amount).toBe('1500.000000')
      expect(result.currency).toBe('USD')
      expect(result.mixedCurrency).toBe(true)
      expect(errorSpy).not.toHaveBeenCalled()
      // mutation-gate closure (round 4/5): exact text, not a substring
      // match — pins down the `.sort()` + `.join(', ')` formatting the
      // round-4 fix deliberately added ("an unordered SELECT backing a
      // legal-document amount is worth pinning down explicitly rather than
      // leaving to chance" — this log line is the one place that
      // non-determinism was previously observable). EUR before USD proves
      // the sort, the comma space proves the separator wasn't silently
      // dropped.
      expect(warnSpy).toHaveBeenCalledWith(
        'resolvePayoutAggregateAmount: payoutRequestId=req-mixed has linked incomes in more than one currency (EUR, USD) — printing the blind sum across currencies (mixed-currency batches are a supported configuration, see transactions.service.ts); mixedCurrency=true',
      )
    })

    it('mutation-gate closure (round 4, HIGH-3): a NULL-snapshot PAYOUT row WITH a resolvable single-currency linked-income aggregate recomputes through resolvePayoutAggregateAmount, never falling back to (and never refusing in favour of) the unrelated live tx.amount', async () => {
      // The one branch the two tests above cannot reach: `resolved` truthy.
      // Without this, `resolvePayoutAggregateAmount`'s entire body (and the
      // `!resolved`/`!payoutRequestId` checks that guard it) can be deleted
      // by a mutant and every existing unit test still passes — both
      // surrounding tests only ever observe the "cannot resolve, refuse"
      // outcome, which a no-op function also produces.
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-payout-happy',
            type: 'PAYOUT',
            senderId: SENIOR.id,
            invoiceDocumentId: 'doc-1',
            amount: '740', // the USDT payable — must NEVER be what verify returns
            currency: 'USDT',
            payoutRequestId: 'req-happy',
          }),
          // The linked income `signInvoice` actually signed — a SEPARATE
          // tx row sharing `payoutRequestId`, routed to
          // `resolvePayoutAggregateAmount`'s query via
          // `ctrl.linkedPayoutRequestId` below (same harness mechanism
          // `autoCreateForPayout`'s own tests already use).
          tx({
            id: 'tx-income-happy',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            amount: '1000',
            currency: 'USD',
            payoutRequestId: 'req-happy',
          }),
        ],
        sigs: [
          {
            id: 's-c',
            transactionId: 'tx-payout-happy',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-x',
            transactionId: 'tx-payout-happy',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'a'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
            amountSnapshot: null,
            currencySnapshot: null,
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-payout-happy'
      h.ctrl.linkedPayoutRequestId = 'req-happy'
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

      const result = await h.svc.verifyInvoice('tx-payout-happy')

      // `.toFixed(6)` (round 4 fix) — never the whole-number `.toString()`
      // the pre-fix helper produced, and never the PAYOUT row's own
      // 740/USDT.
      expect(result.amount).toBe('1000.000000')
      expect(result.currency).toBe('USD')
      expect(result.amount).not.toBe('740.000000')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('recomputed from linked incomes'),
      )
      expect(errorSpy).not.toHaveBeenCalled()
      // security-review round 5 (PR #600, mutation-gate closure): a SINGLE
      // linked income is one distinct currency (`currencies.size === 1`) —
      // pins `mixedCurrency` down to `false` here (a mutant forcing it
      // `true`, or widening `> 1` to `>= 1`, would otherwise survive: the
      // ONLY other test reading this field uses a genuinely mixed batch)
      // and confirms the mixed-currency-specific warning line never fires
      // for a single-currency aggregate (a mutant forcing that `if` to
      // `true` would otherwise survive too).
      expect(result.mixedCurrency).toBe(false)
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('has linked incomes in more than one currency'),
      )
    })

    it('returns 404 for transactions without an invoice', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-1',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: null,
          }),
        ],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-1'
      await expect(h.svc.verifyInvoice('tx-1')).rejects.toThrow(NotFoundException)
    })

    it('returns 404 for non-existing transaction', async () => {
      const h = buildHarness({ txs: [], sigs: [], users: [], projects: [] })
      h.ctrl.findTxId = 'tx-missing'
      await expect(h.svc.verifyInvoice('tx-missing')).rejects.toThrow(NotFoundException)
    })

    // ── SEC-05: COMPANY signature must not expose admin display name ───────────
    it('SEC-05: COMPANY signature signerName is brand name, not admin display name', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-sec05',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-sec05',
            amount: '800',
          }),
        ],
        sigs: [
          {
            id: 's-company',
            transactionId: 'tx-sec05',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'c'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-counterparty',
            transactionId: 'tx-sec05',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'c'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
          },
        ],
        users: [
          { id: ADMIN.id, displayName: 'Maksym Real Name', role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })

      h.ctrl.findTxId = 'tx-sec05'
      const result = await h.svc.verifyInvoice('tx-sec05')

      const companySig = result.signatures.find((s) => s.role === 'COMPANY')
      expect(companySig).toBeDefined()
      // Must be brand name, NOT the real admin display name
      expect(companySig!.signerName).toBe('CheekyCheeseIT')
      expect(companySig!.signerName).not.toBe('Maksym Real Name')

      // Counterparty name is NOT masked — it's the real display name
      const counterpartySig = result.signatures.find((s) => s.role === 'COUNTERPARTY')
      expect(counterpartySig).toBeDefined()
      expect(counterpartySig!.signerName).toBe(SENIOR.displayName)
    })

    // ── SEC-11: verify must gate on SIGNED status — PENDING → 404 ─────────────
    it('SEC-11: returns 404 for PENDING invoice (no COUNTERPARTY signature)', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-pending',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-pending',
            amount: '1200',
          }),
        ],
        sigs: [
          // Only COMPANY signature present — counterparty has not signed yet
          {
            id: 's-company-only',
            transactionId: 'tx-pending',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'd'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })

      h.ctrl.findTxId = 'tx-pending'
      // Must return 404 — not amount/counterparty leak
      await expect(h.svc.verifyInvoice('tx-pending')).rejects.toThrow(NotFoundException)
    })

    it('SEC-11: returns 404 for PENDING SALARY invoice (no COUNTERPARTY signature)', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-salary-pending',
            type: 'SALARY',
            receiverId: JUNIOR.id,
            invoiceDocumentId: 'doc-salary-pending',
            amount: '700',
          }),
        ],
        sigs: [],
        users: [{ id: JUNIOR.id, displayName: JUNIOR.displayName, role: 'JUNIOR' }],
        projects: [],
      })

      h.ctrl.findTxId = 'tx-salary-pending'
      await expect(h.svc.verifyInvoice('tx-salary-pending')).rejects.toThrow(NotFoundException)
    })

    it('SEC-11: SIGNED invoice (COUNTERPARTY signature exists) is still accessible', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-signed',
            type: 'SENIOR_INCOME',
            receiverId: SENIOR.id,
            invoiceDocumentId: 'doc-signed',
            amount: '500',
          }),
        ],
        sigs: [
          {
            id: 's-co',
            transactionId: 'tx-signed',
            signerRole: 'COMPANY',
            signerId: ADMIN.id,
            pdfHash: 'e'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'AUTO_COMPANY',
            signedAt: new Date('2026-05-26T10:00:00Z'),
          },
          {
            id: 's-cp',
            transactionId: 'tx-signed',
            signerRole: 'COUNTERPARTY',
            signerId: SENIOR.id,
            pdfHash: 'e'.repeat(64),
            ipAddress: null,
            userAgent: null,
            method: 'MANUAL_CLICK',
            signedAt: new Date('2026-05-26T11:00:00Z'),
          },
        ],
        users: [
          { id: ADMIN.id, displayName: ADMIN.displayName, role: 'ADMIN' },
          { id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' },
        ],
        projects: [],
      })

      h.ctrl.findTxId = 'tx-signed'
      const result = await h.svc.verifyInvoice('tx-signed')
      expect(result.transactionId).toBe('tx-signed')
      expect(result.status).toBe('SIGNED')
    })
  })

  // task-aggregate-invoice-per-payout — AC1 / AC2 / AC7.
  //
  // The aggregated PAYOUT invoice model: one PAYOUT row (created at
  // createPayoutRequest time) gets exactly ONE invoice that aggregates all
  // linked SENIOR_INCOME / DROP_INCOME rows sharing the same payoutRequestId.
  // The PAYOUT row's `invoice_document_id` is the idempotency anchor.
  describe('autoCreateForPayout (aggregated invoice per PAYOUT)', () => {
    const REQ_ID = 'req-1'
    const PAYOUT_TX_ID = 'tx-payout-1'

    const SIGNED_CONTRACT_NUMBER = 'CHK-1-2026'

    function makePayoutHarness(opts: {
      payoutHasInvoice?: boolean
      incomeRows?: Array<{ id: string; amount: string; projectId: string }>
      projects?: Array<{ id: string; name: string }>
      noSignedContract?: boolean
    }) {
      const incomeRows = opts.incomeRows ?? [{ id: 'inc-1', amount: '1000', projectId: 'p-1' }]
      const projectRows = opts.projects ?? [{ id: 'p-1', name: 'Acme Corp' }]
      const payoutTotal = incomeRows.reduce((s, r) => s + parseFloat(r.amount), 0).toString()
      const signedContracts: SignedContractRow[] = opts.noSignedContract
        ? []
        : [
            {
              userId: SENIOR.id,
              templateId: 'tmpl-1',
              contractNumber: SIGNED_CONTRACT_NUMBER,
              targetRole: 'SENIOR',
              signedAt: new Date('2026-03-01'),
            },
          ]
      const h = buildHarness({
        txs: [
          tx({
            id: PAYOUT_TX_ID,
            type: 'PAYOUT',
            senderId: SENIOR.id,
            receiverId: null,
            amount: payoutTotal,
            currency: 'USDT',
            payoutRequestId: REQ_ID,
            invoiceDocumentId: opts.payoutHasInvoice ? 'doc-existing' : null,
          }),
          ...incomeRows.map((r) =>
            tx({
              id: r.id,
              type: 'SENIOR_INCOME',
              status: 'PAID',
              amount: r.amount,
              currency: 'USDT',
              receiverId: SENIOR.id,
              projectId: r.projectId,
              payoutRequestId: REQ_ID,
            }),
          ),
        ],
        sigs: [],
        users: [
          {
            id: SENIOR.id,
            displayName: SENIOR.displayName,
            role: 'SENIOR',
            paymentMethod: 'USDT_ERC20',
            walletUsdtErc20: '0xabc',
            createdAt: new Date('2026-02-01'),
          },
          {
            id: ADMIN.id,
            displayName: ADMIN.displayName,
            role: 'ADMIN',
            createdAt: new Date('2026-01-01'),
          },
        ],
        projects: projectRows,
        signedContracts,
      })
      return { h, incomeRows, projectRows, payoutTotal }
    }

    it('idempotent — second trigger for the same PAYOUT is a no-op', async () => {
      const { h } = makePayoutHarness({ payoutHasInvoice: true })
      h.ctrl.findTxId = PAYOUT_TX_ID
      await h.svc.autoCreateForPayout(PAYOUT_TX_ID)
      expect(h.pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
      expect(h.uploadInternal).not.toHaveBeenCalled()
      expect(h.notifCreate).not.toHaveBeenCalled()
    })

    it('returns early for non-PAYOUT transaction', async () => {
      const h = buildHarness({
        txs: [tx({ id: 'tx-1', type: 'SENIOR_INCOME' })],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-1'
      await h.svc.autoCreateForPayout('tx-1')
      expect(h.pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
    })

    it('1-project happy path — single invoice with sum amount', async () => {
      const { h, projectRows } = makePayoutHarness({
        incomeRows: [{ id: 'inc-1', amount: '1500', projectId: 'p-1' }],
      })
      h.ctrl.findTxId = PAYOUT_TX_ID
      h.ctrl.linkedPayoutRequestId = REQ_ID
      // Service calls users.findFirst twice: counterparty, then admin.
      h.ctrl.userFindFirstQueue = [SENIOR.id, ADMIN.id]
      h.ctrl.projectFindQueue = projectRows.map((p) => p.id)
      h.ctrl.updateTargetTxId = PAYOUT_TX_ID

      await h.svc.autoCreateForPayout(PAYOUT_TX_ID)

      expect(h.pdfService.generateSignableInvoicePdf).toHaveBeenCalledTimes(1)
      const pdfArgs = (
        h.pdfService.generateSignableInvoicePdf as unknown as {
          mock: { calls: unknown[][] }
        }
      ).mock.calls[0]?.[0] as {
        transaction: {
          amount: string
          contractNumber?: string
          projectNames?: string[]
        }
      }
      // security-review round 5 (PR #600, HIGH-4): `.toFixed(6)`, not the
      // whole-number `.toString()` this test asserted before — amount now
      // comes from the shared `resolvePayoutAggregateAmount` helper (single
      // source of truth for autoCreateForPayout/signInvoice/verifyInvoice),
      // which formats to numeric(18,6) parity with every other amount.
      expect(pdfArgs.transaction.amount).toBe('1500.000000')
      // Contract number now comes from the real signed_contracts DB lookup.
      expect(pdfArgs.transaction.contractNumber).toBe(SIGNED_CONTRACT_NUMBER)
      expect(pdfArgs.transaction.projectNames).toEqual(['Acme Corp'])

      // Doc must be linked to the PAYOUT row, not the income.
      const payoutRow = h.state.txs.find((t) => t.id === PAYOUT_TX_ID)
      expect(payoutRow?.invoiceDocumentId).not.toBeNull()
      // Signature inserted against the PAYOUT row id.
      expect(h.state.sigs.length).toBe(1)
      expect(h.state.sigs[0]!.transactionId).toBe(PAYOUT_TX_ID)
      expect(h.state.sigs[0]!.signerRole).toBe('COMPANY')
      // Notification fired to the receiver (= senior).
      expect(h.notifCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: SENIOR.id,
          type: 'INVOICE_SIGN_REQUIRED',
        }),
      )
    })

    it('6-project happy path — single aggregated invoice, sum amount, all project names', async () => {
      const incomes = [
        { id: 'inc-1', amount: '1000', projectId: 'p-1' },
        { id: 'inc-2', amount: '500', projectId: 'p-2' },
        { id: 'inc-3', amount: '200', projectId: 'p-3' },
        { id: 'inc-4', amount: '700', projectId: 'p-4' },
        { id: 'inc-5', amount: '300', projectId: 'p-5' },
        { id: 'inc-6', amount: '800', projectId: 'p-6' },
      ]
      const projects = [
        { id: 'p-1', name: 'Acme Corp' },
        { id: 'p-2', name: 'LearnSpace' },
        { id: 'p-3', name: 'TechCorp AI' },
        { id: 'p-4', name: 'Senior Regression' },
        { id: 'p-5', name: 'Drop Phase 2' },
        { id: 'p-6', name: 'Sixth Project' },
      ]
      const { h } = makePayoutHarness({ incomeRows: incomes, projects })
      h.ctrl.findTxId = PAYOUT_TX_ID
      h.ctrl.linkedPayoutRequestId = REQ_ID
      h.ctrl.userFindFirstQueue = [SENIOR.id, ADMIN.id]
      h.ctrl.projectFindQueue = projects.map((p) => p.id)
      h.ctrl.updateTargetTxId = PAYOUT_TX_ID

      await h.svc.autoCreateForPayout(PAYOUT_TX_ID)

      // ONE invoice for SIX incomes.
      expect(h.pdfService.generateSignableInvoicePdf).toHaveBeenCalledTimes(1)
      expect(h.uploadInternal).toHaveBeenCalledTimes(1)
      expect(h.notifCreate).toHaveBeenCalledTimes(1)

      const pdfArgs = (
        h.pdfService.generateSignableInvoicePdf as unknown as {
          mock: { calls: unknown[][] }
        }
      ).mock.calls[0]?.[0] as {
        transaction: {
          amount: string
          projectNames?: string[]
        }
      }
      // Sum amount: 1000 + 500 + 200 + 700 + 300 + 800 = 3500. `.toFixed(6)`
      // (round 5, HIGH-4) — see the 1-project test's comment above.
      expect(pdfArgs.transaction.amount).toBe('3500.000000')
      // All 6 project names are passed through — the PDF service decides
      // how to render (truncation happens there).
      expect(pdfArgs.transaction.projectNames).toEqual([
        'Acme Corp',
        'LearnSpace',
        'TechCorp AI',
        'Senior Regression',
        'Drop Phase 2',
        'Sixth Project',
      ])
    })

    it('no signed contract → contractNumber is null in PDF args', async () => {
      const { h, projectRows } = makePayoutHarness({
        incomeRows: [{ id: 'inc-1', amount: '800', projectId: 'p-1' }],
        noSignedContract: true,
      })
      h.ctrl.findTxId = PAYOUT_TX_ID
      h.ctrl.linkedPayoutRequestId = REQ_ID
      h.ctrl.userFindFirstQueue = [SENIOR.id, ADMIN.id]
      h.ctrl.projectFindQueue = projectRows.map((p) => p.id)
      h.ctrl.updateTargetTxId = PAYOUT_TX_ID

      await h.svc.autoCreateForPayout(PAYOUT_TX_ID)

      expect(h.pdfService.generateSignableInvoicePdf).toHaveBeenCalledTimes(1)
      const pdfArgs = (
        h.pdfService.generateSignableInvoicePdf as unknown as {
          mock: { calls: unknown[][] }
        }
      ).mock.calls[0]?.[0] as {
        transaction: { contractNumber?: string | null }
      }
      // No signed_contracts row → lookupContractNumber returns null.
      expect(pdfArgs.transaction.contractNumber).toBeNull()
    })

    it('does nothing when PAYOUT row not found', async () => {
      const h = buildHarness({ txs: [], sigs: [], users: [], projects: [] })
      h.ctrl.findTxId = 'tx-missing'
      await h.svc.autoCreateForPayout('tx-missing')
      expect(h.pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
    })

    it('defensive-only (round 5, HIGH-4 mutation-gate closure): resolvePayoutAggregateAmount unexpectedly returning null despite non-empty linked incomes is a no-op, not a crash', async () => {
      // "Should never happen in production": the SEPARATE linked-incomes
      // fetch above (project names / receiver resolution) already confirmed
      // length > 0, but the shared helper is forced to return null anyway —
      // the only way to reach this defensive branch, since both queries are
      // structurally identical in the mocked harness and cannot diverge on
      // their own (they read the same `ctrl.linkedPayoutRequestId` state).
      const { h, projectRows } = makePayoutHarness({
        incomeRows: [{ id: 'inc-1', amount: '1500', projectId: 'p-1' }],
      })
      h.ctrl.findTxId = PAYOUT_TX_ID
      h.ctrl.linkedPayoutRequestId = REQ_ID
      // Same lookup queues the happy-path tests seed — the counterparty/
      // admin/project resolution above the mutated branch must still
      // succeed so execution actually reaches it.
      h.ctrl.userFindFirstQueue = [SENIOR.id, ADMIN.id]
      h.ctrl.projectFindQueue = projectRows.map((p) => p.id)
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      vi.spyOn(
        h.svc as unknown as {
          resolvePayoutAggregateAmount: (id: string | null) => Promise<unknown>
        },
        'resolvePayoutAggregateAmount',
      ).mockResolvedValue(null)

      await h.svc.autoCreateForPayout(PAYOUT_TX_ID)

      expect(h.pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
      expect(h.uploadInternal).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('aggregate amount could not be resolved'),
      )
    })
  })

  // ── R2: getInvoice cross-counterparty 403 ──────────────────────────────────
  //
  // RBAC guard in `assertCanViewInvoice`:
  //   - ADMIN + ACCOUNTANT see everything.
  //   - SENIOR who is the counterparty (receiverId matches viewer.id) → ok.
  //   - SENIOR who is NOT the counterparty → 403.
  //   - All other roles that are not counterparty → 403.
  //
  // The guard is tested via `getInvoice` (the public-facing method that calls
  // it) so we exercise the real code path, not a private method in isolation.
  describe('getInvoice — R2: assertCanViewInvoice RBAC', () => {
    // A SENIOR_INCOME tx owned by SENIOR (receiverId = SENIOR.id)
    function makeInvoiceTx() {
      return tx({
        id: 'tx-invoice-1',
        type: 'SENIOR_INCOME',
        receiverId: SENIOR.id,
        invoiceDocumentId: 'doc-inv-1',
      })
    }

    it('non-counterparty SENIOR gets ForbiddenException (403)', async () => {
      const h = buildHarness({
        txs: [makeInvoiceTx()],
        sigs: [],
        users: [{ id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' }],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-invoice-1'

      // SENIOR2 is not the counterparty (receiverId = SENIOR.id)
      await expect(h.svc.getInvoice(SENIOR2, 'tx-invoice-1')).rejects.toThrow(ForbiddenException)
    })

    it('ADMIN sees invoice for any counterparty', async () => {
      const h = buildHarness({
        txs: [makeInvoiceTx()],
        sigs: [],
        users: [{ id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' }],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-invoice-1'

      const result = await h.svc.getInvoice(ADMIN, 'tx-invoice-1')
      expect(result.transactionId).toBe('tx-invoice-1')
    })

    it('ACCOUNTANT sees invoice for any counterparty', async () => {
      const h = buildHarness({
        txs: [makeInvoiceTx()],
        sigs: [],
        users: [{ id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' }],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-invoice-1'

      const result = await h.svc.getInvoice(ACCOUNTANT, 'tx-invoice-1')
      expect(result.transactionId).toBe('tx-invoice-1')
    })

    it('owner counterparty SENIOR sees their own invoice', async () => {
      const h = buildHarness({
        txs: [makeInvoiceTx()],
        sigs: [],
        users: [{ id: SENIOR.id, displayName: SENIOR.displayName, role: 'SENIOR' }],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-invoice-1'

      const result = await h.svc.getInvoice(SENIOR, 'tx-invoice-1')
      expect(result.transactionId).toBe('tx-invoice-1')
    })
  })

  // security-review round 2 (PR #600, MED-7) on task-invoice-signature-integrity.
  describe('reissueInvoiceIfStillPaid — AC2-bis / MED-7', () => {
    it('MED-7: a PAYOUT-linked row (payoutRequestId set) never triggers a second, per-row invoice on top of the aggregated PAYOUT invoice', async () => {
      const h = buildHarness({
        txs: [
          tx({
            id: 'tx-linked-income',
            type: 'SENIOR_INCOME',
            status: 'PAID',
            payoutRequestId: 'payout-1',
          }),
        ],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-linked-income'
      const spy = vi.spyOn(h.svc, 'autoCreateForSeniorPayout')

      await h.svc.reissueInvoiceIfStillPaid('tx-linked-income')

      expect(spy).not.toHaveBeenCalled()
    })

    it('MED-7: swallows an autoCreateFor* failure instead of throwing — mirrors safeAutoCreateInvoice, so the amount-edit endpoint never 500s after the new amount was already committed', async () => {
      const h = buildHarness({
        txs: [tx({ id: 'tx-salary', type: 'SALARY', status: 'PAID', payoutRequestId: null })],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-salary'
      vi.spyOn(h.svc, 'autoCreateForSalary').mockRejectedValueOnce(new Error('S3 outage'))
      // mutation-gate closure: assert the warn log itself, not just the
      // resolved value — an empty catch block also "swallows" the
      // rejection, so the resolved-value assertion alone cannot tell the
      // two apart.
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

      await expect(h.svc.reissueInvoiceIfStillPaid('tx-salary')).resolves.toBeUndefined()

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'reissueInvoiceIfStillPaid: auto-create failed for tx=tx-salary: S3 outage',
        ),
      )
    })

    it('happy path unaffected: a still-PAID SALARY row with no payoutRequestId still triggers autoCreateForSalary', async () => {
      const h = buildHarness({
        txs: [tx({ id: 'tx-salary-2', type: 'SALARY', status: 'PAID', payoutRequestId: null })],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-salary-2'
      const spy = vi.spyOn(h.svc, 'autoCreateForSalary').mockResolvedValueOnce(undefined)

      await h.svc.reissueInvoiceIfStillPaid('tx-salary-2')

      expect(spy).toHaveBeenCalledWith('tx-salary-2')
    })

    it('mutation-gate closure: a still-PAID SENIOR_INCOME row (no payoutRequestId) triggers autoCreateForSeniorPayout, NOT autoCreateForSalary — the type branch actually discriminates', async () => {
      const h = buildHarness({
        txs: [
          tx({ id: 'tx-senior', type: 'SENIOR_INCOME', status: 'PAID', payoutRequestId: null }),
        ],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-senior'
      const seniorSpy = vi
        .spyOn(h.svc, 'autoCreateForSeniorPayout')
        .mockResolvedValueOnce(undefined)
      const salarySpy = vi.spyOn(h.svc, 'autoCreateForSalary')

      await h.svc.reissueInvoiceIfStillPaid('tx-senior')

      expect(seniorSpy).toHaveBeenCalledWith('tx-senior')
      expect(salarySpy).not.toHaveBeenCalled()
    })

    it('mutation-gate closure: a NOT-PAID row (status reverted by a cascade) is a pure no-op — no autoCreateFor* call at all', async () => {
      const h = buildHarness({
        txs: [tx({ id: 'tx-pending', type: 'SALARY', status: 'PENDING', payoutRequestId: null })],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-pending'
      const salarySpy = vi.spyOn(h.svc, 'autoCreateForSalary')
      const seniorSpy = vi.spyOn(h.svc, 'autoCreateForSeniorPayout')

      await expect(h.svc.reissueInvoiceIfStillPaid('tx-pending')).resolves.toBeUndefined()

      expect(salarySpy).not.toHaveBeenCalled()
      expect(seniorSpy).not.toHaveBeenCalled()
    })

    it('mutation-gate closure: a still-PAID row of neither SALARY nor SENIOR_INCOME (structurally unreachable in practice, e.g. PAYOUT) is a no-op — the else-if genuinely discriminates on type, not just falls through', async () => {
      const h = buildHarness({
        txs: [tx({ id: 'tx-other', type: 'PAYOUT', status: 'PAID', payoutRequestId: null })],
        sigs: [],
        users: [],
        projects: [],
      })
      h.ctrl.findTxId = 'tx-other'
      const salarySpy = vi.spyOn(h.svc, 'autoCreateForSalary')
      const seniorSpy = vi.spyOn(h.svc, 'autoCreateForSeniorPayout')

      await expect(h.svc.reissueInvoiceIfStillPaid('tx-other')).resolves.toBeUndefined()

      expect(salarySpy).not.toHaveBeenCalled()
      expect(seniorSpy).not.toHaveBeenCalled()
    })
  })
})
