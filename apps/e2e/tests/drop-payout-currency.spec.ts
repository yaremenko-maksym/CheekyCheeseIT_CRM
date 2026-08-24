/**
 * drop-payout-currency.spec.ts — task-drop-payout-currency.
 *
 * «Выплатить дропу» (SettleSeniorPayoutDialog, DROP_PENDING_PAYOUT branch)
 * can now be settled in any of USDT/USD/UAH/EUR — the amount field stays
 * fully disabled (owner decision), only the currency is a real choice, and
 * the shown figure recalculates live via the server-authoritative NBU rate.
 *
 * AC coverage:
 *   AC1 — the amount input is disabled; the currency selector is enabled
 *         (real Radix interaction — driveable in a real browser, unlike the
 *         happy-dom unit tests in SettleSeniorPayoutDialog.test.tsx).
 *   AC2 — switching currency recalculates the shown amount; the obligation's
 *         own currency shows no conversion.
 *   AC3 (главный тест) — the amount SHOWN in the (disabled) input before
 *         submit matches, to the penny, the amount ACTUALLY recorded in the
 *         real database after settle.
 *   AC8 — adaptive at 320/375/768/1024/1440; no horizontal overflow, dialog
 *         stays usable and screenshotted at each width.
 *
 * Money invariants (RBAC, idempotency, company-balance gating) are already
 * covered by `drop-share-usdt-income.spec.ts` (real UI) and
 * `drop-payout-currency.integration.spec.ts` (real DB, unit-level) — this
 * spec proves the USER PATH: what the dialog shows is what gets written.
 */
import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  KOSTYA_ID,
  loginViaApi,
  createDropViaAPI,
  createDropProjectViaAPI,
  onboardDropViaAPI,
  declareUsdtIncomeViaAPI,
  listTransactionsByProjectViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

async function provisionDropPendingPayout(page: import('@playwright/test').Page): Promise<{
  projectId: string
  projectName: string
  dropPendingId: string
  dropShare: number
}> {
  const suffix = uniqueSuffix()
  const dropEmail = `dpc-drop-${suffix}@cheekycheese.dev`
  const projectName = `DPC Flow ${suffix}`

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `DPC Drop ${suffix}`,
  })
  await onboardDropViaAPI(page, { dropId, dropEmail })

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { projectId } = await createDropProjectViaAPI(page, {
    dropId,
    seniorEmail: SEED_EMAILS.seniorA,
    name: projectName,
    rate: 5000,
    currency: 'USDT',
    paymentType: 'USDT',
    seniorSharePercentOverride: 20,
    dropSharePercentOverride: 10,
  })

  // 1000 USDT income × 10% drop share = 100 USDT obligation — a clean,
  // easy-to-predict figure for the cross-currency math below.
  await declareUsdtIncomeViaAPI(page, {
    projectId,
    amount: 1000,
    receiverId: KOSTYA_ID,
  })

  const txs = await listTransactionsByProjectViaAPI(page, projectId)
  const dropPending = txs.find(
    (t) => t.type === 'DROP_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
  )
  if (!dropPending) throw new Error('DROP_PENDING_PAYOUT obligation was not booked')

  return {
    projectId,
    projectName,
    dropPendingId: dropPending.id,
    dropShare: parseFloat(dropPending.amount),
  }
}

test.describe('Выплатить дропу — currency picker (task-drop-payout-currency)', () => {
  test('AC1/AC2/AC3: amount disabled, currency switch recalculates, and the shown figure matches what gets recorded', async ({
    page,
  }) => {
    const { dropPendingId, dropShare } = await provisionDropPendingPayout(page)

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    const settleBtn = page.getByTestId(`tx-row-settle-senior-payout-${dropPendingId}`)
    await expect(settleBtn).toBeVisible()
    await settleBtn.click()

    const dialog = page.getByTestId('settle-senior-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Выплатить дропу')).toBeVisible()

    const amountField = dialog.getByTestId('settle-senior-amount-field')
    await expect(amountField).toBeVisible()
    const amountInput = amountField.getByTestId('amount-currency-amount-input')

    // AC1: amount input disabled; default «Счёт компании» → currency locked too.
    await expect(amountInput).toBeDisabled()
    await expect(amountInput).toHaveValue(dropShare.toFixed(2))
    const currencySelect = amountField.getByRole('combobox')
    await expect(currencySelect).toBeDisabled()

    // Switch funding to an ADMIN partner — unlocks the currency selector.
    // (No cascade-origin guard here: this obligation was booked by
    // declareUsdtProjectIncome, dropCascadeOrigin=false.)
    await dialog.getByTestId(`settle-senior-account-admin-${KOSTYA_ID}`).click()
    await expect(currencySelect).toBeEnabled()
    // AC2 (default, no conversion yet): still the obligation's own currency.
    await expect(amountInput).toHaveValue(dropShare.toFixed(2))

    // AC1/AC2: switch currency via the REAL Radix Select (driveable in a real
    // browser — the happy-dom unit tests deliberately avoid this and use the
    // «Счёт компании» USDT-force trick instead; see
    // SettleSeniorPayoutDialog.test.tsx).
    await currencySelect.click()
    await page.getByRole('option', { name: 'UAH', exact: true }).click()

    // AC2: recalculates live — no longer the obligation's own USDT figure.
    //
    // task-nbu-rate-race-drop-payout: this used to PREDICT the figure with a
    // second, unscoped `GET /api/finance/exchange-rate` call (no `date=`
    // param, so the server resolved it against `kyivToday()` at THAT
    // request's own wall-clock moment — see nbu-currency.service.ts
    // `todayStr()`). The dialog's own preview query is anchored to the
    // obligation's `txDate`, not to "now" — two independent "what day is it"
    // resolutions of the SAME logical rate. They agree except across the
    // Kyiv midnight boundary, where the day rolls over and NBU's rate for
    // the new day takes effect (nbu-currency.service.ts's `MAX_CACHED_RATE_
    // AGE_DAYS` block documents that a rate literally changes value at that
    // instant) — which is exactly the CI failure this replaces (predicted
    // next-day rate vs. the dialog's still-current-day figure).
    //
    // AC3 is "shown == recorded", not "shown == a rate we independently
    // guessed" — so wait for the ACTUAL recalculation (value changes away
    // from the pre-switch USDT figure, and away from empty — `expectedAmount`
    // renders '' while the rate query is loading) and read what the dialog
    // renders. That reading is then the one and only source of truth for the
    // post-submit comparison below — no second network call to race against.
    await expect(amountInput).not.toHaveValue('', { timeout: 10_000 })
    await expect(amountInput).not.toHaveValue(dropShare.toFixed(2), { timeout: 10_000 })
    const shownUah = parseFloat(await amountInput.inputValue())
    expect(shownUah, 'converted UAH figure must be a real positive number').toBeGreaterThan(0)

    // Non-USDT currency → the receipt is no longer explorer-only (a file/url
    // tab toggle appears); fill via the url tab.
    await dialog.getByTestId('receipt-input-mode-url').click()
    await dialog
      .getByTestId('receipt-input-url-field')
      .fill('https://drive.google.com/file/dropcurrencyspec')

    const settleRes = page.waitForResponse(
      (r) => r.url().includes('/settle-company') && r.request().method() === 'POST',
    )
    await dialog.getByTestId('settle-senior-submit').click()
    const res = await settleRes
    expect(res.status()).toBeLessThan(300)
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText('Выплата дропу проведена')).toBeVisible({ timeout: 10_000 })

    // AC3 (главный тест): the figure SHOWN before submit (shownUah) must
    // equal the figure ACTUALLY recorded — to the penny.
    const body = (await res.json()) as {
      created: Array<{
        id: string
        currency: string
        amount: string
        originalAmount: string | null
        originalCurrency: string | null
        exchangeRate: string | null
      }>
    }
    const recorded = body.created.find((c) => c.id === dropPendingId)
    expect(recorded, 'the flipped PAYOUT_DROP row must be returned by settle-company').toBeTruthy()
    expect(recorded!.currency).toBe('UAH')
    expect(parseFloat(recorded!.amount)).toBeCloseTo(shownUah, 2)
    // AC4: obligation snapshot stamped.
    expect(recorded!.originalCurrency).toBe('USDT')
    expect(parseFloat(recorded!.originalAmount!)).toBeCloseTo(dropShare, 6)
    expect(recorded!.exchangeRate).not.toBeNull()
  })

  // owner addendum (2026-08): the date picker defaults to the obligation's
  // own creation date — for a freshly-provisioned obligation (this run) that
  // IS today, so the default (untouched) path records today's date as
  // `txDate`. The exact-date-selection numerics (two DIFFERENT dates
  // applying two DIFFERENT known rates, and `txDate` reflecting whichever
  // was selected) are proven deterministically at the unit level
  // (`pending-settlement.drop-currency.spec.ts` — the owner's own "главный
  // тест" for this part) and the real-DB integration level
  // (`drop-payout-currency.integration.spec.ts`); this spec proves the
  // real-browser rendering + the end-to-end default path through the real
  // backend/DB — deliberately NOT driving react-day-picker's calendar-day
  // grid here (no precedent in this suite for a robust, non-flaky selector
  // for that interaction; see the extended note in the PR).
  test('date picker: renders with today as the default (fresh obligation), and the default path records txDate = today', async ({
    page,
  }) => {
    const { dropPendingId } = await provisionDropPendingPayout(page)

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    const settleBtn = page.getByTestId(`tx-row-settle-senior-payout-${dropPendingId}`)
    await expect(settleBtn).toBeVisible()
    await settleBtn.click()

    const dialog = page.getByTestId('settle-senior-dialog')
    await expect(dialog).toBeVisible()

    const datePicker = dialog.getByTestId('settle-senior-txdate')
    await expect(datePicker).toBeVisible()
    const todayStr = new Date().toISOString().slice(0, 10)
    // dd MMM yyyy (ru locale) — see DatePickerField's `format(selected, 'dd MMM yyyy', {locale: ru})`.
    const [, month, day] = todayStr.split('-')
    await expect(datePicker).toContainText(day!)
    void month // month is locale-formatted (e.g. "серп") — day/year are the stable, unambiguous check.

    // ADMIN_PERSONAL funding — sidesteps the company-account balance gate
    // (unrelated to this test, which only exercises the date default).
    // Currency stays USDT (the obligation's own — switching funding source
    // alone does not touch it), so the receipt stays explorer-only.
    await dialog.getByTestId(`settle-senior-account-admin-${KOSTYA_ID}`).click()
    await dialog
      .getByTestId('receipt-input-url-field')
      .fill('https://etherscan.io/tx/0xdropcurrencydate')

    const settleRes = page.waitForResponse(
      (r) => r.url().includes('/settle-company') && r.request().method() === 'POST',
    )
    await dialog.getByTestId('settle-senior-submit').click()
    const res = await settleRes
    expect(res.status()).toBeLessThan(300)

    const body = (await res.json()) as {
      created: Array<{ id: string; txDate: string | null }>
    }
    const recorded = body.created.find((c) => c.id === dropPendingId)
    expect(recorded).toBeTruthy()
    expect(recorded!.txDate).toBeTruthy()
    expect(recorded!.txDate!.slice(0, 10)).toBe(todayStr)
  })

  test('AC8: adaptive at 320/375/768/1024/1440 — dialog stays usable, no horizontal overflow', async ({
    page,
  }) => {
    const { dropPendingId } = await provisionDropPendingPayout(page)

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    const settleBtn = page.getByTestId(`tx-row-settle-senior-payout-${dropPendingId}`)
    await expect(settleBtn).toBeVisible()
    await settleBtn.click()

    const dialog = page.getByTestId('settle-senior-dialog')
    await expect(dialog).toBeVisible()
    const amountField = dialog.getByTestId('settle-senior-amount-field')
    await expect(amountField).toBeVisible()

    // owner addendum review round (design-fidelity-review.md gate): the
    // BUSIEST state is what actually needs a visual check — an untouched
    // dialog never exercises the currency Select or the date-picker
    // popover, exactly the two surfaces most likely to overflow/collide at
    // 320px. Switch to an ADMIN partner (unlocks the currency Select) and a
    // real conversion currency ONCE, before the width loop, so every
    // screenshot below shows the dialog in that state.
    await dialog.getByTestId(`settle-senior-account-admin-${KOSTYA_ID}`).click()
    const currencySelect = amountField.getByRole('combobox')
    await expect(currencySelect).toBeEnabled()
    await currencySelect.click()
    await page.getByRole('option', { name: 'UAH', exact: true }).click()

    const debugDir = process.env['DEBUG_SCREENSHOT_DIR'] ?? '/tmp/drop-payout-currency-e2e'
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(dialog).toBeVisible()
      await expect(amountField.getByTestId('amount-currency-amount-input')).toBeVisible()
      const hasOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )
      expect(hasOverflow, `horizontal overflow at ${width}px`).toBe(false)
      await page.screenshot({ path: `${debugDir}/settle-drop-${width}.png` })

      // The date-picker calendar POPOVER is the other surface a reviewer
      // asked to see — it collides with the viewport edge more than
      // anything else at 320px. Open it, screenshot with it visible, close
      // it again so the width loop's own overflow check above (dialog
      // closed) stays representative of the steady state.
      const datePickerBtn = dialog.getByTestId('settle-senior-txdate')
      await datePickerBtn.click()
      const calendar = page.getByRole('dialog').filter({ has: page.locator('.rdp-root') })
      await expect(calendar).toBeVisible()
      // The popover's own entrance transition (fade-in + zoom-in, ~200ms —
      // see popover.tsx's `data-[state=open]:animate-in` classes) is still
      // finishing when `toBeVisible()` resolves (that assertion only checks
      // CSS visibility, not "transition settled"). A screenshot taken mid-
      // transition — right after a viewport resize, when floating-ui is
      // ALSO still recomputing the anchor position for the new width — can
      // catch a transient, wrongly-scaled/positioned frame that never
      // matches what an operator actually sees. Let it settle first.
      await page.waitForTimeout(300)
      const calendarOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )
      expect(calendarOverflow, `calendar popover causes horizontal overflow at ${width}px`).toBe(
        false,
      )
      await page.screenshot({ path: `${debugDir}/settle-drop-${width}-calendar-open.png` })
      await page.keyboard.press('Escape')
      await expect(calendar).not.toBeVisible()
    }
  })
})
