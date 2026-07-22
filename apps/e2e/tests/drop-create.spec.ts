/**
 * drop-create.spec.ts — Drop role - phase 1 (AC1).
 *
 * Verifies the ADMIN flow for creating a DROP user via the unified
 * UserDialog on `/users`. Picking the DROP role in the role select
 * swaps in the drop-share slider + mandatory drop-team section and the
 * submit hits `POST /api/users/drops`, which atomically provisions both
 * the DROP user and the paired drop-team (`type='DROP'`).
 *
 * UX fix (task-fix-drop-unify-dialog): the dedicated «Создать дропа»
 * button has been removed — there is now a single «Добавить» entry
 * point covering all roles including DROP.
 *
 * Mock-based (Playwright fixtures intercept `/api/users/drops`).
 */

import { test, expect, USERS } from './fixtures'

const VALID_USDT_WALLET = '0x' + '0'.repeat(40)

test.describe('Drop creation — AC1 (unified UserDialog)', () => {
  test('ADMIN sees a single «Добавить» button — no dedicated drop button', async ({
    asAdmin: page,
  }) => {
    await page.goto('/users')
    await expect(page.getByTestId('users-create-button')).toBeVisible()
    // UX fix: legacy «Создать дропа» button removed.
    await expect(page.getByTestId('users-create-drop-button')).toHaveCount(0)
  })

  test('non-ADMIN does not see the «Добавить» button (access denied page)', async ({
    asSenior: page,
  }) => {
    await page.goto('/users')
    // SENIOR lands on the access-denied notice — neither button surfaces.
    await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
    await expect(page.getByTestId('users-create-button')).toHaveCount(0)
  })

  test('DROP role is selectable in the role picker', async ({ asAdmin: page }) => {
    await page.goto('/users')
    await page.getByTestId('users-create-button').click()
    const dialog = page.getByTestId('user-dialog')
    await expect(dialog).toBeVisible()
    await page.getByTestId('user-dialog-role-trigger').click()
    await expect(page.getByRole('option', { name: 'Дроп' })).toBeVisible()
  })

  test('picking DROP reveals drop-share slider (default 5%) and the team section', async ({
    asAdmin: page,
  }) => {
    await page.goto('/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    // Finance section — share slider with the 5% default hint.
    await expect(dialog.getByText(/Доля дропа/i)).toBeVisible()
    await expect(dialog.getByText(/по умолчанию 5/i).first()).toBeVisible()

    // Drop team section — title visible (renamed «Команда» → «Команда дропа»).
    await expect(dialog.getByRole('heading', { name: /Команда дропа/i })).toBeVisible()

    // teamMode RadioGroup is SENIOR-only — drops always provision their own team.
    await expect(dialog.getByTestId('user-dialog-team-mode')).toHaveCount(0)
  })

  test('submits POST /users/drops with expected payload — DROP role, dropSharePercent', async ({
    asAdmin: page,
  }) => {
    await page.goto('/users')

    // Wait for the POST so we can assert the payload shape per AC1.
    const postReq = page.waitForRequest(
      (req) => req.url().includes('/api/users/drops') && req.method() === 'POST',
    )

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')

    await dialog.getByTestId('user-dialog-email').fill('drop-ac1@cheekycheese.dev')
    await dialog.getByTestId('user-dialog-name').fill('AC1 Drop User')

    // legalFullName is REQUIRED for CREATE-mode contract-eligible roles
    // (createDropSchema superRefine, fix/drop-legal-name-persist) — without
    // it form.handleSubmit() blocks before the mutation ever fires and
    // `postReq` below times out.
    await dialog.getByTestId('user-dialog-legal-full-name').fill('AC1 Legal Dropenko')

    // Slider — type a custom share via the number input. Falls back to
    // default 5 if the number input isn't surfaced.
    const sliderNumber = dialog.locator('input[type="number"]').first()
    if ((await sliderNumber.count()) > 0) {
      await sliderNumber.fill('7')
      await sliderNumber.blur()
    }

    // USDT wallet required by refineRequisitePresence (shared schema).
    // For DROP the default paymentMethod is whatever the form starts with
    // for JUNIOR (BANK_UAH_FOP) — switch to USDT first.
    await dialog.getByTestId('user-dialog-payment-method-USDT_ERC20').click()
    await dialog.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

    // HR + Accountant chips auto-select when fixtures expose a single user
    // per role — see UserDialog auto-select effect.

    // A3-3 (#119) turned CREATE mode into a 3-step wizard — step 1's button
    // is `wizard-next-btn` ("Далее"), which calls the same form.handleSubmit()
    // and (for DROP) fires the POST immediately, same as the old submit did.
    // `user-dialog-submit` only renders in EDIT mode (see UserDialog.tsx
    // `!isCreate` branch) — this pre-existing drift predates
    // fix/drop-legal-name-persist (see drop-share-slider.spec.ts for the same
    // fix applied earlier).
    await dialog.getByTestId('wizard-next-btn').click()

    const req = await postReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>

    expect(body).toMatchObject({
      email: 'drop-ac1@cheekycheese.dev',
      displayName: 'AC1 Drop User',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: VALID_USDT_WALLET,
      legalFullName: 'AC1 Legal Dropenko',
    })

    // hrIds + accountantId are required by createDropSchema. With single-HR
    // and single-accountant fixtures both fields are auto-populated.
    expect(Array.isArray(body.hrIds)).toBe(true)
    expect((body.hrIds as string[]).length).toBeGreaterThan(0)
    expect(body.hrIds as string[]).toContain(USERS.hr.id)
    expect(body.accountantId).toBe(USERS.accountant.id)

    expect(typeof body.dropSharePercent).toBe('number')
    expect(body.dropSharePercent as number).toBeGreaterThanOrEqual(0)
    expect(body.dropSharePercent as number).toBeLessThanOrEqual(100)
  })

  test('cancel closes the dialog without firing a POST', async ({ asAdmin: page }) => {
    await page.goto('/users')

    let postCalled = false
    page.on('request', (req) => {
      if (req.url().includes('/api/users/drops') && req.method() === 'POST') {
        postCalled = true
      }
    })

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(dialog).not.toBeVisible()
    expect(postCalled).toBe(false)
  })

  test('switching to Bank UAH (ФОП) reveals UA-IBAN + РНОКПП fields', async ({ asAdmin: page }) => {
    await page.goto('/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')

    // DROP is NOT USDT-only — switching method should expose the bank fields.
    await dialog.getByTestId('user-dialog-payment-method-BANK_UAH_FOP').click()
    await expect(dialog.getByPlaceholder(/UA0/i)).toBeVisible()
    await expect(dialog.getByPlaceholder(/1234567890/)).toBeVisible()
  })
})
