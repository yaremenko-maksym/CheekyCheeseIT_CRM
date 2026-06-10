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
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { FastifyRequest } from 'fastify'
import type { SessionUser } from '@crm/shared'
import { InvoicesService } from './invoices.service'

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
      from: (_t: unknown) => {
        const chain = {
          where: (_p: unknown) => chain,
          leftJoin: (_t2: unknown, _on: unknown) => chain,
          innerJoin: (_t2: unknown, _on: unknown) => chain,
          orderBy: (_o: unknown) => {
            // Make orderBy return a chainable: limit() OR awaited-list.
            const ordered = {
              limit: async (lim: number) => resolveLimit(lim, fields),
              then: (resolve: (v: unknown) => void) => {
                resolve(resolveOrderByList())
              },
            }
            return ordered
          },
          limit: async (lim: number) => resolveLimit(lim, fields),
          then: (resolve: (v: unknown) => void) => {
            resolve(resolveSelectArray())
          },
        }
        return chain
      },
    }
  }

  function resolveLimit(lim: number, fields: unknown): unknown[] {
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

  function resolveSelectArray(): unknown[] {
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
      expect(pdfArgs.transaction.amount).toBe('1500')
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
      // Sum amount: 1000 + 500 + 200 + 700 + 300 + 800 = 3500
      expect(pdfArgs.transaction.amount).toBe('3500')
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
})
