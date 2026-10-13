import type { Page } from '@playwright/test'
import { REAL_API_BASE, withThrottleRetry } from './common'

// ---------------------------------------------------------------------------
// ensureCompanyWalletViaAPI
// ---------------------------------------------------------------------------

/**
 * Ensure the company wallet is configured (required for payout-request creation).
 * The dev seed leaves walletAddress=NULL. Any spec that needs to create a
 * payout_request (DROP pay flow) must call this first. Idempotent.
 * Caller must be logged in as ADMIN.
 */
export async function ensureCompanyWalletViaAPI(page: Page): Promise<void> {
  const res = await withThrottleRetry(
    () =>
      page.request.patch(`${REAL_API_BASE}/api/company-account/wallet`, {
        data: { walletAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      }),
    'PATCH company-account/wallet',
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(`ensureCompanyWalletViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
}

/**
 * Settle a company obligation (SENIOR_PENDING_PAYOUT or DROP_PENDING_PAYOUT)
 * via POST /pending-settlements/by-source-transaction/:id/settle-company —
 * the SAME generic endpoint the finance-page «Выплатить» button calls
 * (`SettleSeniorPayoutDialog` → `financeApi.settleSeniorPayoutFromTransaction`).
 * Routes server-side by the source-transaction's `type` (ADR D5).
 * `TransactionRow.tsx` renders the «Выплатить» action for BOTH obligation
 * types since PR #367 (the earlier frontend gap flagged in the
 * task-drop-share-e2e report is closed). Settling via API here (instead of
 * clicking that button) is deliberate and mirrors the pre-existing
 * SENIOR_PENDING_PAYOUT pattern: these specs assert the money flow; the
 * button/dialog UI behaviour is covered by its own unit tests.
 *
 * task-receipts-e2e: `settleSeniorPayoutSchema` now requires a mandatory,
 * currency-aware receipt (task-receipts-backend #10) — defaults to a valid
 * etherscan.io link for the (also-defaulted) USDT currency so existing
 * callers keep working; pass `receiptExternalUrl`/`receiptDocumentId` to
 * override for a non-USDT currency.
 */
export async function settleObligationBySourceTransactionViaAPI(
  page: Page,
  sourceTransactionId: string,
  opts: {
    fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
    payerAdminId?: string
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    receiptExternalUrl?: string
    receiptDocumentId?: string
  },
): Promise<{ status: number; body: unknown }> {
  const res = await page.request.post(
    `${REAL_API_BASE}/api/pending-settlements/by-source-transaction/${sourceTransactionId}/settle-company`,
    {
      data: {
        fundingSource: opts.fundingSource,
        ...(opts.payerAdminId !== undefined && { payerAdminId: opts.payerAdminId }),
        currency: opts.currency ?? 'USDT',
        ...(opts.receiptDocumentId
          ? { receiptDocumentId: opts.receiptDocumentId }
          : {
              receiptExternalUrl:
                opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xsettleobligation00001',
            }),
      },
    },
  )
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  if (res.status() >= 400) {
    throw new Error(
      `settleObligationBySourceTransactionViaAPI failed: HTTP ${res.status()} — ${JSON.stringify(body)}`,
    )
  }
  return { status: res.status(), body }
}

/** Fetch the shared company-account balance via GET /api/company-account. */
export async function getCompanyAccountBalanceViaAPI(page: Page): Promise<number> {
  const res = await page.request.get(`${REAL_API_BASE}/api/company-account`)
  if (res.status() !== 200) {
    throw new Error(`getCompanyAccountBalanceViaAPI failed: HTTP ${res.status()}`)
  }
  const body = (await res.json()) as { balance: number | string }
  return typeof body.balance === 'string' ? parseFloat(body.balance) : body.balance
}

/**
 * Self-summary for a DROP via GET /api/finance/drop/me/summary (DROP-only).
 * Used to confirm the drop's aggregate `balance` moves after a
 * DROP_PENDING_PAYOUT settle (PAYOUT_DROP credit — `computeDropAggregate`).
 * Caller must already be logged in as the DROP (`loginViaApi(page, dropEmail)`).
 */
export async function getDropSelfSummaryViaAPI(
  page: Page,
): Promise<{ balance: number; debtToCompany: number; pendingIncomesCount: number }> {
  const res = await page.request.get(`${REAL_API_BASE}/api/finance/drop/me/summary`)
  if (res.status() !== 200) {
    throw new Error(`getDropSelfSummaryViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return (await res.json()) as Awaited<ReturnType<typeof getDropSelfSummaryViaAPI>>
}
