/**
 * company-share-cta.spec.ts — task-company-share-cta.
 *
 * E2E coverage for the CTA strip + two-step payout modal, on top of
 * `mockAuthAs` (auth/notifications/settlements baseline). Mocks `/transactions`
 * and `/payout-requests` locally, mirroring the pattern already used by
 * `finance.spec.ts` / `finance-senior-payment-flow.spec.ts`.
 *
 * AC coverage:
 *   - AC1: banner appears only when there's outstanding validated income;
 *     shows the correct project count + PAYABLE (not gross) amount.
 *   - AC3: after a successful create, the modal does NOT close — it switches
 *     to the step-2 payment form (same mounted dialog).
 *   - AC4: closing on step 2 does not fire any rollback/cancel call.
 *   - AC6: the old dialog is gone — no "Выбрать транзакции для выплаты" title
 *     anywhere in this flow.
 *   - AC7: no horizontal overflow / touch targets ≥44px on mobile (320-375),
 *     tablet (768), laptop (1024-1280), large (1440-1920).
 *   - A11y: focus moves into the step-2 container after the transition.
 */
import { test, expect } from './fixtures'
import { USERS, PROJECTS } from './fixtures'

const PROJECT = PROJECTS[0]!
const API = '\\/api'

const OUTSTANDING_INCOME = {
  id: 'cta-income-1',
  type: 'SENIOR_INCOME',
  status: 'VALIDATED',
  amount: '1000.00',
  currency: 'USDT',
  senderId: null,
  senderName: null,
  senderLabel: 'Client Co',
  receiverId: USERS.senior.id,
  receiverName: USERS.senior.displayName,
  receiverLabel: null,
  seniorSharePercent: 26,
  seniorSharePercentSource: 'USER_DEFAULT',
  dropSharePercent: null,
  dropSharePercentSource: null,
  projectId: PROJECT.id,
  projectName: PROJECT.name,
  receiptDocumentId: null,
  receiptExternalUrl: null,
  notes: null,
  salaryMonth: null,
  txDate: '2026-07-01T00:00:00.000Z',
  txHash: null,
  rejectionReason: null,
  payoutRequestId: null,
  validatedBy: 'accountant-id',
  validatedAt: '2026-07-01T00:00:00.000Z',
  createdBy: USERS.senior.id,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

const CREATED_PAYOUT = {
  id: 'cta-payout-1',
  seniorId: USERS.senior.id,
  seniorName: USERS.senior.displayName,
  incomeAmount: '1000.00',
  payableAmount: '740.00',
  contractAddress: '0xCompanyWallet0000000000000000000000aaaa',
  txHash: null,
  status: 'PENDING',
  transactions: [OUTSTANDING_INCOME],
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
}

async function mockTransactions(page: import('@playwright/test').Page, rows: object[]) {
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }),
  )
}

async function mockPayoutRequests(page: import('@playwright/test').Page) {
  await page.route(new RegExp(`${API}/payout-requests$`), (r) => {
    if (r.request().method() === 'POST') {
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(CREATED_PAYOUT),
      })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
  await page.route(new RegExp(`${API}/payout-requests/${CREATED_PAYOUT.id}$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CREATED_PAYOUT),
    }),
  )
}

test.describe('Company-share payout CTA — banner (AC1)', () => {
  test('shows the strip with correct project count + PAYABLE amount when there is outstanding validated income', async ({
    asSenior,
  }) => {
    await mockTransactions(asSenior, [OUTSTANDING_INCOME])
    await mockPayoutRequests(asSenior)
    await asSenior.goto('/finance')

    const strip = asSenior.getByTestId('company-share-cta-strip')
    await expect(strip).toBeVisible()
    await expect(strip).toContainText('1') // 1 project
    // Payable = 1000 * (1 - 0.26) = 740 — the gross 1000 must NOT be the
    // headline figure (this is the single highest-cost-of-error regression
    // in the whole feature).
    const amount = asSenior.getByTestId('company-share-cta-amount')
    await expect(amount).toContainText('740')
    await expect(amount).not.toContainText('1 000,00')
  })

  test('does NOT render when there is no outstanding validated income', async ({ asSenior }) => {
    await mockTransactions(asSenior, [])
    await mockPayoutRequests(asSenior)
    await asSenior.goto('/finance')
    await expect(asSenior.getByTestId('finance-page')).toBeVisible()
    await expect(asSenior.getByTestId('company-share-cta-strip')).not.toBeVisible()
  })

  test('does NOT render for income already attached to a payout request', async ({ asSenior }) => {
    await mockTransactions(asSenior, [
      { ...OUTSTANDING_INCOME, status: 'PENDING_PAYMENT', payoutRequestId: 'already-in-payout' },
    ])
    await mockPayoutRequests(asSenior)
    await asSenior.goto('/finance')
    await expect(asSenior.getByTestId('company-share-cta-strip')).not.toBeVisible()
  })
})

test.describe('Company-share payout modal — two-step flow (AC3/AC4/AC6)', () => {
  test('clicking the strip opens the modal on step 1, create switches to step 2 WITHOUT closing', async ({
    asSenior,
  }) => {
    await mockTransactions(asSenior, [OUTSTANDING_INCOME])
    await mockPayoutRequests(asSenior)
    await asSenior.goto('/finance')

    await asSenior.getByTestId('company-share-cta-strip').click()
    const modal = asSenior.getByTestId('company-share-payout-modal')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('Оплата доли CheekyCheeseIT')

    // AC6: the old dialog's title is gone from this flow.
    await expect(asSenior.getByText('Выбрать транзакции для выплаты')).toHaveCount(0)

    // Default selection is "everything" (design spec §6.6) — submit is enabled.
    const submit = asSenior.getByTestId('company-share-create-payout')
    await expect(submit).toBeEnabled()
    await submit.click()

    // Step 2 — SAME dialog, still visible, now showing the payment form.
    await expect(modal).toBeVisible()
    await expect(asSenior.getByTestId('payout-detail-payable')).toBeVisible()
    await expect(asSenior.getByTestId('company-share-created-notice')).toContainText(
      'Заявка создана',
    )
    await expect(modal).toContainText('Заявка на выплату')
  })

  test('a11y: focus moves into the step-2 content after the transition', async ({ asSenior }) => {
    await mockTransactions(asSenior, [OUTSTANDING_INCOME])
    await mockPayoutRequests(asSenior)
    await asSenior.goto('/finance')

    await asSenior.getByTestId('company-share-cta-strip').click()
    await asSenior.getByTestId('company-share-create-payout').click()
    await expect(asSenior.getByTestId('company-share-step2-content')).toBeVisible()

    await expect(async () => {
      const focused = await asSenior.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? null,
      )
      expect(focused).toBe('company-share-step2-content')
    }).toPass({ timeout: 3000 })
  })

  test('closing on step 2 does not fire a second create / any delete-shaped call (AC4)', async ({
    asSenior,
  }) => {
    await mockTransactions(asSenior, [OUTSTANDING_INCOME])
    await mockPayoutRequests(asSenior)

    const requestLog: { method: string; url: string }[] = []
    asSenior.on('request', (req) => {
      if (req.url().includes('/payout-requests')) {
        requestLog.push({ method: req.method(), url: req.url() })
      }
    })

    await asSenior.goto('/finance')
    await asSenior.getByTestId('company-share-cta-strip').click()
    await asSenior.getByTestId('company-share-create-payout').click()
    await expect(asSenior.getByTestId('payout-detail-payable')).toBeVisible()

    requestLog.length = 0
    await asSenior.getByTestId('company-share-close-step2').click()
    await expect(asSenior.getByTestId('company-share-payout-modal')).not.toBeVisible()

    expect(requestLog.some((r) => r.method === 'DELETE')).toBe(false)
    expect(requestLog.some((r) => r.method === 'POST')).toBe(false)
  })
})

test.describe('Company-share payout modal — responsive (AC7)', () => {
  for (const width of [320, 375, 768, 1024, 1280, 1440, 1920]) {
    test(`no horizontal overflow at ${width}px (banner + modal step 1)`, async ({ asSenior }) => {
      await asSenior.setViewportSize({ width, height: 900 })
      await mockTransactions(asSenior, [OUTSTANDING_INCOME])
      await mockPayoutRequests(asSenior)
      await asSenior.goto('/finance')

      await expect(asSenior.getByTestId('company-share-cta-strip')).toBeVisible()
      const bannerOverflow = await asSenior.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )
      expect(bannerOverflow, `banner causes horizontal overflow at ${width}px`).toBe(false)

      await asSenior.getByTestId('company-share-cta-strip').click()
      await expect(asSenior.getByTestId('company-share-payout-modal')).toBeVisible()
      const modalOverflow = await asSenior.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )
      expect(modalOverflow, `modal causes horizontal overflow at ${width}px`).toBe(false)
    })
  }

  test('mobile (375px): checkbox rows and footer buttons meet the 44px touch-target minimum', async ({
    asSenior,
  }) => {
    await asSenior.setViewportSize({ width: 375, height: 800 })
    await mockTransactions(asSenior, [OUTSTANDING_INCOME])
    await mockPayoutRequests(asSenior)
    await asSenior.goto('/finance')
    await asSenior.getByTestId('company-share-cta-strip').click()

    // Read the authoritative CSS box (min-height/height), not
    // getBoundingClientRect — subpixel layout rounding can report e.g.
    // 43.96px for an element whose CSS is genuinely `min-height: 44px`,
    // which is not a real touch-target regression.
    const createBtn = asSenior.getByTestId('company-share-create-payout')
    const createBtnHeight = await createBtn.evaluate((el) =>
      parseFloat(getComputedStyle(el).minHeight || getComputedStyle(el).height),
    )
    expect(createBtnHeight).toBeGreaterThanOrEqual(43.5)

    const incomeCheckboxRow = asSenior
      .getByTestId(`company-share-income-checkbox-${OUTSTANDING_INCOME.id}`)
      .locator('..')
    const rowHeight = await incomeCheckboxRow.evaluate((el) =>
      parseFloat(getComputedStyle(el).minHeight || getComputedStyle(el).height),
    )
    expect(rowHeight).toBeGreaterThanOrEqual(43.5)
  })
})
