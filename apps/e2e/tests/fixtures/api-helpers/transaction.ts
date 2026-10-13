import type { Page } from '@playwright/test'
import { REAL_API_BASE } from './common'

/**
 * Insert a DROP_INCOME row via POST /api/transactions/drop-income.
 *
 * Caller must be DROP-authenticated and the project must be routed
 * through them (`project.dropId === drop.id`). The row lands in PENDING
 * until an ACCOUNTANT/ADMIN validates it (see `validateTransactionViaAPI`).
 *
 * Defaults:
 *   - amount: 1000
 *   - currency: 'USDT'
 *   - receiptExternalUrl: 'https://etherscan.io/tx/0xdrop00...' (task-receipts-e2e:
 *     the default currency is USDT, and mandatory-receipt now requires the
 *     receipt to be a blockchain-explorer link for USDT — a file is rejected
 *     and a non-explorer URL is rejected. An explorer link is also a valid
 *     plain http(s) URL, so this same default stays valid for callers that
 *     override `currency` to a non-USDT value too).
 *   - idempotencyKey: fresh `crypto.randomUUID()` per call (task-senior-drop-
 *     income-idempotency, backlog 73/A-3) — same optional-override contract
 *     as `declareUsdtIncomeViaAPI` above; a caller exercising the replay
 *     behaviour passes the SAME key across two calls explicitly.
 */
export async function createDropIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    idempotencyKey?: string
    receiptExternalUrl?: string
    receiptDocumentId?: string
    notes?: string | null
    txDate?: string | null
  },
): Promise<{ txId: string; status: string; amount: string }> {
  const payload = {
    projectId: opts.projectId,
    amount: opts.amount ?? 1000,
    currency: opts.currency ?? 'USDT',
    idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
    ...(opts.receiptDocumentId
      ? { receiptDocumentId: opts.receiptDocumentId }
      : {
          receiptExternalUrl:
            opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xdrop000000000000income',
        }),
    ...(opts.notes !== undefined && { notes: opts.notes }),
    ...(opts.txDate !== undefined && { txDate: opts.txDate }),
  }
  const res = await page.request.post(`${REAL_API_BASE}/api/transactions/drop-income`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createDropIncomeViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; status: string; amount: string }
  return { txId: body.id, status: body.status, amount: body.amount }
}

/**
 * Insert a SENIOR_INCOME row via POST /api/transactions/senior-income.
 *
 * Mirror of `createDropIncomeViaAPI` for the senior path. Required by
 * the regression spec which exercises the legacy senior distribution
 * branch end-to-end and asserts NO PAYOUT_DROP rows are produced.
 *
 * task-receipts-e2e: same explorer-link default fix as `createDropIncomeViaAPI`
 * — the default currency is USDT, so the default receipt must be an
 * allowlisted blockchain-explorer link (a `drive.example.com` URL is rejected
 * by the mandatory currency-aware receipt refine).
 *
 * task-senior-drop-income-idempotency (backlog 73/A-3): `idempotencyKey`
 * defaults to a fresh `crypto.randomUUID()` per call — same optional-override
 * contract as `createDropIncomeViaAPI` above.
 */
export async function createSeniorIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    idempotencyKey?: string
    receiptExternalUrl?: string
    receiptDocumentId?: string
    notes?: string | null
    txDate?: string | null
  },
): Promise<{ txId: string; status: string; amount: string }> {
  const payload = {
    projectId: opts.projectId,
    amount: opts.amount ?? 1000,
    currency: opts.currency ?? 'USDT',
    idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
    ...(opts.receiptDocumentId
      ? { receiptDocumentId: opts.receiptDocumentId }
      : {
          receiptExternalUrl:
            opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xsenior0000000000income',
        }),
    ...(opts.notes !== undefined && { notes: opts.notes }),
    ...(opts.txDate !== undefined && { txDate: opts.txDate }),
  }
  const res = await page.request.post(`${REAL_API_BASE}/api/transactions/senior-income`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createSeniorIncomeViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; status: string; amount: string }
  return { txId: body.id, status: body.status, amount: body.amount }
}

/**
 * Validate a PENDING SENIOR_INCOME/DROP_INCOME via PATCH /api/transactions/:id/validate.
 *
 * Caller must be ADMIN or ACCOUNTANT. The backend:
 *   1. Flips income status PENDING → VALIDATED.
 *   2. Creates a payout_request row.
 *   3. Inserts the placeholder PAYOUT row (PENDING_PAYMENT).
 *
 * The actual distribution math (PAYOUT_DROP + PAYOUT_ADMIN inserts) does
 * NOT happen here — those are created by `payPayoutRequest`. Callers
 * must invoke `payPayoutRequestViaAPI` to trigger distribution.
 */
export async function validateTransactionViaAPI(
  page: Page,
  txId: string,
): Promise<{ payoutRequestId: string | null }> {
  const res = await page.request.patch(`${REAL_API_BASE}/api/transactions/${txId}/validate`, {
    data: { action: 'validate' },
  })
  if (res.status() !== 200) {
    throw new Error(
      `validateTransactionViaAPI failed for ${txId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { payoutRequestId: string | null }
  return { payoutRequestId: body.payoutRequestId ?? null }
}
