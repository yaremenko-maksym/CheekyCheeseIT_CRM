/**
 * drop-create-ui-regressions.spec.ts — task-e2e-fragile-points-audit.
 *
 * UI regressions from PR #63-66 user testing that were patched but had
 * NO targeted E2E coverage. Each test maps to a real bug fixed during
 * the drop role rollout:
 *
 *   1. Slider role label for DROP — `aria-label="Доля дропа в процентах"`,
 *      NOT «Доля синьора». A pre-PR-63 build re-used the senior aria text
 *      and a UX review caught it during user testing.
 *
 *   2. Inline HR validation — deselect all HR chips and submit, expect the
 *      inline error «Выберите минимум одного HR» AND the dialog stays open
 *      (operator can add an HR and retry). Previously the submit would
 *      silently no-op when HR list was empty.
 *
 *   3. Toast «Дроп создан» on positive submit — separate from the 409
 *      retry-path covered in `drop-duplicate-email.spec.ts`. The
 *      drop-duplicate spec only asserts the toast AFTER the retry path
 *      succeeds. This test asserts the toast on the happy path so a
 *      regression that drops the toast doesn't slip through.
 *
 * All tests are mock-based — `/api/users/drops` is intercepted to return
 * 201 with a stub drop user. This is deliberately fast / isolated because
 * the contract under test is purely UI text + form behavior, not the
 * backend cascade (covered by `drop-create.spec.ts` + real-API specs).
 */

import { test, expect, USERS } from './fixtures'
import { VALID_USDT_WALLET } from './fixtures'

const API = 'http://localhost:3001/api'

test.describe('Drop create — UI regressions', () => {
  test('slider for DROP role exposes aria-label «Доля дропа в процентах»', async ({
    asAdmin: page,
  }) => {
    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await expect(dialog).toBeVisible()

    // Both <input type=range> and <input type=number> render with the DROP
    // aria label. Spec §11 wording: «Доля дропа в процентах».
    const sliders = dialog.locator('[aria-label="Доля дропа в процентах"]')
    // 2 inputs in ShareSlider (range + number) → count must be 2.
    await expect(sliders).toHaveCount(2)

    // Senior aria text MUST NOT be present (regression catcher).
    await expect(dialog.locator('[aria-label="Доля синьора в процентах"]')).toHaveCount(0)
  })

  test('slider for SENIOR role still uses «Доля синьора в процентах» (regression-safe)', async ({
    asAdmin: page,
  }) => {
    // Sanity: the role-flip didn't accidentally re-label SENIOR sliders too.
    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[aria-label="Доля синьора в процентах"]')).toHaveCount(2)
    await expect(dialog.locator('[aria-label="Доля дропа в процентах"]')).toHaveCount(0)
  })

  test('submit without HR shows inline «Выберите минимум одного HR» error; dialog stays open', async ({
    asAdmin: page,
  }) => {
    // Override the /api/users mock to return NO HR users — UserDialog can't
    // auto-select what isn't there, so the HR list is empty on submit and
    // the form's inline validation must fire.
    //
    // Order matters: register this override BEFORE goto so it shadows the
    // generic fixture handler (Playwright route handlers run in
    // registration-order LIFO, so the latest wins).
    await page.route(new RegExp(`${API}/users(\\?.*)?$`), (r) => {
      if (r.request().method() === 'POST') return r.fallback()
      // Return ALL users EXCEPT HRs — the picker will render with «Нет
      // доступных HR» and the form-level validation flags an empty hrIds.
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          Object.values(USERS).filter((u) => u.role !== 'HR'),
        ),
      })
    })

    let postFired = false
    await page.route(new RegExp(`${API}/users/drops$`), (r) => {
      postFired = true
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'drop-nohr-id', email: 'drop-nohr@example.dev', displayName: 'Drop NoHR' },
          teamId: 'team-nohr-id',
        }),
      })
    })

    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await dialog.getByTestId('user-dialog-email').fill('drop-nohr@example.dev')
    await dialog.getByTestId('user-dialog-name').fill('Drop NoHR')
    await dialog.getByTestId('user-dialog-payment-method-USDT_ERC20').click()
    await dialog.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

    // Verify the picker actually renders the empty state — without this
    // assertion a passing test would be misleading if HR somehow leaked.
    await expect(dialog.getByText(/Нет доступных HR/i)).toBeVisible({ timeout: 5_000 })

    await dialog.getByTestId('user-dialog-submit').click()

    // Inline validation surfaces the exact wording from UserDialog.tsx:473/532.
    // Use a broader locator (page, not dialog) — the error renders as a
    // <p class="text-destructive"> sibling to the chip picker.
    await expect(
      page.getByText('Выберите минимум одного HR', { exact: false }),
    ).toBeVisible({ timeout: 5_000 })

    // Dialog MUST stay open — the operator should fix the HR and retry.
    await expect(dialog).toBeVisible()

    // The POST must NOT have fired — submit short-circuits on validation.
    expect(postFired).toBe(false)
  })

  test('toast «Дроп создан» appears on successful submit (happy path)', async ({
    asAdmin: page,
  }) => {
    // Mock /users/drops to return 201 immediately (no real DB).
    await page.route(new RegExp(`${API}/users/drops$`), (r) =>
      r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'drop-happy-id',
            email: 'drop-happy@example.dev',
            displayName: 'Drop Happy Path',
          },
          teamId: 'team-happy-id',
          team: { id: 'team-happy-id' },
        }),
      }),
    )

    await page.goto('/crm/users')
    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Дроп' }).click()

    const dialog = page.getByTestId('user-dialog')
    await dialog.getByTestId('user-dialog-email').fill('drop-happy@example.dev')
    await dialog.getByTestId('user-dialog-name').fill('Drop Happy Path')
    await dialog.getByTestId('user-dialog-payment-method-USDT_ERC20').click()
    await dialog.getByTestId('user-dialog-wallet').fill(VALID_USDT_WALLET)

    // HR chip auto-selected (single-HR fixture). Submit.
    await dialog.getByTestId('user-dialog-submit').click()

    // Toast «Дроп создан» surfaces immediately. Sonner renders the toast in
    // a region attached to body — scope is the page, not the dialog.
    await expect(page.getByText('Дроп создан', { exact: false })).toBeVisible({
      timeout: 8_000,
    })
  })
})
