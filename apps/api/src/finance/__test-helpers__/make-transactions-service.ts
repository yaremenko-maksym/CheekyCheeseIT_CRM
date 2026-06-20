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
 *   etherscanService  — no-op (verifyTransaction/verifyDeposit return confirmed=true)
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

export interface MakeTransactionsServiceOverrides {
  db: DatabaseService
  invoicesService?: InvoicesService
  documentsService?: DocumentsService
  nbuCurrencyService?: NbuCurrencyService
  etherscanService?: EtherscanService
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

/** Default no-op stub for NbuCurrencyService.
 *  Tests that exercise currency conversion MUST supply their own stub. */
function makeDefaultNbuStub(): NbuCurrencyService {
  return {
    getRates: vi
      .fn()
      .mockRejectedValue(
        new Error('NbuCurrencyService not stubbed — pass nbuCurrencyService override'),
      ),
  } as unknown as NbuCurrencyService
}

/** Default no-op stub for EtherscanService — happy-path confirm. */
function makeDefaultEtherscanStub(): EtherscanService {
  return {
    verifyTransaction: vi.fn().mockResolvedValue({ confirmed: true, amountUsdt: null }),
    verifyDeposit: vi.fn().mockResolvedValue({
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: 12,
      amountUsdt: null,
    }),
  } as unknown as EtherscanService
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
  } = overrides

  return new TransactionsService(
    db,
    invoicesService,
    documentsService,
    nbuCurrencyService,
    etherscanService,
  )
}
