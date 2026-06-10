/**
 * finance-senior-payment-flow.spec.ts
 *
 * Regression coverage for PR #56 user-testing bugs:
 *
 *   Bug 1 — SENIOR couldn't pay VALIDATED transactions because the UI
 *   filter scoped «Оплатить (N)» by `senderId === userId`. SENIOR_INCOME
 *   rows have `senderId = null` (sender is the client company, surfaced
 *   via `senderLabel`), so the button was *always* hidden in production.
 *   The legacy E2E spec hid this with mock data that set `senderId =
 *   senior.id` — these tests use the realistic shape (senderId=null,
 *   receiverId=senior.id) and assert the button is both visible and
 *   functional.
 *
 *   Bug 2 — every time a transaction with a receipt was opened, the
 *   browser auto-downloaded the PDF/image instead of previewing it.
 *   Root cause: presigned URL embedded `Content-Disposition: attachment`.
 *   This file verifies the receipt opens in an inline preview dialog
 *   (image via `<img>`, PDF via `<object>`).
 *
 * Why a dedicated file: keeps the regression suite isolated, so future
 * changes to the broader finance flow don't accidentally mask either bug.
 */
import { test, expect, USERS, PROJECTS, mockAuthAs } from './fixtures'

const API = 'http://localhost:3001/api'
const PROJECT_ID = PROJECTS[0]!.id
const PROJECT_NAME = PROJECTS[0]!.name

// -----------------------------------------------------------------------------
// Realistic SENIOR_INCOME shape — mirrors what the backend actually returns
// (transactions.service.ts createSeniorIncome): sender_id NULL, sender_label
// = client company, receiver_id = senior. Anything that pre-sets senderId =
// senior.id masks the very bug we're testing.
// -----------------------------------------------------------------------------
function makeSeniorIncome(overrides: object = {}) {
  return {
    id: 'pay-flow-tx-1',
    type: 'SENIOR_INCOME',
    status: 'VALIDATED' as const,
    amount: '5000.00',
    currency: 'USDT' as const,
    senderId: null,
    senderName: null,
    senderLabel: 'TechCorp AI',
    receiverId: USERS.senior.id,
    receiverName: USERS.senior.displayName,
    receiverLabel: null,
    seniorSharePercent: 26,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    receiptDocumentId: null,
    receiptExternalUrl: 'https://drive.example.com/receipt.pdf',
    notes: null,
    salaryMonth: null,
    txHash: null,
    rejectionReason: null,
    payoutRequestId: null,
    validatedBy: USERS.accountant.id,
    validatedAt: '2026-05-02T10:00:00.000Z',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-02T10:00:00.000Z',
    ...overrides,
  }
}

type MockPage = import('@playwright/test').Page

// Stable stub address shared between POST/GET/PATCH responses so the dialog
// can match what the user sees against what we return on submit.
const STUB_CONTRACT = '0xabcdef0123456789abcdef0123456789abcdef01'

function makePayoutResponse(
  overrides: { status?: 'PENDING' | 'PAID'; txHash?: string | null; txs?: object[] } = {},
) {
  return {
    id: 'payout-flow-1',
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    incomeAmount: '5000.00',
    payableAmount: '3700.00',
    contractAddress: STUB_CONTRACT,
    status: overrides.status ?? 'PENDING',
    txHash: overrides.txHash ?? null,
    transactions: overrides.txs ?? [],
    createdAt: '2026-05-02T12:00:00.000Z',
    updatedAt: '2026-05-02T12:00:00.000Z',
  }
}

async function mockTransactions(page: MockPage, txs: object[], payouts: object[] = []) {
  await page.route(new RegExp(`${API}/transactions/([^/?]+)$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(txs[0] ?? {}) }),
  )
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(txs) }),
  )
  // /pay endpoint — final submit. Must match BEFORE the catch-all below.
  await page.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        makePayoutResponse({
          status: 'PAID',
          txHash: '0xdeadbeef',
          txs: [{ ...(txs[0] as object), status: 'PAID' }],
        }),
      ),
    }),
  )
  // Single-payout GET — used by PayoutDetailDialog.
  await page.route(new RegExp(`${API}/payout-requests/([^/?]+)$`), (r) =>
    r.request().method() === 'GET'
      ? r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makePayoutResponse({ txs })),
        })
      : r.fallback(),
  )
  await page.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(makePayoutResponse({ txs })),
        })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payouts) }),
  )
  await page.route(`${API}/projects`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]),
    }),
  )
}

// ─── Bug 1 — «Оплатить» visibility / functionality ─────────────────────────────
//
// Updated for task-payout-auto-on-validate: the batch «Выплатить (N)» header
// flow is gone. ACCOUNTANT validate now atomically creates a PAYOUT row that
// carries the inline «Оплатить» pill. SENIOR_INCOME rows never show any
// pay-out button anymore.

// Make a PAYOUT row (the «Выплата» placeholder auto-created by the backend).
function makePayoutRow(overrides: object = {}) {
  return {
    id: 'pay-flow-payout-row-1',
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT' as const,
    amount: '3700.00',
    currency: 'USDT' as const,
    senderId: USERS.senior.id,
    senderName: USERS.senior.displayName,
    senderLabel: null,
    receiverId: null,
    receiverName: null,
    receiverLabel: 'CheekyCheeseIT',
    seniorSharePercent: null,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txHash: null,
    rejectionReason: null,
    payoutRequestId: 'payout-flow-1',
    validatedBy: null,
    validatedAt: null,
    createdAt: '2026-05-02T11:00:00.000Z',
    updatedAt: '2026-05-02T11:00:00.000Z',
    ...overrides,
  }
}

test.describe('SENIOR submits payment flow (regression for PR #56 Bug 1)', () => {
  test('SENIOR_INCOME row never carries a pay-out pill (PENDING_PAYMENT still no inline button)', async ({
    asSenior,
  }) => {
    // After task-payout-auto-on-validate the «Выплата» row carries pay-out,
    // not the SENIOR_INCOME row — even when SENIOR_INCOME has moved to
    // PENDING_PAYMENT.
    const pendingPaymentIncome = makeSeniorIncome({
      status: 'PENDING_PAYMENT',
      payoutRequestId: 'payout-flow-1',
    })
    await mockTransactions(asSenior, [pendingPaymentIncome])

    await asSenior.goto('/crm/finance')
    await expect(
      asSenior.getByTestId('tx-status-badge-pending_payment').first(),
    ).toBeVisible()
    // No inline button on the SENIOR_INCOME row — both quick-payout (old) and
    // pay-payout pills are gone for this row type.
    await expect(
      asSenior.getByTestId(`row-pay-payout-${pendingPaymentIncome.id}`),
    ).not.toBeVisible()
    // No row-level «Выплатить» (pay-salary) pill anywhere either.
    await expect(
      asSenior.getByTestId(`tx-row-pay-salary-${pendingPaymentIncome.id}`),
    ).not.toBeVisible()
  })

  test('SENIOR sees inline «Оплатить» on the auto-created PAYOUT row', async ({
    asSenior,
  }) => {
    // ACCOUNTANT-just-validated state: SENIOR_INCOME in PENDING_PAYMENT plus
    // the auto-created «Выплата» (PAYOUT, PENDING_PAYMENT, senderId=senior).
    const incomeTx = makeSeniorIncome({
      status: 'PENDING_PAYMENT',
      payoutRequestId: 'payout-flow-1',
    })
    const payoutRow = makePayoutRow()
    await mockTransactions(asSenior, [incomeTx, payoutRow])

    await asSenior.goto('/crm/finance')

    const inlinePay = asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`)
    await expect(inlinePay).toBeVisible()
  })

  test('SENIOR does NOT see any pay-out pill for PENDING (un-validated) SENIOR_INCOME', async ({
    asSenior,
  }) => {
    const pendingTx = makeSeniorIncome({ status: 'PENDING', validatedBy: null, validatedAt: null })
    await mockTransactions(asSenior, [pendingTx])

    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByTestId('tx-status-badge-pending').first()).toBeVisible()
    // SENIOR_INCOME row should not carry any pay-out pill while PENDING.
    await expect(
      asSenior.getByTestId(`row-pay-payout-${pendingTx.id}`),
    ).not.toBeVisible()
    await expect(
      asSenior.getByTestId(`tx-row-pay-salary-${pendingTx.id}`),
    ).not.toBeVisible()
  })

  test('Header batch «Выплатить (N)» button is gone (removed in task-payout-auto-on-validate)', async ({
    asSenior,
  }) => {
    // Even with multiple VALIDATED-looking rows, no batch header button
    // should appear — the flow is now driven entirely from the PAYOUT row.
    const validatedTx = makeSeniorIncome()
    await mockTransactions(asSenior, [validatedTx])

    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByTestId('header-payout-button')).not.toBeVisible()
    // Defensive: the testid would still be the canonical anchor — but as a
    // sanity check, no Wallet-pill row-level pay-payout button either.
    await expect(
      asSenior.getByTestId(`row-pay-payout-${validatedTx.id}`),
    ).not.toBeVisible()
  })

  test('SENIOR pays auto-created PAYOUT: inline «Оплатить» → PayoutDetailDialog → submit tx hash', async ({
    asSenior,
  }) => {
    const incomeTx = makeSeniorIncome({
      status: 'PENDING_PAYMENT',
      payoutRequestId: 'payout-flow-1',
    })
    const payoutRow = makePayoutRow()
    await mockTransactions(asSenior, [incomeTx, payoutRow])

    await asSenior.goto('/crm/finance')

    const inlinePay = asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`)
    await expect(inlinePay).toBeVisible()
    await inlinePay.click()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-title')).toContainText(
      /Подтвердить выплату/i,
    )

    await expect(dialog.getByTestId('payout-detail-contract-address')).toContainText(
      STUB_CONTRACT,
    )

    // PR #56 dev-simulate gate:
    // In `vite dev` the simulate-success radio is rendered and real-mode is
    // disabled — the SENIOR must opt into simulate to unlock submit.
    // In CI's production build (`vite preview`) import.meta.env.DEV === false
    // and the entire dev block is tree-shaken out → the testid is absent and
    // a ≥10-char tx hash alone unlocks submit.
    // isVisible() resolves instantly without timing out on a missing element.
    const simulateRadio = dialog.getByTestId('payout-detail-dev-simulate-success')
    if (await simulateRadio.isVisible()) {
      await simulateRadio.click()
    }
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xabcd1234567890')
    await dialog.getByTestId('payout-detail-submit').click()

    await expect(dialog).not.toBeVisible()
  })

  test('REJECTED transactions never get a pay-out pill', async ({ asSenior }) => {
    const rejected = makeSeniorIncome({
      id: 'pay-flow-tx-rejected',
      status: 'REJECTED',
      rejectionReason: 'Чек нечитаем',
    })
    await mockTransactions(asSenior, [rejected])

    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByTestId('tx-status-badge-rejected').first()).toBeVisible()
    // Rejected rows must not surface any pay-related button.
    await expect(
      asSenior.getByTestId(`row-pay-payout-${rejected.id}`),
    ).not.toBeVisible()
    await expect(
      asSenior.getByTestId(`tx-row-pay-salary-${rejected.id}`),
    ).not.toBeVisible()
  })

  test('ACCOUNTANT does NOT see the «Оплатить» pill on PAYOUT rows (SENIOR-only)', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.accountant)
    const incomeTx = makeSeniorIncome({
      status: 'PENDING_PAYMENT',
      payoutRequestId: 'payout-flow-1',
    })
    const payoutRow = makePayoutRow()
    await mockTransactions(page, [incomeTx, payoutRow])

    await page.goto('/crm/finance')
    await expect(page.getByTestId(`row-pay-payout-${payoutRow.id}`)).not.toBeVisible()
    // Header batch pay-out button is gone — anchor by testid, not text.
    await expect(page.getByTestId('header-payout-button')).not.toBeVisible()
  })
})

// ─── Bug 2 — Receipt inline preview (no auto-download) ────────────────────────

test.describe('Receipt preview (inline, not download) — PR #56 Bug 2 regression', () => {
  test('Image receipt renders inline inside TransactionDetailDialog (no download triggered)', async ({
    asAdmin,
  }) => {
    // Intercept the receipt fetch so the image actually loads in the test
    // browser (a plain test URL would 404 and the onError handler would set
    // display:none, hiding the proof that inline rendering is wired up).
    // 1x1 transparent PNG bytes.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    await asAdmin.route('https://files.example.com/receipt.png', (r) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    )

    const txWithImageReceipt = makeSeniorIncome({
      id: 'pay-flow-tx-img',
      receiptExternalUrl: 'https://files.example.com/receipt.png',
      receiptDocumentId: null,
    })

    await mockTransactions(asAdmin, [txWithImageReceipt])

    // Track download events — if the browser tries to save a file, this flips
    // to true, signaling a regression back to attachment disposition.
    let downloadTriggered = false
    asAdmin.on('download', () => {
      downloadTriggered = true
    })

    await asAdmin.goto('/crm/finance')

    // Click the row to open the detail dialog — bind to tx.id testid so a
    // type-label copy change cannot break the trigger.
    await asAdmin.getByTestId(`tx-row-${txWithImageReceipt.id}`).click()
    const dialog = asAdmin.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // The receipt must render as an <img> with the receipt URL — proves the
    // dialog uses the inline preview path, not a download anchor.
    const img = dialog.locator('img[alt="Чек"]')
    await expect(img).toBeVisible()
    await expect(img).toHaveAttribute('src', /receipt\.png/)

    // No download must have been triggered by opening the dialog.
    expect(downloadTriggered).toBe(false)
  })

  test('PDF receipt renders as inline <object> (browser PDF viewer, not download)', async ({
    asAdmin,
  }) => {
    const txWithPdfReceipt = makeSeniorIncome({
      id: 'pay-flow-tx-pdf',
      receiptExternalUrl: 'https://files.example.com/receipt.pdf',
      receiptDocumentId: null,
    })

    await mockTransactions(asAdmin, [txWithPdfReceipt])

    let downloadTriggered = false
    asAdmin.on('download', () => {
      downloadTriggered = true
    })

    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTestId(`tx-row-${txWithPdfReceipt.id}`).click()
    const dialog = asAdmin.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // PDF is rendered via <object data="..." type="application/pdf">
    const obj = dialog.locator('object[type="application/pdf"]')
    await expect(obj).toBeVisible()
    await expect(obj).toHaveAttribute('data', /receipt\.pdf/)

    expect(downloadTriggered).toBe(false)
  })

  test('Uploaded receipt (documentId) resolves to a presigned URL and renders inline', async ({
    asAdmin,
  }) => {
    const PRESIGNED_URL =
      'https://minio.example.com/crm-documents/uploads/receipt.png?sig=abc'

    const txWithUploadedReceipt = makeSeniorIncome({
      id: 'pay-flow-tx-uploaded',
      receiptExternalUrl: null,
      receiptDocumentId: 'doc-receipt-123',
    })

    await mockTransactions(asAdmin, [txWithUploadedReceipt])

    // Mock the document download endpoint to return a presigned URL.
    await asAdmin.route(`${API}/documents/doc-receipt-123/download`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: PRESIGNED_URL, expiresAt: '2099-01-01T00:00:00.000Z' }),
      }),
    )

    // And mock the presigned URL itself so the <img> actually loads — without
    // this the onError handler hides the element, masking the inline-render
    // check.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    await asAdmin.route(PRESIGNED_URL, (r) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    )

    let downloadTriggered = false
    asAdmin.on('download', () => {
      downloadTriggered = true
    })

    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTestId(`tx-row-${txWithUploadedReceipt.id}`).click()
    const dialog = asAdmin.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Either <img> or <object> appears once the presigned URL resolves.
    const preview = dialog.locator('img[alt="Чек"], object[type="application/pdf"]').first()
    await expect(preview).toBeVisible()

    expect(downloadTriggered).toBe(false)
  })
})
