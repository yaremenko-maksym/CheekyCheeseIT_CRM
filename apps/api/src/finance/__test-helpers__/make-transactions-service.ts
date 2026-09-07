/**
 * Test factory for TransactionsService.
 *
 * Centralises the `new TransactionsService(db, invoices, documents, nbu, etherscan)`
 * call so that a future change to the constructor signature requires a single
 * edit here — not across every spec file.
 *
 * Usage:
 *   // Minimal — only db is required; remaining deps default to no-op stubs.
 *   const svc = makeTransactionsService({ db: myDbStub })
 *
 *   // Override specific deps while keeping the rest as no-op stubs:
 *   const svc = makeTransactionsService({ db, invoicesService: myInvoicesSpy })
 *
 *   // Override all five deps explicitly (rare; integration tests that wire real services):
 *   const svc = makeTransactionsService({ db, invoicesService, documentsService, nbuCurrencyService, etherscanService })
 *
 * Stub defaults:
 *   invoicesService   — no-op (autoCreateForPayout/Income/Salary return undefined)
 *   documentsService  — no-op (findOne returns undefined)
 *   nbuCurrencyService — no-op (getRates throws — callers that need it must pass a real stub)
 *   etherscanService  — no-op (verifyDeposit returns confirmed=true)
 *
 * IMPORTANT: The stubs above are intentionally minimal. If a test path exercises
 * nbu/etherscan logic it MUST pass a customised stub via overrides.
 */
import { vi } from 'vitest'
import { TransactionsService } from '../transactions.service'
import type { DatabaseService } from '../../database/database.service'
import type { InvoicesService } from '../../invoices/invoices.service'
import type { DocumentsService } from '../../documents/documents.service'
import type { NbuCurrencyService } from '../nbu-currency.service'
import type { EtherscanService } from '../etherscan.service'
import type { NotificationsService } from '../../notifications/notifications.service'

export interface MakeTransactionsServiceOverrides {
  db: DatabaseService
  invoicesService?: InvoicesService
  documentsService?: DocumentsService
  nbuCurrencyService?: NbuCurrencyService
  etherscanService?: EtherscanService
  /**
   * task-notification-types-producers (позиция 6). По умолчанию — заглушка,
   * которая ничего не делает: подавляющее большинство спек про деньги, а не про
   * уведомления, и им не должно быть дела до нового шва. Спеки, которые
   * проверяют производителя, передают свой шпион.
   */
  notificationsService?: NotificationsService
}

/** Default no-op stub for InvoicesService — covers auto-create paths. */
function makeDefaultInvoicesStub(): InvoicesService {
  return {
    autoCreateForPayout: vi.fn().mockResolvedValue(undefined),
    autoCreateForIncome: vi.fn().mockResolvedValue(undefined),
    autoCreateForSeniorPayout: vi.fn().mockResolvedValue(undefined),
    autoCreateForSalary: vi.fn().mockResolvedValue(undefined),
  } as unknown as InvoicesService
}

/** Default no-op stub for DocumentsService. */
function makeDefaultDocumentsStub(): DocumentsService {
  return {
    findOne: vi.fn().mockResolvedValue(undefined),
    deleteS3Keys: vi.fn().mockResolvedValue(undefined),
  } as unknown as DocumentsService
}

/** Default stub for NbuCurrencyService.
 *  Returns a deterministic NBU snapshot (USD/UAH 41.50, EUR/UAH 44.80) so paths
 *  that aggregate in a base currency (getSummary / getDropSelfSummary, audit
 *  2026-06-28 #4) resolve without each spec wiring rates. USD ⇄ USDT is a
 *  byte-exact identity in convertToBase regardless of the rate, so single-
 *  currency (USDT/USD) fixtures are unaffected. Tests that need a SPECIFIC
 *  cross-rate (EUR/UAH conversion assertions) MUST still pass their own stub. */
function makeDefaultNbuStub(): NbuCurrencyService {
  return {
    getRates: vi.fn().mockResolvedValue({
      usdUah: '41.50',
      usdtUah: '41.50',
      eurUah: '44.80',
      date: '2026-06-28',
    }),
  } as unknown as NbuCurrencyService
}

/** Default no-op stub for EtherscanService — happy-path confirm. */
function makeDefaultEtherscanStub(): EtherscanService {
  return {
    verifyDeposit: vi.fn().mockResolvedValue({
      found: true,
      toMatches: true,
      // task-onchain-payment-integrity: recorded on-chain sender (audit only).
      fromAddress: null,
      confirmed: true,
      confirmations: 12,
      // Deliberately null: `payPayoutRequest` demands an EXACT amount match, so
      // this default stub can never settle a payout by accident. A spec that
      // exercises the real on-chain payout path MUST pass its own stub with
      // `amountUsdtMinor` equal to the payout's payable (in minor units).
      amountUsdt: null,
      amountUsdtMinor: null,
    }),
  } as unknown as EtherscanService
}

/** Default no-op stub for NotificationsService — producer paths stay silent. */
function makeDefaultNotificationsStub(): NotificationsService {
  return {
    create: vi.fn().mockResolvedValue(null),
    createInTx: vi.fn().mockResolvedValue(null),
    createManyInTx: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService
}

/**
 * Build a TransactionsService with the given overrides.
 * `db` is required; all other deps default to no-op stubs.
 */
export function makeTransactionsService(
  overrides: MakeTransactionsServiceOverrides,
): TransactionsService {
  const {
    db,
    invoicesService = makeDefaultInvoicesStub(),
    documentsService = makeDefaultDocumentsStub(),
    nbuCurrencyService = makeDefaultNbuStub(),
    etherscanService = makeDefaultEtherscanStub(),
    notificationsService = makeDefaultNotificationsStub(),
  } = overrides

  return new TransactionsService(
    db,
    invoicesService,
    documentsService,
    nbuCurrencyService,
    etherscanService,
    notificationsService,
  )
}
