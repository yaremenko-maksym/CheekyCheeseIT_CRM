/**
 * finance-payout-simulate.spec.ts
 *
 * Coverage for Flow B (task-autotest-strengthen-e2e-pr56-flows):
 * PayoutDetailDialog — dev simulate radio toggle introduced in PR #56
 * (Invoice Signing Epic, round 6).
 *
 * Why a dedicated file: PR #56 added 3 mutually-exclusive submit modes to
 * the existing PayoutDetailDialog (real / simulate-success / simulate-error)
 * with subtle gating rules. The existing finance-senior-flow.spec covers
 * the happy path (txHash + submit) but does not enumerate the modes — a
 * regression that re-enables real-mode submit in dev would slip past it.
 *
 * Verified invariants:
 *   B1: Dialog opens from inline pill, shows contract address (label
 *       «Адрес кошелька»), payable amount, default radio = «Реальная
 *       проверка», submit disabled.
 *   B2: «Симулировать ошибку» → submit enabled (hash optional) →
 *       backend 400 → toast/inline message, dialog stays open.
 *   B3: «Симулировать успех» → submit → success toast, dialog closes,
 *       PATCH /pay called with simulateResult='success'.
 *   B4: Real mode in dev — submit stays disabled even with a valid hash.
 */
import { test, expect, USERS, PROJECTS, mockAuthAs } from './fixtures'

const API = 'http://localhost:3001/api'
const PROJECT_ID = PROJECTS[0]!.id
const PROJECT_NAME = PROJECTS[0]!.name

// Stable stub address — must match the contractAddress returned by GET so the
// dialog renders the value the test asserts on.
const STUB_CONTRACT = '0xfeeddeadbeef0123456789abcdef0123456789ab'
const PAYOUT_ID = 'simulate-payout-1'

function makeSeniorIncome(overrides: object = {}) {
  return {
    id: 'simulate-tx-1',
    type: 'SENIOR_INCOME',
    status: 'PENDING_PAYMENT',
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
    payoutRequestId: PAYOUT_ID,
    validatedBy: USERS.accountant.id,
    validatedAt: '2026-05-02T10:00:00.000Z',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-02T10:00:00.000Z',
    ...overrides,
  }
}

function makePayoutRow(overrides: object = {}) {
  return {
    id: 'simulate-payout-row-1',
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
    payoutRequestId: PAYOUT_ID,
    validatedBy: null,
    validatedAt: null,
    createdAt: '2026-05-02T11:00:00.000Z',
    updatedAt: '2026-05-02T11:00:00.000Z',
    ...overrides,
  }
}

function makePayoutRequest(overrides: { status?: 'PENDING' | 'PAID'; txHash?: string | null } = {}) {
  return {
    id: PAYOUT_ID,
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    incomeAmount: '5000.00',
    payableAmount: '3700.00',
    contractAddress: STUB_CONTRACT,
    status: overrides.status ?? 'PENDING',
    txHash: overrides.txHash ?? null,
    transactions: [makeSeniorIncome()],
    createdAt: '2026-05-02T11:00:00.000Z',
    updatedAt: '2026-05-02T11:00:00.000Z',
  }
}

type MockPage = import('@playwright/test').Page

/**
 * Captures POST /api/payout-requests/:id/pay request bodies so the test can
 * assert that the dev-simulate radio actually translates into the right
 * `simulateResult` field on the wire — not just into a dialog state.
 */
function setupPayoutMocks(
  page: MockPage,
  options: { simulateResponse: 'success' | 'error' },
): { getPayCalls: () => Array<Record<string, unknown>> } {
  const payCalls: Array<Record<string, unknown>> = []

  void page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([makeSeniorIncome(), makePayoutRow()]),
    }),
  )

  // Single payout GET — fired by PayoutDetailDialog on open.
  void page.route(new RegExp(`${API}/payout-requests/([^/?]+)$`), (r) =>
    r.request().method() === 'GET'
      ? r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makePayoutRequest()),
        })
      : r.fallback(),
  )

  // /pay endpoint — capture body + return success or error per test setup.
  void page.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) => {
    try {
      const raw = r.request().postData()
      if (raw) {
        payCalls.push(JSON.parse(raw) as Record<string, unknown>)
      } else {
        payCalls.push({})
      }
    } catch {
      payCalls.push({})
    }
    if (options.simulateResponse === 'success') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          makePayoutRequest({
            status: 'PAID',
            // Simulate=success synthesizes a 0xSIM… stub txHash in backend.
            txHash: '0xSIM0000000000000000000000000000000000000000000000000000000000',
          }),
        ),
      })
    }
    // simulate=error path — NestJS BadRequestException
    return r.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 400,
        message: 'Симуляция: транзакция не подтверждена',
        error: 'Bad Request',
      }),
    })
  })

  void page.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  void page.route(`${API}/projects`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]),
    }),
  )

  return { getPayCalls: () => payCalls }
}

async function openPayoutDialog(page: MockPage) {
  await page.goto('/crm/finance')
  const inlinePay = page.getByTestId(`row-pay-payout-${makePayoutRow().id}`)
  await expect(inlinePay).toBeVisible()
  await inlinePay.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('Flow B — Payout payment simulate radio (PR #56)', () => {
  test('B1: dialog opens with contract address, payable amount, default real radio, submit disabled', async ({
    asSenior,
  }) => {
    setupPayoutMocks(asSenior, { simulateResponse: 'success' })
    const dialog = await openPayoutDialog(asSenior)

    // Contract address surfaced under «Адрес кошелька» label (not the old
    // «Адрес смарт-контракта (USDT ERC-20)» — that label change is part of
    // round 6's PR #56 UI cleanup).
    await expect(dialog.getByTestId('payout-detail-contract-address-label')).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-contract-address')).toContainText(STUB_CONTRACT)
    // Payable amount banner — 5000 * 0.74 = 3700
    await expect(dialog.getByTestId('payout-detail-payable')).toContainText(/3[,.]?700/)
    // Count line — SENIOR_INCOME-only, so «(1)» even though the payout
    // request also carries a PAYOUT placeholder row server-side.
    await expect(dialog.getByTestId('payout-detail-transactions-count')).toContainText(
      /Транзакции в выплате \(1\)/,
    )

    // Default radio = real → submit disabled even with no hash typed.
    const realRadio = dialog.getByTestId('payout-detail-dev-simulate-real').locator('input[type="radio"]')
    await expect(realRadio).toBeChecked()
    await expect(dialog.getByTestId('payout-detail-submit')).toBeDisabled()
  })

  test('B2: «Симулировать ошибку» enables submit, backend 400 surfaces inline + keeps dialog open', async ({
    asSenior,
  }) => {
    const { getPayCalls } = setupPayoutMocks(asSenior, { simulateResponse: 'error' })
    const dialog = await openPayoutDialog(asSenior)

    // Pick the error radio
    await dialog.getByTestId('payout-detail-dev-simulate-error').click()
    // hash optional in simulate mode → submit enables without typing anything
    const submitBtn = dialog.getByTestId('payout-detail-submit')
    await expect(submitBtn).not.toBeDisabled()
    await submitBtn.click()

    // Inline error message rendered under input. Toast text is rendered into
    // sonner's portal which lives outside the dialog — assert directly on
    // the page so we don't depend on Radix portal placement.
    await expect(asSenior.getByText('Симуляция: транзакция не подтверждена').first()).toBeVisible()
    // Dialog stays open so the user can switch mode and retry.
    await expect(dialog).toBeVisible()

    // Wire-format check — simulateResult travelled as 'error', and txHash
    // was omitted (input was empty → frontend strips it).
    const calls = getPayCalls()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toMatchObject({ simulateResult: 'error' })
    expect(calls[0]).not.toHaveProperty('txHash')
  })

  test('B3: «Симулировать успех» submits with simulateResult=success → dialog closes', async ({
    asSenior,
  }) => {
    const { getPayCalls } = setupPayoutMocks(asSenior, { simulateResponse: 'success' })
    const dialog = await openPayoutDialog(asSenior)

    await dialog.getByTestId('payout-detail-dev-simulate-success').click()
    const submitBtn = dialog.getByTestId('payout-detail-submit')
    await expect(submitBtn).not.toBeDisabled()
    await submitBtn.click()

    // Dialog closes after success cascade
    await expect(dialog).not.toBeVisible()

    const calls = getPayCalls()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toMatchObject({ simulateResult: 'success' })
  })

  test('B4: hash typed in simulate mode is forwarded', async ({ asSenior }) => {
    // Defensive: when the SENIOR does type a hash in simulate mode (because
    // they have one on hand and want it logged), the frontend must still
    // send it through. The optional behaviour only kicks in when the field
    // is empty.
    const { getPayCalls } = setupPayoutMocks(asSenior, { simulateResponse: 'success' })
    const dialog = await openPayoutDialog(asSenior)

    await dialog.getByTestId('payout-detail-dev-simulate-success').click()
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xabcdef1234567890')
    await dialog.getByTestId('payout-detail-submit').click()
    await expect(dialog).not.toBeVisible()

    const calls = getPayCalls()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toMatchObject({
      simulateResult: 'success',
      txHash: '0xabcdef1234567890',
    })
  })

  test('B5: «Реальная проверка» radio keeps submit disabled even with a valid hash (dev-only gate)', async ({
    asSenior,
  }) => {
    // Default radio is already 'real' but be explicit + type a long hash that
    // would normally satisfy the min(10) gate in prod. In dev real mode is
    // unavailable, so the gate must hold regardless of input.
    setupPayoutMocks(asSenior, { simulateResponse: 'success' })
    const dialog = await openPayoutDialog(asSenior)

    await dialog.getByTestId('payout-detail-dev-simulate-real').click()
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeefdeadbeef')
    await expect(dialog.getByTestId('payout-detail-submit')).toBeDisabled()
  })
})
