/**
 * requisites-warning.spec.ts
 *
 * Tests for the RequisitesEditForm on /crm/profile?tab=requisites.
 *
 * Key behavior:
 * - JUNIOR/HR can choose between USDT ERC-20 and Банк UAH (ФОП)
 * - SENIOR/ADMIN are forced to USDT ERC-20 (radio not shown)
 * - Submitting valid data opens a confirmation AlertDialog
 * - Confirming fires PATCH /users/me/requisites → "Реквизиты обновлены" toast
 * - Cancelling the AlertDialog sends no PATCH
 *
 * RequisitesTab wraps RequisitesEditForm in self-mode; the form is only
 * rendered when permissions.tabs includes 'requisites'. buildSelfView() for
 * JUNIOR includes 'requisites' in the tabs array.
 */

import { test, expect, USERS, mockAuthAs, buildSelfView } from './fixtures'

const API = 'http://localhost:3001/api'

// Junior seed user fixture — has BANK_UAH_FOP fields pre-filled in buildSelfView
const TARGET_IBAN = 'UA213223130000026007233566001'
const TARGET_RNOKPP = '1234567890'

test.describe('Requisites edit form', () => {
  // -------------------------------------------------------------------------
  // Tab visibility
  // -------------------------------------------------------------------------

  test('Реквизиты tab visible for JUNIOR in self view', async ({ asJunior: page }) => {
    await page.goto('/crm/profile')
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Реквизиты' })).toBeVisible()
  })

  test('Реквизиты tab NOT visible for HR in self view (tabs from buildSelfView)', async ({ asHr: page }) => {
    // HR self-view tabs: overview, projects, team (no requisites per buildSelfView)
    await page.goto('/crm/profile')
    await expect(page.getByText('HR Manager')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Реквизиты' })).toHaveCount(0)
  })

  // -------------------------------------------------------------------------
  // Form structure
  // -------------------------------------------------------------------------

  test('JUNIOR sees payment method radio group (can choose USDT or Bank)', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Реквизиты' })).toHaveAttribute('data-state', 'active')
    // RadioGroup with two options
    await expect(page.getByLabel('USDT ERC-20')).toBeVisible()
    await expect(page.getByLabel('Банк UAH (ФОП)')).toBeVisible()
  })

  test('SENIOR does NOT see payment method radio group (USDT only)', async ({ page }) => {
    // Override GET /users/me for senior to include requisites tab
    await mockAuthAs(page, USERS.senior)
    await page.route(`${API}/users/me`, (r) => {
      if (r.request().method() === 'PATCH') return r.fulfill({ status: 200, body: '{}' })
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...buildSelfView(USERS.senior),
          permissions: {
            tabs: ['overview', 'projects', 'team', 'interviews', 'requisites'],
            actions: [],
            fields: {},
          },
        }),
      })
    })
    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByText('Senior Dev')).toBeVisible()
    // No RadioGroup — USDT only for SENIOR
    await expect(page.getByLabel('Банк UAH (ФОП)')).toHaveCount(0)
    // USDT wallet input is visible
    await expect(page.getByLabel('USDT ERC-20 кошелёк')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Confirmation dialog — Bank UAH flow
  // -------------------------------------------------------------------------

  test('submitting valid Bank UAH data opens confirmation AlertDialog', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByText('Junior Dev')).toBeVisible()

    // Select Bank UAH method
    await page.getByLabel('Банк UAH (ФОП)').check()

    // Fill required fields
    await page.getByLabel('ФИО получателя').fill('Тест Тестенко')
    await page.getByLabel('IBAN (UA…)').fill('UA213223130000026007233566001')
    await page.getByLabel('РНОКПП (10 цифр)').fill('1234567890')

    await page.getByRole('button', { name: 'Сохранить реквизиты' }).click()

    // AlertDialog appears with the confirmation text
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await expect(page.getByText('На основе этих данных будут производиться следующие выплаты')).toBeVisible()
  })

  test('confirming AlertDialog sends PATCH /users/me/requisites and shows toast', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)

    const patchReq = page.waitForRequest(
      (req) => req.url().includes('/users/me/requisites') && req.method() === 'PATCH',
      { timeout: 5000 },
    )

    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByText('Junior Dev')).toBeVisible()

    await page.getByLabel('Банк UAH (ФОП)').check()
    await page.getByLabel('ФИО получателя').fill('Тест Тестенко')
    await page.getByLabel('IBAN (UA…)').fill(TARGET_IBAN)
    await page.getByLabel('РНОКПП (10 цифр)').fill(TARGET_RNOKPP)

    await page.getByRole('button', { name: 'Сохранить реквизиты' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()

    // Click the confirm action button in the AlertDialog
    await page.getByRole('button', { name: 'Подтвердить' }).click()

    const req = await patchReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body.paymentMethod).toBe('BANK_UAH_FOP')
    expect(body.bankUahIban).toBe(TARGET_IBAN)
    expect(body.bankUahRnokpp).toBe(TARGET_RNOKPP)

    await expect(page.getByText('Реквизиты обновлены')).toBeVisible()
  })

  test('cancelling AlertDialog sends no PATCH', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)

    let patched = false
    page.on('request', (req) => {
      if (req.url().includes('/users/me/requisites') && req.method() === 'PATCH') patched = true
    })

    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByText('Junior Dev')).toBeVisible()

    await page.getByLabel('Банк UAH (ФОП)').check()
    await page.getByLabel('ФИО получателя').fill('Тест Тестенко')
    await page.getByLabel('IBAN (UA…)').fill(TARGET_IBAN)
    await page.getByLabel('РНОКПП (10 цифр)').fill(TARGET_RNOKPP)

    await page.getByRole('button', { name: 'Сохранить реквизиты' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()

    // Cancel — no PATCH should fire
    await page.getByRole('button', { name: 'Отмена' }).click()
    await expect(page.getByRole('alertdialog')).not.toBeVisible()
    expect(patched).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  test('submitting USDT method with empty wallet shows validation error', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByText('Junior Dev')).toBeVisible()

    // USDT_ERC20 is the default; leave wallet empty
    await page.getByLabel('USDT ERC-20 кошелёк').clear()
    await page.getByRole('button', { name: 'Сохранить реквизиты' }).click()

    // Validation error rendered in the form (no AlertDialog opens)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('.text-destructive')).toBeVisible()
  })

  test('submitting Bank UAH method with invalid IBAN shows validation error', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByText('Junior Dev')).toBeVisible()

    await page.getByLabel('Банк UAH (ФОП)').check()
    await page.getByLabel('ФИО получателя').fill('Valid Name')
    await page.getByLabel('IBAN (UA…)').fill('INVALID-IBAN')
    await page.getByLabel('РНОКПП (10 цифр)').fill('1234567890')

    await page.getByRole('button', { name: 'Сохранить реквизиты' }).click()

    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('.text-destructive')).toBeVisible()
  })
})
