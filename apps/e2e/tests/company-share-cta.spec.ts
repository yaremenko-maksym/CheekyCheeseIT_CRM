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

  test('closing on step 2 keeps the created payout: it reappears as a PENDING_PAYMENT row with «Оплатить» (AC4)', async ({
    asSenior,
  }) => {
    // Stateful mock: /transactions reflects the SAME server-side effect the
    // real backend performs on createPayoutRequest — the income flips to
    // PENDING_PAYMENT + payoutRequestId, and a new PAYOUT row appears. This
    // proves the row genuinely "survives" the close, not just that no extra
    // network call fired.
    let rows: object[] = [OUTSTANDING_INCOME]
    await asSenior.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }),
    )
    await asSenior.route(new RegExp(`${API}/payout-requests$`), (r) => {
      if (r.request().method() === 'POST') {
        rows = [
          { ...OUTSTANDING_INCOME, status: 'PENDING_PAYMENT', payoutRequestId: CREATED_PAYOUT.id },
          {
            id: 'cta-payout-row-1',
            type: 'PAYOUT',
            status: 'PENDING_PAYMENT',
            amount: CREATED_PAYOUT.payableAmount,
            currency: 'USDT',
            senderId: USERS.senior.id,
            senderName: USERS.senior.displayName,
            senderLabel: null,
            receiverId: null,
            receiverName: null,
            receiverLabel: 'CheekyCheeseIT',
            seniorSharePercent: null,
            dropSharePercent: null,
            projectId: PROJECT.id,
            projectName: PROJECT.name,
            receiptDocumentId: null,
            receiptExternalUrl: null,
            notes: null,
            salaryMonth: null,
            txDate: null,
            txHash: null,
            rejectionReason: null,
            payoutRequestId: CREATED_PAYOUT.id,
            validatedBy: null,
            validatedAt: null,
            createdBy: USERS.senior.id,
            createdAt: '2026-07-27T00:00:00.000Z',
            updatedAt: '2026-07-27T00:00:00.000Z',
          },
        ]
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(CREATED_PAYOUT),
        })
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await asSenior.route(new RegExp(`${API}/payout-requests/${CREATED_PAYOUT.id}$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CREATED_PAYOUT),
      }),
    )

    await asSenior.goto('/finance')
    await asSenior.getByTestId('company-share-cta-strip').click()
    await asSenior.getByTestId('company-share-create-payout').click()
    await expect(asSenior.getByTestId('payout-detail-payable')).toBeVisible()

    await asSenior.getByTestId('company-share-close-step2').click()
    await expect(asSenior.getByTestId('company-share-payout-modal')).not.toBeVisible()

    // The created payout is visible in the table as PENDING_PAYMENT with an
    // «Оплатить» pill — nothing was lost by closing mid-flow.
    await expect(asSenior.getByTestId(`row-pay-payout-cta-payout-row-1`)).toBeVisible()
    await expect(asSenior.getByTestId(`row-pay-payout-cta-payout-row-1`)).toContainText('Оплатить')
  })

  test('a second click while creation is in flight does not create two payout requests (AC5)', async ({
    asSenior,
  }) => {
    await mockTransactions(asSenior, [OUTSTANDING_INCOME])
    let createCalls = 0
    // The POST handler blocks on this gate so the create mutation stays in
    // flight while we assert the button is disabled below.
    //
    // The gate is built up front rather than by capturing `resolve` from inside
    // the handler (task-lint-teeth). The old shape declared
    // `let resolveCreate: (() => void) | null = null` and assigned it inside the
    // route callback, which TS cannot see: at the call site the variable was
    // still narrowed to `null`, so `resolveCreate?.()` was TS2349 "not callable"
    // — and, worse, an optional call on a value the compiler believed was always
    // null. Had the route never fired, that line would have silently done
    // nothing instead of failing. Definite-assignment (`!`) is accurate here:
    // a Promise executor runs synchronously, so `releaseCreate` is assigned
    // before the next statement.
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    await asSenior.route(new RegExp(`${API}/payout-requests$`), async (r) => {
      if (r.request().method() === 'POST') {
        createCalls += 1
        await createGate
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(CREATED_PAYOUT),
        })
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await asSenior.route(new RegExp(`${API}/payout-requests/${CREATED_PAYOUT.id}$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CREATED_PAYOUT),
      }),
    )

    await asSenior.goto('/finance')
    await asSenior.getByTestId('company-share-cta-strip').click()
    const submit = asSenior.getByTestId('company-share-create-payout')
    await submit.click()
    // A native disabled <button> does not dispatch click events at all — the
    // guard IS the disabled state, so asserting it (while the mutation is
    // still in flight, before resolveCreate below) proves a second click
    // physically cannot reach the handler.
    await expect(submit).toBeDisabled()

    releaseCreate()
    await expect(asSenior.getByTestId('payout-detail-payable')).toBeVisible()
    expect(createCalls).toBe(1)
  })

  // fidelity-review finding #3 (LOW, unconfirmed): the auditor saw the modal
  // vanish once on a first pass through create->step2 with zero interaction,
  // could not reproduce it in two follow-up clean attempts, and suspected a
  // tooling artifact rather than a product bug — but flagged it as worth a
  // defensive regression given "the modal must not close after submit" is
  // the single highest-stakes owner requirement. This pins that: idle on
  // step 2 for several seconds with NO interaction must NOT auto-close.
  // `CONFIRMED_AUTOCLOSE_MS` (1.5s) is gated behind an actual `payMutation`
  // success, not a bare timer — this test proves that gate holds under idle.
  test('step 2 does not auto-close while idle (no payMutation triggered) — regression for fidelity finding #3', async ({
    asSenior,
  }) => {
    await mockTransactions(asSenior, [OUTSTANDING_INCOME])
    await mockPayoutRequests(asSenior)

    await asSenior.goto('/finance')
    await asSenior.getByTestId('company-share-cta-strip').click()
    await asSenior.getByTestId('company-share-create-payout').click()
    await expect(asSenior.getByTestId('payout-detail-payable')).toBeVisible()

    // CONFIRMED_AUTOCLOSE_MS is 1.5s — wait comfortably past it, doing
    // nothing, and confirm the modal is still there.
    await asSenior.waitForTimeout(3000)
    await expect(asSenior.getByTestId('company-share-payout-modal')).toBeVisible()
    await expect(asSenior.getByTestId('payout-detail-payable')).toBeVisible()
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

  // fidelity-review finding #1 (HIGH, fix-before-merge): reproduces the
  // exact reported bug — a bare <fieldset> gets browser-default
  // `min-width: min-content`, which balloons to the widest UNWRAPPED row
  // the moment ANY project name in the list is long, hiding EVERY project's
  // amount (not just the long-named one). Content-length-driven, not
  // viewport-driven — the auditor confirmed it reproduced identically at
  // 320 and 1440, so both are asserted here (not just mobile).
  for (const width of [320, 1440]) {
    test(`long project name does not push other projects' amounts off-screen at ${width}px (fidelity finding #1)`, async ({
      asSenior,
    }) => {
      const LONG_NAME = 'International Recruitment Platform for EdTech Companies Worldwide'
      const SHORT_NAME = 'AI Platform v2'
      const longNameIncome = {
        ...OUTSTANDING_INCOME,
        id: 'cta-income-long',
        projectId: 'project-long-name-id',
        projectName: LONG_NAME,
      }
      const shortNameIncome = {
        ...OUTSTANDING_INCOME,
        id: 'cta-income-short',
        projectId: 'project-short-name-id',
        projectName: SHORT_NAME,
      }

      await asSenior.setViewportSize({ width, height: 900 })
      await mockTransactions(asSenior, [longNameIncome, shortNameIncome])
      await mockPayoutRequests(asSenior)
      await asSenior.goto('/finance')
      await asSenior.getByTestId('company-share-cta-strip').click()
      await expect(asSenior.getByTestId('company-share-payout-modal')).toBeVisible()
      // Let Radix's open transform/zoom animation settle before measuring
      // bounding boxes below — mid-transition `getBoundingClientRect()`
      // reports the scaled-down transient rect, which is a false positive
      // for an overflow check, not a real layout issue.
      await asSenior.waitForTimeout(300)

      // Both project rows' checkboxes are present...
      const longCheckbox = asSenior.getByTestId(
        'company-share-project-checkbox-project-long-name-id',
      )
      const shortCheckbox = asSenior.getByTestId(
        'company-share-project-checkbox-project-short-name-id',
      )
      await expect(longCheckbox).toBeVisible()
      await expect(shortCheckbox).toBeVisible()

      // ...and — the actual regression — BOTH rows' amount figures must
      // still be on-screen and within the dialog's own width, not clipped
      // off to the right by an oversized <fieldset>.
      const dialogBox = await asSenior.getByTestId('company-share-payout-modal').boundingBox()
      const longAmount = longCheckbox.locator('..').getByText(/USDT/)
      const shortAmount = shortCheckbox.locator('..').getByText(/USDT/)
      await expect(longAmount).toBeVisible()
      await expect(shortAmount).toBeVisible()
      const longAmountBox = await longAmount.boundingBox()
      const shortAmountBox = await shortAmount.boundingBox()
      expect(dialogBox).toBeTruthy()
      expect(longAmountBox).toBeTruthy()
      expect(shortAmountBox).toBeTruthy()
      // Amount's right edge must be within the dialog's right edge — if the
      // fieldset ballooned, this would fail (amount pushed far past it).
      expect(longAmountBox!.x + longAmountBox!.width).toBeLessThanOrEqual(
        dialogBox!.x + dialogBox!.width + 1,
      )
      expect(shortAmountBox!.x + shortAmountBox!.width).toBeLessThanOrEqual(
        dialogBox!.x + dialogBox!.width + 1,
      )
      // No page-level horizontal overflow either.
      const overflow = await asSenior.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )
      expect(overflow, `long-name row causes horizontal overflow at ${width}px`).toBe(false)
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
